import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { AddressInfo } from "node:net";
import type { Hex } from "viem";
import type { Context } from "ponder:registry";

// Mock Ponder virtual modules that are not available outside the Ponder runtime.
// vi.mock calls are hoisted by vitest so they resolve before any imports below.
vi.mock("ponder:schema", () => ({
  conditionalOrderGenerator: { $inferInsert: {}, eventId: "eventId", orderType: "orderType", chainId: "chainId", hash: "hash" },
  discreteOrder: { $inferInsert: {}, chainId: "chainId", orderUid: "orderUid" },
}));

vi.mock("ponder", () => ({
  and: vi.fn(),
  eq: vi.fn(),
  inArray: vi.fn(),
  sql: Object.assign(vi.fn(), { raw: vi.fn() }),
}));

import * as data from "../../src/data";
import { ORDERBOOK_MAX_RETRIES, UPSERT_CHUNK_SIZE } from "../../src/constants";
import {
  drainOwnerSlice,
  fetchAccountOrders,
  fetchFlashLoanEnrichmentByUids,
  fetchOrderStatusByUids,
  fetchOwnerOrderStatuses,
  upsertDiscreteOrders,
  type ComposableOrder,
} from "../../src/application/helpers/orderbookClient";

// ─── Helpers ─────────────────────────────────────────────────────────────────

type RequestHandler = (req: IncomingMessage, res: ServerResponse) => void;

async function startServer(handler: RequestHandler): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/** Temporarily override `ORDERBOOK_API_URLS[chainId]` for the duration of a test callback. */
async function withFakeApi(
  chainId: number,
  serverUrl: string,
  fn: () => Promise<void>,
): Promise<void> {
  const original = data.ORDERBOOK_API_URLS[chainId];
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (data.ORDERBOOK_API_URLS as any)[chainId] = serverUrl;
    await fn();
  } finally {
    if (original === undefined) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      delete (data.ORDERBOOK_API_URLS as any)[chainId];
    } else {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (data.ORDERBOOK_API_URLS as any)[chainId] = original;
    }
  }
}

/** Minimal Ponder context stub for fetchOrderStatusByUids tests. Only `db.sql` is
 * exercised, so a partial stub cast to Context is intentional. */
function makeContext(): Context {
  return { db: { sql: { execute: async () => [] } } } as unknown as Context;
}

/** Build a single `{ order: {...} }` item matching the real CoW Orderbook API shape (by_uids endpoint). */
function makeWrappedOrder(uid: string, status: "open" | "fulfilled" | "expired" | "cancelled") {
  return {
    order: {
      uid,
      status,
      sellAmount: "1000000000000000000",
      buyAmount: "2000000000000000000",
      feeAmount: "1000000000000000",
      validTo: 9_999_999_999,
      creationDate: "2024-01-01T00:00:00Z",
      signingScheme: "eip1271",
      signature: "0x",
      executedSellAmount: status === "fulfilled" ? "1000000000000000000" : "0",
      executedBuyAmount: status === "fulfilled" ? "2000000000000000000" : "0",
      executedFee: status === "fulfilled" ? "1000000000000000" : "0",
    },
  };
}

interface OrderStub {
  uid: string;
  status: string;
  executedSellAmount: string;
  executedBuyAmount: string;
  executedFee: string;
  sellAmount?: string;
  buyAmount?: string;
  feeAmount?: string;
  validTo?: number;
  creationDate?: string;
  signingScheme?: string;
  signature?: string;
}

function makeOrderStub(overrides: Partial<OrderStub> & Pick<OrderStub, "uid" | "status">): OrderStub {
  return {
    sellAmount: "1000000000000000000",
    buyAmount: "2000000000",
    feeAmount: "0",
    validTo: 9999999999,
    creationDate: "2024-01-01T00:00:00.000Z",
    signingScheme: "eip1271",
    signature: "0x",
    executedSellAmount: "0",
    executedBuyAmount: "0",
    executedFee: "0",
    ...overrides,
  };
}

// Realistic CoW order UIDs (orderHash + owner + validTo = 56 bytes each).
const UID_A = `0x${"aa".repeat(56)}` as const;
const UID_B = `0x${"bb".repeat(56)}` as const;

// Isolated chain ID that doesn't exist in production — safe to mutate and delete.
const TEST_CHAIN_ID = 99_999;

// ─── fetchOrderStatusByUids tests ─────────────────────────────────────────────

