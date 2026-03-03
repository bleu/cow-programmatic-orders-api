// Handler contract address → order type, keyed by chain ID then address (lowercase).
// Only confirmed addresses are listed. Unknown handlers → "Unknown".
// Extend this map as part of COW-713–COW-716 (decoder tasks).

export type OrderType =
  | "TWAP"
  | "StopLoss"
  | "PerpetualSwap"
  | "GoodAfterTime"
  | "TradeAboveThreshold"
  | "Unknown";

const HANDLER_MAP: Record<number, Record<string, OrderType>> = {
  1: {
    // Perpetual Swap — confirmed from PoC
    "0x519ba24e959e33b3b6220ca98bd353d8c2d89920": "PerpetualSwap",
    // TODO(COW-713): add TWAP handler address
    // TODO(COW-714): add StopLoss handler address
    // TODO(COW-716): add GoodAfterTime and TradeAboveThreshold handler addresses
  },
  100: {}, // Gnosis — populated when COW-710 research is complete
  42161: {}, // Arbitrum — populated when COW-710 research is complete
};

export function getOrderTypeFromHandler(
  handler: string,
  chainId: number
): OrderType {
  return HANDLER_MAP[chainId]?.[handler.toLowerCase()] ?? "Unknown";
}
