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

/**
 * COW-907: Progressive backoff for generators stuck returning PollResult.tryNextBlock.
 *
 * Every tryNextBlock response increments a counter on the generator; any other
 * response resets it to zero. The counter selects the next-check block offset:
 *   count <= WARMUP_THRESHOLD   → +1 block  (default, healthy behavior)
 *   count <= COOLDOWN_THRESHOLD → +10 blocks
 *   count >  COOLDOWN_THRESHOLD → +50 blocks
 *
 * Block counts (not seconds) intentionally — simpler, and the ceiling is
 * acceptable on both gnosis (~5s/block → 250s) and mainnet (~12s/block → 600s).
 */
export const TRY_NEXT_BLOCK_WARMUP_THRESHOLD = 50;
export const TRY_NEXT_BLOCK_COOLDOWN_THRESHOLD = 200;
export const TRY_NEXT_BLOCK_BACKOFF_WARMUP = 1n;
export const TRY_NEXT_BLOCK_BACKOFF_MID = 10n;
export const TRY_NEXT_BLOCK_BACKOFF_COLD = 50n;
