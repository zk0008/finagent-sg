/**
 * lib/rateLimit.ts
 *
 * In-memory sliding-window rate limiter.
 * Deliberately simple — in-memory works on Vercel serverless (resets on cold
 * start, which is acceptable for auth endpoints). No external dependency.
 *
 * Usage:
 *   const { success } = rateLimit(`login:${email}`, 5, 15 * 60 * 1000);
 *   if (!success) return 429;
 */

type Entry = { count: number; resetAt: number };

const store = new Map<string, Entry>();
let callCount = 0;

function cleanup(): void {
  const now = Date.now();
  for (const [key, entry] of store) {
    if (entry.resetAt <= now) store.delete(key);
  }
}

/**
 * @param key       Unique string identifying the caller (e.g. `login:${email}`)
 * @param limit     Maximum allowed calls within the window
 * @param windowMs  Window duration in milliseconds
 */
export function rateLimit(
  key: string,
  limit: number,
  windowMs: number,
): { success: boolean; remaining: number } {
  // Sweep expired entries every 100 calls to prevent unbounded memory growth
  callCount++;
  if (callCount % 100 === 0) cleanup();

  const now = Date.now();
  const entry = store.get(key);

  if (!entry || entry.resetAt <= now) {
    // First call in this window (or window has expired — start fresh)
    store.set(key, { count: 1, resetAt: now + windowMs });
    return { success: true, remaining: limit - 1 };
  }

  entry.count++;

  if (entry.count > limit) {
    return { success: false, remaining: 0 };
  }

  return { success: true, remaining: limit - entry.count };
}
