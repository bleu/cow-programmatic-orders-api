import { describe, it, expect, vi, afterEach } from "vitest";
import {
  DEFAULT_MAX_LAG_SECONDS,
  describeStaleChains,
  fetchChainStatus,
  findStaleChains,
  maxLagSecondsFor,
  type ChainStatus,
} from "../../src/api/freshness";
import type { ChainConfig } from "../../src/chains/types";

const NOW = 1_786_024_484;

// Only the two fields findStaleChains reads.
const CHAINS = [
  { name: "mainnet", chainId: 1 },
  { name: "gnosis", chainId: 100 },
] as unknown as ChainConfig[];

/** Shape copied from a live /status response. */
function status(
  entries: Record<string, { number: number; timestamp: number }>,
): ChainStatus {
  return Object.fromEntries(
    Object.entries(entries).map(([chain, block]) => [chain, { block }]),
  );
}

const FRESH = status({
  mainnet: { number: 25_696_339, timestamp: NOW - 21 },
  gnosis: { number: 47_586_912, timestamp: NOW - 14 },
});

afterEach(() => {
  delete process.env.READINESS_MAX_LAG_SECONDS;
  delete process.env.READINESS_MAX_LAG_SECONDS_1;
  delete process.env.READINESS_MAX_LAG_SECONDS_100;
  vi.unstubAllGlobals();
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

describe("fetchChainStatus", () => {
  it("returns the parsed payload", async () => {
    const body = {
      mainnet: { id: 1, block: { number: 25_696_339, timestamp: NOW - 21 } },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve({ ok: true, json: () => Promise.resolve(body) } as Response),
      ),
    );

    await expect(fetchChainStatus("http://localhost:3000")).resolves.toEqual(body);
  });

  it("returns an empty payload on a non-200, so every chain reads as stale", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve({ ok: false } as Response)),
    );

    await expect(fetchChainStatus("http://localhost:3000")).resolves.toEqual({});
  });

  it("returns an empty payload when the request throws", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("ECONNREFUSED"))),
    );

    await expect(fetchChainStatus("http://localhost:3000")).resolves.toEqual({});
  });
});

describe("findStaleChains", () => {
  it("reports nothing while every chain is near the tip", () => {
    expect(findStaleChains(FRESH, NOW, CHAINS)).toEqual([]);
  });

  it("flags a chain whose newest block has aged past the budget", () => {
    // The production failure: sync froze and the checkpoint stopped moving.
    const frozen = status({
      mainnet: { number: 25_694_617, timestamp: NOW - 16_670 },
      gnosis: { number: 47_586_912, timestamp: NOW - 10 },
    });

    expect(findStaleChains(frozen, NOW, CHAINS)).toEqual([
      {
        chain: "mainnet",
        blockNumber: 25_694_617,
        lagSeconds: 16_670,
        maxLagSeconds: DEFAULT_MAX_LAG_SECONDS,
      },
    ]);
  });

  it("flags every stalled chain, not just the first", () => {
    const frozen = status({
      mainnet: { number: 25_694_617, timestamp: NOW - 16_670 },
      gnosis: { number: 47_582_895, timestamp: NOW - 16_671 },
    });

    expect(findStaleChains(frozen, NOW, CHAINS).map((s) => s.chain)).toEqual([
      "mainnet",
      "gnosis",
    ]);
  });

  it("treats a chain missing from the payload as stale", () => {
    const partial = status({
      mainnet: { number: 25_696_339, timestamp: NOW - 21 },
    });

    expect(findStaleChains(partial, NOW, CHAINS)).toEqual([
      {
        chain: "gnosis",
        blockNumber: null,
        lagSeconds: null,
        maxLagSeconds: DEFAULT_MAX_LAG_SECONDS,
      },
    ]);
  });

  it("treats an unreachable /status as stale rather than fresh", () => {
    expect(findStaleChains({}, NOW, CHAINS)).toHaveLength(2);
  });

  it("treats a malformed entry as stale", () => {
    const malformed = { mainnet: { block: null }, gnosis: null } as ChainStatus;

    expect(findStaleChains(malformed, NOW, CHAINS)).toHaveLength(2);
  });

  it("stays fresh right at the budget and turns stale one second past it", () => {
    const atBudget = status({
      mainnet: { number: 1, timestamp: NOW - DEFAULT_MAX_LAG_SECONDS },
      gnosis: { number: 2, timestamp: NOW },
    });
    expect(findStaleChains(atBudget, NOW, CHAINS)).toEqual([]);

    const pastBudget = status({
      mainnet: { number: 1, timestamp: NOW - DEFAULT_MAX_LAG_SECONDS - 1 },
      gnosis: { number: 2, timestamp: NOW },
    });
    expect(findStaleChains(pastBudget, NOW, CHAINS)).toHaveLength(1);
  });

  it("honours a per-chain budget", () => {
    process.env.READINESS_MAX_LAG_SECONDS_100 = "30";
    const lagging = status({
      mainnet: { number: 1, timestamp: NOW - 60 },
      gnosis: { number: 2, timestamp: NOW - 60 },
    });

    expect(findStaleChains(lagging, NOW, CHAINS).map((s) => s.chain)).toEqual([
      "gnosis",
    ]);
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

    expect(message).toBe("Chain sync is stalled — gnosis: no indexed block reported.");
  });
});
