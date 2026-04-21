// Handler contract address → order type, keyed by chain ID then address (lowercase).
// Most handler addresses are chain-agnostic: the five core CREATE2-deployed handlers are
// confirmed identical across chains in cowprotocol/composable-cow/networks.json.
// Chain-specific handlers (not CREATE2-shared) live in per-chain overlays merged into
// HANDLER_MAP. Extend HANDLER_ADDRESS_TO_TYPE (chain-agnostic) or the relevant per-chain
// overlay if new order types or handler versions are deployed.
//
// REFERENCE — ERC4626CowSwapFeeBurner future deployments (chains not yet indexed).
// Captured here so the chain-expansion PR can wire them in one place:
//   42161  Arbitrum  0xd53f5d8d926fb2a0f7be614b16e649b8ac102d83
//   8453   Base      0x4b979ed48f982ba0baa946cb69c1083eb799729c
//   10     Optimism  0x201efd508c8dfe9de1a13c2452863a78cb2a86cc
//   43114  Avalanche 0x5c6fb490bdfd3246eb0bb062c168decaf4bd9fdd

export type OrderType =
  | "TWAP"
  | "StopLoss"
  | "PerpetualSwap"
  | "GoodAfterTime"
  | "TradeAboveThreshold"
  | "CirclesBackingOrder"
  | "SwapOrderHandler"
  | "ERC4626CowSwapFeeBurner"
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
const MAINNET_ONLY_HANDLERS: Record<string, OrderType> = {
  "0xd506fe0b3ddf9e685c16e000514a835d3a511b26": "SwapOrderHandler",
  "0x816e90dc85bf016455017a76bc09cc0451eeb308": "ERC4626CowSwapFeeBurner",
};

const GNOSIS_ONLY_HANDLERS: Record<string, OrderType> = {
  "0x43866c5602b0e3b3272424396e88b849796dc608": "CirclesBackingOrder",
  "0x7a77934d32d78bfe8dc1e23415b5679960a1c610": "SwapOrderHandler",
  "0x5915dea04ce390f0f44ca0806f7c6dd99ce2f941": "ERC4626CowSwapFeeBurner",
};

const HANDLER_MAP: Record<number, Record<string, OrderType>> = {
  1:     { ...HANDLER_ADDRESS_TO_TYPE, ...MAINNET_ONLY_HANDLERS }, // Mainnet
  100:   { ...HANDLER_ADDRESS_TO_TYPE, ...GNOSIS_ONLY_HANDLERS },  // Gnosis Chain
  42161: {}, // Arbitrum One
};

/**
 * Union of every address that could appear as a composable-cow handler on any supported
 * chain. Used by data.ts for EIP-1271 signature validation — a signature referencing a
 * known handler on any chain must be recognized.
 */
export const ALL_HANDLER_ADDRESSES: readonly string[] = [
  ...Object.keys(HANDLER_ADDRESS_TO_TYPE),
  ...Object.keys(MAINNET_ONLY_HANDLERS),
  ...Object.keys(GNOSIS_ONLY_HANDLERS),
];

export function getOrderTypeFromHandler(
  handler: string,
  chainId: number,
): OrderType {
  return HANDLER_MAP[chainId]?.[handler.toLowerCase()] ?? "Unknown";
}
