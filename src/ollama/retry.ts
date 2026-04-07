export interface RetryOptions {
  /** Maximum number of attempts (including the first). Default: 3 */
  maxAttempts?: number;
  /** Base delay in ms before first retry. Doubles each attempt. Default: 1000 */
  baseDelayMs?: number;
  /** Maximum delay in ms (caps exponential backoff). Default: 30000 */
  maxDelayMs?: number;
  /** HTTP status codes that should trigger a retry. Default: [429, 500, 502, 503, 504] */
  retryableStatuses?: number[];
}

const DEFAULT_OPTIONS: Required<RetryOptions> = {
  maxAttempts: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30_000,
  retryableStatuses: [429, 500, 502, 503, 504],
};

/**
 * Wrap a fetch call with exponential backoff retry.
 * Only retries on network errors and retryable HTTP status codes.
 * Respects Retry-After headers from 429 responses.
 */
export async function fetchWithRetry(url: string, init: RequestInit, options?: RetryOptions): Promise<Response> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    try {
      const response = await fetch(url, init);

      if (response.ok || !opts.retryableStatuses.includes(response.status)) {
        return response;
      }

      // Retryable status — compute delay
      if (attempt < opts.maxAttempts) {
        const retryAfter = parseRetryAfter(response.headers.get('retry-after'));
        const backoff = Math.min(retryAfter ?? opts.baseDelayMs * Math.pow(2, attempt - 1), opts.maxDelayMs);
        await sleep(backoff, init.signal as AbortSignal | undefined);
        continue;
      }

      // Final attempt — return the response as-is (caller handles the error)
      return response;
    } catch (err) {
      // AbortError should not be retried
      if (err instanceof Error && err.name === 'AbortError') {
        throw err;
      }

      lastError = err instanceof Error ? err : new Error(String(err));

      if (attempt < opts.maxAttempts) {
        const backoff = Math.min(opts.baseDelayMs * Math.pow(2, attempt - 1), opts.maxDelayMs);
        await sleep(backoff, init.signal as AbortSignal | undefined);
        continue;
      }
    }
  }

  throw lastError ?? new Error('Fetch failed after retries');
}

/**
 * Parse a Retry-After header value into milliseconds.
 * Supports both delay-seconds and HTTP-date formats.
 */
function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;

  // Try as integer seconds
  const seconds = parseInt(value, 10);
  if (!isNaN(seconds) && seconds >= 0) {
    return seconds * 1000;
  }

  // Try as HTTP date
  const date = new Date(value);
  if (!isNaN(date.getTime())) {
    const delayMs = date.getTime() - Date.now();
    return Math.max(0, delayMs);
  }

  return null;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new DOMException('Aborted', 'AbortError'));
      },
      { once: true },
    );
  });
}
