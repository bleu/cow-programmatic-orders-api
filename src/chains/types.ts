import { SupportedChainId } from "@cowprotocol/cow-sdk";

export type { SupportedChainId };

/**
 * Derive the ContractPoller block interval from block time so that polls
 * happen approximately every 20 seconds regardless of chain speed.
 * e.g. mainnet (12s) → 1 block, gnosis (5s) → 4 blocks, base (2s) → 10 blocks.
 */
export function pollerInterval(blockTimeSeconds: number): number {
  return Math.max(1, Math.floor(20 / blockTimeSeconds));
}

/**
 * ChainConfig — everything needed to configure one chain in ponder.config.ts
 * and derive runtime constants (block time, RPC URL, API URL, etc.).
 *
 * Add a new chain by:
 *   1. Creating src/chains/<name>.ts implementing this interface.
 *   2. Importing and appending it to ACTIVE_CHAINS in src/chains/index.ts.
 */
export interface ChainConfig {
  /** Ponder chain key (e.g. "mainnet", "gnosis"). Must match ponder chain names. */
  name: string;
  /** EIP-155 chain ID — must be a value from the cow-sdk SupportedChainId enum. */
  chainId: SupportedChainId;
  /** Environment variable name holding the RPC URL for this chain. */
  rpcEnvVar: string;
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
   * GPv2Settlement deployment — null if not indexed on this chain.
   * Currently only indexed where AaveV3AdapterFactory is deployed.
   */
  gpv2Settlement: { address: `0x${string}`; startBlock: number } | null;

  /**
   * FlashLoanRouter address — used to filter GPv2Settlement:Settlement events.
   * Null if GPv2Settlement is not indexed on this chain.
   */
  flashLoanRouter: `0x${string}` | null;

  /**
   * AaveV3AdapterFactory address — used for view calls (not a Ponder-indexed contract).
   * Null if not deployed/confirmed on this chain.
   */
  aaveV3AdapterFactory: `0x${string}` | null;

  /**
   * CoW Protocol Orderbook API path for this chain (the part after https://api.cow.fi/).
   * e.g. "mainnet", "xdai", "arbitrum_one". Combined with the base URL at call sites.
   */
  orderbookApiPath: string;
}
