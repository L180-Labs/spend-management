import { ConfigService } from '@nestjs/config';
import { isLocalDevelopment } from './local-development';
import { GoogleStrategy } from './auth/strategies/google.strategy';
import { MailService } from './mail/mail.service';

function configFor(values: Record<string, unknown>): ConfigService {
  // Isolate from Jest's NODE_ENV=test and from developer machine credentials.
  return { get: (key: string, fallback?: unknown) => values[key] ?? fallback } as ConfigService;
}

describe('local development configuration', () => {
  it.each([
    ['production', 'true', false],
    ['development', 'false', false],
    [undefined, 'true', false],
    ['development', 'true', true],
  ])('requires explicit development opt-in (%s, %s)', (env, flag, expected) => {
    const config = configFor({ NODE_ENV: env, LOCAL_DEV_MODE: flag });
    expect(isLocalDevelopment(config)).toBe(expected);
  });

  it('starts without external credentials only in local development', () => {
    const local = configFor({ NODE_ENV: 'development', LOCAL_DEV_MODE: 'true' });
    expect(() => new GoogleStrategy(local)).not.toThrow();
    expect(() => new MailService(local)).not.toThrow();
    const production = configFor({ NODE_ENV: 'production', LOCAL_DEV_MODE: 'true' });
    expect(() => new GoogleStrategy(production)).toThrow();
    expect(() => new MailService(production)).toThrow();
  });

  it('suppresses outbound mail in local mode', async () => {
    const service = new MailService(configFor({ NODE_ENV: 'development', LOCAL_DEV_MODE: 'true' }));
    const fetchSpy = jest.spyOn(global, 'fetch');
    try {
      await service.sendThresholdAlert('developer@example.test', [
        { toolName: 'Test tool', vendor: 'Local', barPct: 90, thresholdPct: 80, capAmount: 100 },
      ]);
      await service.sendRenewalReminder('developer@example.test', 'Test tool', 'Local', new Date(), 1, 20);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
