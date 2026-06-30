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
  const flashLoanOrder = {
    orderUid: "orderUid", chainId: "chainId", adapter: "adapter",
    sellToken: "sellToken", buyToken: "buyToken",
    executedSellAmount: "executedSellAmount", executedBuyAmount: "executedBuyAmount",
    feeAmount: "feeAmount", validTo: "validTo", owner: "owner",
    receiver: "receiver", kind: "kind", sellAmountIntended: "sellAmountIntended",
    buyAmountIntended: "buyAmountIntended", flashLoanAmount: "flashLoanAmount",
    flashLoanFeeAmount: "flashLoanFeeAmount", source: "source", type: "type",
    txHash: "txHash", blockNumber: "blockNumber", blockTimestamp: "blockTimestamp",
  };
  return {
    default: { ownerMapping, conditionalOrderGenerator, discreteOrder, flashLoanOrder },
    ownerMapping,
    conditionalOrderGenerator,
    discreteOrder,
    flashLoanOrder,
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

const FLASH_LOAN_ORDER = {
  orderUid: "0x" + "ee".repeat(56),
  chainId: CHAIN_ID,
  adapter: "0x0ece00000000000000000000000000000000aaaa",
  sellToken: "0x1111111111111111111111111111111111111111",
  buyToken: "0x2222222222222222222222222222222222222222",
  executedSellAmount: "5000000000000000000",
  executedBuyAmount: "4900000000000000000",
  feeAmount: "1000000000000000",
  validTo: 1893456000,
  owner: OWNER,
  receiver: OWNER,
  kind: "sell",
  sellAmountIntended: "5000000000000000000",
  buyAmountIntended: "4800000000000000000",
  flashLoanAmount: "5000000000000000000",
  flashLoanFeeAmount: "2500000000000000",
  source: "aave",
  type: "RepayWithCollateral",
  txHash: "0x" + "ff".repeat(32),
  blockNumber: BigInt("12345678"),
  blockTimestamp: BigInt("1700000000"),
};

beforeEach(() => {
  vi.mocked(db.select).mockReset();
});

describe("ordersByOwnerHandler", () => {
  it("returns empty orders array when no generators are found", async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(makeSelectChain([]) as never) // ownerMapping → no proxies
      .mockReturnValueOnce(makeSelectChain([]) as never) // generators → none
      .mockReturnValueOnce(makeSelectChain([]) as never); // flashLoanOrder

    const ctx = makeContext();
    await ordersByOwnerHandler(ctx as never, vi.fn() as never);
    const result = ctx._responses[0]!.body as { orders: unknown[] };
    expect(result.orders).toEqual([]);
  });

  it("returns empty orders when generators exist but have no discrete orders", async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(makeSelectChain([]) as never)
      .mockReturnValueOnce(makeSelectChain([GENERATOR]) as never)
      .mockReturnValueOnce(makeSelectChain([]) as never)
      .mockReturnValueOnce(makeSelectChain([]) as never); // flashLoanOrder

    const ctx = makeContext();
    await ordersByOwnerHandler(ctx as never, vi.fn() as never);
    const result = ctx._responses[0]!.body as { orders: unknown[] };
    expect(result.orders).toEqual([]);
  });

  it("returns enriched orders with embedded generator data including hash", async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(makeSelectChain([]) as never)
      .mockReturnValueOnce(makeSelectChain([GENERATOR]) as never)
      .mockReturnValueOnce(makeSelectChain([ORDER]) as never)
      .mockReturnValueOnce(makeSelectChain([]) as never); // flashLoanOrder

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
      .mockReturnValueOnce(makeSelectChain([ORDER]) as never)
      .mockReturnValueOnce(makeSelectChain([]) as never); // flashLoanOrder

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
      .mockReturnValueOnce(makeSelectChain([ORDER]) as never)
      .mockReturnValueOnce(makeSelectChain([]) as never); // flashLoanOrder

    const ctx = makeContext();
    await ordersByOwnerHandler(ctx as never, vi.fn() as never);
    const result = ctx._responses[0]!.body as { orders: unknown[] };
    expect(result.orders).toHaveLength(1);
  });

  it("returns flash-loan orders in a separate flashLoanOrders array, even with no generators", async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(makeSelectChain([]) as never) // ownerMapping
      .mockReturnValueOnce(makeSelectChain([]) as never) // generators → none
      .mockReturnValueOnce(makeSelectChain([FLASH_LOAN_ORDER]) as never); // flashLoanOrder

    const ctx = makeContext();
    await ordersByOwnerHandler(ctx as never, vi.fn() as never);
    const result = ctx._responses[0]!.body as {
      orders: unknown[];
      flashLoanOrders: Array<Record<string, unknown>>;
    };

    expect(result.orders).toEqual([]);
    expect(result.flashLoanOrders).toHaveLength(1);
    const fl = result.flashLoanOrders[0]!;
    expect(fl["orderUid"]).toBe(FLASH_LOAN_ORDER.orderUid);
    expect(fl["type"]).toBe("RepayWithCollateral");
    expect(fl["source"]).toBe("aave");
    expect(fl["kind"]).toBe("sell");
    // bigint columns serialise to decimal strings
    expect(fl["blockTimestamp"]).toBe("1700000000");
    expect(fl["blockNumber"]).toBe("12345678");
  });

  it("excludes flash-loan orders when ownerAddressType is cowshed_proxy", async () => {
    // FL query must be skipped entirely — only ownerMapping + generators run.
    vi.mocked(db.select)
      .mockReturnValueOnce(makeSelectChain([]) as never) // ownerMapping
      .mockReturnValueOnce(makeSelectChain([]) as never); // generators

    const ctx = makeContext({ ownerAddressType: "cowshed_proxy" });
    await ordersByOwnerHandler(ctx as never, vi.fn() as never);
    const result = ctx._responses[0]!.body as { flashLoanOrders: unknown[] };
    expect(result.flashLoanOrders).toEqual([]);
    expect(db.select).toHaveBeenCalledTimes(2);
  });

  it("includes flash-loan orders when ownerAddressType is flash_loan_helper", async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(makeSelectChain([]) as never) // ownerMapping
      .mockReturnValueOnce(makeSelectChain([]) as never) // generators
      .mockReturnValueOnce(makeSelectChain([FLASH_LOAN_ORDER]) as never); // flashLoanOrder

    const ctx = makeContext({ ownerAddressType: "flash_loan_helper" });
    await ordersByOwnerHandler(ctx as never, vi.fn() as never);
    const result = ctx._responses[0]!.body as { flashLoanOrders: unknown[] };
    expect(result.flashLoanOrders).toHaveLength(1);
  });

  it("excludes flash-loan orders when status filter is not 'fulfilled'", async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(makeSelectChain([]) as never) // ownerMapping
      .mockReturnValueOnce(makeSelectChain([]) as never); // generators

    const ctx = makeContext({ status: "expired" });
    await ordersByOwnerHandler(ctx as never, vi.fn() as never);
    const result = ctx._responses[0]!.body as { flashLoanOrders: unknown[] };
    expect(result.flashLoanOrders).toEqual([]);
    expect(db.select).toHaveBeenCalledTimes(2);
  });

  it("includes flash-loan orders when status filter is 'fulfilled'", async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(makeSelectChain([]) as never) // ownerMapping
      .mockReturnValueOnce(makeSelectChain([]) as never) // generators
      .mockReturnValueOnce(makeSelectChain([FLASH_LOAN_ORDER]) as never); // flashLoanOrder

    const ctx = makeContext({ status: "fulfilled" });
    await ordersByOwnerHandler(ctx as never, vi.fn() as never);
    const result = ctx._responses[0]!.body as { flashLoanOrders: unknown[] };
    expect(result.flashLoanOrders).toHaveLength(1);
  });
});

// ─── Schema tests ──────────────────────────────────────────────────

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
  // Regression guard: hash was previously missing from the schema,
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
      "On-chain canonical identifier: keccak256(abi.encode(ConditionalOrderParams { handler, salt, staticInput })) — the value returned by ComposableCow.hash(params) and used as the key in singleOrders(owner, hash) and remove(owner, hash).",
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

    const result = OrdersByOwnerResponse.safeParse({
      orders: [orderItem],
      flashLoanOrders: [],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.orders).toHaveLength(1);
      expect(result.data.orders[0]!.generator?.hash).toBe(validGenerator.hash);
    }
  });

  it("parses an empty orders array", () => {
    const result = OrdersByOwnerResponse.safeParse({
      orders: [],
      flashLoanOrders: [],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.orders).toHaveLength(0);
    }
  });
});

