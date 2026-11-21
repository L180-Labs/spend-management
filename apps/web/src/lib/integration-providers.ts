/** One input in a provider's credential form (see IntegrationProviderMeta.credentialFields). */
export interface CredentialField {
  /** The config key the backend provider reads. */
  key: string;
  label: string;
  placeholder?: string;
  /** Rendered as a password input. */
  secret?: boolean;
  optional?: boolean;
  /** Rendered as a select instead of a text input. */
  options?: { value: string; label: string }[];
  defaultValue?: string;
}

export interface IntegrationProviderMeta {
  value: string;
  label: string;
  /** Vendor name to auto-fill on the tool when this integration is selected (e.g. "Anthropic" for the "Claude (Anthropic)" integration). */
  vendor: string;
  /** Whether this provider has a real API to connect to. False for known vendors that are
   * tracked manually (e.g. Namecheap) - picking one just fills in Name/Vendor/Payment
   * defaults, it never shows a token field or implies a live sync. */
  hasApi: boolean;
  tokenKey: string;
  tokenLabel: string;
  placeholder: string;
  helpText: string;
  /** Whether this provider can report a spend limit/hard cap via API (see fetchLimitsUSD on the backend). Meaningless when hasApi is false. */
  hasLimits: boolean;
  /** Payment type this vendor is naturally tracked as - auto-applied when picked from the dropdown. */
  defaultPaymentKind: 'PREPAID' | 'MOSUB' | 'ONETIME';
  /** Only meaningful for MOSUB vendors. */
  defaultBillingCycle?: 'MONTHLY' | 'YEARLY';
  /** True when connecting needs more than one credential field (e.g. GCP needs a
   * service account JSON key plus project/dataset/table/billing-account IDs, not
   * a single token) - the Add Tool and Configure Integration modals render a
   * provider-specific field set instead of the generic single tokenKey input. */
  multiField?: boolean;
  /** True when the provider's data is inherently batch/delayed rather than live
   * (e.g. GCP's BigQuery Billing Export, hours-to-days behind) - anywhere this
   * provider's synced amount is shown, it must read as "delayed," never "Live",
   * so it's never confused with a truly real-time sync. */
  hasLag?: boolean;
  /** Only meaningful when hasLimits is true. For most hasLimits providers (e.g.
   * Railway) a null fetchLimitsUSD result means something's actually broken
   * (bad token, wrong scope) - Connect should block until it succeeds. For a
   * provider whose limit-reading depends on a genuinely optional resource the
   * account may just not have set up yet (e.g. GCP's Budget - a separate,
   * optional Console resource, unlike Railway's near-universal usage limits),
   * a null result is a normal, expected state, not an error - Connect should
   * fall back to manual cap entry instead of hard-blocking. */
  limitsOptional?: boolean;
  /** Generic multi-input credential form (e.g. AWS key ID + secret, GitHub
   * account + token). When set, the modals render these fields instead of
   * the single tokenKey input. GCP keeps its own bespoke form (multiField). */
  credentialFields?: CredentialField[];
}