describe("fetchOrderStatusByUids", () => {
  beforeAll(() => {
    // Placeholder so the early-exit guard (!apiBaseUrl) passes for TEST_CHAIN_ID.
    // Individual tests replace this with the actual server URL before each call.
    data.ORDERBOOK_API_URLS[TEST_CHAIN_ID] = "http://placeholder";
  });

  afterAll(() => {
    delete (data.ORDERBOOK_API_URLS as Record<number, string | undefined>)[TEST_CHAIN_ID];
  });

  it("returns empty map immediately when the uids array is empty", async () => {
    const result = await fetchOrderStatusByUids(makeContext(), TEST_CHAIN_ID, []);
    expect(result.size).toBe(0);
  });

  it("correctly unwraps the { order } wrapper and maps uid → status", async () => {
    const { url, close } = await startServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify([makeWrappedOrder(UID_A, "fulfilled")]));
    });
    data.ORDERBOOK_API_URLS[TEST_CHAIN_ID] = url;
    try {
      const result = await fetchOrderStatusByUids(makeContext(), TEST_CHAIN_ID, [UID_A]);
      expect(result.has(UID_A)).toBe(true);
      expect(result.get(UID_A)?.status).toBe("fulfilled");
    } finally {
      await close();
    }
  });

  it("populates executed amounts from the unwrapped response", async () => {
    const { url, close } = await startServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify([makeWrappedOrder(UID_A, "fulfilled")]));
    });
    data.ORDERBOOK_API_URLS[TEST_CHAIN_ID] = url;
    try {
      const result = await fetchOrderStatusByUids(makeContext(), TEST_CHAIN_ID, [UID_A]);
      const info = result.get(UID_A);
      expect(info?.executedSellAmount).toBe(1000000000000000000n);
      expect(info?.executedBuyAmount).toBe(2000000000000000000n);
      expect(info?.executedFee).toBe(1000000000000000n);
    } finally {
      await close();
    }
  });

  it("returns statuses for multiple orders in a single batch", async () => {
    const { url, close } = await startServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify([
        makeWrappedOrder(UID_A, "fulfilled"),
        makeWrappedOrder(UID_B, "open"),
      ]));
    });
    data.ORDERBOOK_API_URLS[TEST_CHAIN_ID] = url;
    try {
      const result = await fetchOrderStatusByUids(makeContext(), TEST_CHAIN_ID, [UID_A, UID_B]);
      expect(result.get(UID_A)?.status).toBe("fulfilled");
      expect(result.get(UID_B)?.status).toBe("open");
    } finally {
      await close();
    }
  });

  it("returns empty map on HTTP error response without throwing", async () => {
    const { url, close } = await startServer((_req, res) => {
      res.writeHead(500);
      res.end("Internal Server Error");
    });
    data.ORDERBOOK_API_URLS[TEST_CHAIN_ID] = url;
    try {
      const result = await fetchOrderStatusByUids(makeContext(), TEST_CHAIN_ID, [UID_A]);
      expect(result.size).toBe(0);
    } finally {
      await close();
    }
  });

  it("returns empty map when the response body is an empty array", async () => {
    const { url, close } = await startServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("[]");
    });
    data.ORDERBOOK_API_URLS[TEST_CHAIN_ID] = url;
    try {
      const result = await fetchOrderStatusByUids(makeContext(), TEST_CHAIN_ID, [UID_A]);
      expect(result.size).toBe(0);
    } finally {
      await close();
    }
  });
});

// ─── Stale-cache fetch-through (fulfilled entries missing executedFee) ────────

describe("fetchOrderStatusByUids — stale fulfilled cache entries", () => {
  /** Context stub whose per-UID cache read returns `rows`; cache writes are no-ops. */
  function makeCacheContext(rows: Record<string, unknown>[]): Context {
    return {
      db: {
        sql: {
          select: () => ({ from: () => ({ where: async () => rows }) }),
          insert: () => ({ values: () => ({ onConflictDoUpdate: async () => undefined }) }),
          execute: async () => [],
        },
      },
    } as unknown as Context;
  }

  beforeAll(() => {
    data.ORDERBOOK_API_URLS[TEST_CHAIN_ID] = "http://placeholder";
  });

  afterAll(() => {
    delete (data.ORDERBOOK_API_URLS as Record<number, string | undefined>)[TEST_CHAIN_ID];
  });

  it("re-fetches a fulfilled entry cached with a null executedFee (pre-executed_fee column)", async () => {
    let calls = 0;
    const { url, close } = await startServer((_req, res) => {
      calls++;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify([makeWrappedOrder(UID_A, "fulfilled")]));
    });
    data.ORDERBOOK_API_URLS[TEST_CHAIN_ID] = url;
    const ctx = makeCacheContext([
      { orderUid: UID_A, status: "fulfilled", executedSellAmount: "1", executedBuyAmount: "2", executedFee: null },
    ]);
    try {
      const result = await fetchOrderStatusByUids(ctx, TEST_CHAIN_ID, [UID_A]);
      expect(calls).toBe(1); // stale entry treated as a miss
      expect(result.get(UID_A)).toEqual({
        status: "fulfilled",
        executedSellAmount: 1000000000000000000n,
        executedBuyAmount: 2000000000000000000n,
        executedFee: 1000000000000000n,
      });
    } finally {
      await close();
    }
  });

  it("falls back to the cached entry when the stale UID no longer appears on the API", async () => {
    const { url, close } = await startServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("[]"); // aged out of /by_uids
    });
    data.ORDERBOOK_API_URLS[TEST_CHAIN_ID] = url;
    const ctx = makeCacheContext([
      { orderUid: UID_A, status: "fulfilled", executedSellAmount: "1", executedBuyAmount: "2", executedFee: null },
    ]);
    try {
      const result = await fetchOrderStatusByUids(ctx, TEST_CHAIN_ID, [UID_A]);
      expect(result.get(UID_A)).toEqual({
        status: "fulfilled",
        executedSellAmount: 1n,
        executedBuyAmount: 2n,
        executedFee: null,
      });
    } finally {
      await close();
    }
  });

  it("serves fulfilled entries with a concrete executedFee straight from cache", async () => {
    let calls = 0;
    const { url, close } = await startServer((_req, res) => {
      calls++;
      res.writeHead(200, { "content-type": "application/json" });
      res.end("[]");
    });
    data.ORDERBOOK_API_URLS[TEST_CHAIN_ID] = url;
    const ctx = makeCacheContext([
      { orderUid: UID_A, status: "fulfilled", executedSellAmount: "1", executedBuyAmount: "2", executedFee: "3" },
    ]);
    try {
      const result = await fetchOrderStatusByUids(ctx, TEST_CHAIN_ID, [UID_A]);
      expect(calls).toBe(0); // no network — cache is complete
      expect(result.get(UID_A)?.executedFee).toBe(3n);
    } finally {
      await close();
    }
  });
});

// ─── Resilience: 429 / 5xx handling ───────────────────────────────────────────

