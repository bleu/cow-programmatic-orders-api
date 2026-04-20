/**
 * Application-level constants — tuning parameters with no chain dependency.
 * Chain-specific config (addresses, block times, poll intervals) lives in src/data.ts.
 */

import { ORDERBOOK_POLL_INTERVAL } from "./data";

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
