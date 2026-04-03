/**
 * Compute GPv2 order UIDs from order data — pure viem implementation.
 *
 * UID = abi.encodePacked(orderDigest, owner, uint32(validTo))
 * where orderDigest = EIP-712 typed hash of the GPv2Order struct.
 *
 * Reference: GPv2Order.sol (tmp/contracts/gpv2-contracts/src/contracts/libraries/GPv2Order.sol)
 * Source: COW-731 / Phase 2 of orderbook cache refactor
 */

import { encodePacked, hashTypedData, type Hex } from "viem";
import { GPV2_SETTLEMENT_ADDRESS } from "../../data";

// GPv2Order EIP-712 type definition — must match GPv2Order.sol exactly
const GPV2_ORDER_TYPES = {
  Order: [
    { name: "sellToken", type: "address" },
    { name: "buyToken", type: "address" },
    { name: "receiver", type: "address" },
    { name: "sellAmount", type: "uint256" },
    { name: "buyAmount", type: "uint256" },
    { name: "validTo", type: "uint32" },
    { name: "appData", type: "bytes32" },
    { name: "feeAmount", type: "uint256" },
    { name: "kind", type: "string" },
    { name: "partiallyFillable", type: "bool" },
    { name: "sellTokenBalance", type: "string" },
    { name: "buyTokenBalance", type: "string" },
  ],
} as const;

/** GPv2Order.Data fields as returned by getTradeableOrderWithSignature */
export interface GPv2OrderData {
  sellToken: Hex;
  buyToken: Hex;
  receiver: Hex;
  sellAmount: bigint;
  buyAmount: bigint;
  validTo: number;
  appData: Hex;
  feeAmount: bigint;
  kind: Hex;               // bytes32 — must be converted to "sell" or "buy" string
  partiallyFillable: boolean;
  sellTokenBalance: Hex;   // bytes32 — must be converted to "erc20" / "external" / "internal"
  buyTokenBalance: Hex;    // bytes32 — must be converted to "erc20" / "internal"
}

// GPv2Order.sol constant hashes — keccak256 of the string representation
const KIND_SELL = "0x6ed88e868af0a1983e3886d5f3e95a2fafbd6c3450bc229e27342283dc429ccc";
const KIND_BUY  = "0x68d080d2d76b2b66b0362ccf78225f93b4e09a3d39c1e5bbd3e9750eafec7e1b";
const BALANCE_ERC20    = "0x5a28e9363bb942b639270062aa6bb295f434bcdfc42c97267bf003f272060dc9";
const BALANCE_EXTERNAL = "0xabee3b73373acd583a130924aad6dc38cfdc44ba0555ba94ce2ff63980ea0632";
const BALANCE_INTERNAL = "0x4ac99ace14ee0a5ef932dc609df0943ab7ac16b7583b3f8de0d74ae99a9e79b5";

function decodeKind(kindHash: Hex): string {
  if (kindHash.toLowerCase() === KIND_SELL.toLowerCase()) return "sell";
  if (kindHash.toLowerCase() === KIND_BUY.toLowerCase()) return "buy";
  return "sell"; // fallback
}

function decodeBalance(balanceHash: Hex): string {
  const h = balanceHash.toLowerCase();
  if (h === BALANCE_ERC20.toLowerCase()) return "erc20";
  if (h === BALANCE_EXTERNAL.toLowerCase()) return "external";
  if (h === BALANCE_INTERNAL.toLowerCase()) return "internal";
  return "erc20"; // fallback
}

/**
 * Compute the 56-byte order UID for a GPv2 order.
 *
 * UID = abi.encodePacked(orderDigest, owner, uint32(validTo))
 * where orderDigest = EIP-712 typed hash of the order struct.
 *
 * The domain uses the GPv2Settlement contract address as verifyingContract.
 */
export function computeOrderUid(
  chainId: number,
  order: GPv2OrderData,
  owner: Hex,
): Hex {
  const domain = {
    name: "Gnosis Protocol",
    version: "v2",
    chainId,
    verifyingContract: GPV2_SETTLEMENT_ADDRESS as Hex,
  };

  // Convert bytes32 enum hashes to their string representations for EIP-712 hashing
  const message = {
    sellToken: order.sellToken,
    buyToken: order.buyToken,
    receiver: order.receiver,
    sellAmount: order.sellAmount,
    buyAmount: order.buyAmount,
    validTo: order.validTo,
    appData: order.appData,
    feeAmount: order.feeAmount,
    kind: decodeKind(order.kind),
    partiallyFillable: order.partiallyFillable,
    sellTokenBalance: decodeBalance(order.sellTokenBalance),
    buyTokenBalance: decodeBalance(order.buyTokenBalance),
  };

  const orderDigest = hashTypedData({
    domain,
    types: GPV2_ORDER_TYPES,
    primaryType: "Order",
    message,
  });

  return encodePacked(
    ["bytes32", "address", "uint32"],
    [orderDigest, owner, order.validTo],
  );
}
