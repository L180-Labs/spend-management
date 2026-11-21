import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CredentialFields, credentialFieldsConfig, credentialFieldsReady } from './credential-fields';
import { INTEGRATION_PROVIDERS, matchProviderByVendor } from '@/lib/integration-providers';

const github = INTEGRATION_PROVIDERS.find((p) => p.value === 'GITHUB')!;

describe('credential fields', () => {
  it('is ready only when every required field is filled, counting select defaults', () => {
    const fields = github.credentialFields!;
    expect(credentialFieldsReady(fields, {})).toBe(false);
    expect(credentialFieldsReady(fields, { accountName: 'acme', token: '  ' })).toBe(false);
    expect(credentialFieldsReady(fields, { accountName: 'acme', token: 'github_pat_x' })).toBe(true); // accountType defaults to org
  });

  it('builds a trimmed config with select defaults applied', () => {
    expect(credentialFieldsConfig(github.credentialFields!, { accountName: ' acme ', token: 'tok ' }))
      .toEqual({ accountType: 'org', accountName: 'acme', token: 'tok' });
  });

  it('renders secrets as password inputs and selects for option fields', async () => {
    const onChange = jest.fn();
    render(<CredentialFields fields={github.credentialFields!} values={{}} onChange={onChange} inputStyle={{}} labelStyle={{}} />);
    expect(screen.getByLabelText('Access Token')).toHaveAttribute('type', 'password');
    await userEvent.selectOptions(screen.getByLabelText('Account type'), 'user');
    expect(onChange).toHaveBeenCalledWith('accountType', 'user');
  });
});

describe('AWS / GitHub / Meta Ads providers', () => {
  it('are API-backed and declare a credential form', () => {
    for (const value of ['AWS', 'GITHUB', 'META_ADS']) {
      const p = INTEGRATION_PROVIDERS.find((x) => x.value === value)!;
      expect(p.hasApi).toBe(true);
      expect(p.credentialFields?.length).toBeGreaterThan(1);
    }
  });

  it('AWS takes an optional session token for temporary credentials, sent only when filled in', () => {
    const fields = INTEGRATION_PROVIDERS.find((x) => x.value === 'AWS')!.credentialFields!;
    const token = fields.find((f) => f.key === 'sessionToken');
    expect(token).toEqual(expect.objectContaining({ optional: true, secret: true }));

    const keys = { accessKeyId: 'ASIAEXAMPLE', secretAccessKey: 'secret' };
    expect(credentialFieldsReady(fields, keys)).toBe(true);
    expect(credentialFieldsConfig(fields, keys)).toEqual(keys);
    expect(credentialFieldsConfig(fields, { ...keys, sessionToken: ' tok ' })).toEqual({ ...keys, sessionToken: 'tok' });
  });

  it('matches tools by vendor without claiming look-alike vendors', () => {
    expect(matchProviderByVendor('GitHub')?.value).toBe('GITHUB');
    expect(matchProviderByVendor('Meta Ads')?.value).toBe('META_ADS');
    expect(matchProviderByVendor('AWS')?.value).toBe('AWS');
    expect(matchProviderByVendor('Metabase')).toBeUndefined();
  });
});
