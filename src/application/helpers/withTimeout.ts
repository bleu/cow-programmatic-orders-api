/**
 * Bound external I/O inside Ponder block handlers.
 *
 * Ponder 0.16 wraps every indexed block in a single DB transaction
 * (node_modules/.../ponder/src/runtime/multichain.ts:363,639). A handler that
 * `await`s an external HTTP / RPC call holds that transaction open across the
 * network round-trip; on a slow peer, Postgres terminates the connection and
 * Ponder retries the full block up to 9× before shutting the process down.
 *
 * Wrap every external call with `withTimeout` (or use `fetchWithTimeout` for
 * HTTP). On `TimeoutError`, log + return from the handler without writes — the
 * handler is idempotent, so the next block retries naturally.
 */

export class TimeoutError extends Error {
  constructor(
    public readonly label: string,
    public readonly timeoutMs: number,
  ) {
    super(`[COW:timeout] ${label} exceeded ${timeoutMs}ms`);
    this.name = "TimeoutError";
  }
}

/**
 * Race `promise` against a `timeoutMs` timer. If the timer wins, reject with a
 * `TimeoutError`. Clears the timer on either resolution.
 *
 * Note: this does NOT cancel the underlying work — for `fetch` use
 * `fetchWithTimeout` below, which threads an `AbortSignal` to close the socket.
 * For viem `multicall` there is no `signal` option; the HTTP request may still
 * resolve in the background and its result will be dropped.
 */
export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new TimeoutError(label, timeoutMs)),
      timeoutMs,
    );
  });
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    timeout,
  ]);
}

/**
 * `fetch` with a hard wall-clock timeout that cancels the underlying socket via
 * `AbortSignal.timeout`. Re-maps the `AbortError` / `TimeoutError` DOMException
 * into our own `TimeoutError` so callers can `instanceof`-check once.
 */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit | undefined,
  timeoutMs: number,
  label: string,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const name = (err as Error | undefined)?.name;
    if (name === "TimeoutError" || name === "AbortError") {
      throw new TimeoutError(label, timeoutMs);
    }
    throw err;
  }
}
