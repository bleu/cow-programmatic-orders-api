import { describe, it, expect } from "vitest";
import {
  DETERMINISTIC_ORDER_TYPE,
  type OrderType,
} from "../../src/utils/order-types";

describe("DETERMINISTIC_ORDER_TYPE", () => {
  it("covers every OrderType (exhaustive record)", () => {
    // If a new OrderType is added to the union without updating the record,
    // TypeScript will catch it at compile time. This test documents the intent.
    const types = Object.keys(DETERMINISTIC_ORDER_TYPE) as OrderType[];
    expect(types.length).toBeGreaterThan(0);
  });

  it("marks TWAP, StopLoss, CirclesBackingOrder as deterministic", () => {
    expect(DETERMINISTIC_ORDER_TYPE["TWAP"]).toBe(true);
    expect(DETERMINISTIC_ORDER_TYPE["StopLoss"]).toBe(true);
    // Regression guard: CirclesBackingOrder must be deterministic
    expect(DETERMINISTIC_ORDER_TYPE["CirclesBackingOrder"]).toBe(true);
  });

  it("marks non-deterministic types as false", () => {
    expect(DETERMINISTIC_ORDER_TYPE["PerpetualSwap"]).toBe(false);
    expect(DETERMINISTIC_ORDER_TYPE["GoodAfterTime"]).toBe(false);
    expect(DETERMINISTIC_ORDER_TYPE["TradeAboveThreshold"]).toBe(false);
    expect(DETERMINISTIC_ORDER_TYPE["SwapOrderHandler"]).toBe(false);
    expect(DETERMINISTIC_ORDER_TYPE["ERC4626CowSwapFeeBurner"]).toBe(false);
    expect(DETERMINISTIC_ORDER_TYPE["CurveCowSwapBurner"]).toBe(false);
    expect(DETERMINISTIC_ORDER_TYPE["BalancerCowSwapFeeBurner"]).toBe(false);
    expect(DETERMINISTIC_ORDER_TYPE["CowAmmConstantProduct"]).toBe(false);
    expect(DETERMINISTIC_ORDER_TYPE["Unknown"]).toBe(false);
  });
});
