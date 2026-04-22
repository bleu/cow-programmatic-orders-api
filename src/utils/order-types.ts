// Handler contract address → order type, keyed by chain ID then address (lowercase).
// Addresses confirmed from cowprotocol/composable-cow/networks.json (identical on all chains).
// Extend HANDLER_ADDRESS_TO_TYPE if new order types or handler versions are deployed.

export type OrderType =
  | "TWAP"
  | "StopLoss"
  | "PerpetualSwap"
  | "GoodAfterTime"
  | "TradeAboveThreshold"
  | "Unknown";

/**
 * Canonical address → order type map (chain-agnostic; all handlers are CREATE2-deployed at the
 * same address on every supported chain). Single source of truth — do not duplicate addresses.
 */
export const HANDLER_ADDRESS_TO_TYPE: Record<string, OrderType> = {
  "0x6cf1e9ca41f7611def408122793c358a3d11e5a5": "TWAP",
  "0x412c36e5011cd2517016d243a2dfb37f73a242e7": "StopLoss",
  "0x519ba24e959e33b3b6220ca98bd353d8c2d89920": "PerpetualSwap",
  "0xdaf33924925e03c9cc3a10d434016d6cfad0add5": "GoodAfterTime",
  "0x812308712a6d1367f437e1c1e4af85c854e1e9f6": "TradeAboveThreshold",
};

const HANDLER_MAP: Record<number, Record<string, OrderType>> = {
  1: HANDLER_ADDRESS_TO_TYPE, // Mainnet
  100: HANDLER_ADDRESS_TO_TYPE, // Gnosis Chain
  42161: {}, // Arbitrum One
};

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
