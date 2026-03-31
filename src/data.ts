import { ComposableCowAbi } from "../abis/ComposableCowAbi";
import { CoWShedFactoryAbi } from "../abis/CoWShedFactoryAbi";
import { GPv2SettlementAbi } from "../abis/GPv2SettlementAbi";

// CREATE2-deployed contracts share the same address across chains
const COMPOSABLE_COW_ADDRESS =
  "0xfdaFc9d1902f4e0b84f65F49f244b32b31013b74" as const;
const GPV2_SETTLEMENT_ADDRESS =
  "0x9008D19f58AAbD9eD0D60971565AA8510560ab41" as const;
const AAVE_V3_ADAPTER_FACTORY_ADDRESS =
  "0xdeCc46a4b09162f5369c5c80383aaa9159bcf192" as const;
const FLASH_LOAN_ROUTER_ADDRESS =
  "0x9da8B48441583a2b93e2eF8213aAD0EC0b392C69" as const;

/**
 * ComposableCoW contract configuration per chain.
 * Mainnet only for M1. Add gnosis/arbitrum in a future task.
 */
export const COMPOSABLE_COW_DEPLOYMENTS = {
  mainnet: {
    address: COMPOSABLE_COW_ADDRESS,
    startBlock: 17883049,
    // No endBlock — index continuously
  },
  gnosis: {
    address: COMPOSABLE_COW_ADDRESS,
    startBlock: 29389123,
  },
  // arbitrum: { address: COMPOSABLE_COW_ADDRESS, startBlock: ... }, // TODO: COW-7xx
} as const;

export const ComposableCowContract = {
  abi: ComposableCowAbi,
  chain: {
    mainnet: COMPOSABLE_COW_DEPLOYMENTS.mainnet,
    gnosis: COMPOSABLE_COW_DEPLOYMENTS.gnosis,
  },
} as const;

/**
 * CoWShedFactory — emits COWShedBuilt (user, shed).
 *
 * Gnosis has two factory deployments with the same ABI:
 *   - 0x4f4350bf... (current) — deploys CoWShedForComposableCoW proxies
 *   - 0x312f92fe... (legacy)  — deploys standard COWShed proxies (2 historical events)
 * Both are indexed via a single Ponder contract entry using an address array.
 */
export const COW_SHED_FACTORY_DEPLOYMENTS = {
  mainnet: {
    address: "0x312f92fe5f1710408b20d52a374fa29e099cfa86" as const,
    startBlock: 22939254,
  },
  gnosis: {
    address: [
      "0x4f4350bf2c74aacd508d598a1ba94ef84378793d", // current (CoWShedForComposableCoW)
      "0x312f92fe5f1710408b20d52a374fa29e099cfa86", // legacy (COWShed); 2 historical events
    ] as const,
    startBlock: 41469991, // earliest COWShedBuilt from either factory on Gnosis
  },
} as const;

export const CoWShedFactoryContract = {
  abi: CoWShedFactoryAbi,
  chain: {
    mainnet: COW_SHED_FACTORY_DEPLOYMENTS.mainnet,
    gnosis: COW_SHED_FACTORY_DEPLOYMENTS.gnosis,
  },
} as const;

/**
 * GPv2Settlement — mainnet only.
 *
 * Start block = AaveV3AdapterFactory deployment block, NOT ComposableCoW genesis.
 */
export const GPV2_SETTLEMENT_DEPLOYMENTS = {
  mainnet: {
    address: GPV2_SETTLEMENT_ADDRESS,
    startBlock: 23812751, // AaveV3AdapterFactory deployment block (Nov 16, 2025)
  },
  gnosis: {
    address: GPV2_SETTLEMENT_ADDRESS,
    startBlock: 43177077, // AaveV3AdapterFactory deployment block on Gnosis
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
 * Not a Ponder-indexed contract — used for view calls only.
 */
export const AAVE_V3_ADAPTER_FACTORY_ADDRESSES = {
  mainnet: AAVE_V3_ADAPTER_FACTORY_ADDRESS,
  gnosis: AAVE_V3_ADAPTER_FACTORY_ADDRESS, // verified on Gnosisscan
  // arbitrum: "0x...", // TODO: verify
} as const;

/**
 * FlashLoanRouter — the CoW Protocol solver that submits all Aave flash loan settlements.
 * Confirmed via ROUTER() on AaveV3AdapterFactory (immutable variable, cannot change).
 * Used to filter GPv2Settlement:Settlement events to only those involving flash loans.
 */
export const FLASH_LOAN_ROUTER_ADDRESSES = {
  mainnet: FLASH_LOAN_ROUTER_ADDRESS,
  gnosis: FLASH_LOAN_ROUTER_ADDRESS, // confirmed via ROUTER() on Gnosis AaveV3AdapterFactory
  // arbitrum: "0x...", // TODO: confirm via ROUTER() on arbitrum AaveV3AdapterFactory
} as const;
