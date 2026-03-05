import { ComposableCowAbi } from "../abis/ComposableCowAbi";

/**
 * ComposableCoW contract configuration per chain.
 * Mainnet only for M1. Add gnosis/arbitrum in a future task.
 */
export const COMPOSABLE_COW_DEPLOYMENTS = {
  mainnet: {
    address: "0xfdaFc9d1902f4e0b84f65F49f244b32b31013b74" as const,
    startBlock: 17883049,
    // No endBlock — index continuously
  },
  // gnosis: { address: "0x...", startBlock: ... },   // TODO: COW-7xx
  // arbitrum: { address: "0x...", startBlock: ... }, // TODO: COW-7xx
} as const;

export const ComposableCowContract = {
  abi: ComposableCowAbi,
  chain: {
    mainnet: COMPOSABLE_COW_DEPLOYMENTS.mainnet,
  },
} as const;