/** Capture structured `log()` output — the logger writes warn/error as JSON via console.error. */
function captureErrorLogs() {
  const lines: Record<string, unknown>[] = [];
  const spy = vi.spyOn(console, "error").mockImplementation((line: unknown) => {
    try {
      lines.push(JSON.parse(String(line)));
    } catch {
      /* non-JSON line — ignore */
    }
  });
  return {
    has: (msg: string) => lines.some((l) => l.msg === msg),
    find: (msg: string) => lines.find((l) => l.msg === msg),
    restore: () => spy.mockRestore(),
  };
}

describe("orderbook resilience (429 / 5xx)", () => {
  beforeAll(() => {
    data.ORDERBOOK_API_URLS[TEST_CHAIN_ID] = "http://placeholder";
  });

  afterAll(() => {
    delete (data.ORDERBOOK_API_URLS as Record<number, string | undefined>)[TEST_CHAIN_ID];
  });

  it("retries a 429 (honoring Retry-After) and succeeds on a later attempt", async () => {
    let calls = 0;
    const { url, close } = await startServer((_req, res) => {
      calls++;
      if (calls === 1) {
        res.writeHead(429, { "retry-after": "0", "content-type": "application/json" });
        res.end(JSON.stringify({ message: "rate limited" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify([makeWrappedOrder(UID_A, "fulfilled")]));
    });
    data.ORDERBOOK_API_URLS[TEST_CHAIN_ID] = url;
    const logs = captureErrorLogs();
    try {
      const result = await fetchOrderStatusByUids(makeContext(), TEST_CHAIN_ID, [UID_A]);
      expect(calls).toBe(2);
      expect(result.get(UID_A)?.status).toBe("fulfilled");
      expect(logs.has("ob:unavailable")).toBe(false);
    } finally {
      logs.restore();
      await close();
    }
  });

  it("classifies a persistent 429 as ob:unavailable and stops after bounded retries", async () => {
    let calls = 0;
    const { url, close } = await startServer((_req, res) => {
      calls++;
      res.writeHead(429, { "retry-after": "0", "content-type": "application/json" });
      res.end(JSON.stringify({ message: "rate limited" }));
    });
    data.ORDERBOOK_API_URLS[TEST_CHAIN_ID] = url;
    const logs = captureErrorLogs();
    try {
      const result = await fetchOrderStatusByUids(makeContext(), TEST_CHAIN_ID, [UID_A]);
      expect(calls).toBe(ORDERBOOK_MAX_RETRIES + 1); // bounded: 1 initial + retries
      expect(result.has(UID_A)).toBe(false); // absent from map…
      expect(logs.find("ob:unavailable")?.status).toBe(429); // …but the cause is logged distinctly
    } finally {
      logs.restore();
      await close();
    }
  });

});

// ─── fetchOwnerOrderStatuses tests ────────────────────────────────────────────

const FAKE_OWNER = "0xaabbccddEEff0011223344556677889900aabbcc" as Hex;
const FAKE_CHAIN_ID = 1;
const UNKNOWN_CHAIN_ID = 99999;

describe("fetchOwnerOrderStatuses", () => {
  it("returns an empty map for an unknown chainId (no API URL configured)", async () => {
    const result = await fetchOwnerOrderStatuses(UNKNOWN_CHAIN_ID, FAKE_OWNER);
    expect(result).toBeInstanceOf(Map);
    expect(result.size).toBe(0);
  });

  it("happy path — server returns orders, Map is built with uid/status/executedAmounts", async () => {
    const orders = [
      makeOrderStub({ uid: "0xuid1", status: "fulfilled", executedSellAmount: "500", executedBuyAmount: "1000" }),
      makeOrderStub({ uid: "0xuid2", status: "open", executedSellAmount: "0", executedBuyAmount: "0" }),
      makeOrderStub({ uid: "0xuid3", status: "expired", executedSellAmount: "250", executedBuyAmount: "500" }),
    ];

    const { url, close } = await startServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(orders));
    });

    try {
      await withFakeApi(FAKE_CHAIN_ID, url, async () => {
        const result = await fetchOwnerOrderStatuses(FAKE_CHAIN_ID, FAKE_OWNER);

        expect(result).toBeInstanceOf(Map);
        expect(result.size).toBe(3);

        expect(result.get("0xuid1")).toEqual({
          status: "fulfilled",
          executedSellAmount: 500n,
          executedBuyAmount: 1000n,
          executedFee: 0n,
        });
        expect(result.get("0xuid2")).toEqual({
          status: "open",
          executedSellAmount: 0n,
          executedBuyAmount: 0n,
          executedFee: 0n,
        });
        expect(result.get("0xuid3")).toEqual({
          status: "expired",
          executedSellAmount: 250n,
          executedBuyAmount: 500n,
          executedFee: 0n,
        });
      });
    } finally {
      await close();
    }
  });

  it("handles null executedSellAmount and executedBuyAmount from the server", async () => {
    const orders = [
      {
        uid: "0xuid-null",
        status: "cancelled",
        executedSellAmount: null,
        executedBuyAmount: null,
        executedFee: null,
        sellAmount: "1000",
        buyAmount: "2000",
        feeAmount: "0",
        validTo: 9999999999,
        creationDate: "2024-01-01T00:00:00.000Z",
        signingScheme: "eip1271",
        signature: "0x",
      },
    ];

    const { url, close } = await startServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(orders));
    });

    try {
      await withFakeApi(FAKE_CHAIN_ID, url, async () => {
        const result = await fetchOwnerOrderStatuses(FAKE_CHAIN_ID, FAKE_OWNER);

        expect(result.size).toBe(1);
        expect(result.get("0xuid-null")).toEqual({
          status: "cancelled",
          executedSellAmount: null,
          executedBuyAmount: null,
          executedFee: null,
        });
      });
    } finally {
      await close();
    }
  });

  it("handles an empty orders array from the server", async () => {
    const { url, close } = await startServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify([]));
    });

    try {
      await withFakeApi(FAKE_CHAIN_ID, url, async () => {
        const result = await fetchOwnerOrderStatuses(FAKE_CHAIN_ID, FAKE_OWNER);
        expect(result).toBeInstanceOf(Map);
        expect(result.size).toBe(0);
      });
    } finally {
      await close();
    }
  });

  it("paginates — fetches subsequent pages when first page is full (PAGE_LIMIT=1000)", async () => {
    const PAGE_LIMIT = 1000;
    const page1: OrderStub[] = Array.from({ length: PAGE_LIMIT }, (_, i) =>
      makeOrderStub({ uid: `0xpage1-${i}`, status: "open" }),
    );
    const page2: OrderStub[] = [
      makeOrderStub({ uid: "0xpage2-0", status: "fulfilled", executedSellAmount: "999", executedBuyAmount: "888" }),
    ];

    const receivedOffsets: number[] = [];

    const { url, close } = await startServer((req, res) => {
      const parsedUrl = new URL(req.url ?? "/", `http://127.0.0.1`);
      const offset = parseInt(parsedUrl.searchParams.get("offset") ?? "0", 10);
      receivedOffsets.push(offset);

      const page = offset === 0 ? page1 : page2;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(page));
    });

    try {
      await withFakeApi(FAKE_CHAIN_ID, url, async () => {
        const result = await fetchOwnerOrderStatuses(FAKE_CHAIN_ID, FAKE_OWNER);

        expect(receivedOffsets).toContain(0);
        expect(receivedOffsets).toContain(PAGE_LIMIT);

        expect(result.size).toBe(PAGE_LIMIT + 1);

        expect(result.get("0xpage2-0")).toEqual({
          status: "fulfilled",
          executedSellAmount: 999n,
          executedBuyAmount: 888n,
          executedFee: 0n,
        });
      });
    } finally {
      await close();
    }
  });

  it("handles a non-200 response gracefully — returns empty map without throwing", async () => {
    const { url, close } = await startServer((_req, res) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: "Internal Server Error" }));
    });

    try {
      await withFakeApi(FAKE_CHAIN_ID, url, async () => {
        const result = await fetchOwnerOrderStatuses(FAKE_CHAIN_ID, FAKE_OWNER);
        expect(result).toBeInstanceOf(Map);
        expect(result.size).toBe(0);
      });
    } finally {
      await close();
    }
  });

  it("uses the correct /api/v1/account/{owner}/orders endpoint with limit and offset params", async () => {
    const receivedPaths: string[] = [];

    const { url, close } = await startServer((req, res) => {
      receivedPaths.push(req.url ?? "");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify([]));
    });

    try {
      await withFakeApi(FAKE_CHAIN_ID, url, async () => {
        await fetchOwnerOrderStatuses(FAKE_CHAIN_ID, FAKE_OWNER);
      });

      expect(receivedPaths.length).toBeGreaterThanOrEqual(1);
      const firstPath = receivedPaths[0]!;
      expect(firstPath).toContain(`/api/v1/account/${FAKE_OWNER}/orders`);
      expect(firstPath).toContain("limit=1000");
      expect(firstPath).toContain("offset=0");
    } finally {
      await close();
    }
  });
});

