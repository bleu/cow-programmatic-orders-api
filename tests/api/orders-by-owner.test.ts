import { describe, it, expect } from "vitest";
import {
  GeneratorSummary,
  OrdersByOwnerResponse,
} from "../../src/api/schemas/orders-by-owner";

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
  it("parses correctly when hash is present as a valid hex string", () => {
    const result = GeneratorSummary.safeParse(validGenerator);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.hash).toBe(validGenerator.hash);
    }
  });

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

  // Regression guard: ownerAddressType is nullable — null is the common case
  // for generators that don't go through a proxy.
  it("ownerAddressType accepts null", () => {
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
