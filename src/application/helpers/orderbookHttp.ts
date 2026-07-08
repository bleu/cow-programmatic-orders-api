/**
 * Orderbook HTTP layer — the CoW Orderbook API client, with no Ponder dependency.
 *
 * Deliberately free of `ponder` / `ponder:schema` imports so it can be imported by
 * both the Ponder handlers (via orderbookClient.ts) AND the standalone drain worker
 * (src/worker/drain.ts), which runs outside the Ponder runtime where the virtual
 * `ponder:*` modules don't resolve.
 *
 * Only raw HTTP lives here: fetch + bounded retry/backoff, account pagination, and
 * by_uids batching. Decoding, generator matching, and the durable cache live in
 * composableCache.ts (also ponder-free) and orderbookClient.ts (Ponder-side).
 */

import type { Hex } from "viem";
import {
  ORDERBOOK_HTTP_TIMEOUT_MS,
  ORDERBOOK_MAX_RETRIES,
  ORDERBOOK_RETRY_BASE_MS,
  ORDERBOOK_RETRY_BUDGET_MS,
  ORDERBOOK_RETRY_MAX_DELAY_MS,
} from "../../constants";
import { fetchWithTimeout, TimeoutError } from "./withTimeout";
import { log } from "./logger";

/** Raw API response shape (subset of fields we use). */
export interface OrderbookOrder {
  uid: string;
  status: "open" | "fulfilled" | "expired" | "cancelled" | "presignaturePending";
  kind: "sell" | "buy";
  receiver: string | null;
  sellAmount: string;
  buyAmount: string;
  feeAmount: string;
  validTo: number;
  creationDate: string; // ISO 8601
  signingScheme: string;
  signature: string;
  executedSellAmount: string;
  executedBuyAmount: string;
}

export const PAGE_LIMIT = 1000;
export const BATCH_SIZE = 50;

/**
 * The orderbook API refused to answer (HTTP 429 or 5xx) after bounded retries.
 * Distinct from "the API has no such order" (a UID simply absent from a 2xx
 * body) so callers / dashboards can alarm on an unavailable API rather than
 * silently treating it as "order not on API yet".
 */
export class OrderbookUnavailableError extends Error {
  constructor(
    public readonly status: number,
    public readonly endpoint: string,
  ) {
    super(`[COW:orderbook-unavailable] ${endpoint} responded ${status}`);
    this.name = "OrderbookUnavailableError";
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Parse an orderbook order's ISO creationDate into Unix seconds. */
export function orderCreationSeconds(order: OrderbookOrder): number {
  return Math.floor(new Date(order.creationDate).getTime() / 1000);
}

/** Parse a `Retry-After` header (delta-seconds or HTTP-date) into milliseconds; null if absent/unparseable. */
function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return null;
}

/**
 * `fetchWithTimeout` plus bounded retry/backoff for transient orderbook errors.
 *
 * Returns the Response on a 2xx. On 429 it honors `Retry-After` (capped at
 * ORDERBOOK_RETRY_MAX_DELAY_MS); on 5xx it uses exponential backoff. Retries
 * stop once ORDERBOOK_MAX_RETRIES is reached or the next sleep would push the
 * loop past ORDERBOOK_RETRY_BUDGET_MS — at which point it throws
 * OrderbookUnavailableError instead of holding the caller open indefinitely.
 * A TimeoutError from the underlying fetch propagates unchanged.
 */
export async function fetchOrderbook(
  url: string,
  init: RequestInit | undefined,
  endpoint: string,
): Promise<Response> {
  let spent = 0;
  for (let attempt = 0; ; attempt++) {
    const response = await fetchWithTimeout(url, init, ORDERBOOK_HTTP_TIMEOUT_MS, endpoint);
    if (response.ok) return response;

    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable || attempt >= ORDERBOOK_MAX_RETRIES) {
      throw new OrderbookUnavailableError(response.status, endpoint);
    }

    const retryAfterMs =
      response.status === 429 ? parseRetryAfter(response.headers.get("retry-after")) : null;
    const backoffMs = ORDERBOOK_RETRY_BASE_MS * 2 ** attempt;
    const delay = Math.min(retryAfterMs ?? backoffMs, ORDERBOOK_RETRY_MAX_DELAY_MS);

    // Fail fast rather than hold the caller open past our budget.
    if (spent + delay > ORDERBOOK_RETRY_BUDGET_MS) {
      throw new OrderbookUnavailableError(response.status, endpoint);
    }

    log("warn", "ob:retry", { endpoint, status: response.status, attempt: attempt + 1, delayMs: delay, retryAfterMs });
    await sleep(delay);
    spent += delay;
  }
}

/**
 * Fetch a single page of an owner's account orders at a given offset (newest-first).
 *
 * Used by the drain worker's offset-walk: it advances `offset` by the raw page length
 * and stops on a short page, so each call must surface the untrimmed page. Throws
 * OrderbookUnavailableError / TimeoutError so the worker can leave the owner for retry
 * (its next_offset is already durably committed, so re-fetches are harmless).
 */
