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
      "On-chain canonical identifier: keccak256(abi.encode(handler, salt, staticInput)). Used by ComposableCow.singleOrders(owner, hash) and remove(owner, hash).",
    );
  });

  it("ownerAddressType accepts null (regression guard for unchanged field)", () => {
    const result = GeneratorSummary.safeParse({ ...validGenerator, ownerAddressType: null });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.ownerAddressType).toBeNull();
    }
  });

  it("ownerAddressType accepts the enum value 'cowshed_proxy'", () => {
    const result = GeneratorSummary.safeParse({
      ...validGenerator,
      ownerAddressType: "cowshed_proxy",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.ownerAddressType).toBe("cowshed_proxy");
    }
  });

  it("ownerAddressType accepts the enum value 'flash_loan_helper'", () => {
    const result = GeneratorSummary.safeParse({
      ...validGenerator,
      ownerAddressType: "flash_loan_helper",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.ownerAddressType).toBe("flash_loan_helper");
    }
  });
});

describe("OrdersByOwnerResponse schema", () => {
  it("wraps an array of GeneratorSummary correctly via the orders field", () => {
    // Build a minimal OrderItem that nests the generator.
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
      expect(result.data.orders[0].generator?.hash).toBe(validGenerator.hash);
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
