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

/**
 * CHAIN_CONFIGS — the chain registry, keyed by SupportedChainId.
 *
 * `satisfies Record<SupportedChainId, ChainConfig | null>` makes coverage
 * exhaustive: when cow-sdk adds a member to SupportedChainId, `pnpm typecheck`
 * FAILS ("Property … is missing") until a developer adds an entry here that is
 * either a full ChainConfig or `null`.
 *
 * `null` = explicitly skipped. A chain is skipped when it lacks the flash-loan
 * infra (router + AaveV3AdapterFactory) and/or GPv2Settlement deployment that a
 * full ChainConfig now requires (see the constraint note in types.ts). Today
 * that is sepolia, ink, and lens; their verified ComposableCoW/CoWShed
 * deployment data lives in git history and can be restored if they ever gain the
 * infra (or if `flashLoan`/`gpv2Settlement` are reverted to nullable per the
 * note in types.ts).
 */
export const CHAIN_CONFIGS = {
  [SupportedChainId.MAINNET]: mainnet,
  [SupportedChainId.BNB]: bnb,
  [SupportedChainId.GNOSIS_CHAIN]: gnosis,
  [SupportedChainId.POLYGON]: polygon,
  [SupportedChainId.LENS]: null, // no AaveV3AdapterFactory / flash-loan infra; orderbook not live (api.cow.fi/lens 404s)
  [SupportedChainId.BASE]: base,
  [SupportedChainId.PLASMA]: plasma,
  [SupportedChainId.ARBITRUM_ONE]: arbitrum,
  [SupportedChainId.AVALANCHE]: avalanche,
  [SupportedChainId.INK]: null, // no CoWShedFactory and no AaveV3AdapterFactory / flash-loan infra confirmed
  [SupportedChainId.LINEA]: linea,
  [SupportedChainId.SEPOLIA]: null, // no AaveV3AdapterFactory / flash-loan infra
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
