// Handler contract address → order type, keyed by chain ID then address (lowercase).
// Most handler addresses are chain-agnostic: the five core CREATE2-deployed handlers are
// confirmed identical across chains in cowprotocol/composable-cow/networks.json.
// Chain-specific handlers (e.g. CirclesBackingOrder on Gnosis) live in per-chain overlays
// merged into the appropriate entry of HANDLER_MAP.
// Extend HANDLER_ADDRESS_TO_TYPE (chain-agnostic) or a per-chain overlay if new order types
// or handler versions are deployed.

export type OrderType =
  | "TWAP"
  | "StopLoss"
  | "PerpetualSwap"
  | "GoodAfterTime"
  | "TradeAboveThreshold"
  | "CirclesBackingOrder"
  | "Unknown";

/**
 * Canonical address → order type map for chain-agnostic handlers (CREATE2-deployed at the
 * same address on every supported chain). Single source of truth for these five — do not
 * duplicate addresses.
 */
export const HANDLER_ADDRESS_TO_TYPE: Record<string, OrderType> = {
  "0x6cf1e9ca41f7611def408122793c358a3d11e5a5": "TWAP",
  "0x412c36e5011cd2517016d243a2dfb37f73a242e7": "StopLoss",
  "0x519ba24e959e33b3b6220ca98bd353d8c2d89920": "PerpetualSwap",
  "0xdaf33924925e03c9cc3a10d434016d6cfad0add5": "GoodAfterTime",
  "0x812308712a6d1367f437e1c1e4af85c854e1e9f6": "TradeAboveThreshold",
};

/**
 * Chain-specific handlers that are not CREATE2-shared across chains.
 * Keep separate from HANDLER_ADDRESS_TO_TYPE so the chain-agnostic invariant holds.
 */
const GNOSIS_ONLY_HANDLERS: Record<string, OrderType> = {
  "0x43866c5602b0e3b3272424396e88b849796dc608": "CirclesBackingOrder",
};

const HANDLER_MAP: Record<number, Record<string, OrderType>> = {
  1: HANDLER_ADDRESS_TO_TYPE, // Mainnet
  100: { ...HANDLER_ADDRESS_TO_TYPE, ...GNOSIS_ONLY_HANDLERS }, // Gnosis Chain
  42161: {}, // Arbitrum One
};

/**
 * Union of every address that could appear as a composable-cow handler on any supported
 * chain. Used by data.ts for EIP-1271 signature validation — a signature referencing a
 * known handler on any chain must be recognized.
 */
export const ALL_HANDLER_ADDRESSES: readonly string[] = [
  ...Object.keys(HANDLER_ADDRESS_TO_TYPE),
  ...Object.keys(GNOSIS_ONLY_HANDLERS),
];

export function getOrderTypeFromHandler(
  handler: string,
  chainId: number,
): OrderType {
  return HANDLER_MAP[chainId]?.[handler.toLowerCase()] ?? "Unknown";
}

// Single source of truth for which order types have UIDs computable from staticInput
// alone (no on-chain calls). Keep in sync with the switch in `precomputeOrderUids`.
export const DETERMINISTIC_ORDER_TYPES = new Set<OrderType>(["TWAP", "StopLoss"]);

export function isDeterministicOrderType(orderType: string): boolean {
  return DETERMINISTIC_ORDER_TYPES.has(orderType as OrderType);
}
