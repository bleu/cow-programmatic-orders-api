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
 * COW-908: Hard per-block ceiling on how many generators the C1 ContractPoller
 * will multicall in a single block. Generators exceeding the cap defer to the
 * next block (prioritized by oldest lastCheckBlock first).
 *
 * Override per chain with env var MAX_GENERATORS_PER_BLOCK_<chainId>, e.g.
 * MAX_GENERATORS_PER_BLOCK_1=200, MAX_GENERATORS_PER_BLOCK_100=400.
 */
export const DEFAULT_MAX_GENERATORS_PER_BLOCK = 200;

/**
 * Progressive backoff for generators stuck returning PollResult.tryNextBlock.
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

/**
 * C5 (DeterministicCancellationSweeper) re-check cadence, in blocks.
 *
 * For deterministic generators (`allCandidatesKnown = true`), `remove()` detection
 * is via a `ComposableCoW.singleOrders(owner, hash)` storage read. `remove()` is
 * rare; a ~100 block cadence gives a worst-case detection lag of ~20 min on
 * mainnet and ~8 min on Gnosis while keeping the RPC cost well below C1's
 * every-block poll.
 */
export const DETERMINISTIC_CANCEL_SWEEP_INTERVAL = 100n;

/**
 * Hard wall-clock cap for a single orderbook HTTP request (per page or per
 * batched `by_uids` chunk). Keeps block-handler transactions short so a slow
 * api.cow.fi response cannot drive the indexer into Ponder's retry/shutdown
 * path. See `src/application/helpers/withTimeout.ts`.
 */
export const ORDERBOOK_HTTP_TIMEOUT_MS = 10_000;

/**
 * Hard wall-clock cap for a block handler's aggregate `context.client.multicall`
 * call (C1, C5). viem has no per-call signal; the timer races the promise and
 * the handler returns cleanly on breach.
 */
export const BLOCK_HANDLER_RPC_TIMEOUT_MS = 15_000;

/**
 * Hard wall-clock cap for the whole per-owner bootstrap fetch in C4
 * (account pagination + by_uids refresh). Owners that exceed this are skipped;
 * the normal C1 / C2 path picks them up on subsequent blocks.
 */
export const BOOTSTRAP_OWNER_FETCH_TIMEOUT_MS = 30_000;
