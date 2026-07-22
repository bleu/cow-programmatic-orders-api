import { describe, expect, it, vi } from "vitest";
import type { Context } from "ponder:registry";

vi.mock("ponder:schema", () => ({
  conditionalOrderGenerator: {},
  discreteOrder: {
    conditionalOrderGeneratorId: "conditionalOrderGeneratorId",
    chainId: "chainId",
    executedSellAmount: "executedSellAmount",
    executedBuyAmount: "executedBuyAmount",
    executedFeeAmount: "executedFeeAmount",
  },
}));

vi.mock("ponder", () => ({
  and: vi.fn(),
  eq: vi.fn(),
  inArray: vi.fn(),
  sql: vi.fn(),
}));

import { refreshGeneratorExecutedAmounts } from "../../src/application/helpers/executedAmounts";

function makeContext(
  rows: {
    generatorId: string;
    executedSellAmount: string;
    executedBuyAmount: string;
    executedFeeAmount: string;
  }[],
) {
  const groupBy = vi.fn().mockResolvedValue(rows);
  const where = vi.fn(() => ({ groupBy }));
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

describe("refreshGeneratorExecutedAmounts", () => {
  it("updates each parent once and resets parents without parts", async () => {
    const { context, update, set } = makeContext([
      {
        generatorId: "generator-a",
        executedSellAmount: "100",
        executedBuyAmount: "90",
        executedFeeAmount: "2",
      },
    ]);

    await refreshGeneratorExecutedAmounts(context, 100, [
      "generator-a",
      "generator-a",
      "generator-b",
    ]);

    expect(update).toHaveBeenCalledTimes(2);
    expect(update).toHaveBeenNthCalledWith(1, {}, { chainId: 100, eventId: "generator-a" });
    expect(update).toHaveBeenNthCalledWith(2, {}, { chainId: 100, eventId: "generator-b" });
    expect(set).toHaveBeenNthCalledWith(1, {
      executedSellAmount: "100",
      executedBuyAmount: "90",
      executedFeeAmount: "2",
    });
    expect(set).toHaveBeenNthCalledWith(2, {
      executedSellAmount: "0",
      executedBuyAmount: "0",
      executedFeeAmount: "0",
    });
  });

  it("does nothing without affected parents", async () => {
    const { context, select, update } = makeContext([]);

    await refreshGeneratorExecutedAmounts(context, 100, []);

    expect(select).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });
});
