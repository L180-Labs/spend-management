'use client';

import type { CSSProperties } from 'react';
import type { CredentialField } from '@/lib/integration-providers';

/** True when every required credential field has a non-blank value. */
export function credentialFieldsReady(fields: CredentialField[], values: Record<string, string>): boolean {
  return fields.every((f) => f.optional || !!(values[f.key] ?? f.defaultValue ?? '').trim());
}

/** The config object sent to the API: trimmed values, select defaults applied, blank optionals dropped. */
export function credentialFieldsConfig(fields: CredentialField[], values: Record<string, string>): Record<string, string> {
  const config: Record<string, string> = {};
  for (const f of fields) {
    const value = (values[f.key] ?? f.defaultValue ?? '').trim();
    if (value) config[f.key] = value;
  }
  return config;
}

/**
 * Generic credential form for providers that need more than one token
 * (IntegrationProviderMeta.credentialFields) - used by both the Add Tool and
 * Configure Integration modals so their field sets can never drift.
 */
export function CredentialFields({
  fields, values, onChange, inputStyle, labelStyle,
}: {
  fields: CredentialField[];
  values: Record<string, string>;
  onChange: (key: string, value: string) => void;
  inputStyle: CSSProperties;
  labelStyle: CSSProperties;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {fields.map((f) => {
        const id = `cred-${f.key}`;
        const value = values[f.key] ?? f.defaultValue ?? '';
        return (
          <div key={f.key}>
            <label htmlFor={id} style={labelStyle}>
              {f.label}{f.optional && <span style={{ opacity: 0.6, marginLeft: 4 }}>(optional)</span>}
            </label>
            {f.options ? (
              <select id={id} value={value} onChange={(e) => onChange(f.key, e.target.value)} style={inputStyle}>
                {f.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            ) : (
              <input
                id={id}
                type={f.secret ? 'password' : 'text'}
                value={value}
                onChange={(e) => onChange(f.key, e.target.value)}
                placeholder={f.placeholder}
                autoComplete="off"
                spellCheck={false}
                style={{ ...inputStyle, ...(f.secret ? { fontFamily: 'monospace', letterSpacing: '0.03em' } : {}) }}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
