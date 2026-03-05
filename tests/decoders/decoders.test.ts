import { describe, it, expect } from "vitest";
import { encodeAbiParameters, type Hex } from "viem";
import {
  decodeTwapStaticInput,
  decodeStopLossStaticInput,
  decodePerpetualSwapStaticInput,
  decodeGoodAfterTimeStaticInput,
  decodeTradeAboveThresholdStaticInput,
  decodeStaticInput,
} from "../../src/decoders/index";

const ADDR_A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const;
const ADDR_B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as const;
const ADDR_C = "0xcccccccccccccccccccccccccccccccccccccccc" as const;
const APP_DATA = ("0x" + "ab".repeat(32)) as `0x${string}`;

describe("decodeTwapStaticInput", () => {
  it("round-trips all fields", () => {
    const encoded = encodeAbiParameters(
      [{ type: "tuple", components: [
        { name: "sellToken",      type: "address" },
        { name: "buyToken",       type: "address" },
        { name: "receiver",       type: "address" },
        { name: "partSellAmount", type: "uint256" },
        { name: "minPartLimit",   type: "uint256" },
        { name: "t0",             type: "uint256" },
        { name: "n",              type: "uint256" },
        { name: "t",              type: "uint256" },
        { name: "span",           type: "uint256" },
        { name: "appData",        type: "bytes32" },
      ]}],
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
      [{ type: "tuple", components: [
        { name: "sellToken",                    type: "address" },
        { name: "buyToken",                     type: "address" },
        { name: "sellAmount",                   type: "uint256" },
        { name: "buyAmount",                    type: "uint256" },
        { name: "appData",                      type: "bytes32" },
        { name: "receiver",                     type: "address" },
        { name: "isSellOrder",                  type: "bool"    },
        { name: "isPartiallyFillable",          type: "bool"    },
        { name: "validTo",                      type: "uint32"  },
        { name: "sellTokenPriceOracle",         type: "address" },
        { name: "buyTokenPriceOracle",          type: "address" },
        { name: "strike",                       type: "int256"  },
        { name: "maxTimeSinceLastOracleUpdate", type: "uint256" },
      ]}],
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
      [{ type: "tuple", components: [
        { name: "tokenA",                type: "address" },
        { name: "tokenB",                type: "address" },
        { name: "validityBucketSeconds", type: "uint32"  },
        { name: "halfSpreadBps",         type: "uint256" },
        { name: "appData",               type: "bytes32" },
      ]}],
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
      [{ type: "tuple", components: [
        { name: "sellToken",           type: "address" },
        { name: "buyToken",            type: "address" },
        { name: "receiver",            type: "address" },
        { name: "sellAmount",          type: "uint256" },
        { name: "minSellBalance",      type: "uint256" },
        { name: "startTime",           type: "uint256" },
        { name: "endTime",             type: "uint256" },
        { name: "allowPartialFill",    type: "bool"    },
        { name: "priceCheckerPayload", type: "bytes"   },
        { name: "appData",             type: "bytes32" },
      ]}],
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
      [{ type: "tuple", components: [
        { name: "sellToken",             type: "address" },
        { name: "buyToken",              type: "address" },
        { name: "receiver",              type: "address" },
        { name: "validityBucketSeconds", type: "uint32"  },
        { name: "threshold",             type: "uint256" },
        { name: "appData",               type: "bytes32" },
      ]}],
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

describe("decodeStaticInput error handling", () => {
  it("throws on malformed staticInput for a known type", () => {
    expect(() => decodeTwapStaticInput("0xdeadbeef")).toThrow();
  });

  it("returns null for Unknown order type", () => {
    const result = decodeStaticInput("Unknown", "0x1234" as Hex);
    expect(result).toBeNull();
  });
});
