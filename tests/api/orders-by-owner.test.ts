import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  GeneratorSummary,
  OrdersByOwnerResponse,
} from "../../src/api/schemas/orders-by-owner";

// Mock virtual modules before any ponder-importing source files are loaded.
// ponder:api is resolved to tests/__mocks__/ponder-api.ts via vitest alias — no inline override needed.
vi.mock("ponder:schema", () => {
  const ownerMapping = { owner: "owner", chainId: "chainId", address: "address" };
  const conditionalOrderGenerator = {
    eventId: "eventId", chainId: "chainId", orderType: "orderType",
    owner: "owner", resolvedOwner: "resolvedOwner", status: "status",
    ownerAddressType: "ownerAddressType", hash: "hash",
  };
  const discreteOrder = {
    conditionalOrderGeneratorId: "conditionalOrderGeneratorId",
    orderUid: "orderUid", chainId: "chainId", status: "status",
    sellAmount: "sellAmount", buyAmount: "buyAmount", feeAmount: "feeAmount",
    validTo: "validTo", creationDate: "creationDate",
    executedSellAmount: "executedSellAmount", executedBuyAmount: "executedBuyAmount",
  };
  return {
    default: { ownerMapping, conditionalOrderGenerator, discreteOrder },
    ownerMapping,
    conditionalOrderGenerator,
    discreteOrder,
  };
});
vi.mock("ponder", () => ({
  and: (..._args: unknown[]) => ({}),
  eq: (..._args: unknown[]) => ({}),
  inArray: (..._args: unknown[]) => ({}),
  or: (..._args: unknown[]) => ({}),
}));

import { db } from "ponder:api";
import { makeSelectChain } from "../__mocks__/ponder-api";
import { ordersByOwnerHandler } from "../../src/api/endpoints/orders-by-owner";

const OWNER = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const EVENT_ID = "abc123";
const CHAIN_ID = 1;

/** Minimal Hono context stub that satisfies orders-by-owner handler requirements. */
function makeContext({
  owner = OWNER,
  chainId = CHAIN_ID,
  status,
  ownerAddressType,
}: {
  owner?: string;
  chainId?: number;
  status?: string;
  ownerAddressType?: string;
} = {}) {
  const responses: Array<{ body: unknown; status: number }> = [];
  return {
    req: {
      valid: (type: "param" | "query") => {
        if (type === "param") return { owner };
        return { chainId, status, ownerAddressType };
      },
    },
    json: (body: unknown, httpStatus = 200) => {
      // Simulate JSON serialization to catch BigInt issues early.
      const serialised = JSON.parse(JSON.stringify(body, (_k, v) =>
        typeof v === "bigint" ? v.toString() : v
      ));
      responses.push({ body: serialised, status: httpStatus });
      return { body: serialised, status: httpStatus };
    },
    _responses: responses,
  };
}

const GENERATOR = {
  eventId: EVENT_ID,
  chainId: CHAIN_ID,
  orderType: "TWAP",
  owner: OWNER,
  resolvedOwner: OWNER,
  status: "Active",
  ownerAddressType: null,
  hash: "0xabc123def456abc123def456abc123def456abc123def456abc123def456abc1",
};

const ORDER = {
  orderUid: "0x" + "bb".repeat(56),
  chainId: CHAIN_ID,
  status: "fulfilled",
  sellAmount: "1000000000000000000",
  buyAmount: "2000000000000000000",
  feeAmount: "1000000000000000",
  validTo: 9_999_999_999,
  creationDate: BigInt("1700000000"),
  executedSellAmount: "1000000000000000000",
  executedBuyAmount: "2000000000000000000",
  generatorId: EVENT_ID,
};

beforeEach(() => {
  vi.mocked(db.select).mockReset();
});

