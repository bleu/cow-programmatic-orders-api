// Handler contract address -> order type, keyed by chain ID then address (lowercase).
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
  | "CurveCowSwapBurner"
  | "BalancerCowSwapFeeBurner"
  | "CowAmmConstantProduct"
  | "Unknown";

/**
 * Canonical address -> order type map for chain-agnostic handlers (CREATE2-deployed at the
 * same address on every supported chain). Single source of truth for these five — do not
 * duplicate addresses.
 */
const HANDLER_ADDRESS_TO_TYPE: Record<string, OrderType> = {
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
  // Curve Finance fee-burn handler: converts protocol fees -> target token via CoW swap.
  // Source: https://docs.curve.finance/fees/CowSwapBurner/ — Vyper 0.3.10, verified.
  "0xc0fc3ddfec95ca45a0d2393f518d3ea1ccf44f8b": "CurveCowSwapBurner",
  // Balancer v3 CowSwapFeeBurner: burns protocol fees via CoW swap.
  // v2 (current): deployed via 20250530-v3-cow-swap-fee-burner-v2 task.
  "0x9958317b80ee5f10457017d54c2484d722059157": "BalancerCowSwapFeeBurner",
  // v1 (deprecated): deployed via 20250221-v3-cow-swap-fee-burner (now in deprecated/).
  "0x0e800d8d2e8b4694610aedc385aa6d763492b106": "BalancerCowSwapFeeBurner",
};

const GNOSIS_ONLY_HANDLERS: Record<string, OrderType> = {
  "0x43866c5602b0e3b3272424396e88b849796dc608": "CirclesBackingOrder",
  "0x7a77934d32d78bfe8dc1e23415b5679960a1c610": "SwapOrderHandler",
  "0x5915dea04ce390f0f44ca0806f7c6dd99ce2f941": "ERC4626CowSwapFeeBurner",
  // Balancer v3 CowSwapFeeBurner v2 on Gnosis.
  // Deployed via 20250530-v3-cow-swap-fee-burner-v2 task.
  "0x254f3a2974b97dc2e675f6115c845567c55f83b0": "BalancerCowSwapFeeBurner",
  // CoW AMM ConstantProduct pool (verified). Each pool instance IS its own handler —
  // the pool address equals the handler address. Factory: ConstantProductFactory.
  // Source: https://github.com/cowprotocol/cow-amm
  "0xb148f40fff05b5ce6b22752cf8e454b556f7a851": "CowAmmConstantProduct",
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

// Single source of truth for which order types have UIDs computable from staticInput
// alone (no on-chain calls). Keep in sync with the switch in `precomputeOrderUids`.
export const DETERMINISTIC_ORDER_TYPE: Record<OrderType, boolean> = {
  TWAP: true,
  StopLoss: true,
  CirclesBackingOrder: true,
  PerpetualSwap: false,
  GoodAfterTime: false,
  TradeAboveThreshold: false,
  SwapOrderHandler: false,
  ERC4626CowSwapFeeBurner: false,
  CurveCowSwapBurner: false,
  BalancerCowSwapFeeBurner: false,
  CowAmmConstantProduct: false,
  Unknown: false,
};
