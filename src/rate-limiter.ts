/**
 * rate-limiter.ts — Simple in-memory sliding-window rate limiter.
 *
 * Uses a per-IP counter with periodic cleanup of expired entries.
 * Suitable for Cloudflare Workers: each isolate has its own counter,
 * so this is a deterrent, not a hard global limit. For tighter control
 * pair with Cloudflare's Rate Limiting rule in the dashboard.
 *
 * The window is a sliding window: a request at T is counted if it fell
 * within [T - windowMs, T]. Old entries are lazily cleaned on each check
 * (full scan every CLEAN_INTERVAL checks to keep hot-path fast).
 */

interface RateLimitEntry {
  /** Timestamps of requests within the current window (ms since epoch) */
  timestamps: number[];
}

const DEFAULT_WINDOW_MS = 60_000;   // 60 seconds
const DEFAULT_MAX_REQUESTS = 20;    // 20 requests per window
const CLEAN_INTERVAL = 10;          // Full cleanup every Nth check

const store = new Map<string, RateLimitEntry>();
let checkCount = 0;

/**
 * Checks whether a request from `ip` should be allowed.
 *
 * @param ip — Client IP address (use CF-Connecting-IP in Workers)
 * @param maxRequests — Max requests in the window (default 20)
 * @param windowMs — Sliding window duration in ms (default 60s)
 * @returns true if the request is within limits, false if rate-limited
 */
export function checkRateLimit(
  ip: string,
  maxRequests: number = DEFAULT_MAX_REQUESTS,
  windowMs: number = DEFAULT_WINDOW_MS,
): boolean {
  const now = Date.now();
  const cutoff = now - windowMs;

  let entry = store.get(ip);

  if (!entry) {
    // First request from this IP
    entry = { timestamps: [now] };
    store.set(ip, entry);
    return true;
  }

  // Prune timestamps outside the window
  entry.timestamps = entry.timestamps.filter((t) => t > cutoff);

  // Periodic full cleanup of stale IPs (lazy maintenance)
  checkCount++;
  if (checkCount % CLEAN_INTERVAL === 0) {
    for (const [key, e] of store) {
      e.timestamps = e.timestamps.filter((t) => t > cutoff);
      if (e.timestamps.length === 0) {
        store.delete(key);
      }
    }
  }

  // Check limit
  if (entry.timestamps.length >= maxRequests) {
    return false;
  }

  // Record this request
  entry.timestamps.push(now);
  return true;
}

/**
 * Extracts the client IP from a Workers Request object.
 * Uses CF-Connecting-IP when behind Cloudflare, falls back to
 * x-forwarded-for or the request's remote address.
 */
export function getClientIp(request: Request): string {
  return (
    request.headers.get('CF-Connecting-IP') ??
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    'unknown'
  );
}

/**
 * Resets the rate limiter state. Used in tests.
 */
export function resetRateLimiter(): void {
  store.clear();
  checkCount = 0;
}