// ─── drainOwnerSlice tests ────────────────────────────────────────────────────

/** Fake Ponder context for drainOwnerSlice: serves drain state / cache rows /
 *  generator lookups by projection shape, and records every inserted row so tests
 *  can assert what was persisted (drain-state writes and discreteOrder upserts). */
function makeDrainContext(opts: {
  drainState?: { nextOffset: number; fullyDrained: boolean; deltaCursor: number | null };
  cacheRows?: Record<string, unknown>[];
  generators?: { eventId: string; hash: string; orderType?: string }[];
  existingDiscreteRows?: Record<string, unknown>[];
} = {}) {
  const inserted: Record<string, unknown>[] = [];
  let insertStatements = 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const select = (proj: any) => ({
    from: () => ({
      where: () => {
        let rows: unknown[];
        if (proj.nextOffset !== undefined) rows = opts.drainState ? [opts.drainState] : [];
        else if (proj.eventId !== undefined) rows = opts.generators ?? [];
        // upsertDiscreteOrders change detection: discreteOrder rows have no generatorHash.
        else if (proj.orderUid !== undefined && proj.generatorHash === undefined) rows = opts.existingDiscreteRows ?? [];
        else rows = opts.cacheRows ?? [];
        return Object.assign(Promise.resolve(rows), { limit: () => Promise.resolve(rows) });
      },
    }),
  });
  const insert = () => ({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    values: (vals: any) => {
      const record = async () => {
        insertStatements++;
        inserted.push(...(Array.isArray(vals) ? vals : [vals]));
      };
      return { onConflictDoUpdate: record, onConflictDoNothing: record };
    },
  });
  // bumpGeneratorsUpdatedAt cursor bumps — recorded but not asserted here.
  const update = () => ({ set: () => ({ where: async () => {} }) });
  return {
    ctx: { db: { sql: { select, insert, update } } } as unknown as Context,
    inserted,
    statementCount: () => insertStatements,
  };
}

