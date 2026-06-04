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
 */
export const ALL_DEFINED_CHAINS = [
  mainnet,
  gnosis,
  arbitrum,
  base,
  sepolia,
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
 * To enable a chain: add it here and supply its RPC URL env var in docker-compose.yml
 * and the deployment .env file. To disable: remove it from this array.
 * ponder.config.ts derives all RPC/contract config from this array.
 */
export const ACTIVE_CHAINS = [
  mainnet,
  gnosis,
  // arbitrum, // fully verified — enable when ARBITRUM_RPC_URL is provisioned
  // base,     // fully verified — enable when BASE_RPC_URL is provisioned
  // bnb,      // fully verified — enable when BNB_RPC_URL is provisioned
  // polygon,  // fully verified — enable when POLYGON_RPC_URL is provisioned
  // avalanche,// fully verified — enable when AVALANCHE_RPC_URL is provisioned
  // linea,    // fully verified — enable when LINEA_RPC_URL is provisioned
  // plasma,   // fully verified — enable when PLASMA_RPC_URL is provisioned
  // lens,     // enable when LENS_RPC_URL is provisioned; aaveV3AdapterFactory=null (no flash loan detection); orderbook not live yet
  // sepolia,  // enable when SEPOLIA_RPC_URL is provisioned; aaveV3AdapterFactory=null (no flash loan detection)
  // ink,      // enable when INK_RPC_URL is provisioned; cowShedFactory=null (no CoWShed indexing); aaveV3AdapterFactory=null (no flash loan detection)
];
