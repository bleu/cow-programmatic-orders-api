import { SupportedChainId } from "@cowprotocol/cow-sdk";

/**
 * ChainConfig — everything needed to configure one chain in ponder.config.ts
 * and derive runtime constants (block time, RPC URL, API URL, etc.).
 *
 * Add a new chain by:
 *   1. Creating src/chains/<name>.ts implementing this interface.
 *   2. Registering it under its SupportedChainId key in the CHAIN_CONFIGS
 *      registry in src/chains/index.ts (a full ChainConfig, or `null` to skip).
 *   3. Adding it to ACTIVE_CHAINS in src/chains/index.ts to actually index it.
 *
 * Flash-loan-required constraint: `flashLoan` and `gpv2Settlement` are non-null,
 * so any chain configured as a full ChainConfig MUST have flash-loan infra
 * (router + adapter factory) and a settlement deployment. A chain lacking that
 * infra (today: sepolia, ink, lens) cannot be a ChainConfig — it must be a `null`
 * entry in CHAIN_CONFIGS. If a future need arises to index an orders-only chain
 * WITHOUT flash-loan infra, revert `flashLoan` (and `gpv2Settlement`) to `| null`
 * and re-add the per-chain settlement gate in ponder.config.ts.
 */
export interface ChainConfig {
  /** Ponder chain key (e.g. "mainnet", "gnosis"). Must match ponder chain names. */
  name: string;
  /** EIP-155 chain ID — must be a value from the cow-sdk SupportedChainId enum. */
  chainId: SupportedChainId;
  /** Environment variable name holding the RPC URL for this chain. */
  rpcEnvVar: string;
  /**
   * Environment variable name holding the WebSocket RPC URL for this chain.
   * Optional; enables Ponder realtime WS subscriptions, falls back to HTTP polling when unset.
   */
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

  /**
   * GPv2Settlement deployment. Always indexed on a configured chain
   * (chains without it are `null` in CHAIN_CONFIGS — see the constraint note above).
   */
  gpv2Settlement: { address: `0x${string}`; startBlock: number };

  /**
   * Flash-loan infrastructure for this chain. Always present on a configured chain.
   *  - `router`: FlashLoanRouter address — used to filter GPv2Settlement:Settlement events.
   *  - `adapterFactory`: AaveV3AdapterFactory address — used for view calls
   *    (not a Ponder-indexed contract).
   *
   * Grouped (rather than two independent nullable fields) so the router and factory
   * cannot drift out of sync — a chain has flash-loan infra or it doesn't.
   */
  flashLoan: { router: `0x${string}`; adapterFactory: `0x${string}` };

  /**
   * CoW Protocol Orderbook API path for this chain (the part after https://api.cow.fi/).
   * e.g. "mainnet", "xdai", "arbitrum_one". Combined with the base URL at call sites.
   */
  orderbookApiPath: string;

  /**
   * Orderbook recheck cadence for this chain, in **seconds** (wall-clock).
   *
   * Replaces the former global ORDERBOOK_POLL_INTERVAL (a single block count
   * shared across all chains — a scaling smell flagged in grant review F17).
   * Converted to a per-chain block offset at runtime as
   * `max(1, round(orderbookPollInterval / blockTime))` (see src/data.ts
   * RECHECK_INTERVAL_BLOCKS_BY_CHAIN_ID).
   *
   * Defaults preserve the prior cadence (20 blocks): each chain sets
   * `20 * blockTime` seconds. Tune per chain as the chain list grows.
   */
  orderbookPollInterval: number;
}
