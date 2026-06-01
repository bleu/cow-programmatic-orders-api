import { describe, it, expect } from "vitest";
import { encodeAbiParameters, type Hex } from "viem";
import {
  decodeTwapStaticInput,
  decodeStopLossStaticInput,
  decodePerpetualSwapStaticInput,
  decodeGoodAfterTimeStaticInput,
  decodeTradeAboveThresholdStaticInput,
  decodeCirclesBackingOrderStaticInput,
  decodeSwapOrderHandlerStaticInput,
  decodeErc4626CowSwapFeeBurnerStaticInput,
  decodeStaticInput,
} from "../../src/decoders/index";
import { TWAP_ABI } from "../../src/decoders/twap";
import { STOP_LOSS_ABI } from "../../src/decoders/stop-loss";
import { PERPETUAL_SWAP_ABI } from "../../src/decoders/perpetual-swap";
import { GOOD_AFTER_TIME_ABI } from "../../src/decoders/good-after-time";
import { TRADE_ABOVE_THRESHOLD_ABI } from "../../src/decoders/trade-above-threshold";
import { CIRCLES_BACKING_ORDER_ABI } from "../../src/decoders/circles-backing-order";
import { SWAP_ORDER_HANDLER_ABI } from "../../src/decoders/swap-order-handler";

const ADDR_A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const;
const ADDR_B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as const;
const ADDR_C = "0xcccccccccccccccccccccccccccccccccccccccc" as const;
const APP_DATA = ("0x" + "ab".repeat(32)) as `0x${string}`;

describe("decodeTwapStaticInput", () => {
  it("round-trips all fields", () => {
    const encoded = encodeAbiParameters(
      TWAP_ABI,
      [{ sellToken: ADDR_A, buyToken: ADDR_B, receiver: ADDR_C,
         partSellAmount: 1000n, minPartLimit: 900n, t0: 1700000000n,
         n: 6n, t: 3600n, span: 0n, appData: APP_DATA }]
    );
    const result = decodeTwapStaticInput(encoded);
    expect(result.sellToken).toBe(ADDR_A);
    expect(result.buyToken).toBe(ADDR_B);
    expect(result.receiver).toBe(ADDR_C);
    expect(result.partSellAmount).toBe(1000n);
    expect(result.minPartLimit).toBe(900n);
    expect(result.t0).toBe(1700000000n);
    expect(result.n).toBe(6n);
    expect(result.t).toBe(3600n);
    expect(result.span).toBe(0n);
    expect(result.appData).toBe(APP_DATA);
  });
});

describe("decodeStopLossStaticInput", () => {
  it("round-trips all fields including signed strike", () => {
    const encoded = encodeAbiParameters(
      STOP_LOSS_ABI,
      [{ sellToken: ADDR_A, buyToken: ADDR_B, sellAmount: 500n, buyAmount: 400n,
         appData: APP_DATA, receiver: ADDR_C, isSellOrder: true,
         isPartiallyFillable: false, validTo: 86400, sellTokenPriceOracle: ADDR_A,
         buyTokenPriceOracle: ADDR_B, strike: -1000n,
         maxTimeSinceLastOracleUpdate: 3600n }]
    );
    const result = decodeStopLossStaticInput(encoded);
    expect(result.isSellOrder).toBe(true);
    expect(result.isPartiallyFillable).toBe(false);
    expect(result.strike).toBe(-1000n);  // signed
    expect(result.validTo).toBe(86400);
    expect(result.maxTimeSinceLastOracleUpdate).toBe(3600n);
  });
});

describe("decodePerpetualSwapStaticInput", () => {
  it("round-trips all fields", () => {
    const encoded = encodeAbiParameters(
      PERPETUAL_SWAP_ABI,
      [{ tokenA: ADDR_A, tokenB: ADDR_B, validityBucketSeconds: 900,
         halfSpreadBps: 5n, appData: APP_DATA }]
    );
    const result = decodePerpetualSwapStaticInput(encoded);
    expect(result.tokenA).toBe(ADDR_A);
    expect(result.tokenB).toBe(ADDR_B);
    expect(result.validityBucketSeconds).toBe(900);
    expect(result.halfSpreadBps).toBe(5n);
  });
});