export async function fetchAccountOrderPage(
  apiBaseUrl: string,
  owner: Hex,
  offset: number,
  pageSize = PAGE_LIMIT,
  signingScheme?: string,
): Promise<OrderbookOrder[]> {
  const params = new URLSearchParams({ limit: String(pageSize), offset: String(offset) });
  if (signingScheme) params.set("signingScheme", signingScheme);
  const url = `${apiBaseUrl}/api/v1/account/${owner}/orders?${params.toString()}`;
  const response = await fetchOrderbook(url, undefined, "ob:account");
  return (await response.json()) as OrderbookOrder[];
}

/** Fetch orders for an owner with pagination. maxPages limits how many pages are fetched (0 = unlimited).
 *  signingScheme, if provided, is appended as a query param — the API filters server-side when supported,
 *  reducing payload for owners with many ECDSA orders mixed with composable ones.
 *  pageSize overrides the default PAGE_LIMIT per request.
 *
 *  sinceCreationDate (Unix seconds), if provided, enables an incremental drain: the
 *  API returns orders newest-first (creationDate DESC), so once a page contains an
 *  order strictly older than the cursor, everything beyond it is already known and
 *  pagination stops. Orders at or after the cursor are kept (the boundary is
 *  re-included so ties at exactly the cursor second are never dropped). */
export async function fetchAccountOrders(
  apiBaseUrl: string,
  owner: Hex,
  maxPages = 0,
  signingScheme?: string,
  pageSize = PAGE_LIMIT,
  sinceCreationDate?: number,
): Promise<{ orders: OrderbookOrder[]; complete: boolean }> {
  const allOrders: OrderbookOrder[] = [];
  let offset = 0;
  let pagesFetched = 0;
  // complete=false means pagination was cut short by an error (rate limit / timeout /
  // network) — the caller must NOT treat the result as the owner's full history.
  let complete = false;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const page = await fetchAccountOrderPage(apiBaseUrl, owner, offset, pageSize, signingScheme);

      if (sinceCreationDate !== undefined) {
        // DESC order → orders at/after the cursor form a prefix of the page.
        const fresh = page.filter((o) => orderCreationSeconds(o) >= sinceCreationDate);
        allOrders.push(...fresh);
        if (fresh.length < page.length) { complete = true; break; } // crossed the cursor — older orders already cached
      } else {
        allOrders.push(...page);
      }

      pagesFetched++;
      if (page.length < pageSize) { complete = true; break; } // last page
      if (maxPages > 0 && pagesFetched >= maxPages) { complete = true; break; } // page cap reached
      offset += page.length;
    } catch (err) {
      if (err instanceof OrderbookUnavailableError) {
        log("error", "ob:unavailable", { endpoint: "ob:account", status: err.status, owner });
        break;
      }
      if (err instanceof TimeoutError) {
        log("warn", "ob:accountTimeout", { owner, offset, after: ORDERBOOK_HTTP_TIMEOUT_MS });
        break;
      }
      log("warn", "ob:accountFetchFailed", { owner, err: String(err) });
      break;
    }
  }

  return { orders: allOrders, complete };
}

/** Batch-fetch orders by UID to refresh status of open orders.
 *  Chunks into BATCH_SIZE to avoid HTTP 413, then fires all chunks in parallel
 *  so N chunks take the time of one instead of N × one. */
export async function fetchOrdersByUids(
  apiBaseUrl: string,
  uids: string[],
): Promise<OrderbookOrder[]> {
  if (uids.length === 0) return [];

  const url = `${apiBaseUrl}/api/v1/orders/by_uids`;
  const chunks: string[][] = [];
  for (let i = 0; i < uids.length; i += BATCH_SIZE) {
    chunks.push(uids.slice(i, i + BATCH_SIZE));
  }

  const chunkResults = await Promise.all(
    chunks.map(async (chunk, idx) => {
      try {
        const response = await fetchOrderbook(
          url,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(chunk),
          },
          "ob:byUids",
        );
        const raw = (await response.json()) as { order: OrderbookOrder }[];
        return raw.flatMap((item) => (item?.order != null ? [item.order] : []));
      } catch (err) {
        if (err instanceof OrderbookUnavailableError) {
          log("error", "ob:unavailable", { endpoint: "ob:byUids", status: err.status, uids: chunk.length, offset: idx * BATCH_SIZE });
          return [] as OrderbookOrder[];
        }
        if (err instanceof TimeoutError) {
          log("warn", "ob:batchFetchTimeout", { uids: chunk.length, offset: idx * BATCH_SIZE, after: ORDERBOOK_HTTP_TIMEOUT_MS });
          return [] as OrderbookOrder[];
        }
        log("warn", "ob:batchFetchFailed", { err: String(err), offset: idx * BATCH_SIZE });
        return [] as OrderbookOrder[];
      }
    }),
  );

  return chunkResults.flat();
}
