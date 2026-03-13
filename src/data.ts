import { ComposableCowAbi } from "../abis/ComposableCowAbi";
import { CoWShedFactoryAbi } from "../abis/CoWShedFactoryAbi";
import { GPv2SettlementAbi } from "../abis/GPv2SettlementAbi";

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

/** CoWShedFactory — mainnet only. Emits COWShedBuilt (shed, user). */
export const COW_SHED_FACTORY_DEPLOYMENTS = {
  mainnet: {
    address: "0x312f92fe5f1710408b20d52a374fa29e099cfa86" as const,
    startBlock: 22939254,
  },
} as const;

export const CoWShedFactoryContract = {
  abi: CoWShedFactoryAbi,
  chain: {
    mainnet: COW_SHED_FACTORY_DEPLOYMENTS.mainnet,
  },
} as const;

/**
 * GPv2Settlement — mainnet only.
 * Start block 17883049 (ComposableCoW genesis), not 12593265 (Settlement genesis),
 * to avoid syncing 2+ years of unrelated trades.
 */
export const GPV2_SETTLEMENT_DEPLOYMENTS = {
  mainnet: {
    address: "0x9008D19f58AAbD9eD0D60971565AA8510560ab41" as const,
    startBlock: 17883049,
  },
} as const;

export const GPv2SettlementContract = {
  abi: GPv2SettlementAbi,
  chain: {
    mainnet: GPV2_SETTLEMENT_DEPLOYMENTS.mainnet,
  },
} as const;

/**
 * AaveV3AdapterFactory — deploys per-user flash loan adapter proxies.
 * Detection: call FACTORY() on a contract; if it returns this address, it is an Aave adapter.
 * Same address across all chains (CREATE2 deterministic deployment).
 * Not a Ponder-indexed contract — used for view calls only.
 */
export const AAVE_V3_ADAPTER_FACTORY_ADDRESS =
  "0xdeCc46a4b09162f5369c5c80383aaa9159bcf192" as const;