describe("drainOwnerSlice — full-history drain", () => {
  const DRAIN_OWNER = "0x3333333333333333333333333333333333333333" as Hex;

  it("paginates the full account history at limit=1000 and reports complete", async () => {
    const receivedOffsets: number[] = [];
    const receivedLimits = new Set<string>();

    // 3 pages of the account endpoint: 1000 + 1000 + 500 = 2500 orders,
    // mimicking a large-history owner. All are non-composable (signature "0x"
    // decodes to null), so they filter out and no generator lookup is needed —
    // but the drain still pages through every one of them.
    const { url, close } = await startServer((req, res) => {
      const parsed = new URL(req.url ?? "/", "http://127.0.0.1");
      const offset = parseInt(parsed.searchParams.get("offset") ?? "0", 10);
      receivedOffsets.push(offset);
      receivedLimits.add(parsed.searchParams.get("limit") ?? "");

      const count = offset >= 2000 ? 500 : 1000;
      const orders = Array.from({ length: count }, (_, i) =>
        makeOrderStub({ uid: `0xorder${offset + i}`, status: "open" }),
      );
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(orders));
    });

    try {
      await withFakeApi(TEST_CHAIN_ID, url, async () => {
        const { ctx, inserted } = makeDrainContext();
        const { complete } = await drainOwnerSlice(ctx, TEST_CHAIN_ID, DRAIN_OWNER, 123n);

        expect(receivedOffsets).toContain(0);
        expect(receivedOffsets).toContain(1000);
        expect(receivedOffsets).toContain(2000);
        expect(receivedLimits).toEqual(new Set(["1000"]));
        expect(complete).toBe(true);
        expect(inserted.some((r) => r.fullyDrained === true)).toBe(true);
      });
    } finally {
      await close();
    }
  });

  it("records the resume offset on an interrupted drain and does NOT report complete (silent-hole regression)", async () => {
    // Page 0 succeeds; page at offset 1000 always 500s. Before the resumable drain,
    // this partial fetch advanced the derived cursor and the retry falsely reported
    // complete — permanently skipping everything below the partial slice.
    const { url, close } = await startServer((req, res) => {
      const parsed = new URL(req.url ?? "/", "http://127.0.0.1");
      const offset = parseInt(parsed.searchParams.get("offset") ?? "0", 10);
      if (offset === 0) {
        const orders = Array.from({ length: 1000 }, (_, i) =>
          makeOrderStub({ uid: `0xorder${i}`, status: "open", creationDate: toIso(5000 - i) }),
        );
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(orders));
        return;
      }
      res.writeHead(500);
      res.end("boom");
    });

    try {
      await withFakeApi(TEST_CHAIN_ID, url, async () => {
        const { ctx, inserted } = makeDrainContext();
        const { complete } = await drainOwnerSlice(ctx, TEST_CHAIN_ID, DRAIN_OWNER, 123n);

        expect(complete).toBe(false);
        // Progress banked: resume offset persisted, delta-cursor candidate recorded…
        expect(inserted.some((r) => r.nextOffset === 1000)).toBe(true);
        expect(inserted.some((r) => r.deltaCursor === 5000)).toBe(true);
        // …but the owner is NOT marked fully drained.
        expect(inserted.some((r) => r.fullyDrained === true)).toBe(false);
      });
    } finally {
      await close();
    }
  });

  it("resumes pagination at the stored offset instead of offset 0", async () => {
    const receivedOffsets: number[] = [];
    const { url, close } = await startServer((req, res) => {
      const parsed = new URL(req.url ?? "/", "http://127.0.0.1");
      const offset = parseInt(parsed.searchParams.get("offset") ?? "0", 10);
      receivedOffsets.push(offset);
      // The tail: a final short page.
      const orders = Array.from({ length: 5 }, (_, i) =>
        makeOrderStub({ uid: `0xtail${i}`, status: "open" }),
      );
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(orders));
    });

    try {
      await withFakeApi(TEST_CHAIN_ID, url, async () => {
        const { ctx, inserted } = makeDrainContext({
          drainState: { nextOffset: 1000, fullyDrained: false, deltaCursor: 5000 },
        });
        const { complete } = await drainOwnerSlice(ctx, TEST_CHAIN_ID, DRAIN_OWNER, 123n);

        expect(receivedOffsets).toEqual([1000]); // never re-fetched from 0
        expect(complete).toBe(true);
        expect(inserted.some((r) => r.fullyDrained === true)).toBe(true);
      });
    } finally {
      await close();
    }
  });

  it("ends the slice at the abort signal without reporting complete", async () => {
    const receivedOffsets: number[] = [];
    const { url, close } = await startServer((req, res) => {
      const parsed = new URL(req.url ?? "/", "http://127.0.0.1");
      receivedOffsets.push(parseInt(parsed.searchParams.get("offset") ?? "0", 10));
      const orders = Array.from({ length: 1000 }, (_, i) =>
        makeOrderStub({ uid: `0xabort${i}`, status: "open" }),
      );
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(orders));
    });

    try {
      await withFakeApi(TEST_CHAIN_ID, url, async () => {
        const { ctx, inserted } = makeDrainContext();
        const controller = new AbortController();
        // Abort as soon as the first page lands (the drain-state write for it).
        const origPush = inserted.push.bind(inserted);
        inserted.push = (...rows) => { controller.abort(); return origPush(...rows); };

        const { complete } = await drainOwnerSlice(ctx, TEST_CHAIN_ID, DRAIN_OWNER, 123n, controller.signal);

        expect(complete).toBe(false);
        expect(receivedOffsets).toEqual([0]); // no further pages after the abort
        expect(inserted.some((r) => r.fullyDrained === true)).toBe(false);
      });
    } finally {
      await close();
    }
  });
});

// ─── drainOwnerSlice delta-mode tests ─────────────────────────────────────────

