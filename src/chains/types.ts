import { SupportedChainId } from "@cowprotocol/cow-sdk";

/**
 * ChainConfig — everything needed to configure one chain in ponder.config.ts
 * and derive runtime constants (block time, RPC URL, API URL, etc.).
 *
 * Add a new chain by:
 *   1. Creating src/chains/<name>.ts implementing this interface.
 *   2. Registering it under its SupportedChainId key in CHAIN_CONFIGS
 *      (src/chains/index.ts) — a full ChainConfig, or `null` to skip.
 *   3. Adding it to ACTIVE_CHAINS to actually index it.
 */

/**
 * One flash-loan provider's on-chain infrastructure on a given chain.
 *  - `router`: the provider's FlashLoanRouter — settles flash-loan orders; used
 *    to filter GPv2Settlement:Settlement events by solver.
 *  - `adapterFactory`: the provider's adapter factory — used for view calls to
 *    detect flash-loan adapter accounts (not a Ponder-indexed contract).
 */
export interface FlashLoanProvider {
  router: `0x${string}`;
  adapterFactory: `0x${string}`;
}

export interface ChainConfig {
  /** Ponder chain key (e.g. "mainnet", "gnosis"). Must match ponder chain names. */
  name: string;
  /** EIP-155 chain ID — must be a value from the cow-sdk SupportedChainId enum. */
  chainId: SupportedChainId;
  /** Environment variable name holding the RPC URL for this chain. */
  rpcEnvVar: string;
  /** Optional WS RPC URL env var — enables Ponder realtime subscriptions; HTTP polling when unset. */
  wsRpcEnvVar?: string;
  /** Approximate block time in seconds — used to estimate block numbers from epoch timestamps. */
  blockTime: number;

  /** ComposableCoW CREATE2 deployment on this chain. */
  composableCow: { address: `0x${string}`; startBlock: number };
  /** ComposableCowLive — same address, always starts at "latest" for live event monitoring. */
  composableCowLive: { address: `0x${string}` };

  /**
   * CoWShedFactory deployment(s) on this chain.
   * Gnosis has two factory addresses (current + legacy), so address may be an array.
   * Null when the factory address hasn't been confirmed for this chain yet.
   */
  cowShedFactory: {
    address: `0x${string}` | readonly `0x${string}`[];
    startBlock: number;
  } | null;

  /** GPv2Settlement deployment — null if not indexed on this chain. */
  gpv2Settlement: { address: `0x${string}`; startBlock: number } | null;

  /**
   * Flash-loan infrastructure for this chain — null if none is deployed.
   *
   * Keyed by provider so other flash-loan kinds (each with its own router and
   * adapter factory) can be added as new keys without disturbing existing ones.
   * The addresses today are Aave-V3-specific, and the settlement indexer
   * currently only detects the `aaveV3` provider — add a key here (and wire it
   * in src/data.ts / settlement handler) when another provider is supported.
   */
  flashLoan: { aaveV3: FlashLoanProvider } | null;

  /**
   * CoW Protocol Orderbook API path for this chain (the part after https://api.cow.fi/).
   * e.g. "mainnet", "xdai", "arbitrum_one". Combined with the base URL at call sites.
   */
  orderbookApiPath: string;

  /**
   * Orderbook recheck cadence for this chain, in **seconds** (wall-clock).
   * Converted to a per-chain block offset at runtime as
   * `max(1, round(orderbookPollInterval / blockTime))` (see src/data.ts).
   * Defaults to `20 * blockTime` to preserve the prior 20-block cadence.
   */
  orderbookPollInterval: number;
}
