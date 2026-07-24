/**
 * Trust classification for cached terminal order statuses (COW-1183).
 *
 * The cow_cache tables live outside Ponder's reorg journal, so a terminal
 * status cached right after a settlement can silently outlive a reorg. Reorg
 * detection can't close this: block handlers start at "latest" and spend
 * minutes to hours catching up after every deploy, during which the orderbook
 * API answers from the real tip while our cursor is behind — reorgs up there
 * resolve before we ever process those heights.
 *
 * Instead, a terminal row is only trusted permanently once it is provably
 * beyond the chain's reorg window W (per-chain, see reorgSafetyWindowSeconds):
 *
 *  - Fast path: validTo passed more than W ago. GPv2 rejects fills after
 *    validTo, so validTo is an upper bound on execution time — old orders
 *    (the whole owner-backfill flood) are final with zero re-fetching.
 *  - Cooling-off: otherwise the row is "soft" until a fetch made more than W
 *    after terminal_since re-confirmed the status. Wall clock is immune to
 *    indexer lag: the API can only report a fill after it happened in real
 *    time, so "still terminal W after first seen" proves the settlement
 *    survived W of real time.
 *
 * Soft rows are served but keep being re-fetched by the callers' existing
 * batched miss paths; a reorged-out status heals on the next poll.
 */

import { CACHE_VERSION } from "../../../constants";
import { TERMINAL_STATUSES } from "./types";

export type CacheTrust = "trusted" | "soft" | "not-terminal";

export interface TrustInputs {
  status: string;
  validTo: number | null;
  /** Wall-clock seconds when this terminal status was first observed. */
  terminalSince: number | null;
  /** Wall-clock seconds of the fetch that last wrote this row. */
  fetchedAt: number | null;
  cacheVersion: number | null;
}

/**
 * Classify a cached row: "trusted" rows are final and served as-is forever;
 * "soft" rows are served but must be re-fetched (treated as misses with the
 * cached data kept as fallback); "not-terminal" rows are plain misses.
 */
export function classifyCachedRow(
  row: TrustInputs,
  nowSeconds: number,
  windowSeconds: number,
): CacheTrust {
  if (!TERMINAL_STATUSES.has(row.status)) return "not-terminal";

  // Stale-version rows must heal (re-fetch once) before any finality shortcut.
  if (row.cacheVersion !== CACHE_VERSION) return "soft";

  if (row.validTo != null && row.validTo < nowSeconds - windowSeconds) {
    return "trusted";
  }

  if (
    row.terminalSince != null &&
    row.fetchedAt != null &&
    row.fetchedAt - row.terminalSince > windowSeconds
  ) {
    return "trusted";
  }

  return "soft";
}
