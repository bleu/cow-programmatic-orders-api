export type { ChainConfig } from "./types";

import { mainnet } from "./mainnet";
import { gnosis } from "./gnosis";
// import { arbitrum } from "./arbitrum"; // uncomment to enable Arbitrum

/**
 * ACTIVE_CHAINS — the canonical list of chains this indexer processes.
 *
 * To add a chain:
 *   1. Create src/chains/<name>.ts implementing ChainConfig.
 *   2. Import and append it here.
 *   3. Update SupportedChainId in src/data.ts.
 *   4. Ensure the RPC URL env var is set (see .env.local.example).
 *
 * To disable a chain temporarily, comment out its entry below — no other
 * files need to change. ponder.config.ts derives everything from this array.
 */
export const ACTIVE_CHAINS = [
  mainnet,
  gnosis,
  // arbitrum,
];
