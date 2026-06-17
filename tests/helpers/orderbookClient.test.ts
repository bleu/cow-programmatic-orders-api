import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { AddressInfo } from "node:net";
import type { Hex } from "viem";

// Mock Ponder virtual modules that are not available outside the Ponder runtime.
// vi.mock calls are hoisted by vitest so they resolve before any imports below.
vi.mock("ponder:schema", () => ({
  conditionalOrderGenerator: { $inferInsert: {}, eventId: "eventId", orderType: "orderType", chainId: "chainId", hash: "hash" },
  discreteOrder: { $inferInsert: {}, chainId: "chainId", orderUid: "orderUid" },
}));

vi.mock("ponder", () => ({
  and: vi.fn(),
  eq: vi.fn(),
  sql: Object.assign(vi.fn(), { raw: vi.fn() }),
}));

import * as data from "../../src/data";
import { ORDERBOOK_MAX_RETRIES } from "../../src/constants";
import { fetchOrderStatusByUids, fetchOwnerOrderStatuses } from "../../src/application/helpers/orderbookClient";

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

/** Minimal Ponder context stub for fetchOrderStatusByUids tests. */
function makeContext() {
  return { db: { sql: { execute: async () => [] } } };
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
    },
  };
}

interface OrderStub {
  uid: string;
  status: string;
  executedSellAmount: string;
  executedBuyAmount: string;
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
      expect(info?.executedSellAmount).toBe("1000000000000000000");
      expect(info?.executedBuyAmount).toBe("2000000000000000000");
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

  it("retries a 5xx then classifies it as ob:unavailable", async () => {
    let calls = 0;
    const { url, close } = await startServer((_req, res) => {
      calls++;
      res.writeHead(503);
      res.end("unavailable");
    });
    data.ORDERBOOK_API_URLS[TEST_CHAIN_ID] = url;
    const logs = captureErrorLogs();
    try {
      const result = await fetchOrderStatusByUids(makeContext(), TEST_CHAIN_ID, [UID_A]);
      expect(calls).toBe(ORDERBOOK_MAX_RETRIES + 1);
      expect(result.size).toBe(0);
      expect(logs.find("ob:unavailable")?.status).toBe(503);
    } finally {
      logs.restore();
      await close();
    }
  });

  it("does NOT classify a genuine empty 200 as unavailable (order simply absent)", async () => {
    const { url, close } = await startServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("[]");
    });
    data.ORDERBOOK_API_URLS[TEST_CHAIN_ID] = url;
    const logs = captureErrorLogs();
    try {
      const result = await fetchOrderStatusByUids(makeContext(), TEST_CHAIN_ID, [UID_A]);
      expect(result.size).toBe(0);
      expect(logs.has("ob:unavailable")).toBe(false);
    } finally {
      logs.restore();
      await close();
    }
  });

  it("parses an HTTP-date Retry-After without error", async () => {
    let calls = 0;
    const { url, close } = await startServer((_req, res) => {
      calls++;
      if (calls === 1) {
        res.writeHead(429, {
          "retry-after": new Date(Date.now() + 10).toUTCString(),
          "content-type": "application/json",
        });
        res.end("{}");
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify([makeWrappedOrder(UID_A, "open")]));
    });
    data.ORDERBOOK_API_URLS[TEST_CHAIN_ID] = url;
    try {
      const result = await fetchOrderStatusByUids(makeContext(), TEST_CHAIN_ID, [UID_A]);
      expect(calls).toBe(2);
      expect(result.get(UID_A)?.status).toBe("open");
    } finally {
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
          executedSellAmount: "500",
          executedBuyAmount: "1000",
        });
        expect(result.get("0xuid2")).toEqual({
          status: "open",
          executedSellAmount: "0",
          executedBuyAmount: "0",
        });
        expect(result.get("0xuid3")).toEqual({
          status: "expired",
          executedSellAmount: "250",
          executedBuyAmount: "500",
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
          executedSellAmount: "999",
          executedBuyAmount: "888",
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
