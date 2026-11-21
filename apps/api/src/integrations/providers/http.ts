/** How long one outbound provider request may take before it's abandoned. */
export const PROVIDER_REQUEST_TIMEOUT_MS = 15_000;

/**
 * fetch() with a hard timeout, so a slow or hung provider API can't leave a
 * sync (or the Save button waiting on one) spinning forever. A timeout surfaces
 * as a plain, readable Error naming the service.
 */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  service: string,
  timeoutMs = PROVIDER_REQUEST_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err: any) {
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
      throw new Error(`${service} did not respond within ${Math.round(timeoutMs / 1000)} seconds - try again later.`);
    }
    throw err;
  }
}