describe("ordersByOwnerHandler", () => {
  it("returns empty orders array when no generators are found", async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(makeSelectChain([]) as never) // ownerMapping → no proxies
      .mockReturnValueOnce(makeSelectChain([]) as never); // generators → none

    const ctx = makeContext();
    await ordersByOwnerHandler(ctx as never, vi.fn() as never);
    const result = ctx._responses[0]!.body as { orders: unknown[] };
    expect(result.orders).toEqual([]);
  });

  it("returns empty orders when generators exist but have no discrete orders", async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(makeSelectChain([]) as never)
      .mockReturnValueOnce(makeSelectChain([GENERATOR]) as never)
      .mockReturnValueOnce(makeSelectChain([]) as never);

    const ctx = makeContext();
    await ordersByOwnerHandler(ctx as never, vi.fn() as never);
    const result = ctx._responses[0]!.body as { orders: unknown[] };
    expect(result.orders).toEqual([]);
  });

  it("returns enriched orders with embedded generator data including hash", async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(makeSelectChain([]) as never)
      .mockReturnValueOnce(makeSelectChain([GENERATOR]) as never)
      .mockReturnValueOnce(makeSelectChain([ORDER]) as never);

    const ctx = makeContext();
    await ordersByOwnerHandler(ctx as never, vi.fn() as never);
    const result = ctx._responses[0]!.body as { orders: Array<Record<string, unknown>> };

    expect(result.orders).toHaveLength(1);
    const order = result.orders[0]!;
    expect(order["orderUid"]).toBe(ORDER.orderUid);
    expect(order["status"]).toBe("fulfilled");
    const gen = order["generator"] as Record<string, unknown>;
    expect(gen["eventId"]).toBe(EVENT_ID);
    expect(gen["orderType"]).toBe("TWAP");
    expect(gen["hash"]).toBe(GENERATOR.hash);
  });

  it("serialises creationDate as a decimal string (BigInt scalar)", async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(makeSelectChain([]) as never)
      .mockReturnValueOnce(makeSelectChain([GENERATOR]) as never)
      .mockReturnValueOnce(makeSelectChain([ORDER]) as never);

    const ctx = makeContext();
    await ordersByOwnerHandler(ctx as never, vi.fn() as never);
    const result = ctx._responses[0]!.body as { orders: Array<Record<string, unknown>> };
    expect(result.orders[0]!["creationDate"]).toBe("1700000000");
  });

  it("includes proxy addresses from ownerMapping in the generator lookup", async () => {
    const PROXY = "0xcccccccccccccccccccccccccccccccccccccccc";
    vi.mocked(db.select)
      .mockReturnValueOnce(makeSelectChain([{ address: PROXY }]) as never)
      .mockReturnValueOnce(makeSelectChain([GENERATOR]) as never)
      .mockReturnValueOnce(makeSelectChain([ORDER]) as never);

    const ctx = makeContext();
    await ordersByOwnerHandler(ctx as never, vi.fn() as never);
    const result = ctx._responses[0]!.body as { orders: unknown[] };
    expect(result.orders).toHaveLength(1);
  });
});

// ─── Schema tests (COW-993) ──────────────────────────────────────────────────

// A minimal valid GeneratorSummary payload that satisfies all required fields.
const validGenerator = {
  eventId: "0xabc123",
  chainId: 1,
  orderType: "TWAP",
  owner: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  resolvedOwner: null,
  status: "open",
  hash: "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
  ownerAddressType: null,
} as const;

describe("GeneratorSummary schema", () => {
  // Regression guard for COW-993: hash was previously missing from the schema,
  // causing it to be silently dropped from API responses. safeParse accepts
  // unknown so TS gives no protection here at runtime.
  it("fails parse when hash is missing", () => {
    const { hash: _omitted, ...withoutHash } = validGenerator;
    const result = GeneratorSummary.safeParse(withoutHash);
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join("."));
      expect(paths).toContain("hash");
    }
  });

  it("fails parse when hash is not a string (number supplied)", () => {
    const result = GeneratorSummary.safeParse({ ...validGenerator, hash: 12345 });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join("."));
      expect(paths).toContain("hash");
    }
  });

  it("hash field carries the correct describe() text", () => {
    const shape = GeneratorSummary.shape;
    const description = shape.hash.description;
    expect(description).toBe(
      "On-chain canonical identifier: keccak256(abi.encode((handler, salt, staticInput))). Used by ComposableCow.singleOrders(owner, hash) and remove(owner, hash).",
    );
  });

  it("ownerAddressType accepts null (regression guard for unchanged field)", () => {
    const result = GeneratorSummary.safeParse({ ...validGenerator, ownerAddressType: null });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.ownerAddressType).toBeNull();
    }
  });
});

describe("OrdersByOwnerResponse schema", () => {
  it("wraps an array of GeneratorSummary correctly via the orders field", () => {
    const orderItem = {
      orderUid: "0xorder001",
      chainId: 1,
      status: "open",
      sellAmount: "1000000000000000000",
      buyAmount: "2000000000000000000",
      feeAmount: "0",
      validTo: null,
      creationDate: "1700000000",
      executedSellAmount: null,
      executedBuyAmount: null,
      generatorId: "0xabc123",
      generator: validGenerator,
    };

    const result = OrdersByOwnerResponse.safeParse({ orders: [orderItem] });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.orders).toHaveLength(1);
      expect(result.data.orders[0]!.generator?.hash).toBe(validGenerator.hash);
    }
  });

  it("parses an empty orders array", () => {
    const result = OrdersByOwnerResponse.safeParse({ orders: [] });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.orders).toHaveLength(0);
    }
  });
});

