import { describe, expect, it, vi } from "vitest";
import type { Context } from "ponder:registry";

vi.mock("ponder:schema", () => ({
  conditionalOrderGenerator: {
    eventId: "eventId",
    chainId: "chainId",
    orderType: "orderType",
  },
  discreteOrder: {
    conditionalOrderGeneratorId: "conditionalOrderGeneratorId",
    chainId: "chainId",
    executedSellAmount: "executedSellAmount",
    executedBuyAmount: "executedBuyAmount",
    executedFee: "executedFee",
  },
}));

vi.mock("ponder", () => ({
  and: vi.fn(),
  eq: vi.fn(),
  inArray: vi.fn(),
  sql: vi.fn(),
}));

import { refreshTwapExecutedTotals } from "../../src/application/helpers/executedAmounts";

/** Fake context: the first select resolves the generator-type lookup, the
 *  second (with .groupBy) resolves the per-generator aggregate. */
function makeContext(
  generators: { eventId: string; orderType: string }[],
  totals: {
    generatorId: string;
    executedSellAmount: string;
    executedBuyAmount: string;
    executedFee: string;
  }[],
) {
  let selectCalls = 0;
  const groupBy = vi.fn().mockResolvedValue(totals);
  const where = vi.fn(() => {
    selectCalls++;
    if (selectCalls === 1) return Promise.resolve(generators);
    return { groupBy };
  });
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  const set = vi.fn().mockResolvedValue(undefined);
  const update = vi.fn(() => ({ set }));

  return {
    context: { db: { sql: { select }, update } } as unknown as Context,
    select,
    update,
    set,
  };
}

describe("refreshTwapExecutedTotals", () => {
  it("writes totals for TWAP parents and zeros for TWAP parents without parts", async () => {
    const { context, update, set } = makeContext(
      [
        { eventId: "generator-a", orderType: "TWAP" },
        { eventId: "generator-b", orderType: "TWAP" },
      ],
      [
        {
          generatorId: "generator-a",
          executedSellAmount: "100",
          executedBuyAmount: "90",
          executedFee: "2",
        },
      ],
    );

    await refreshTwapExecutedTotals(context, 100, [
      "generator-a",
      "generator-a",
      "generator-b",
    ]);

    expect(update).toHaveBeenCalledTimes(2);
    expect(update).toHaveBeenNthCalledWith(1, expect.anything(), { chainId: 100, eventId: "generator-a" });
    expect(update).toHaveBeenNthCalledWith(2, expect.anything(), { chainId: 100, eventId: "generator-b" });
    expect(set).toHaveBeenNthCalledWith(1, {
      additionalData: {
        executedSellAmount: "100",
        executedBuyAmount: "90",
        executedFee: "2",
      },
    });
    expect(set).toHaveBeenNthCalledWith(2, {
      additionalData: {
        executedSellAmount: "0",
        executedBuyAmount: "0",
        executedFee: "0",
      },
    });
  });

  it("skips non-TWAP parents entirely", async () => {
    const { context, select, update } = makeContext(
      [{ eventId: "generator-swap", orderType: "PerpetualSwap" }],
      [],
    );

    await refreshTwapExecutedTotals(context, 100, ["generator-swap"]);

    expect(select).toHaveBeenCalledTimes(1); // type lookup only, no aggregate
    expect(update).not.toHaveBeenCalled();
  });

  it("does nothing without affected parents", async () => {
    const { context, select, update } = makeContext([], []);

    await refreshTwapExecutedTotals(context, 100, []);

    expect(select).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });
});
