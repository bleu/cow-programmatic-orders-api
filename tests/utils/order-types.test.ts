import { describe, it, expect } from "vitest";
import {
  DETERMINISTIC_ORDER_TYPES,
  isDeterministicOrderType,
} from "../../src/utils/order-types";

describe("DETERMINISTIC_ORDER_TYPES", () => {
  it("includes TWAP", () => {
    expect(DETERMINISTIC_ORDER_TYPES.has("TWAP")).toBe(true);
  });

  it("includes StopLoss", () => {
    expect(DETERMINISTIC_ORDER_TYPES.has("StopLoss")).toBe(true);
  });

  // Regression guard for COW-1003 (F2): CirclesBackingOrder is deterministic
  // (precomputed in uidPrecompute.ts) but was missing from this set, causing
  // spurious non-deterministic warnings in logs.
  it("includes CirclesBackingOrder (COW-1003)", () => {
    expect(DETERMINISTIC_ORDER_TYPES.has("CirclesBackingOrder")).toBe(true);
  });

  it("does not include non-deterministic types", () => {
    expect(DETERMINISTIC_ORDER_TYPES.has("PerpetualSwap")).toBe(false);
    expect(DETERMINISTIC_ORDER_TYPES.has("GoodAfterTime")).toBe(false);
    expect(DETERMINISTIC_ORDER_TYPES.has("TradeAboveThreshold")).toBe(false);
  });

  it("isDeterministicOrderType returns true for all members", () => {
    for (const type of DETERMINISTIC_ORDER_TYPES) {
      expect(isDeterministicOrderType(type)).toBe(true);
    }
  });

  it("isDeterministicOrderType returns false for unknown types", () => {
    expect(isDeterministicOrderType("Unknown")).toBe(false);
    expect(isDeterministicOrderType("")).toBe(false);
  });
});
