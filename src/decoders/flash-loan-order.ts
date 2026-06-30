/**
 * Extract validTo (Unix seconds) from a CoW order UID. The UID is
 * 56 bytes — 32-byte digest + 20-byte owner + 4-byte uint32 validTo — so
 * validTo is the trailing 4 bytes, authoritative over any getHookData value.
 */
export function decodeValidToFromOrderUid(orderUid: `0x${string}`): number {
  const hex = orderUid.slice(2);
  return parseInt(hex.slice(-8), 16);
}

import { decodeAbiParameters } from "viem";

const TRADE_DATA_PARAMS = [
  { name: "sellToken", type: "address" },
  { name: "buyToken", type: "address" },
  { name: "sellAmount", type: "uint256" },
  { name: "buyAmount", type: "uint256" },
  { name: "feeAmount", type: "uint256" },
  { name: "orderUid", type: "bytes" },
] as const;

export interface TradeData {
  sellToken: `0x${string}`;
  buyToken: `0x${string}`;
  sellAmount: bigint;
  buyAmount: bigint;
  feeAmount: bigint;
  orderUid: `0x${string}`;
}

/**
 * Decode the non-indexed data of a GPv2Settlement `Trade` event. The settlement
 * handler reads only the indexed owner topic; this recovers the tokens,
 * executed amounts, fee and order UID carried in the log data.
 */
export function decodeTradeData(data: `0x${string}`): TradeData {
  const [sellToken, buyToken, sellAmount, buyAmount, feeAmount, orderUid] =
    decodeAbiParameters(TRADE_DATA_PARAMS, data);
  return {
    sellToken: sellToken.toLowerCase() as `0x${string}`,
    buyToken: buyToken.toLowerCase() as `0x${string}`,
    sellAmount,
    buyAmount,
    feeAmount,
    orderUid,
  };
}

export type FlashLoanOrderType =
  | "RepayWithCollateral"
  | "CollateralSwap"
  | "DebtSwap";

// Aave V3 adapter implementations behind the per-order EIP-1167 minimal proxies.
const IMPL_TO_TYPE: Record<string, FlashLoanOrderType> = {
  ac27f3f86e78b14721d07c4f9ce999285f9aaa06: "RepayWithCollateral",
  "029d584e847373b6373b01dfad1a0c9bfb916382": "CollateralSwap",
  "73e7af13ef172f13d8fefebfd90c7a6530096344": "DebtSwap",
};

const EIP1167_PREFIX = "363d3d373d3d3d363d73";
const EIP1167_SUFFIX = "5af43d82803e903d91602b57fd5bf3";

/**
 * Detect the Aave flash-loan adapter type from its runtime bytecode.
 * Adapters are EIP-1167 minimal proxies; the implementation address sits at
 * bytes [10:30]. Returns null when the bytecode is not a recognised clone
 * (wrong prefix/suffix or an unknown implementation).
 */
export function detectFlashLoanOrderType(
  code: `0x${string}`,
): FlashLoanOrderType | null {
  const hex = code.slice(2).toLowerCase();
  if (!hex.startsWith(EIP1167_PREFIX)) return null;
  if (!hex.endsWith(EIP1167_SUFFIX)) return null;
  const impl = hex.slice(20, 60);
  return IMPL_TO_TYPE[impl] ?? null;
}
