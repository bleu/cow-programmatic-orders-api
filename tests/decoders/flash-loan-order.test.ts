import { describe, it, expect } from "vitest";
import { encodeAbiParameters } from "viem";
import {
  detectFlashLoanOrderType,
  decodeValidToFromOrderUid,
  decodeTradeData,
} from "../../src/decoders/flash-loan-order";

const SELL_TOKEN = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const;
const BUY_TOKEN = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as const;
const ORDER_UID = `0x${"cc".repeat(56)}` as `0x${string}`;

// A CoW order UID is 56 bytes: 32-byte digest + 20-byte owner + 4-byte validTo.
const makeOrderUid = (validToHex8: string) =>
  `0x${"11".repeat(32)}${"22".repeat(20)}${validToHex8}` as `0x${string}`;

// EIP-1167 minimal-proxy runtime bytecode = prefix + <impl 20 bytes> + suffix.
const EIP1167_PREFIX = "363d3d373d3d3d363d73";
const EIP1167_SUFFIX = "5af43d82803e903d91602b57fd5bf3";
const makeClone = (impl: string) =>
  `0x${EIP1167_PREFIX}${impl}${EIP1167_SUFFIX}` as `0x${string}`;

const REPAY_IMPL = "ac27f3f86e78b14721d07c4f9ce999285f9aaa06";
const COLLATERAL_SWAP_IMPL = "029d584e847373b6373b01dfad1a0c9bfb916382";
const DEBT_SWAP_IMPL = "73e7af13ef172f13d8fefebfd90c7a6530096344";

describe("detectFlashLoanOrderType", () => {
  it("detects RepayWithCollateral from its EIP-1167 clone bytecode", () => {
    expect(detectFlashLoanOrderType(makeClone(REPAY_IMPL))).toBe(
      "RepayWithCollateral",
    );
  });

  it("detects CollateralSwap and DebtSwap from their clone bytecode", () => {
    expect(detectFlashLoanOrderType(makeClone(COLLATERAL_SWAP_IMPL))).toBe(
      "CollateralSwap",
    );
    expect(detectFlashLoanOrderType(makeClone(DEBT_SWAP_IMPL))).toBe(
      "DebtSwap",
    );
  });

  it("returns null for an unrecognised implementation", () => {
    expect(
      detectFlashLoanOrderType(makeClone("dead00000000000000000000000000000000beef")),
    ).toBeNull();
  });

  it("returns null when the bytecode is not an EIP-1167 clone", () => {
    expect(detectFlashLoanOrderType("0x")).toBeNull();
    expect(detectFlashLoanOrderType("0x60806040")).toBeNull();
  });

  it("returns null when the EIP-1167 suffix does not match", () => {
    const badSuffix =
      `0x${EIP1167_PREFIX}${REPAY_IMPL}deadbeefdeadbeefdeadbeefdeadbe` as `0x${string}`;
    expect(detectFlashLoanOrderType(badSuffix)).toBeNull();
  });
});

describe("decodeTradeData", () => {
  it("round-trips the non-indexed fields of a Trade event log", () => {
    const data = encodeAbiParameters(
      [
        { name: "sellToken", type: "address" },
        { name: "buyToken", type: "address" },
        { name: "sellAmount", type: "uint256" },
        { name: "buyAmount", type: "uint256" },
        { name: "feeAmount", type: "uint256" },
        { name: "orderUid", type: "bytes" },
      ],
      [SELL_TOKEN, BUY_TOKEN, 1000n, 900n, 5n, ORDER_UID],
    );

    const decoded = decodeTradeData(data);
    expect(decoded.sellToken).toBe(SELL_TOKEN);
    expect(decoded.buyToken).toBe(BUY_TOKEN);
    expect(decoded.sellAmount).toBe(1000n);
    expect(decoded.buyAmount).toBe(900n);
    expect(decoded.feeAmount).toBe(5n);
    expect(decoded.orderUid).toBe(ORDER_UID);
  });
});

describe("decodeValidToFromOrderUid", () => {
  it("reads validTo as the trailing uint32 of the order UID", () => {
    expect(decodeValidToFromOrderUid(makeOrderUid("ffffffff"))).toBe(
      4294967295,
    );
    expect(decodeValidToFromOrderUid(makeOrderUid("00000064"))).toBe(100);
  });
});
