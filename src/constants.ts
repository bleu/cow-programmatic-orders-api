/**
 * Application-level constants — tuning parameters with no chain dependency.
 * Chain-specific config (addresses, block times, poll intervals) lives in src/data.ts.
 */

/** Stop processing API orders older than this window (7 days). */
export const MAX_ORDER_LIFETIME_SECONDS = 7 * 24 * 60 * 60;

/**
 * How many seconds behind real-time a block can be before we treat it as historical backfill.
 * Used to skip API calls during historical sync (API only has current state, not historical).
 */
export const LIVE_LAG_THRESHOLD_SECONDS = 10 * 60; // 10 minutes

/**
 * The signingScheme value returned by the CoW Orderbook API for EIP-1271 signed orders.
 * Note: spelled "eip1271" in the API response — NOT "erc1271".
 */
export const SIGNING_SCHEME_EIP1271 = "eip1271";

/** Far-future expiry for terminal orders: effectively permanent (multiple years). */
export const TERMINAL_CACHE_EXPIRY_SECONDS = MAX_ORDER_LIFETIME_SECONDS * 365;
