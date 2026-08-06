import { describe, it, expect, afterEach } from "vitest";
import {
  DEFAULT_MAX_LAG_SECONDS,
  describeStaleChains,
  findStaleChains,
  maxLagSecondsFor,
} from "../../src/api/freshness";
import type { ChainConfig } from "../../src/chains/types";

const NOW = 1_786_003_795;

// Only the two fields findStaleChains reads.
const CHAINS = [
  { name: "mainnet", chainId: 1 },
  { name: "gnosis", chainId: 100 },
] as unknown as ChainConfig[];

function gauges(entries: Record<string, number>) {
  return new Map(Object.entries(entries));
}

const FRESH_TIMESTAMPS = gauges({ mainnet: NOW - 20, gnosis: NOW - 15 });
const BLOCK_NUMBERS = gauges({ mainnet: 25_694_617, gnosis: 47_582_895 });

afterEach(() => {
  delete process.env.READINESS_MAX_LAG_SECONDS;
  delete process.env.READINESS_MAX_LAG_SECONDS_1;
  delete process.env.READINESS_MAX_LAG_SECONDS_100;
});

describe("maxLagSecondsFor", () => {
  it("falls back to the default when nothing is configured", () => {
    expect(maxLagSecondsFor(1)).toBe(DEFAULT_MAX_LAG_SECONDS);
  });

  it("prefers the per-chain override over the global one", () => {
    process.env.READINESS_MAX_LAG_SECONDS = "120";
    process.env.READINESS_MAX_LAG_SECONDS_1 = "600";
    expect(maxLagSecondsFor(1)).toBe(600);
    expect(maxLagSecondsFor(100)).toBe(120);
  });

  it("ignores unparseable and non-positive values", () => {
    process.env.READINESS_MAX_LAG_SECONDS = "not-a-number";
    expect(maxLagSecondsFor(1)).toBe(DEFAULT_MAX_LAG_SECONDS);
    process.env.READINESS_MAX_LAG_SECONDS = "0";
    expect(maxLagSecondsFor(1)).toBe(DEFAULT_MAX_LAG_SECONDS);
  });
});

describe("findStaleChains", () => {
  it("reports nothing while every chain is near the tip", () => {
    expect(
      findStaleChains(FRESH_TIMESTAMPS, BLOCK_NUMBERS, NOW, CHAINS),
    ).toEqual([]);
  });

  it("flags a chain whose newest block has aged past the budget", () => {
    // The production failure: sync froze and the block timestamp stopped moving.
    const timestamps = gauges({ mainnet: NOW - 16_670, gnosis: NOW - 10 });

    const stale = findStaleChains(timestamps, BLOCK_NUMBERS, NOW, CHAINS);

    expect(stale).toEqual([
      {
        chain: "mainnet",
        blockNumber: 25_694_617,
        lagSeconds: 16_670,
        maxLagSeconds: DEFAULT_MAX_LAG_SECONDS,
      },
    ]);
  });

  it("flags every stalled chain, not just the first", () => {
    const timestamps = gauges({ mainnet: NOW - 16_670, gnosis: NOW - 16_671 });

    expect(
      findStaleChains(timestamps, BLOCK_NUMBERS, NOW, CHAINS).map((s) => s.chain),
    ).toEqual(["mainnet", "gnosis"]);
  });

  it("treats a chain missing from the metrics as stale", () => {
    const stale = findStaleChains(
      gauges({ mainnet: NOW - 20 }),
      gauges({ mainnet: 25_694_617 }),
      NOW,
      CHAINS,
    );

    expect(stale).toEqual([
      {
        chain: "gnosis",
        blockNumber: null,
        lagSeconds: null,
        maxLagSeconds: DEFAULT_MAX_LAG_SECONDS,
      },
    ]);
  });

  it("treats an empty metrics scrape as stale rather than fresh", () => {
    expect(
      findStaleChains(gauges({}), gauges({}), NOW, CHAINS),
    ).toHaveLength(2);
  });

  it("stays fresh right at the budget and turns stale one second past it", () => {
    const atBudget = gauges({
      mainnet: NOW - DEFAULT_MAX_LAG_SECONDS,
      gnosis: NOW,
    });
    expect(findStaleChains(atBudget, BLOCK_NUMBERS, NOW, CHAINS)).toEqual([]);

    const pastBudget = gauges({
      mainnet: NOW - DEFAULT_MAX_LAG_SECONDS - 1,
      gnosis: NOW,
    });
    expect(
      findStaleChains(pastBudget, BLOCK_NUMBERS, NOW, CHAINS),
    ).toHaveLength(1);
  });

  it("honours a per-chain budget", () => {
    process.env.READINESS_MAX_LAG_SECONDS_100 = "30";
    const timestamps = gauges({ mainnet: NOW - 60, gnosis: NOW - 60 });

    expect(
      findStaleChains(timestamps, BLOCK_NUMBERS, NOW, CHAINS).map((s) => s.chain),
    ).toEqual(["gnosis"]);
  });
});

describe("describeStaleChains", () => {
  it("names the block and its age", () => {
    const message = describeStaleChains([
      {
        chain: "mainnet",
        blockNumber: 25_694_617,
        lagSeconds: 16_670,
        maxLagSeconds: 300,
      },
    ]);

    expect(message).toBe(
      "Chain sync is stalled — mainnet: block 25694617 is 16670s old (max 300s).",
    );
  });

  it("distinguishes a chain that reported no block at all", () => {
    const message = describeStaleChains([
      { chain: "gnosis", blockNumber: null, lagSeconds: null, maxLagSeconds: 300 },
    ]);

    expect(message).toBe("Chain sync is stalled — gnosis: no synced block reported.");
  });
});
