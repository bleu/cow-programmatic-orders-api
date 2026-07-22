import { describe, it, expect } from "vitest";
import { mapWithConcurrency } from "../../src/application/helpers/concurrency";

describe("mapWithConcurrency", () => {
  it("runs every item and returns results in input order", async () => {
    const results = await mapWithConcurrency([1, 2, 3], 2, async (n) => n * 10);
    expect(results).toEqual([10, 20, 30]);
  });

  it("never runs more than `limit` workers at once", async () => {
    let active = 0;
    let maxActive = 0;
    const items = [1, 2, 3, 4, 5, 6];

    const results = await mapWithConcurrency(items, 2, async (n) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return n;
    });

    expect(maxActive).toBeLessThanOrEqual(2);
    expect(results).toEqual(items);
  });

  it("propagates a worker rejection", async () => {
    const boom = new Error("boom");
    await expect(
      mapWithConcurrency([1, 2, 3], 2, async (n) => {
        if (n === 2) throw boom;
        return n;
      }),
    ).rejects.toBe(boom);
  });

  it("with concurrency 1, a rejection halts the remaining items", async () => {
    const started: number[] = [];
    await expect(
      mapWithConcurrency([1, 2, 3, 4, 5, 6], 1, async (n) => {
        started.push(n);
        if (n === 2) throw new Error("boom");
        return n;
      }),
    ).rejects.toThrow("boom");

    // Single runner: the throw breaks its loop, so items 3..6 never start.
    expect(started).toEqual([1, 2]);
  });

  it("returns an empty array without calling the worker for empty input", async () => {
    let calls = 0;
    const results = await mapWithConcurrency([], 3, async (n) => {
      calls++;
      return n;
    });
    expect(results).toEqual([]);
    expect(calls).toBe(0);
  });
});
