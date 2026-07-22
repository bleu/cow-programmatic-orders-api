import { describe, it, expect, vi } from "vitest";
import type { Context } from "ponder:registry";

// Mock virtual modules before the helper (which imports them) is loaded.
vi.mock("ponder", () => ({
  and: (...args: unknown[]) => ({ op: "and", args }),
  eq: (column: unknown, value: unknown) => ({ op: "eq", column, value }),
  inArray: (column: unknown, values: unknown[]) => ({ op: "inArray", column, values }),
}));
vi.mock("ponder:schema", () => {
  const conditionalOrderGenerator = { chainId: "chainId", eventId: "eventId" };
  return { conditionalOrderGenerator, default: { conditionalOrderGenerator } };
});

import { bumpGeneratorsUpdatedAt } from "../../src/application/helpers/updatedAtBlock";

type RecordedUpdate = { set?: Record<string, unknown>; where?: unknown };

/** Minimal Ponder context stub recording update(...).set(...).where(...) chains. */
function makeContext(): { context: Context; updates: RecordedUpdate[] } {
  const updates: RecordedUpdate[] = [];
  const sqlDb = {
    update: (_table: unknown) => {
      const call: RecordedUpdate = {};
      updates.push(call);
      return {
        set: (values: Record<string, unknown>) => {
          call.set = values;
          return {
            where: async (condition: unknown) => {
              call.where = condition;
            },
          };
        },
      };
    },
  };
  return { context: { db: { sql: sqlDb } } as unknown as Context, updates };
}

describe("bumpGeneratorsUpdatedAt", () => {
  it("issues no update when there are no generator ids", async () => {
    const { context, updates } = makeContext();
    await bumpGeneratorsUpdatedAt(context, 1, [], 123n);
    expect(updates.length).toBe(0);
  });

  it("bumps repeated ids once, in a single chain-scoped bulk update", async () => {
    const { context, updates } = makeContext();
    await bumpGeneratorsUpdatedAt(context, 100, ["gen-a", "gen-b", "gen-a"], 456n);

    expect(updates.length).toBe(1);
    expect(updates[0]!.set).toEqual({ updatedAtBlock: 456n });

    const where = updates[0]!.where as { op: string; args: Array<{ op: string; column: unknown; value?: unknown; values?: unknown[] }> };
    expect(where.op).toBe("and");
    const chainCondition = where.args.find((a) => a.op === "eq");
    expect(chainCondition?.value).toBe(100);
    const idCondition = where.args.find((a) => a.op === "inArray");
    expect(idCondition?.values).toEqual(["gen-a", "gen-b"]);
  });
});
