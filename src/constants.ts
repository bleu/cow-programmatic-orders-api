/**
 * Application-level constants — tuning parameters with no chain dependency.
 * Chain-specific config (addresses, block times, poll intervals) lives in src/data.ts.
 */

/**
 * Fallback orderbook recheck cadence, in blocks. After a successful
 * getTradeableOrderWithSignature call, schedule the next check this many blocks
 * later when the chain has no entry in RECHECK_INTERVAL_BLOCKS_BY_CHAIN_ID
 * (src/data.ts). Mirrors the former global default of 20 blocks; the per-chain
 * cadence is derived from ChainConfig.orderbookPollInterval (seconds) — F17.
 */
export const DEFAULT_RECHECK_INTERVAL_BLOCKS = 20n;

/**
 * The signingScheme value returned by the CoW Orderbook API for EIP-1271 signed orders.
 * Note: spelled "eip1271" in the API response — NOT "erc1271".
 */
export const SIGNING_SCHEME_EIP1271 = "eip1271";

/**
 * Hard per-block ceiling on how many generators the OrderDiscoveryPoller
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
 *   count <= WARMUP_THRESHOLD   -> +1 block  (default, healthy behavior)
 *   count <= COOLDOWN_THRESHOLD -> +10 blocks
 *   count >  COOLDOWN_THRESHOLD -> +50 blocks
 *
 * Block counts (not seconds) intentionally — simpler, and the ceiling is
 * acceptable on both gnosis (~5s/block -> 250s) and mainnet (~12s/block -> 600s).
 */
export const TRY_NEXT_BLOCK_WARMUP_THRESHOLD = 50;
export const TRY_NEXT_BLOCK_COOLDOWN_THRESHOLD = 200;
export const TRY_NEXT_BLOCK_BACKOFF_WARMUP = 1n;
export const TRY_NEXT_BLOCK_BACKOFF_MID = 10n;
export const TRY_NEXT_BLOCK_BACKOFF_COLD = 50n;

/**
 * CancellationWatcher re-check cadence, in blocks.
 *
 * For deterministic generators (`allCandidatesKnown = true`), `remove()` detection
 * is via a `ComposableCoW.singleOrders(owner, hash)` storage read. `remove()` is
 * rare; a ~100 block cadence gives a worst-case detection lag of ~20 min on
 * mainnet and ~8 min on Gnosis while keeping the RPC cost well below
 * OrderDiscoveryPoller's every-block poll.
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
 * Bounded retry for transient orderbook failures (HTTP 429 / 5xx).
 *
 * These calls run inside Ponder block handlers that hold a DB transaction open,
 * so the retry loop must stay short — we cannot honor a large `Retry-After` by
 * sleeping (Postgres would terminate the connection). The loop adds at most
 * ORDERBOOK_RETRY_BUDGET_MS of wall-clock; if a `Retry-After` (or backoff) would
 * exceed the budget, we fail fast and let the next poll (the per-chain recheck
 * cadence, ~20 blocks, later) retry naturally — but the failure is logged as a rate-limit/
 * server error, not as "order not on API yet".
 */
export const ORDERBOOK_MAX_RETRIES = 2; // ≤ 3 attempts total
export const ORDERBOOK_RETRY_BASE_MS = 250; // exponential backoff base
export const ORDERBOOK_RETRY_MAX_DELAY_MS = 2_000; // cap on a single sleep (incl. Retry-After)
export const ORDERBOOK_RETRY_BUDGET_MS = 4_000; // total wall-clock the retry loop may add

/**
 * Hard wall-clock cap for a block handler's aggregate `context.client.multicall`
 * call (OrderDiscoveryPoller, CancellationWatcher). viem has no per-call signal; the timer races the promise and
 * the handler returns cleanly on breach.
 */
export const BLOCK_HANDLER_RPC_TIMEOUT_MS = 15_000;

// Tighter cap for cheap inner-loop calls (getCode, eth_call) in the settlement handler.
// The outer receipt fetch and readContract(owner()) keep the full 15 s.
export const SETTLEMENT_INNER_RPC_TIMEOUT_MS = 5_000;

/**
 * Hard wall-clock cap for the whole per-owner bootstrap fetch in OwnerBackfill
 * (account pagination + by_uids refresh). Owners that exceed this are skipped;
 * the normal OrderDiscoveryPoller / CandidateConfirmer path picks them up on subsequent blocks.
 */
export const BOOTSTRAP_OWNER_FETCH_TIMEOUT_MS = 30_000;

/**
 * Maximum number of times OwnerBackfill will retry a timed-out owner across
 * indexer restarts. After this many consecutive failures the owner is removed
 * from bootstrap_retry_queue and left to the normal OrderDiscoveryPoller/CandidateConfirmer discovery path.
 */
export const BOOTSTRAP_MAX_RETRY_COUNT = 5;

/**
 * Maximum number of TWAP parts that precomputeOrderUids will attempt to enumerate.
 * Pathological orders with n > this value skip precompute and fall back to the
 * OrderDiscoveryPoller discovery path (allCandidatesKnown=false). Logged as
 * `precompute:skip` with reason=too_many_parts when triggered.
 */
export const MAX_TWAP_PRECOMPUTE_PARTS = 100_000;

/**
 * Hard per-block ceiling on how many open discrete orders OrderStatusTracker
 * will check in a single block. Caps the /by_uids batch size and keeps block
 * handler transactions short.
 *
 * Override per chain with env var MAX_DISCRETE_ORDERS_PER_BLOCK_<chainId>, e.g.
 * MAX_DISCRETE_ORDERS_PER_BLOCK_1=200, MAX_DISCRETE_ORDERS_PER_BLOCK_100=500.
 */
export const DEFAULT_MAX_DISCRETE_ORDERS_PER_BLOCK = 200;

/**
 * Per-block cap on how many pending flash-loan orders FlashLoanOrderEnricher
 * enriches from the orderbook per chain. Override per chain with env var
 * MAX_FLASH_LOAN_ORDERS_PER_BLOCK_<chainId>.
 */
export const DEFAULT_MAX_FLASH_LOAN_ORDERS_PER_BLOCK = 200;

/**
 * Max orderbook-enrichment attempts before a flash-loan order is treated as
 * permanently un-enrichable (never indexed by the orderbook / aged out) and is
 * no longer polled. Keeps the enricher from hammering the API forever.
 */
export const MAX_FLASH_LOAN_ENRICHMENT_ATTEMPTS = 10;

/**
 * Slice size for the one-shot FlashLoanOrderBackfiller drain. The historical
 * backlog is processed in sequential slices of this many UIDs to bound orderbook
 * concurrency (each slice fans out to ceil(size / 50) parallel by_uids requests).
 */
export const FLASH_LOAN_BACKFILL_SLICE_SIZE = 500;
