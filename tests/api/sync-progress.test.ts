import { describe, it, expect, vi, afterEach } from "vitest";
import { Hono } from "hono";
import { syncProgressHandler } from "../../src/api/endpoints/sync-progress";

type ChainProgress = {
  totalBlocks: number;
  processedBlocks: number;
  historicalBlocksFetchedPct: number;
  isRealtime: boolean;
  isComplete: boolean;
};

function buildApp() {
  const app = new Hono();
  app.get("/api/sync-progress", (c) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    syncProgressHandler(c as any, async () => {}),
  );
  return app;
}

const SAMPLE_METRICS = `
# HELP ponder_historical_total_blocks Number of blocks required for the historical sync
# TYPE ponder_historical_total_blocks gauge
ponder_historical_total_blocks{chain="mainnet"} 7000000
ponder_historical_total_blocks{chain="gnosis"} 17000000
# HELP ponder_historical_completed_blocks Number of blocks processed
# TYPE ponder_historical_completed_blocks gauge
ponder_historical_completed_blocks{chain="mainnet"} 500000
ponder_historical_completed_blocks{chain="gnosis"} 1000000
# HELP ponder_historical_cached_blocks Number of blocks from cache
# TYPE ponder_historical_cached_blocks gauge
ponder_historical_cached_blocks{chain="mainnet"} 2500000
ponder_historical_cached_blocks{chain="gnosis"} 1400000
# HELP ponder_sync_is_realtime Boolean indicating realtime mode
# TYPE ponder_sync_is_realtime gauge
ponder_sync_is_realtime{chain="mainnet"} 0
ponder_sync_is_realtime{chain="gnosis"} 1
# HELP ponder_sync_is_complete Boolean indicating sync complete
# TYPE ponder_sync_is_complete gauge
ponder_sync_is_complete{chain="mainnet"} 0
ponder_sync_is_complete{chain="gnosis"} 1
`.trim();

function mockFetch(metricsBody: string) {
  vi.stubGlobal(
    "fetch",
    vi.fn((_url: string) =>
      Promise.resolve({
        text: () => Promise.resolve(metricsBody),
      } as Response),
    ),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GET /api/sync-progress", () => {
  it("returns 200", async () => {
    mockFetch(SAMPLE_METRICS);
    const app = buildApp();
    const res = await app.request("http://localhost/api/sync-progress");
    expect(res.status).toBe(200);
  });

  it("returns one entry per chain found in metrics", async () => {
    mockFetch(SAMPLE_METRICS);
    const app = buildApp();
    const res = await app.request("http://localhost/api/sync-progress");
    const body = (await res.json()) as Record<string, ChainProgress>;
    expect(Object.keys(body)).toEqual(expect.arrayContaining(["mainnet", "gnosis"]));
  });

  it("computes processedBlocks as completed + cached", async () => {
    mockFetch(SAMPLE_METRICS);
    const app = buildApp();
    const res = await app.request("http://localhost/api/sync-progress");
    const body = (await res.json()) as Record<string, ChainProgress>;
    // mainnet: 500_000 completed + 2_500_000 cached = 3_000_000
    expect(body["mainnet"]!.processedBlocks).toBe(3_000_000);
    // gnosis: 1_000_000 + 1_400_000 = 2_400_000
    expect(body["gnosis"]!.processedBlocks).toBe(2_400_000);
  });

  it("computes historicalBlocksFetchedPct correctly (rounded to 1 decimal)", async () => {
    mockFetch(SAMPLE_METRICS);
    const app = buildApp();
    const res = await app.request("http://localhost/api/sync-progress");
    const body = (await res.json()) as Record<string, ChainProgress>;
    // mainnet: 3_000_000 / 7_000_000 = 42.857... → 42.9
    expect(body["mainnet"]!.historicalBlocksFetchedPct).toBe(42.9);
    // gnosis: 2_400_000 / 17_000_000 = 14.117... → 14.1
    expect(body["gnosis"]!.historicalBlocksFetchedPct).toBe(14.1);
  });

  it("sets isRealtime from ponder_sync_is_realtime metric", async () => {
    mockFetch(SAMPLE_METRICS);
    const app = buildApp();
    const res = await app.request("http://localhost/api/sync-progress");
    const body = (await res.json()) as Record<string, ChainProgress>;
    expect(body["mainnet"]!.isRealtime).toBe(false);
    expect(body["gnosis"]!.isRealtime).toBe(true);
  });

  it("isComplete requires both isRealtime=true and pct>=100 (ignores ponder_sync_is_complete)", async () => {
    // gnosis is realtime but only 14.1% processed — must NOT be complete
    mockFetch(SAMPLE_METRICS);
    const app = buildApp();
    const res = await app.request("http://localhost/api/sync-progress");
    const body = (await res.json()) as Record<string, ChainProgress>;
    expect(body["gnosis"]!.isRealtime).toBe(true);
    expect(body["gnosis"]!.isComplete).toBe(false);
  });

  it("isComplete is true when isRealtime=true and all blocks processed", async () => {
    // Regression: ponder_sync_is_complete=0 must not block isComplete when realtime+100%
    const fullSyncMetrics = `
ponder_historical_total_blocks{chain="gnosis"} 1000
ponder_historical_completed_blocks{chain="gnosis"} 600
ponder_historical_cached_blocks{chain="gnosis"} 400
ponder_sync_is_realtime{chain="gnosis"} 1
ponder_sync_is_complete{chain="gnosis"} 0
`.trim();
    mockFetch(fullSyncMetrics);
    const app = buildApp();
    const res = await app.request("http://localhost/api/sync-progress");
    const body = (await res.json()) as Record<string, ChainProgress>;
    expect(body["gnosis"]!.isComplete).toBe(true);
  });

  it("returns empty object and 200 when metrics endpoint is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("unreachable"))));
    const app = buildApp();
    const res = await app.request("http://localhost/api/sync-progress");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, ChainProgress>;
    expect(body).toEqual({});
  });
});
