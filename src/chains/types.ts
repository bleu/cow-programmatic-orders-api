/**
 * ChainConfig — everything needed to configure one chain in ponder.config.ts
 * and derive runtime constants (block time, RPC URL, API URL, etc.).
 *
 * Add a new chain by:
 *   1. Creating src/chains/<name>.ts implementing this interface.
 *   2. Importing and appending it to ACTIVE_CHAINS in src/chains/index.ts.
 *   3. Updating SupportedChainId in src/data.ts.
 */
export interface ChainConfig {
  /** Ponder chain key (e.g. "mainnet", "gnosis"). Must match ponder chain names. */
  name: string;
  /** Numeric EIP-155 chain ID (e.g. 1, 100). */
  chainId: number;
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
   */
  cowShedFactory: {
    address: `0x${string}` | readonly `0x${string}`[];
    startBlock: number;
  };

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
   * Null if not deployed on this chain.
   */
  aaveV3AdapterFactory: `0x${string}` | null;

  /**
   * ContractPoller block interval override for this chain.
   * Defaults to 1; Gnosis uses 4 (~20s) to avoid wasteful RPC calls.
   */
  contractPollerInterval: number;

  /** CoW Protocol Orderbook API base URL for this chain. */
  orderbookApiUrl: string;
}