describe("decodeGoodAfterTimeStaticInput", () => {
  it("round-trips including dynamic bytes field", () => {
    const payload = "0xdeadbeef" as `0x${string}`;
    const encoded = encodeAbiParameters(
      GOOD_AFTER_TIME_ABI,
      [{ sellToken: ADDR_A, buyToken: ADDR_B, receiver: ADDR_C,
         sellAmount: 200n, minSellBalance: 50n,
         startTime: 1700000000n, endTime: 1700086400n,
         allowPartialFill: true, priceCheckerPayload: payload,
         appData: APP_DATA }]
    );
    const result = decodeGoodAfterTimeStaticInput(encoded);
    expect(result.allowPartialFill).toBe(true);
    expect(result.priceCheckerPayload).toBe(payload);
    expect(result.startTime).toBe(1700000000n);
    expect(result.endTime).toBe(1700086400n);
  });
});

describe("decodeTradeAboveThresholdStaticInput", () => {
  it("round-trips all fields", () => {
    const encoded = encodeAbiParameters(
      TRADE_ABOVE_THRESHOLD_ABI,
      [{ sellToken: ADDR_A, buyToken: ADDR_B, receiver: ADDR_C,
         validityBucketSeconds: 1800, threshold: 1000000n,
         appData: APP_DATA }]
    );
    const result = decodeTradeAboveThresholdStaticInput(encoded);
    expect(result.threshold).toBe(1000000n);
    expect(result.validityBucketSeconds).toBe(1800);
    expect(result.receiver).toBe(ADDR_C);
  });
});

describe("decodeCirclesBackingOrderStaticInput", () => {
  it("round-trips all four fields", () => {
    const encoded = encodeAbiParameters(
      CIRCLES_BACKING_ORDER_ABI,
      [{ buyToken: ADDR_A, buyAmount: 12345n, validTo: 1800000000, appData: APP_DATA }],
    );
    const result = decodeCirclesBackingOrderStaticInput(encoded);
    expect(result.buyToken).toBe(ADDR_A);
    expect(result.buyAmount).toBe(12345n);
    expect(result.validTo).toBe(1800000000);
    expect(result.appData).toBe(APP_DATA);
  });

  it("throws on malformed input", () => {
    expect(() => decodeCirclesBackingOrderStaticInput("0xdeadbeef")).toThrow();
  });
});

describe("decodeSwapOrderHandlerStaticInput", () => {
  it("round-trips all five fields", () => {
    const encoded = encodeAbiParameters(
      SWAP_ORDER_HANDLER_ABI,
      [{ sellToken: ADDR_A, buyToken: ADDR_B, receiver: ADDR_C,
         validityPeriod: 86400, appData: APP_DATA }],
    );
    const result = decodeSwapOrderHandlerStaticInput(encoded);
    expect(result.sellToken).toBe(ADDR_A);
    expect(result.buyToken).toBe(ADDR_B);
    expect(result.receiver).toBe(ADDR_C);
    expect(result.validityPeriod).toBe(86400);
    expect(result.appData).toBe(APP_DATA);
  });

  it("throws on malformed input", () => {
    expect(() => decodeSwapOrderHandlerStaticInput("0xdeadbeef")).toThrow();
  });
});

describe("decodeErc4626CowSwapFeeBurnerStaticInput", () => {
  it("round-trips a single address", () => {
    const encoded = encodeAbiParameters(
      [{ name: "tokenIn", type: "address" }] as const,
      [ADDR_A],
    );
    const result = decodeErc4626CowSwapFeeBurnerStaticInput(encoded);
    expect(result.tokenIn).toBe(ADDR_A);
  });

  it("throws on malformed input", () => {
    expect(() => decodeErc4626CowSwapFeeBurnerStaticInput("0xdeadbeef")).toThrow();
  });
});

describe("decodeStaticInput error handling", () => {
  it("throws on malformed staticInput for a known type", () => {
    expect(() => decodeTwapStaticInput("0xdeadbeef")).toThrow();
  });

  it("returns null for Unknown order type", () => {
    const result = decodeStaticInput("Unknown", "0x1234" as Hex);
    expect(result).toBeNull();
  });
});
