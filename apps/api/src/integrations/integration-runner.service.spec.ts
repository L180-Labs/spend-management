jest.mock('./providers/railway.provider', () => ({
  RailwayProvider: jest.fn().mockImplementation(() => ({
    fetchSpendUSD: jest.fn(),
    fetchLimitsUSD: jest.fn(),
  })),
}));
jest.mock('./providers/claude.provider', () => ({
  ClaudeProvider: jest.fn().mockImplementation(() => ({
    fetchSpendUSD: jest.fn(),
  })),
}));
jest.mock('./providers/heygen.provider', () => ({
  // Mirrors the real HeyGenProvider's shape - only fetchSpendUSD, which
  // (unlike Railway/Claude) can return providerState.
  HeyGenProvider: jest.fn().mockImplementation(() => ({
    fetchSpendUSD: jest.fn(),
  })),
}));

import { IntegrationRunnerService, PROVIDERS, isDueForScheduledSync, providerCapState, shouldAdoptProviderCap } from './integration-runner.service';

describe('IntegrationRunnerService', () => {
  let prisma: any;
  let service: IntegrationRunnerService;
  const railway = PROVIDERS.RAILWAY as any;
  const claude = PROVIDERS.CLAUDE as any;
  const heygen = PROVIDERS.HEYGEN as any;

  beforeEach(() => {
    jest.clearAllMocks();
    prisma = {
      toolIntegration: {
        findMany: jest.fn(),
        // The cap-tracking columns, read inside the sync's transaction.
        findUnique: jest.fn().mockResolvedValue({ lastProviderCapUSD: null, providerCapTracked: false }),
        update: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      tool: { findUnique: jest.fn(), update: jest.fn() },
      $executeRaw: jest.fn(),
      $transaction: jest.fn(async (fn: any) => fn(prisma)),
    };
    service = new IntegrationRunnerService(prisma);
  });

  /** Every data object written to tool_integrations, by any method - none may contain config. */
  const integrationWrites = () => [
    ...prisma.toolIntegration.update.mock.calls,
    ...prisma.toolIntegration.updateMany.mock.calls,
  ].map(([args]: any[]) => args.data);

  describe('runAll', () => {
    it('only queries active integrations belonging to non-deleted tools', async () => {
      prisma.toolIntegration.findMany.mockResolvedValue([]);
      await service.runAll();
      expect(prisma.toolIntegration.findMany).toHaveBeenCalledWith({
        where: { isActive: true, tool: { deletedAt: null } },
      });
    });

    it('runs every returned integration', async () => {
      prisma.toolIntegration.findMany.mockResolvedValue([
        { id: 'i1', toolId: 't1', provider: 'RAILWAY', config: {} },
        { id: 'i2', toolId: 't2', provider: 'CLAUDE', config: {} },
      ]);
      railway.fetchSpendUSD.mockResolvedValue({ amountUSD: 5 });
      claude.fetchSpendUSD.mockResolvedValue({ amountUSD: 8 });
      prisma.tool.findUnique.mockResolvedValue({ capAmount: 0, alertThresholdPct: 80 });

      await service.runAll();

      expect(railway.fetchSpendUSD).toHaveBeenCalledTimes(1);
      expect(claude.fetchSpendUSD).toHaveBeenCalledTimes(1);
    });
  });

  describe('runOne', () => {
    it('dispatches to the provider registered for integration.provider (generic, no hardcoded vendor check)', async () => {
      railway.fetchSpendUSD.mockResolvedValue({ amountUSD: 12.5, breakdown: [], byProject: [] });
      prisma.tool.findUnique.mockResolvedValue({ capAmount: 0, alertThresholdPct: 80 });

      await service.runOne({ id: 'i1', toolId: 't1', provider: 'RAILWAY', config: { token: 'x' } });

      expect(railway.fetchSpendUSD).toHaveBeenCalledWith({ token: 'x' });
      expect(claude.fetchSpendUSD).not.toHaveBeenCalled();
    });

    it('logs a warning and does nothing when no provider is registered for the given key', async () => {
      await service.runOne({ id: 'i1', toolId: 't1', provider: 'UNKNOWN_VENDOR', config: {} });
      expect(prisma.tool.update).not.toHaveBeenCalled();
      expect(integrationWrites()).toEqual([]);
    });

    it('updates usedAmount/barPct using the tool cap when the provider does not expose limits, without re-writing the cap', async () => {
      claude.fetchSpendUSD.mockResolvedValue({ amountUSD: 40, breakdown: [], byProject: [] });
      prisma.tool.findUnique.mockResolvedValue({ capAmount: 100, alertThresholdPct: 80 });

      await service.runOne({ id: 'i2', toolId: 't2', provider: 'CLAUDE', config: {} });

      expect(prisma.tool.update).toHaveBeenCalledWith({
        where: { id: 't2' },
        data: { usedAmount: 40, barPct: 40 },
      });
    });

    it('refreshes cap/alertThresholdPct from provider-reported limits when available', async () => {
      railway.fetchSpendUSD.mockResolvedValue({ amountUSD: 9, breakdown: [], byProject: [] });
      railway.fetchLimitsUSD.mockResolvedValue({ computeHardLimitUSD: 20, computeSoftLimitUSD: 16 });
      prisma.tool.findUnique.mockResolvedValue({ capAmount: 0, alertThresholdPct: 80 });

      await service.runOne({ id: 'i1', toolId: 't1', provider: 'RAILWAY', config: {} });

      expect(prisma.tool.update).toHaveBeenCalledWith({
        where: { id: 't1' },
        data: { usedAmount: 9, barPct: 45, capAmount: 20, alertThresholdPct: 80 },
      });
    });

    it('records lastError and lastFailedSyncAt (their own columns only) instead of throwing when the provider call fails', async () => {
      claude.fetchSpendUSD.mockRejectedValue(new Error('API key revoked'));

      await service.runOne({ id: 'i2', toolId: 't2', provider: 'CLAUDE', config: { adminApiKey: 'old-key' } });

      expect(prisma.toolIntegration.updateMany).toHaveBeenCalledWith({
        where: { id: 'i2' },
        data: { lastError: 'API key revoked', lastFailedSyncAt: expect.any(Date) },
      });
    });

    it('merges providerState into config in the database, touching only those keys (HeyGen-style stateful providers)', async () => {
      heygen.fetchSpendUSD.mockResolvedValue({
        amountUSD: 25,
        providerState: { heygenLastBalance: 35, heygenPeriodSpend: 25, heygenPeriodMonthKey: '2026-08' },
      });
      prisma.tool.findUnique.mockResolvedValue({ capAmount: 50, alertThresholdPct: 80 });

      await service.runOne({ id: 'i3', toolId: 't3', provider: 'HEYGEN', config: { apiKey: 'k1', heygenLastBalance: 50 } });

      expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
      const [sql, stateJson, id] = prisma.$executeRaw.mock.calls[0];
      expect(sql.join('?')).toContain('"config" = "config" || ?::jsonb');
      expect(JSON.parse(stateJson)).toEqual({ heygenLastBalance: 35, heygenPeriodSpend: 25, heygenPeriodMonthKey: '2026-08' });
      expect(stateJson).not.toContain('k1'); // never the credentials
      expect(id).toBe('i3');
    });

    it('never writes config from its own copy - for any provider, on success or failure', async () => {
      railway.fetchSpendUSD.mockResolvedValue({ amountUSD: 9, breakdown: [], byProject: [] });
      railway.fetchLimitsUSD.mockResolvedValue({ computeHardLimitUSD: 20, computeSoftLimitUSD: 16 });
      prisma.tool.findUnique.mockResolvedValue({ capAmount: 0, alertThresholdPct: 80 });
      await service.runOne({ id: 'i1', toolId: 't1', provider: 'RAILWAY', config: { apiToken: 'tok' } });

      claude.fetchSpendUSD.mockRejectedValue(new Error('nope'));
      await service.runOne({ id: 'i2', toolId: 't2', provider: 'CLAUDE', config: { adminApiKey: 'k' } });

      expect(integrationWrites().length).toBeGreaterThan(0);
      for (const data of integrationWrites()) expect(data).not.toHaveProperty('config');
      expect(prisma.$executeRaw).not.toHaveBeenCalled();
    });

    it('persists lastSyncRemainingBalanceUSD when a provider reports one (HeyGen)', async () => {
      heygen.fetchSpendUSD.mockResolvedValue({
        amountUSD: 25,
        remainingBalanceUSD: 35,
        providerState: { heygenLastBalance: 35, heygenPeriodSpend: 25, heygenPeriodMonthKey: '2026-08' },
      });
      prisma.tool.findUnique.mockResolvedValue({ capAmount: 50, alertThresholdPct: 80 });

      await service.runOne({ id: 'i3', toolId: 't3', provider: 'HEYGEN', config: { apiKey: 'k1' } });

      expect(prisma.toolIntegration.updateMany).toHaveBeenCalledWith({
        where: { id: 'i3' },
        data: expect.objectContaining({ lastSyncRemainingBalanceUSD: 35 }),
      });
    });

    it('explicitly persists lastSyncRemainingBalanceUSD: null (not left untouched) for providers that never report a balance (Railway, Claude)', async () => {
      railway.fetchSpendUSD.mockResolvedValue({ amountUSD: 9, breakdown: [], byProject: [] });
      prisma.tool.findUnique.mockResolvedValue({ capAmount: 20, alertThresholdPct: 80 });

      await service.runOne({ id: 'i1', toolId: 't1', provider: 'RAILWAY', config: {} });

      expect(prisma.toolIntegration.updateMany).toHaveBeenCalledWith({
        where: { id: 'i1' },
        data: expect.objectContaining({ lastSyncRemainingBalanceUSD: null }),
      });
    });
  });

  describe('a sync whose credentials were re-saved while it ran', () => {
    const startedWith = new Date('2026-11-21T10:00:00Z');

    it('only writes if the saved config is still the one it started with', async () => {
      claude.fetchSpendUSD.mockResolvedValue({ amountUSD: 4, breakdown: [], byProject: [] });
      prisma.tool.findUnique.mockResolvedValue({ capAmount: 0, alertThresholdPct: 80 });

      await service.runOne({ id: 'i2', toolId: 't2', provider: 'CLAUDE', config: {}, configUpdatedAt: startedWith });

      expect(prisma.toolIntegration.updateMany).toHaveBeenCalledWith(expect.objectContaining({
        where: { id: 'i2', configUpdatedAt: startedWith },
      }));
    });

    it('discards a successful result from the old credentials - the tool keeps its current figures', async () => {
      claude.fetchSpendUSD.mockResolvedValue({ amountUSD: 4, breakdown: [], byProject: [] });
      prisma.toolIntegration.updateMany.mockResolvedValue({ count: 0 }); // re-saved meanwhile

      await service.runOne({ id: 'i2', toolId: 't2', provider: 'CLAUDE', config: {}, configUpdatedAt: startedWith });

      expect(prisma.tool.update).not.toHaveBeenCalled();
      expect(prisma.toolIntegration.update).not.toHaveBeenCalled();
    });

    it('a failure from a mistyped secret that has since been corrected does not mark the integration as failing (the reviewer\'s example)', async () => {
      const aws = PROVIDERS.AWS as any;
      const spy = jest.spyOn(aws, 'fetchSpendUSD').mockRejectedValue(new Error('AWS rejected the access key'));
      prisma.toolIntegration.updateMany.mockResolvedValue({ count: 0 }); // the corrected secret was saved meanwhile

      await service.runOne({ id: 'a1', toolId: 't1', provider: 'AWS', config: { accessKeyId: 'AKIA', secretAccessKey: 'typo' }, configUpdatedAt: startedWith });

      // The only write attempted is the guarded status update - which matched nothing.
      expect(prisma.toolIntegration.updateMany).toHaveBeenCalledWith({
        where: { id: 'a1', configUpdatedAt: startedWith },
        data: { lastError: 'AWS rejected the access key', lastFailedSyncAt: expect.any(Date) },
      });
      for (const data of integrationWrites()) expect(data).not.toHaveProperty('config');
      spy.mockRestore();
    });
  });

  describe('provider caps vs hand-entered caps', () => {
    it('adopts the provider cap when the tool has none, or still has the one the provider set', () => {
      expect(shouldAdoptProviderCap(0, 100, undefined)).toBe(true);
      expect(shouldAdoptProviderCap(100, 100, undefined)).toBe(true);
      expect(shouldAdoptProviderCap(100, 150, 100)).toBe(true); // provider budget raised since - follow it
    });

    it('keeps a cap the user typed in by hand', () => {
      expect(shouldAdoptProviderCap(250, 100, 100)).toBe(false); // provider set 100, user changed it to 250
      expect(shouldAdoptProviderCap(250, 100, null)).toBe(false); // typed in when connecting
    });

    it('integrations connected before caps were remembered keep following the provider (e.g. a changed GCP budget)', () => {
      expect(shouldAdoptProviderCap(100, 150, undefined)).toBe(true);
    });

    it('right after a save (null), adopts only when the tool has no cap or already matches', () => {
      expect(shouldAdoptProviderCap(0, 100, null)).toBe(true);
      expect(shouldAdoptProviderCap(100, 100, null)).toBe(true);
    });

    it('providerCapState maps the columns: untracked = undefined (legacy), tracked = the remembered cap or null', () => {
      expect(providerCapState({ lastProviderCapUSD: null, providerCapTracked: false })).toBeUndefined();
      expect(providerCapState({ lastProviderCapUSD: null, providerCapTracked: true })).toBeNull();
      expect(providerCapState({ lastProviderCapUSD: 75, providerCapTracked: true })).toBe(75);
    });

    it('a sync does not overwrite a hand-entered cap, and does not touch the cap fields at all', async () => {
      railway.fetchSpendUSD.mockResolvedValue({ amountUSD: 30, breakdown: [], byProject: [] });
      railway.fetchLimitsUSD.mockResolvedValue({ computeHardLimitUSD: 100, computeSoftLimitUSD: 80 });
      prisma.tool.findUnique.mockResolvedValue({ capAmount: 250, alertThresholdPct: 90 });
      prisma.toolIntegration.findUnique.mockResolvedValue({ lastProviderCapUSD: 100, providerCapTracked: true });

      await service.runOne({ id: 'i1', toolId: 't1', provider: 'RAILWAY', config: { apiToken: 'tok' } });

      expect(prisma.tool.update).toHaveBeenCalledWith({
        where: { id: 't1' },
        data: { usedAmount: 30, barPct: 12 },
      });
      expect(prisma.toolIntegration.update).not.toHaveBeenCalled();
    });

    it('remembers the provider cap it applied in its own columns, so a later hand edit can be recognised', async () => {
      railway.fetchSpendUSD.mockResolvedValue({ amountUSD: 30, breakdown: [], byProject: [] });
      railway.fetchLimitsUSD.mockResolvedValue({ computeHardLimitUSD: 100, computeSoftLimitUSD: 80 });
      prisma.tool.findUnique.mockResolvedValue({ capAmount: 0, alertThresholdPct: 80 });

      await service.runOne({ id: 'i1', toolId: 't1', provider: 'RAILWAY', config: { apiToken: 'tok' } });

      expect(prisma.tool.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ capAmount: 100, alertThresholdPct: 80 }) }));
      expect(prisma.toolIntegration.update).toHaveBeenCalledWith({
        where: { id: 'i1' },
        data: { lastProviderCapUSD: 100, providerCapTracked: true },
      });
    });

    it('does not re-write the remembered cap when it hasn\'t changed', async () => {
      railway.fetchSpendUSD.mockResolvedValue({ amountUSD: 9, breakdown: [], byProject: [] });
      railway.fetchLimitsUSD.mockResolvedValue({ computeHardLimitUSD: 20, computeSoftLimitUSD: 16 });
      prisma.tool.findUnique.mockResolvedValue({ capAmount: 20, alertThresholdPct: 80 });
      prisma.toolIntegration.findUnique.mockResolvedValue({ lastProviderCapUSD: 20, providerCapTracked: true });

      await service.runOne({ id: 'i1', toolId: 't1', provider: 'RAILWAY', config: { apiToken: 'tok' } });

      expect(prisma.toolIntegration.update).not.toHaveBeenCalled();
    });
  });

  describe('the sync that runs on Save', () => {
    it('never reads or writes the cap, so it cannot overwrite the cap the Configure screen sets', async () => {
      railway.fetchSpendUSD.mockResolvedValue({ amountUSD: 30, breakdown: [], byProject: [] });
      railway.fetchLimitsUSD.mockResolvedValue({ computeHardLimitUSD: 100, computeSoftLimitUSD: 80 });
      prisma.tool.findUnique.mockResolvedValue({ capAmount: 0, alertThresholdPct: 80 });

      await service.runOne({ id: 'i1', toolId: 't1', provider: 'RAILWAY', config: { apiToken: 'tok' } }, { applyLimits: false });

      expect(railway.fetchLimitsUSD).not.toHaveBeenCalled();
      expect(prisma.tool.update).toHaveBeenCalledWith({ where: { id: 't1' }, data: { usedAmount: 30, barPct: 0 } });
      expect(prisma.toolIntegration.update).not.toHaveBeenCalled();
    });
  });

  describe('scheduled sync interval', () => {
    const hourly = {} as any;
    const sixHourly = { minSyncIntervalMinutes: 360 } as any;
    const now = Date.parse('2026-11-21T12:00:00Z');
    const hoursAgo = (h: number) => new Date(now - h * 3_600_000);

    it('syncs providers without an interval every run, and anything never synced', () => {
      expect(isDueForScheduledSync(hourly, hoursAgo(1), now)).toBe(true);
      expect(isDueForScheduledSync(sixHourly, null, now)).toBe(true);
    });

    it('skips a 6-hourly provider (AWS) until 6 hours after its last sync', () => {
      expect(isDueForScheduledSync(sixHourly, hoursAgo(1), now)).toBe(false);
      expect(isDueForScheduledSync(sixHourly, hoursAgo(5), now)).toBe(false);
      expect(isDueForScheduledSync(sixHourly, hoursAgo(6), now)).toBe(true);
    });

    it('counts a failed attempt too, so a broken AWS connection is not retried every hour', () => {
      expect(isDueForScheduledSync(sixHourly, hoursAgo(30), now, hoursAgo(1).toISOString())).toBe(false);
      expect(isDueForScheduledSync(sixHourly, null, now, hoursAgo(1).toISOString())).toBe(false);
      expect(isDueForScheduledSync(sixHourly, null, now, hoursAgo(7).toISOString())).toBe(true);
      expect(isDueForScheduledSync(hourly, null, now, hoursAgo(0.5).toISOString())).toBe(true); // hourly providers unaffected
    });

    it('runAll only runs integrations that are due', async () => {
      const aws = PROVIDERS.AWS as any;
      const spy = jest.spyOn(service, 'runOne').mockResolvedValue(undefined);
      prisma.toolIntegration.findMany.mockResolvedValue([
        { id: 'a', toolId: 't1', provider: 'AWS', config: {}, lastSyncAt: new Date(Date.now() - 3_600_000) },
        { id: 'r', toolId: 't2', provider: 'RAILWAY', config: {}, lastSyncAt: new Date(Date.now() - 3_600_000) },
        { id: 'f', toolId: 't3', provider: 'AWS', config: {}, lastSyncAt: null, lastFailedSyncAt: new Date(Date.now() - 3_600_000) }, // failed an hour ago: backs off too
      ]);
      expect(aws.minSyncIntervalMinutes).toBe(360);

      await service.runAll();
      expect(spy.mock.calls.map(([i]) => i.id)).toEqual(['r']);
    });
  });
});
