import { describe, it, expect } from "vitest";
import { encodeAbiParameters } from "viem";
import {
  detectFlashLoanOrderType,
  decodeValidToFromOrderUid,
  decodeTradeData,
  normalizeHookData,
} from "../../src/decoders/flash-loan-order";

const KIND_SELL =
  "0xf3b277728b3fee749481eb3e0b3b48980dbbab78658fc419025cb16eee346775" as const;
const KIND_BUY =
  "0x6ed88e868af0a1983e3886d5f3e95a2fafbd6c3450bc229e27342283dc429ccc" as const;

const makeHookData = (overrides: Record<string, unknown> = {}) => ({
  owner: "0x3EBC89534D84Ca51987Af62EBCc7B356BFd65728" as `0x${string}`,
  receiver: "0xDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD" as `0x${string}`,
  sellToken: SELL_TOKEN,
  buyToken: BUY_TOKEN,
  sellAmount: 1000n,
  buyAmount: 900n,
  kind: KIND_SELL,
  validTo: 1700000000n,
  flashLoanAmount: 500n,
  flashLoanFeeAmount: 3n,
  hookSellTokenAmount: 0n,
  hookBuyTokenAmount: 0n,
  ...overrides,
});

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

describe("normalizeHookData", () => {
  it("maps a sell-kind hook tuple to nullable enrichment fields", () => {
    const r = normalizeHookData(makeHookData());
    expect(r.owner).toBe("0x3ebc89534d84ca51987af62ebcc7b356bfd65728");
    expect(r.receiver).toBe("0xdddddddddddddddddddddddddddddddddddddddd");
    expect(r.kind).toBe("sell");
    expect(r.sellAmountIntended).toBe("1000");
    expect(r.buyAmountIntended).toBe("900");
    expect(r.flashLoanAmount).toBe("500");
    expect(r.flashLoanFeeAmount).toBe("3");
  });

  it("maps buy kind, and an unrecognised kind hash to null", () => {
    expect(normalizeHookData(makeHookData({ kind: KIND_BUY })).kind).toBe(
      "buy",
    );
    expect(
      normalizeHookData(makeHookData({ kind: `0x${"00".repeat(32)}` })).kind,
    ).toBeNull();
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
