import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { AddressInfo } from "node:net";
import { fetchOrderStatusByUids } from "../../src/application/helpers/orderbookClient";
import { ORDERBOOK_API_URLS } from "../../src/data";

// Isolated chain ID that doesn't exist in production — safe to mutate and delete.
const TEST_CHAIN_ID = 99_999;

async function startServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/**
 * Minimal Ponder context stub.
 * context.db.sql.execute returns [] (empty cache) so every UID goes to the live API path.
 * Cache writes are no-ops.
 */
function makeContext() {
  return { db: { sql: { execute: async () => [] } } };
}

/** Build a single `{ order: {...} }` item matching the real CoW Orderbook API shape. */
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

// Realistic CoW order UIDs (orderHash + owner + validTo = 56 bytes each).
const UID_A = `0x${"aa".repeat(56)}` as const;
const UID_B = `0x${"bb".repeat(56)}` as const;

describe("fetchOrderStatusByUids", () => {
  beforeAll(() => {
    // Placeholder so the early-exit guard (!apiBaseUrl) passes for TEST_CHAIN_ID.
    // Individual tests replace this with the actual server URL before each call.
    ORDERBOOK_API_URLS[TEST_CHAIN_ID] = "http://placeholder";
  });

  afterAll(() => {
    delete (ORDERBOOK_API_URLS as Record<number, string | undefined>)[TEST_CHAIN_ID];
  });

  it("returns empty map immediately when the uids array is empty", async () => {
    const result = await fetchOrderStatusByUids(makeContext(), TEST_CHAIN_ID, []);
    expect(result.size).toBe(0);
  });

  it("correctly unwraps the { order } wrapper and maps uid → status (regression: COW-979)", async () => {
    // Bug: the API returns [{ order: { uid, status, ... } }] but the code was reading
    // the array items as flat OrderbookOrder objects, so order.uid was always undefined.
    // This caused fetchOrderStatusByUids to return an empty map for every candidate,
    // silently skipping C2/C3 promotions for fulfilled/expired orders.
    const { url, close } = await startServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify([makeWrappedOrder(UID_A, "fulfilled")]));
    });
    ORDERBOOK_API_URLS[TEST_CHAIN_ID] = url;
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
    ORDERBOOK_API_URLS[TEST_CHAIN_ID] = url;
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
    ORDERBOOK_API_URLS[TEST_CHAIN_ID] = url;
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
    ORDERBOOK_API_URLS[TEST_CHAIN_ID] = url;
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
    ORDERBOOK_API_URLS[TEST_CHAIN_ID] = url;
    try {
      const result = await fetchOrderStatusByUids(makeContext(), TEST_CHAIN_ID, [UID_A]);
      expect(result.size).toBe(0);
    } finally {
      await close();
    }
  });
});
