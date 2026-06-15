/**
 * Tests for the C3 StatusUpdater row-building filter logic.
 *
 * blockHandler.ts defines a module-level constant:
 *   const VALID_DISCRETE_STATUSES = new Set(["fulfilled", "unfilled", "expired", "cancelled"]);
 *
 * The row loop skips any order whose API status is absent from this set.
 * Because blockHandler.ts imports `ponder:registry` it cannot be imported in
 * tests, so we reconstruct both the set and the filtering logic here and
 * verify their behaviour directly.
 */
import { describe, it, expect } from "vitest";

// ── Reconstruction of VALID_DISCRETE_STATUSES ────────────────────────────────
// Keep this in sync with the definition in src/application/handlers/blockHandler.ts.
const VALID_DISCRETE_STATUSES = new Set([
  "fulfilled",
  "unfilled",
  "expired",
  "cancelled",
]);

type DiscreteStatus = "open" | "fulfilled" | "unfilled" | "expired" | "cancelled";

interface OpenOrder {
  orderUid: string;
  conditionalOrderGeneratorId: string;
  sellAmount: string;
  buyAmount: string;
  feeAmount: string;
  validTo: number | null;
  creationDate: bigint;
  promotedAt: bigint | null;
}

interface StatusInfo {
  status: string;
  executedSellAmount: string | null;
  executedBuyAmount: string | null;
}

/**
 * Pure re-implementation of the row-building logic from C3 StatusUpdater.
 * Returns the list of rows that would be passed to the multi-row upsert.
 */
function buildRowsToUpdate(
  openOrders: OpenOrder[],
  statuses: Map<string, StatusInfo>,
  chainId: number,
): Array<{ orderUid: string; status: DiscreteStatus }> {
  const rows: Array<{ orderUid: string; status: DiscreteStatus }> = [];
  for (const order of openOrders) {
    const info = statuses.get(order.orderUid);
    if (!info || !VALID_DISCRETE_STATUSES.has(info.status)) continue;
    rows.push({
      orderUid: order.orderUid,
      status: info.status as DiscreteStatus,
    });
  }
  return rows;
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

function makeOrder(uid: string): OpenOrder {
  return {
    orderUid: uid,
    conditionalOrderGeneratorId: "gen-1",
    sellAmount: "1000",
    buyAmount: "900",
    feeAmount: "10",
    validTo: 1800000000,
    creationDate: 1700000000n,
    promotedAt: 1700000001n,
  };
}

// ── VALID_DISCRETE_STATUSES membership ───────────────────────────────────────

describe("VALID_DISCRETE_STATUSES membership", () => {
  it('includes "fulfilled"', () => {
    expect(VALID_DISCRETE_STATUSES.has("fulfilled")).toBe(true);
  });

  it('includes "expired"', () => {
    expect(VALID_DISCRETE_STATUSES.has("expired")).toBe(true);
  });

  it('includes "cancelled"', () => {
    expect(VALID_DISCRETE_STATUSES.has("cancelled")).toBe(true);
  });

  it('includes "unfilled"', () => {
    expect(VALID_DISCRETE_STATUSES.has("unfilled")).toBe(true);
  });

  it('does NOT include "open" — open orders are not valid update targets', () => {
    expect(VALID_DISCRETE_STATUSES.has("open")).toBe(false);
  });

  it("contains exactly four statuses", () => {
    expect(VALID_DISCRETE_STATUSES.size).toBe(4);
  });
});

// ── Row-building filter logic ─────────────────────────────────────────────────

describe("C3 StatusUpdater row-building filter", () => {
  const CHAIN_ID = 1;

  it('includes an order whose API status is "fulfilled"', () => {
    const orders = [makeOrder("uid-fulfilled")];
    const statuses = new Map<string, StatusInfo>([
      ["uid-fulfilled", { status: "fulfilled", executedSellAmount: "999", executedBuyAmount: "888" }],
    ]);
    const rows = buildRowsToUpdate(orders, statuses, CHAIN_ID);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("fulfilled");
    expect(rows[0]?.orderUid).toBe("uid-fulfilled");
  });

  it('includes an order whose API status is "expired"', () => {
    const orders = [makeOrder("uid-expired")];
    const statuses = new Map<string, StatusInfo>([
      ["uid-expired", { status: "expired", executedSellAmount: null, executedBuyAmount: null }],
    ]);
    const rows = buildRowsToUpdate(orders, statuses, CHAIN_ID);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("expired");
  });

  it('includes an order whose API status is "cancelled"', () => {
    const orders = [makeOrder("uid-cancelled")];
    const statuses = new Map<string, StatusInfo>([
      ["uid-cancelled", { status: "cancelled", executedSellAmount: null, executedBuyAmount: null }],
    ]);
    const rows = buildRowsToUpdate(orders, statuses, CHAIN_ID);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("cancelled");
  });

  it('includes an order whose API status is "unfilled"', () => {
    const orders = [makeOrder("uid-unfilled")];
    const statuses = new Map<string, StatusInfo>([
      ["uid-unfilled", { status: "unfilled", executedSellAmount: null, executedBuyAmount: null }],
    ]);
    const rows = buildRowsToUpdate(orders, statuses, CHAIN_ID);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("unfilled");
  });

  it('excludes an order whose API status is "open" — open is not a terminal status', () => {
    const orders = [makeOrder("uid-open")];
    const statuses = new Map<string, StatusInfo>([
      ["uid-open", { status: "open", executedSellAmount: null, executedBuyAmount: null }],
    ]);
    const rows = buildRowsToUpdate(orders, statuses, CHAIN_ID);
    expect(rows).toHaveLength(0);
  });

  it("excludes an order with no matching entry in the status map", () => {
    const orders = [makeOrder("uid-missing")];
    const statuses = new Map<string, StatusInfo>(); // empty — nothing returned from API
    const rows = buildRowsToUpdate(orders, statuses, CHAIN_ID);
    expect(rows).toHaveLength(0);
  });

  it("only includes orders with valid statuses from a mixed batch", () => {
    const orders = [
      makeOrder("uid-a"),  // fulfilled → include
      makeOrder("uid-b"),  // open      → exclude
      makeOrder("uid-c"),  // expired   → include
      makeOrder("uid-d"),  // absent    → exclude
      makeOrder("uid-e"),  // cancelled → include
    ];
    const statuses = new Map<string, StatusInfo>([
      ["uid-a", { status: "fulfilled", executedSellAmount: "100", executedBuyAmount: "90" }],
      ["uid-b", { status: "open",      executedSellAmount: null, executedBuyAmount: null }],
      ["uid-c", { status: "expired",   executedSellAmount: null, executedBuyAmount: null }],
      // uid-d intentionally absent
      ["uid-e", { status: "cancelled", executedSellAmount: null, executedBuyAmount: null }],
    ]);
    const rows = buildRowsToUpdate(orders, statuses, CHAIN_ID);
    const uids = rows.map((r) => r.orderUid);
    expect(uids).toContain("uid-a");
    expect(uids).toContain("uid-c");
    expect(uids).toContain("uid-e");
    expect(uids).not.toContain("uid-b");
    expect(uids).not.toContain("uid-d");
    expect(rows).toHaveLength(3);
  });

  it("returns an empty array when the orders list is empty", () => {
    const rows = buildRowsToUpdate([], new Map(), CHAIN_ID);
    expect(rows).toHaveLength(0);
  });
});
