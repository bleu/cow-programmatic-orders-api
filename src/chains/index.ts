export type { ChainConfig, SupportedChainId } from "./types";

import { mainnet } from "./mainnet";
import { gnosis } from "./gnosis";
import { arbitrum } from "./arbitrum";
import { base } from "./base";
import { sepolia } from "./sepolia";
import { bnb } from "./bnb";
import { polygon } from "./polygon";
import { lens } from "./lens";
import { plasma } from "./plasma";
import { avalanche } from "./avalanche";
import { ink } from "./ink";
import { linea } from "./linea";

/**
 * ALL_DEFINED_CHAINS — one entry per chain in cow-sdk's ALL_SUPPORTED_CHAIN_IDS.
 *
 * When cow-sdk adds a new chain to ALL_SUPPORTED_CHAIN_IDS, add a corresponding
 * src/chains/<name>.ts here. Populate contract addresses from the block explorer
 * (ComposableCow is CREATE2 at 0xfdaFc9d1902f4e0b84f65F49f244b32b31013b74;
 * CoWShedFactory and AaveV3AdapterFactory addresses vary per chain and must be verified).
 *
 * Chains with unconfirmed addresses should have null fields and be kept out of
 * ACTIVE_CHAINS until all required addresses are verified.
 */
export const ALL_DEFINED_CHAINS = [
  // --- Fully configured ---
  mainnet,
  gnosis,
  // --- Partially configured (addresses confirmed, not yet active) ---
  arbitrum,
  base,
  sepolia,
  // --- Stubs: added to mirror cow-sdk's ALL_SUPPORTED_CHAIN_IDS; contract
  //     addresses must be verified before enabling in ACTIVE_CHAINS (COW-986) ---
  bnb,
  polygon,
  lens,
  plasma,
  avalanche,
  ink,
  linea,
];

/**
 * ACTIVE_CHAINS — the chains this indexer instance actually processes.
 *
 * To enable a chain: move it here from the stub list above (ensure all contract
 * addresses in its ChainConfig are confirmed — no null fields that are required
 * at runtime). To disable a chain: remove it from this array.
 * ponder.config.ts derives all RPC/contract config from this array.
 */
export const ACTIVE_CHAINS = [
  mainnet,
  gnosis,
  // arbitrum, // TODO: confirm cowShedFactory address before enabling
  // base,     // TODO: confirm cowShedFactory address before enabling
  // sepolia,  // TODO: confirm cowShedFactory address before enabling
  // bnb,      // TODO: verify all contract addresses (COW-986)
  // polygon,  // TODO: verify all contract addresses (COW-986)
  // lens,     // TODO: verify all contract addresses (COW-986)
  // plasma,   // TODO: verify all contract addresses (COW-986)
  // avalanche,// TODO: verify all contract addresses (COW-986)
  // ink,      // TODO: verify all contract addresses (COW-986)
  // linea,    // TODO: verify all contract addresses (COW-986)
];