describe("drainOwnerSlice — delta mode (fully drained owner)", () => {
  const OWNER = "0x2222222222222222222222222222222222222222" as Hex;
  const GEN_HASH = `0x${"cc".repeat(32)}`;

  const CACHE_ROWS = [
    {
      orderUid: "0xcached-order",
      generatorHash: GEN_HASH,
      orderType: "PerpetualSwap",
      status: "fulfilled",
      sellAmount: "1000",
      buyAmount: "2000",
      feeAmount: "0",
      validTo: 9999999999,
      creationDate: 1700000000n,
      executedSellAmount: "1000",
      executedBuyAmount: "2000",
    },
  ];

  it("rebuilds the cached history re-mapped to the current generator when no new orders exist", async () => {
    // Simulates a post-reindex deploy: discreteOrder is empty, but the durable cache
    // still holds the owner's history and the orderbook has nothing new past the cursor.
    const { url, close } = await startServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("[]");
    });

    const { ctx, inserted } = makeDrainContext({
      drainState: { nextOffset: 0, fullyDrained: true, deltaCursor: 1700000000 },
      cacheRows: [{ ...CACHE_ROWS[0]!, executedFee: "17" }],
      // eventId differs from any prior deployment — the row is keyed by the stable hash.
      generators: [{ eventId: "gen-current", hash: GEN_HASH }],
    });

    try {
      await withFakeApi(TEST_CHAIN_ID, url, async () => {
        const { discovered, complete } = await drainOwnerSlice(ctx, TEST_CHAIN_ID, OWNER, 123n);
        expect(complete).toBe(true);
        expect(discovered).toBe(1);
        const row = inserted.find((r) => r.orderUid === "0xcached-order");
        expect(row).toBeDefined();
        expect(row!.conditionalOrderGeneratorId).toBe("gen-current");
        expect(row!.status).toBe("fulfilled");
        expect(row!.executedFee).toBe(17n);
      });
    } finally {
      await close();
    }
  });

  it("does NOT advance the delta cursor when the delta fetch is cut short (silent-hole regression)", async () => {
    // Page 0 of the delta is full (everything newer than the cursor), page 1 fails.
    // The cursor must stay put so the whole window is re-fetched later — advancing it
    // would permanently skip the unfetched middle of the delta.
    const { url, close } = await startServer((req, res) => {
      const parsed = new URL(req.url ?? "/", "http://127.0.0.1");
      const offset = parseInt(parsed.searchParams.get("offset") ?? "0", 10);
      if (offset === 0) {
        const orders = Array.from({ length: 1000 }, (_, i) =>
          makeOrderStub({ uid: `0xdelta${i}`, status: "open", creationDate: toIso(2_000_000_000 - i) }),
        );
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(orders));
        return;
      }
      res.writeHead(500);
      res.end("boom");
    });

    const { ctx, inserted } = makeDrainContext({
      drainState: { nextOffset: 0, fullyDrained: true, deltaCursor: 1700000000 },
      cacheRows: CACHE_ROWS,
      generators: [{ eventId: "gen-current", hash: GEN_HASH }],
    });

    try {
      await withFakeApi(TEST_CHAIN_ID, url, async () => {
        const { complete } = await drainOwnerSlice(ctx, TEST_CHAIN_ID, OWNER, 123n);
        expect(complete).toBe(false);
        expect(inserted.some((r) => r.deltaCursor !== undefined && r.deltaCursor !== null)).toBe(false);
      });
    } finally {
      await close();
    }
  });
});

// ─── fetchAccountOrders resume / onPage tests ─────────────────────────────────

describe("fetchAccountOrders — resumable pagination", () => {
  const OWNER = "0x4444444444444444444444444444444444444444" as Hex;

  it("starts at opts.startOffset and reports per-page progress via onPage", async () => {
    const pages: Record<number, OrderStub[]> = {
      2: [makeOrderStub({ uid: "0xr1", status: "open" }), makeOrderStub({ uid: "0xr2", status: "open" })],
      4: [makeOrderStub({ uid: "0xr3", status: "open" })],
    };
    const receivedOffsets: number[] = [];
    const { url, close } = await startServer((req, res) => {
      const parsed = new URL(req.url ?? "/", "http://127.0.0.1");
      const offset = parseInt(parsed.searchParams.get("offset") ?? "0", 10);
      receivedOffsets.push(offset);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(pages[offset] ?? []));
    });

    const pageCalls: { uids: string[]; nextOffset: number }[] = [];
    try {
      const { complete } = await fetchAccountOrders(url, OWNER, 0, undefined, 2, undefined, {
        startOffset: 2,
        onPage: async (orders, nextOffset) => {
          pageCalls.push({ uids: orders.map((o) => o.uid), nextOffset });
        },
      });
      expect(receivedOffsets).toEqual([2, 4]); // resumed — offset 0 never re-fetched
      expect(pageCalls).toEqual([
        { uids: ["0xr1", "0xr2"], nextOffset: 4 },
        { uids: ["0xr3"], nextOffset: 5 },
      ]);
      expect(complete).toBe(true);
    } finally {
      await close();
    }
  });

  it("stops between pages when the signal aborts, reporting complete=false", async () => {
    const receivedOffsets: number[] = [];
    const { url, close } = await startServer((req, res) => {
      const parsed = new URL(req.url ?? "/", "http://127.0.0.1");
      receivedOffsets.push(parseInt(parsed.searchParams.get("offset") ?? "0", 10));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify([
        makeOrderStub({ uid: "0xs1", status: "open" }),
        makeOrderStub({ uid: "0xs2", status: "open" }),
      ]));
    });

    const controller = new AbortController();
    try {
      const { complete, nextOffset } = await fetchAccountOrders(url, OWNER, 0, undefined, 2, undefined, {
        signal: controller.signal,
        onPage: async () => controller.abort(), // slice deadline hits mid-drain
      });
      expect(receivedOffsets).toEqual([0]); // no request after the abort
      expect(complete).toBe(false);
      expect(nextOffset).toBe(2); // resume point past the persisted page
    } finally {
      await close();
    }
  });
});

