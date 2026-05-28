export type { ChainConfig, SupportedChainId } from "./types";

import { mainnet } from "./mainnet";
import { gnosis } from "./gnosis";
import { arbitrum } from "./arbitrum";
import { base } from "./base";
import { sepolia } from "./sepolia";

/**
 * ALL_DEFINED_CHAINS — every chain that has a confirmed config file.
 * Used to derive ORDERBOOK_API_URLS and other chain-wide lookups.
 *
 * Adding a new chain: create src/chains/<name>.ts, import it here,
 * and add it to this array. Then add it to ACTIVE_CHAINS when ready to index.
 */
export const ALL_DEFINED_CHAINS = [mainnet, gnosis, arbitrum, base, sepolia];

/**
 * ACTIVE_CHAINS — the chains this indexer instance actually processes.
 *
 * To enable a chain: uncomment its entry (ensure cowShedFactory is confirmed first).
 * To disable a chain: comment out its entry — no other files need to change.
 * ponder.config.ts derives all RPC/contract config from this array.
 */
export const ACTIVE_CHAINS = [
  mainnet,
  gnosis,
  // arbitrum, // TODO: confirm cowShedFactory address before enabling
  // base,     // TODO: confirm cowShedFactory address before enabling
  // sepolia,  // TODO: confirm cowShedFactory address before enabling
];
