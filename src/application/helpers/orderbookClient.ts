/**
 * Orderbook client — fetches and caches composable orders from the CoW Orderbook API.
 *
 * Cache strategy (per-UID):
 * - Uses cow_cache.order_uid_cache to store per-UID terminal statuses
 * - Terminal orders (fulfilled/expired/cancelled) are cached and never re-fetched
 * - Open/non-cached orders are refreshed via POST /api/v1/orders/by_uids
 * - Cache is invalidated per-owner when ConditionalOrderCreated fires
 *
 * KNOWN LIMITATION — Off-chain cancellation gap:
 *   Orders cancelled via the CoW Orderbook API's DELETE endpoint (off-chain
 *   soft cancel) are NOT detected after they've been cached as terminal.
 *   This is rare for EIP-1271 composable orders, which follow the on-chain
 *   cancellation path via ComposableCoW.remove().
 *
 * KNOWN LIMITATION — Settlement reorg gap:
 *   Terminal statuses live in cow_cache outside Ponder's reorg journal and are
 *   never re-fetched. Parent execution totals remain consistent with
 *   discreteOrder, but both can retain a settlement that reorged out until
 *   terminal-status caching gains a finality-aware policy.
 *
 * This module is a thin barrel: the implementation lives in ./orderbook/*
 * (types, http, cache, processing, client). It re-exports the public API so
 * existing import paths keep working.
 */

export {
  fetchComposableOrders,
  upsertDiscreteOrders,
  fetchOrderStatusByUids,
  fetchOwnerOrderStatuses,
  fetchFlashLoanEnrichmentByUids,
} from "./orderbook/client";
export { OrderbookUnavailableError, fetchAccountOrders } from "./orderbook/http";
export type {
  ComposableOrder,
  OrderStatusInfo,
  FlashLoanEnrichment,
} from "./orderbook/types";
