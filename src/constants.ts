/**
 * Application-level constants — tuning parameters with no chain dependency.
 * Chain-specific config (addresses, block times, poll intervals) lives in src/data.ts.
 */

import { ORDERBOOK_POLL_INTERVAL, BLOCK_TIME_SECONDS } from "./data";

/** Stop processing API orders older than this window (7 days). */
export const MAX_ORDER_LIFETIME_SECONDS = 7 * 24 * 60 * 60;

/**
 * How many seconds behind real-time a block can be before we treat it as historical backfill.
 * Set to 3× the max poll interval so a slightly-behind live indexer is not treated as backfill.
 * Used by block handlers to skip expensive RPC/API calls on historical blocks.
 */
export const LIVE_LAG_THRESHOLD_SECONDS =
  ORDERBOOK_POLL_INTERVAL * Math.max(...Object.values(BLOCK_TIME_SECONDS)) * 3;

/**
 * After a successful getTradeableOrderWithSignature call, schedule the next check
 * this many blocks later. Mirrors ORDERBOOK_POLL_INTERVAL as a bigint for use in
 * block handler arithmetic.
 */
export const RECHECK_INTERVAL = BigInt(ORDERBOOK_POLL_INTERVAL);

/**
 * The signingScheme value returned by the CoW Orderbook API for EIP-1271 signed orders.
 * Note: spelled "eip1271" in the API response — NOT "erc1271".
 */
export const SIGNING_SCHEME_EIP1271 = "eip1271";
