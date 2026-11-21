'use client';

import { FormEvent, useState } from 'react';
import { useRouter } from 'next/navigation';
import { login, storeUser } from '@/lib/auth';

export function LocalLogin() {
  const router = useRouter();
  const [email, setEmail] = useState('developer@example.test');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError('');
    setLoading(true);
    try {
      storeUser(await login(email, password));
      router.replace('/dashboard');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <p className="text-sm text-[var(--c-9aa0ab)]">Sign in to your local workspace.</p>
      <label className="block text-sm">
        Email
        <input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)}
          className="mt-1 w-full rounded-lg border border-[var(--c-1e212a)] bg-[var(--c-0a0b0e)] px-3 py-2" />
      </label>
      <label className="block text-sm">
        Password
        <input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)}
          className="mt-1 w-full rounded-lg border border-[var(--c-1e212a)] bg-[var(--c-0a0b0e)] px-3 py-2" />
      </label>
      {error && <p role="alert" className="text-sm text-[var(--c-f85149)]">{error}</p>}
      <button disabled={loading} type="submit" className="w-full rounded-lg bg-[#5E6AD2] px-4 py-3 text-sm font-semibold text-white disabled:opacity-50">
        {loading ? 'Signing in…' : 'Sign in locally'}
      </button>
    </form>
  );
}