// Single source of truth for which integrations/known vendors are supported,
// shared by the Add Tool modal and the Configure Integration modal so the two
// never drift.
export const INTEGRATION_PROVIDERS: IntegrationProviderMeta[] = [
  {
    value: 'RAILWAY',
    label: 'Railway',
    vendor: 'Railway',
    hasApi: true,
    tokenKey: 'apiToken',
    tokenLabel: 'API Token',
    placeholder: 'Paste your Railway API token',
    // Counterintuitively, an Account-scoped token ("No workspace") CANNOT read budget
    // limits or usage history for this app - only a token scoped TO the workspace can
    // (verified empirically: Account-scoped only gets a bare current-spend number,
    // Workspace-scoped gets spend + limits + history). Pick the workspace, not "No workspace".
    helpText: 'railway.com → Account Settings → API Tokens → pick your workspace (not "No workspace")',
    hasLimits: true,
    defaultPaymentKind: 'PREPAID',
  },
  {
    value: 'CLAUDE',
    label: 'Claude (Anthropic)',
    vendor: 'Anthropic',
    hasApi: true,
    tokenKey: 'adminApiKey',
    tokenLabel: 'Admin API Key',
    placeholder: 'Paste your Anthropic Admin API key (sk-ant-admin01-...)',
    helpText: 'console.anthropic.com → Settings → Admin Keys',
    hasLimits: false,
    defaultPaymentKind: 'PREPAID',
  },
  {
    value: 'NAMECHEAP',
    label: 'Namecheap',
    vendor: 'Namecheap',
    hasApi: false,
    tokenKey: '',
    tokenLabel: '',
    placeholder: '',
    helpText: '',
    hasLimits: false,
    defaultPaymentKind: 'MOSUB',
    defaultBillingCycle: 'YEARLY',
  },
  {
    // No IntegrationProvider - Hostinger's Billing API reports subscription
    // status/renewal metadata, not a verified per-subscription cost figure
    // (see docs/hostinger-integration-loop-prompt.md Step 0). Manual entry
    // only, same as Namecheap/Google Workspace.
    value: 'HOSTINGER',
    label: 'Hostinger',
    vendor: 'Hostinger',
    hasApi: false,
    tokenKey: '',
    tokenLabel: '',
    placeholder: '',
    helpText: '',
    hasLimits: false,
    defaultPaymentKind: 'MOSUB',
    defaultBillingCycle: 'MONTHLY',
  },
  {
    value: 'GOOGLE_WORKSPACE',
    label: 'Google Workspace',
    vendor: 'Google Workspace',
    hasApi: false,
    tokenKey: '',
    tokenLabel: '',
    placeholder: '',
    helpText: '',
    hasLimits: false,
    defaultPaymentKind: 'MOSUB',
    defaultBillingCycle: 'MONTHLY',
  },
  {
    value: 'HEYGEN',
    label: 'HeyGen',
    vendor: 'HeyGen',
    hasApi: true,
    tokenKey: 'apiKey',
    tokenLabel: 'API Key',
    placeholder: 'Paste your HeyGen API key',
    helpText: 'app.heygen.com → Settings → API Keys',
    // No spend-limit endpoint (same as Claude) - budget cap is always entered
    // manually, even in "Connect account" mode.
    hasLimits: false,
    defaultPaymentKind: 'PREPAID',
  },
  {
    value: 'GCP',
    label: 'Google Cloud Platform',
    vendor: 'Google Cloud',
    hasApi: true,
    // Not a single token - see multiField below. tokenKey still matches the config
    // field the backend reads, kept for consistency with the generic shape.
    tokenKey: 'serviceAccountJson',
    tokenLabel: 'Service Account JSON Key',
    placeholder: '',
    helpText: 'GCP Console → BigQuery Billing Export must be enabled first, and the service account needs roles/billing.viewer on the billing account to read the configured budget - see docs/gcp-billing-integration-loop-prompt.md',
    // Reads the configured budget (amount + alert threshold) from the Cloud
    // Billing Budget API - a different endpoint from the BigQuery export used
    // for spend, requiring the extra roles/billing.viewer role.
    hasLimits: true,
    // Unlike Railway, a GCP Budget is a separate, optional Console resource -
    // plenty of real accounts won't have one configured. A null result here
    // must fall back to manual cap entry, not block connecting entirely.
    limitsOptional: true,
    defaultPaymentKind: 'PREPAID',
    multiField: true,
    // BigQuery Billing Export is a daily batch, hours-to-5-days behind - never
    // "Live" the way Railway/Claude/HeyGen's syncs are.
    hasLag: true,
  },
  {
    value: 'AWS',
    label: 'Amazon Web Services (AWS)',
    vendor: 'AWS',
    hasApi: true,
    tokenKey: 'secretAccessKey',
    tokenLabel: 'Secret Access Key',
    placeholder: '',
    helpText: 'IAM → Users → Security credentials → Create access key. The key needs ce:GetCostAndUsage (plus budgets:ViewBudget to read your monthly budget). AWS bills $0.01 for every sync, including saving and "Sync now". Automatic syncs run every 6 hours - about $1.20 a month per account.',
    // Reads a monthly COST budget from AWS Budgets when one exists; budgets are
    // optional in AWS, so a missing one falls back to manual cap entry.
    hasLimits: true,
    limitsOptional: true,
    defaultPaymentKind: 'PREPAID',
    // Cost Explorer data trails real usage by up to ~24h.
    hasLag: true,
    credentialFields: [
      { key: 'accessKeyId', label: 'Access Key ID', placeholder: 'AKIA…' },
      { key: 'secretAccessKey', label: 'Secret Access Key', placeholder: 'Paste the secret access key', secret: true },
      // Only for temporary (STS / SSO) credentials, whose key ID starts with ASIA.
      // Those expire within hours, so a permanent IAM user key is the better fit for syncing.
      { key: 'sessionToken', label: 'Session Token', placeholder: 'Only for temporary credentials (key ID starting ASIA…)', secret: true, optional: true },
    ],
  },
  {
    value: 'GITHUB',
    label: 'GitHub',
    vendor: 'GitHub',
    hasApi: true,
    tokenKey: 'token',
    tokenLabel: 'Access Token',
    placeholder: '',
    helpText: 'github.com → Settings → Developer settings → Fine-grained token. Organization: "Administration" read (you must be an owner or billing manager). Personal account: "Plan" read.',
    // Metered usage only (Actions, Packages, Codespaces, Copilot, seats) from the
    // enhanced billing usage report - no budget is read, cap is entered manually.
    hasLimits: false,
    defaultPaymentKind: 'PREPAID',
    credentialFields: [
      { key: 'accountType', label: 'Account type', options: [{ value: 'org', label: 'Organization' }, { value: 'user', label: 'Personal account' }], defaultValue: 'org' },
      { key: 'accountName', label: 'Organization or username', placeholder: 'e.g. life180labs' },
      { key: 'token', label: 'Access Token', placeholder: 'github_pat_…', secret: true },
    ],
  },
  {
    value: 'META_ADS',
    label: 'Meta Ads',
    // "Meta Ads", not "Meta": vendor matching is a substring check, and plain
    // "meta" would also claim unrelated vendors (e.g. Metabase).
    vendor: 'Meta Ads',
    hasApi: true,
    tokenKey: 'accessToken',
    tokenLabel: 'Access Token',
    placeholder: '',
    helpText: 'Business Settings → Users → System users → Generate token with ads_read, and assign the ad account to that system user. Ad account ID is in Ads Manager (act_…).',
    // An ad account's spend_cap is a lifetime cap, not a monthly budget - cap is entered manually.
    hasLimits: false,
    defaultPaymentKind: 'PREPAID',
    credentialFields: [
      { key: 'adAccountId', label: 'Ad Account ID', placeholder: 'act_1234567890' },
      { key: 'accessToken', label: 'Access Token', placeholder: 'System user access token', secret: true },
    ],
  },
];

/**
 * Matches a tool's free-text vendor field to a supported integration, tolerating
 * the kind of variation real data has (e.g. "Railway.com" vs the provider's
 * canonical "Railway") via a substring check in either direction, not just an
 * exact match. Single source of truth - both the Add Tool dropdown's "already
 * exists" check and the Configure Integration provider lock must use this same
 * function, or the two can silently drift out of sync with each other.
 */
export function matchProviderByVendor(vendor: string | undefined | null): IntegrationProviderMeta | undefined {
  const toolVendor = vendor?.trim().toLowerCase();
  if (!toolVendor) return undefined;
  return INTEGRATION_PROVIDERS.find((p) => {
    const providerVendor = p.vendor.toLowerCase();
    return toolVendor === providerVendor || toolVendor.includes(providerVendor);
  });
}
