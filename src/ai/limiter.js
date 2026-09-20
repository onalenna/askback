/**
 * Concurrency limiter + retry for AI provider calls.
 *
 * Two problems this solves when many people ask at once:
 *  1. Bursts of simultaneous questions would fire dozens of model calls in
 *     parallel and hit provider rate limits (HTTP 429 / throttling).
 *  2. A transient 429 or 5xx used to fail the whole answer.
 *
 * runLimited() caps how many calls run at the same time (extras queue), and
 * withRetry() retries throttling/temporary errors with exponential backoff.
 * Tune AI_MAX_CONCURRENCY and AI_MAX_RETRIES via env.
 */

const MAX_CONCURRENCY = Math.max(1, parseInt(process.env.AI_MAX_CONCURRENCY || '4', 10));
const MAX_RETRIES = Math.max(0, parseInt(process.env.AI_MAX_RETRIES || '4', 10));
const BASE_DELAY_MS = Math.max(100, parseInt(process.env.AI_RETRY_BASE_MS || '500', 10));

let active = 0;
const queue = [];

function drain() {
  if (active >= MAX_CONCURRENCY) return;
  const next = queue.shift();
  if (!next) return;
  active += 1;
  Promise.resolve()
    .then(next.fn)
    .then(next.resolve, next.reject)
    .finally(() => {
      active -= 1;
      drain();
    });
}

/** Run fn() but never let more than MAX_CONCURRENCY run at once. */
function runLimited(fn) {
  return new Promise((resolve, reject) => {
    queue.push({ fn, resolve, reject });
    drain();
  });
}

/** True for errors worth retrying: rate limits and transient server errors. */
function isRetryable(err) {
  const status = err?.status || err?.statusCode || err?.$metadata?.httpStatusCode;
  if (status === 429) return true;
  if (status >= 500 && status < 600) return true;
  const name = String(err?.name || '');
  if (/Throttling|TooManyRequests|ServiceUnavailable|Timeout/i.test(name)) return true;
  return false;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Retry fn() on throttling/transient errors with exponential backoff + jitter. */
async function withRetry(fn) {
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= MAX_RETRIES || !isRetryable(err)) throw err;
      const delay = BASE_DELAY_MS * 2 ** attempt + Math.floor(Math.random() * 200);
      console.warn(
        `[ai] retryable error (${err?.status || err?.name || 'unknown'}), retry ${attempt + 1}/${MAX_RETRIES} in ${delay}ms`
      );
      await sleep(delay);
      attempt += 1;
    }
  }
}

/** Convenience: queue + retry together, the wrapper used by AI call sites. */
function runAi(fn) {
  return runLimited(() => withRetry(fn));
}

module.exports = { runLimited, withRetry, runAi, MAX_CONCURRENCY, MAX_RETRIES };
