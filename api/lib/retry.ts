// api/lib/retry.ts
// ─────────────────────────────────────────────────────────────
// Retry-with-backoff helper for transient Walmart / network failures.
//
// Retries ONLY on transient errors:
//   • HTTP 5xx  (includes Cloudflare 520/521/522 — anything >= 500)
//   • network-level fetch failures ("fetch failed", ECONNRESET, …)
//
// Backoff schedule defaults to 2s / 4s / 8s → 4 total attempts.
// Non-transient errors (4xx, programmer errors) throw immediately.
// ─────────────────────────────────────────────────────────────

/** Default delays between attempts → initial try + 3 retries = 4 attempts. */
export const DEFAULT_BACKOFF_MS = [2_000, 4_000, 8_000];

/**
 * Error carrying an HTTP status so the retry predicate can classify it.
 * Throw this from fetch wrappers when `res.ok` is false.
 */
export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

/** True when the failure is worth retrying (5xx / 520 / network). */
export function isTransientError(err: unknown): boolean {
  if (err instanceof HttpError) {
    return err.status >= 500; // 5xx + Cloudflare 520/521/522/…
  }
  // Undici surfaces network failures as `TypeError: fetch failed`; cover the
  // common low-level socket errors too.
  const msg = err instanceof Error ? err.message : String(err);
  return /fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up|network|aborted/i.test(
    msg,
  );
}

export interface RetryOptions {
  /** Label used in log lines. */
  label?: string;
  /** Delays (ms) between attempts; length + 1 = max attempts. */
  delaysMs?: number[];
}

/**
 * Run `fn`, retrying transient failures with fixed backoff.
 * Re-throws the last error once attempts are exhausted or the error is
 * non-transient — so callers send their failure alert exactly once.
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const delays = opts.delaysMs ?? DEFAULT_BACKOFF_MS;
  const label = opts.label ?? 'operation';
  let lastErr: unknown;

  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const hasMoreAttempts = attempt < delays.length;
      if (!isTransientError(err) || !hasMoreAttempts) throw err;
      const delay = delays[attempt];
      const reason = err instanceof Error ? err.message : String(err);
      console.warn(
        `[retry] ${label} attempt ${attempt + 1} failed (${reason}); retrying in ${delay}ms`,
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  throw lastErr;
}
