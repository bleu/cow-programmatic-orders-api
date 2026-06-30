import { SupportedChainId } from "@cowprotocol/cow-sdk";
import { type ChainConfig } from "./types";
import { mainnet } from "./mainnet";
import { gnosis } from "./gnosis";
import { arbitrum } from "./arbitrum";
import { base } from "./base";
import { bnb } from "./bnb";
import { polygon } from "./polygon";
import { plasma } from "./plasma";
import { avalanche } from "./avalanche";
import { linea } from "./linea";
import { ink } from "./ink";
import { lens } from "./lens";
import { sepolia } from "./sepolia";

/**
 * CHAIN_CONFIGS — the chain registry, keyed by SupportedChainId.
 *
 * `satisfies Record<SupportedChainId, ChainConfig | null>` makes coverage
 * exhaustive: when cow-sdk adds a member to SupportedChainId, `pnpm typecheck`
 * fails until an entry is added here — a full ChainConfig, or `null` to skip.
 */
export const CHAIN_CONFIGS = {
  [SupportedChainId.MAINNET]: mainnet,
  [SupportedChainId.BNB]: bnb,
  [SupportedChainId.GNOSIS_CHAIN]: gnosis,
  [SupportedChainId.POLYGON]: polygon,
  [SupportedChainId.LENS]: lens,
  [SupportedChainId.BASE]: base,
  [SupportedChainId.PLASMA]: plasma,
  [SupportedChainId.ARBITRUM_ONE]: arbitrum,
  [SupportedChainId.AVALANCHE]: avalanche,
  [SupportedChainId.INK]: ink,
  [SupportedChainId.LINEA]: linea,
  [SupportedChainId.SEPOLIA]: sepolia,
} satisfies Record<SupportedChainId, ChainConfig | null>;

/**
 * ALL_DEFINED_CHAINS — every chain configured with a full ChainConfig.
 * Derived from CHAIN_CONFIGS (drops the `null` / skipped entries). Used for
 * API-only lookups (e.g. orderbook URLs) across all configured chains, not just
 * the actively indexed ones.
 */
export const ALL_DEFINED_CHAINS: ChainConfig[] = Object.values(CHAIN_CONFIGS).filter(
  (c): c is ChainConfig => c !== null,
);

/**
 * ACTIVE_CHAINS — the chains this indexer instance actually processes.
 *
 * Explicit in-code selection (not env-gated). To enable a chain: add it here and
 * supply its RPC URL env var in docker-compose.yml and the deployment .env file.
 * To disable: remove it from this array. ponder.config.ts derives all
 * RPC/contract config from this array.
 *
 * Inactive-but-defined chains (arbitrum, base, bnb, polygon, avalanche, linea,
 * plasma) are fully verified — add one here once its RPC URL is provisioned.
 */
export const ACTIVE_CHAINS: ChainConfig[] = [mainnet, gnosis];
