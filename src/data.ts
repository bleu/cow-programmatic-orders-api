import { ALL_HANDLER_ADDRESSES } from "./utils/order-types";
import { ACTIVE_CHAINS, ALL_DEFINED_CHAINS } from "./chains";
import { SupportedChainId } from "@cowprotocol/cow-sdk";

export { SupportedChainId };

// CREATE2-deployed contracts share the same address across chains
export const GPV2_SETTLEMENT_ADDRESS =
  "0x9008D19f58AAbD9eD0D60971565AA8510560ab41" as const;

/**
 * Per-chain orderbook recheck cadence, in blocks, keyed by chain ID.
 * Derived from each chain's orderbookPollInterval (seconds) and blockTime:
 *   blocks = max(1, round(orderbookPollInterval / blockTime)).
 * Partial: lookups fall back to DEFAULT_RECHECK_INTERVAL_BLOCKS (src/constants.ts).
 */
export const RECHECK_INTERVAL_BLOCKS_BY_CHAIN_ID: Partial<Record<SupportedChainId, bigint>> =
  Object.fromEntries(
    ALL_DEFINED_CHAINS.map((c) => [
      c.chainId,
      BigInt(Math.max(1, Math.round(c.orderbookPollInterval / c.blockTime))),
    ]),
  );

/**
 * Human-readable chain names keyed by chain ID.
 * Derived from ACTIVE_CHAINS — used for API schema descriptions and logging.
 * Partial: only the active chains are present, so lookups are `string | undefined`.
 */
export const CHAIN_NAMES: Partial<Record<SupportedChainId, string>> =
  Object.fromEntries(ACTIVE_CHAINS.map((c) => [c.chainId, c.name]));

/**
 * ComposableCoW address keyed by numeric chain ID.
 * Derived from ACTIVE_CHAINS — update chain files to change addresses.
 * Partial: only the active chains are present, so lookups are `0x… | undefined`.
 */
export const COMPOSABLE_COW_ADDRESS_BY_CHAIN_ID: Partial<
  Record<SupportedChainId, `0x${string}`>
> = Object.fromEntries(ACTIVE_CHAINS.map((c) => [c.chainId, c.composableCow.address]));

/**
 * Known ComposableCoW order handler addresses — derived from the ALL_HANDLER_ADDRESSES
 * list in src/utils/order-types.ts (union of the chain-agnostic map + all per-chain overlays).
 * Used by the EIP-1271 decoder and orderbook handlers to validate that a decoded signature
 * belongs to a composable order.
 *
 * Chain-global union by design: a Gnosis-only handler address (e.g. CirclesBackingOrder) is
 * accepted on any chain here. Cross-chain false positives are benign — the handler wouldn't
 * actually be deployed at that address on the wrong chain, so downstream calls would revert —
 * and keeping one flat set avoids threading chainId through every EIP-1271 validation site.
 */
export const COMPOSABLE_COW_HANDLER_ADDRESSES = new Set(ALL_HANDLER_ADDRESSES);

/**
 * CoW Protocol Orderbook API base URLs per chain ID.
 * Derived from ALL_DEFINED_CHAINS so every configured chain is covered,
 * including inactive ones used for API-only lookups.
 */
export const ORDERBOOK_API_URLS: Record<number, string> = Object.fromEntries(
  ALL_DEFINED_CHAINS.map((c) => [c.chainId, `https://api.cow.fi/${c.orderbookApiPath}`]),
);

/**
 * Flash-loan adapter factory addresses keyed by chain name.
 * Derived from ACTIVE_CHAINS — only chains with flash-loan infra are included.
 * Used by settlement.ts to resolve per-chain factory addresses at runtime.
 */
export const AAVE_V3_ADAPTER_FACTORY_ADDRESSES: Record<string, `0x${string}`> =
  Object.fromEntries(
    ACTIVE_CHAINS
      .filter((c) => c.flashLoan !== null)
      .map((c) => [c.name, c.flashLoan!.adapterFactory]),
  );

/**
 * GPv2Settlement deployment info keyed by chain name.
 * Derived from ACTIVE_CHAINS — only chains with a non-null gpv2Settlement are included.
 * Used by settlement.ts to resolve the settlement contract address per chain.
 */
export const GPV2_SETTLEMENT_DEPLOYMENTS: Record<string, { address: `0x${string}`; startBlock: number }> =
  Object.fromEntries(
    ACTIVE_CHAINS
      .filter((c) => c.gpv2Settlement !== null)
      .map((c) => [c.name, c.gpv2Settlement!]),
  );