// ─── upsertDiscreteOrders chunking test ───────────────────────────────────────

describe("upsertDiscreteOrders — chunking", () => {
  it("splits large upserts into UPSERT_CHUNK_SIZE statements (bind-param cap)", async () => {
    const orders: ComposableOrder[] = Array.from({ length: 2 * UPSERT_CHUNK_SIZE + 500 }, (_, i) => ({
      uid: `0xchunk${i}`,
      status: "open",
      generatorId: "gen-1",
      generatorHash: "0xhash",
      orderType: "PerpetualSwap",
      sellAmount: "1",
      buyAmount: "2",
      feeAmount: "0",
      validTo: 9999999999,
      creationDate: 1700000000n,
      executedSellAmount: 0n,
      executedBuyAmount: 0n,
    }));

    const { ctx, inserted, statementCount } = makeDrainContext();
    const count = await upsertDiscreteOrders(ctx, TEST_CHAIN_ID, orders, 123n);

    expect(count).toBe(orders.length);
    expect(inserted).toHaveLength(orders.length);
    expect(statementCount()).toBe(3); // 1000 + 1000 + 500
  });
});

// ─── fetchAccountOrders incremental-cursor tests ──────────────────────────────

const toIso = (unixSeconds: number) => new Date(unixSeconds * 1000).toISOString();

describe("fetchAccountOrders — sinceCreationDate early-stop", () => {
  const OWNER = "0x1111111111111111111111111111111111111111" as Hex;

  it("stops paginating once a page dips below the cursor, keeping only orders at/after it", async () => {
    // Orders are newest-first (creationDate DESC). cursor=250 means everything at
    // or after 250 is new; older is already cached and must not be re-fetched.
    const pages: Record<number, OrderStub[]> = {
      0: [
        makeOrderStub({ uid: "0xo1", status: "open", creationDate: toIso(500) }),
        makeOrderStub({ uid: "0xo2", status: "open", creationDate: toIso(400) }),
      ],
      2: [
        makeOrderStub({ uid: "0xo3", status: "fulfilled", creationDate: toIso(300) }),
        makeOrderStub({ uid: "0xo4", status: "fulfilled", creationDate: toIso(200) }), // < cursor → stop
      ],
      4: [
        makeOrderStub({ uid: "0xo5", status: "fulfilled", creationDate: toIso(100) }),
      ],
    };
    const receivedOffsets: number[] = [];

    const { url, close } = await startServer((req, res) => {
      const parsed = new URL(req.url ?? "/", "http://127.0.0.1");
      const offset = parseInt(parsed.searchParams.get("offset") ?? "0", 10);
      receivedOffsets.push(offset);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(pages[offset] ?? []));
    });

    try {
      await withFakeApi(TEST_CHAIN_ID, url, async () => {
        const { orders, complete } = await fetchAccountOrders(url, OWNER, 0, undefined, 2, 250);

        // Never requested offset 4 — pagination stopped after crossing the cursor.
        expect(receivedOffsets).toEqual([0, 2]);
        // Kept o1,o2 (whole first page) + o3 (>= cursor); dropped o4 (< cursor).
        expect(orders.map((o) => o.uid)).toEqual(["0xo1", "0xo2", "0xo3"]);
        expect(complete).toBe(true); // clean termination — crossed the cursor
      });
    } finally {
      await close();
    }
  });

  it("drains every page when no cursor is given (full backfill)", async () => {
    const pages: Record<number, OrderStub[]> = {
      0: [makeOrderStub({ uid: "0xa", status: "open", creationDate: toIso(500) }), makeOrderStub({ uid: "0xb", status: "open", creationDate: toIso(400) })],
      2: [makeOrderStub({ uid: "0xc", status: "open", creationDate: toIso(300) })],
    };
    const receivedOffsets: number[] = [];
    const { url, close } = await startServer((req, res) => {
      const parsed = new URL(req.url ?? "/", "http://127.0.0.1");
      const offset = parseInt(parsed.searchParams.get("offset") ?? "0", 10);
      receivedOffsets.push(offset);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(pages[offset] ?? []));
    });
    try {
      await withFakeApi(TEST_CHAIN_ID, url, async () => {
        const { orders, complete } = await fetchAccountOrders(url, OWNER, 0, undefined, 2);
        expect(receivedOffsets).toEqual([0, 2]);
        expect(orders.map((o) => o.uid)).toEqual(["0xa", "0xb", "0xc"]);
        expect(complete).toBe(true); // reached the last page
      });
    } finally {
      await close();
    }
  });

  it("reports complete=false when pagination is cut short by an orderbook error", async () => {
    // Page 0 succeeds (full page), page 1 always 500s → fetchOrderbook exhausts retries
    // and fetchAccountOrders breaks with a partial result.
    const { url, close } = await startServer((req, res) => {
      const parsed = new URL(req.url ?? "/", "http://127.0.0.1");
      const offset = parseInt(parsed.searchParams.get("offset") ?? "0", 10);
      if (offset === 0) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify([
          makeOrderStub({ uid: "0xp0", status: "open", creationDate: toIso(500) }),
          makeOrderStub({ uid: "0xp1", status: "open", creationDate: toIso(400) }),
        ]));
        return;
      }
      res.writeHead(500);
      res.end("boom");
    });
    try {
      await withFakeApi(TEST_CHAIN_ID, url, async () => {
        const { orders, complete } = await fetchAccountOrders(url, OWNER, 0, undefined, 2);
        expect(complete).toBe(false); // cut short — caller must not treat as full history
        expect(orders.map((o) => o.uid)).toEqual(["0xp0", "0xp1"]); // partial page 0 only
      });
    } finally {
      await close();
    }
  });
});

// ─── fetchFlashLoanEnrichmentByUids tests ─────────────────────────────────────

