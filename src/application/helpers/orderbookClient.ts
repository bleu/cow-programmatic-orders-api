/**
 * Orderbook client — fetches and caches composable orders from the CoW Orderbook API.
 *
 * Cache strategy (per-UID):
 * - Uses cow_cache.order_uid_cache to store per-UID terminal statuses
 * - Terminal orders (fulfilled/expired/cancelled) are cached, but only trusted
 *   permanently once provably beyond the chain's reorg window (COW-1183) —
 *   see ./orderbook/trust.ts. Until then the row is "soft": served, but
 *   re-fetched on every read so a reorged-out settlement heals on the next
 *   poll. Rows written by an older CACHE_VERSION also re-fetch lazily, which
 *   is how new columns (e.g. executed_fee) heal on historical rows.
 * - Open/non-cached orders are refreshed via POST /api/v1/orders/by_uids
 * - Cache is invalidated per-owner when ConditionalOrderCreated fires
 *
 * KNOWN LIMITATION — Off-chain cancellation gap:
 *   Orders cancelled via the CoW Orderbook API's DELETE endpoint (off-chain
 *   soft cancel) are NOT detected once the cached status has hardened past
 *   the reorg window (soft-window cancels are caught by the re-polling).
 *   This is rare for EIP-1271 composable orders, which follow the on-chain
 *   cancellation path via ComposableCoW.remove(), and cannot produce wrong
 *   executed amounts — only a stale fulfilled/expired vs cancelled label.
 *
 * This module is a thin barrel: the implementation lives in ./orderbook/*
 * (types, http, cache, processing, client, trust). It re-exports the public
 * API so existing import paths keep working.
 */

export {
  drainOwnerSlice,
  upsertDiscreteOrders,
  fetchOrderStatusByUids,
  fetchOwnerOrderStatuses,
  fetchFlashLoanEnrichmentByUids,
  type OwnerDrainResult,
} from "./orderbook/client";
export { OrderbookUnavailableError, fetchAccountOrders } from "./orderbook/http";
export type {
  ComposableOrder,
  OrderStatusInfo,
  FlashLoanEnrichment,
} from "./orderbook/types";
