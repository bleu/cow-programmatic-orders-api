import { describe, it, expect, vi } from "vitest";
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

// We import the module under test after patching ORDERBOOK_API_URLS via a
// helper that starts a local HTTP server and temporarily overrides the URL.
// Because orderbookClient.ts reads ORDERBOOK_API_URLS at call time (not at
// module load time) we can monkey-patch it for each test.
import * as data from "../../src/data";
import { fetchOwnerOrderStatuses } from "../../src/application/helpers/orderbookClient";

// ─── Helpers ─────────────────────────────────────────────────────────────────

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

const FAKE_OWNER = "0xaabbccddEEff0011223344556677889900aabbcc" as Hex;
const FAKE_CHAIN_ID = 1;
const UNKNOWN_CHAIN_ID = 99999;

// ─── Tests ───────────────────────────────────────────────────────────────────

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
    // PAGE_LIMIT is 1000 in orderbookClient.ts. Build two pages: first exactly
    // 1000 orders (triggers another fetch), second with fewer (terminates pagination).
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

        // Should have fetched both pages
        expect(receivedOffsets).toContain(0);
        expect(receivedOffsets).toContain(PAGE_LIMIT);

        // Total entries = 1000 + 1
        expect(result.size).toBe(PAGE_LIMIT + 1);

        // Spot-check the page-2 entry
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
        // fetchAccountOrders breaks out of the loop on non-ok response and
        // returns whatever was accumulated so far (nothing). So result is empty.
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