function makeWrappedFlashLoanOrder(
  uid: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    order: {
      uid,
      status: "fulfilled",
      kind: "sell",
      receiver: "0xCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
      sellAmount: "5000000000000000000",
      buyAmount: "4800000000000000000",
      feeAmount: "1000000000000000",
      validTo: 9_999_999_999,
      creationDate: "2024-01-01T00:00:00Z",
      signingScheme: "eip1271",
      signature: "0x",
      executedSellAmount: "5000000000000000000",
      executedBuyAmount: "4900000000000000000",
      ...overrides,
    },
  };
}

describe("fetchFlashLoanEnrichmentByUids", () => {
  it("returns an empty map for empty uids without hitting the network", async () => {
    const result = await fetchFlashLoanEnrichmentByUids(makeContext(), TEST_CHAIN_ID, []);
    expect(result.size).toBe(0);
  });

  it("returns an empty map for an unknown chainId (no API URL configured)", async () => {
    const result = await fetchFlashLoanEnrichmentByUids(makeContext(), 424242, [UID_A]);
    expect(result.size).toBe(0);
  });

  it("maps kind, receiver (lowercased), intended and executed amounts from the by_uids body", async () => {
    const { url, close } = await startServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify([makeWrappedFlashLoanOrder(UID_A)]));
    });
    try {
      await withFakeApi(TEST_CHAIN_ID, url, async () => {
        const result = await fetchFlashLoanEnrichmentByUids(makeContext(), TEST_CHAIN_ID, [UID_A]);
        const info = result.get(UID_A);
        expect(info).toBeDefined();
        expect(info!.kind).toBe("sell");
        expect(info!.receiver).toBe("0xcccccccccccccccccccccccccccccccccccccccc");
        expect(info!.sellAmount).toBe("5000000000000000000");
        expect(info!.buyAmount).toBe("4800000000000000000");
        expect(info!.executedSellAmount).toBe("5000000000000000000");
        expect(info!.executedBuyAmount).toBe("4900000000000000000");
      });
    } finally {
      await close();
    }
  });

  it("keeps receiver null when the orderbook returns null", async () => {
    const { url, close } = await startServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify([makeWrappedFlashLoanOrder(UID_A, { receiver: null })]));
    });
    try {
      await withFakeApi(TEST_CHAIN_ID, url, async () => {
        const result = await fetchFlashLoanEnrichmentByUids(makeContext(), TEST_CHAIN_ID, [UID_A]);
        expect(result.get(UID_A)!.receiver).toBeNull();
      });
    } finally {
      await close();
    }
  });

  it("omits uids the orderbook does not return (caller retries later)", async () => {
    const { url, close } = await startServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify([makeWrappedFlashLoanOrder(UID_A)]));
    });
    try {
      await withFakeApi(TEST_CHAIN_ID, url, async () => {
        const result = await fetchFlashLoanEnrichmentByUids(makeContext(), TEST_CHAIN_ID, [UID_A, UID_B]);
        expect(result.has(UID_A)).toBe(true);
        expect(result.has(UID_B)).toBe(false);
      });
    } finally {
      await close();
    }
  });

  it("returns an empty map on HTTP error without throwing", async () => {
    const { url, close } = await startServer((_req, res) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "boom" }));
    });
    try {
      await withFakeApi(TEST_CHAIN_ID, url, async () => {
        const result = await fetchFlashLoanEnrichmentByUids(makeContext(), TEST_CHAIN_ID, [UID_A]);
        expect(result.size).toBe(0);
      });
    } finally {
      await close();
    }
  });

  it("serves cached UIDs without hitting the orderbook", async () => {
    let requests = 0;
    const { url, close } = await startServer((_req, res) => {
      requests++;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify([]));
    });
    const cachedRow = {
      orderUid: UID_A,
      receiver: "0xcccccccccccccccccccccccccccccccccccccccc",
      kind: "buy",
      sellAmount: "111",
      buyAmount: "222",
      executedSellAmount: "111",
      executedBuyAmount: "220",
    };
    const ctx = { db: { sql: { select: () => ({ from: () => ({ where: async () => [cachedRow] }) }) } } } as unknown as Context;
    try {
      await withFakeApi(TEST_CHAIN_ID, url, async () => {
        const result = await fetchFlashLoanEnrichmentByUids(ctx, TEST_CHAIN_ID, [UID_A]);
        expect(result.get(UID_A)?.kind).toBe("buy");
        expect(result.get(UID_A)?.receiver).toBe("0xcccccccccccccccccccccccccccccccccccccccc");
        expect(requests).toBe(0); // fully served from cache
      });
    } finally {
      await close();
    }
  });

  it("writes freshly fetched enrichment to the cache", async () => {
    const { url, close } = await startServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify([makeWrappedFlashLoanOrder(UID_A)]));
    });
    const inserted: Record<string, unknown>[] = [];
    const ctx = {
      db: {
        sql: {
          select: () => ({ from: () => ({ where: async () => [] }) }), // empty cache
          insert: () => ({ values: (vals: Record<string, unknown>[]) => ({ onConflictDoNothing: async () => { inserted.push(...vals); } }) }),
        },
      },
    } as unknown as Context;
    try {
      await withFakeApi(TEST_CHAIN_ID, url, async () => {
        await fetchFlashLoanEnrichmentByUids(ctx, TEST_CHAIN_ID, [UID_A]);
        expect(inserted).toHaveLength(1);
        expect(inserted[0]!.orderUid).toBe(UID_A);
        expect(inserted[0]!.kind).toBe("sell");
        expect(inserted[0]!.receiver).toBe("0xcccccccccccccccccccccccccccccccccccccccc");
      });
    } finally {
      await close();
    }
  });
});
