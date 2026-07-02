import { describe, it, expect } from "vitest";
import {
  DETERMINISTIC_ORDER_TYPE,
  NON_DETERMINISTIC_TYPES,
  isNonDeterministic,
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

describe("NON_DETERMINISTIC_TYPES / isNonDeterministic", () => {
  it("is the exact complement of DETERMINISTIC_ORDER_TYPE (derived, no drift)", () => {
    const expected = (Object.keys(DETERMINISTIC_ORDER_TYPE) as OrderType[]).filter(
      (t) => !DETERMINISTIC_ORDER_TYPE[t],
    );
    expect([...NON_DETERMINISTIC_TYPES].sort()).toEqual([...expected].sort());
  });

  it("isNonDeterministic agrees with the deterministic record for every type", () => {
    for (const t of Object.keys(DETERMINISTIC_ORDER_TYPE) as OrderType[]) {
      expect(isNonDeterministic(t)).toBe(!DETERMINISTIC_ORDER_TYPE[t]);
    }
  });

  it("includes SwapOrderHandler and ERC4626CowSwapFeeBurner (drift-fix regression guard)", () => {
    // The old hand-listed OwnerBackfill set omitted these two non-deterministic types,
    // so their history was never backfilled. Deriving from the record covers them.
    expect(NON_DETERMINISTIC_TYPES).toContain("SwapOrderHandler");
    expect(NON_DETERMINISTIC_TYPES).toContain("ERC4626CowSwapFeeBurner");
  });

  it("excludes deterministic types", () => {
    expect(NON_DETERMINISTIC_TYPES).not.toContain("TWAP");
    expect(NON_DETERMINISTIC_TYPES).not.toContain("StopLoss");
    expect(NON_DETERMINISTIC_TYPES).not.toContain("CirclesBackingOrder");
  });
});
