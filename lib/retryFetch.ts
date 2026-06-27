/**
 * lib/retryFetch.ts
 *
 * Thin wrapper around fetch with retry logic for transient failures.
 * Used by LangGraph worker nodes to handle network glitches and server-side
 * rate limits / temporary errors from the internal wrapper routes.
 */

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503]);

/**
 * Wraps fetch with configurable retry logic.
 * - maxRetries defaults to 2 (3 total attempts)
 * - baseDelayMs defaults to 1000; delay scales as baseDelayMs * attempt
 * - Retries on network errors and HTTP 429/500/502/503
 * - Returns immediately on any other status (success or non-retryable error)
 * - On exhaustion: returns the last Response for HTTP errors, throws for network errors
 */
export async function retryFetch(
  url: string,
  options: RequestInit,
  config?: { maxRetries?: number; baseDelayMs?: number },
): Promise<Response> {
  const maxRetries  = config?.maxRetries  ?? 2;
  const baseDelayMs = config?.baseDelayMs ?? 1000;

  let lastResponse: Response | undefined;
  let lastError:    Error    | undefined;

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    try {
      const response = await fetch(url, options);

      if (!RETRYABLE_STATUSES.has(response.status)) {
        return response;
      }

      lastResponse = response;
    } catch (err) {
      lastError = err as Error;
    }

    if (attempt <= maxRetries) {
      const delay = baseDelayMs * attempt;
      console.warn(`[retryFetch] Attempt ${attempt} failed for ${url}, retrying in ${delay}ms...`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  if (lastError) throw lastError;
  return lastResponse!;
}
