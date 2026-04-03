/**
 * Hono API — GraphQL auto-generated from schema + custom query endpoints.
 *
 * Auto-generated GraphQL (via Ponder's graphql() middleware) covers:
 *   - conditionalOrderGenerators(where: { owner }) { discreteOrders { ... } }
 *   - discreteOrders(where: { status, conditionalOrderGeneratorId })
 *   - All table queries with filtering, pagination, and nested relation traversal
 *
 * Custom endpoints (below) cover queries that require:
 *   - Owner resolution through owner_mapping (EOA → CoWShed proxy)
 *   - Computed aggregates (execution summary: filled/open/expired parts)
 *
 * Reference: COW-739
 */

import { db } from "ponder:api";
import schema from "ponder:schema";
import { Hono } from "hono";
import { client, graphql } from "ponder";
import { and, eq, inArray, or, sql } from "ponder";

const app = new Hono();

app.use("/sql/*", client({ db, schema }));
app.use("/", graphql({ db, schema }));
app.use("/graphql", graphql({ db, schema }));
app.get("/healthz", (c) => c.json({ status: "ok" }));

// ── Custom endpoints ───────────────────────────────────────────────────────────

/**
 * GET /api/orders/by-owner/:owner
 *
 * Returns discrete orders for a resolved owner address. Resolves EOA through
 * owner_mapping so that CoWShed proxy users and flash loan adapter users get
 * their orders returned under their EOA address.
 *
 * Query params:
 *   chainId  — number, optional (all chains if omitted)
 *   status   — open|fulfilled|unfilled|expired|cancelled, optional
 */
app.get("/api/orders/by-owner/:owner", async (c) => {
  const rawOwner = c.req.param("owner").toLowerCase() as `0x${string}`;
  const chainIdParam = c.req.query("chainId");
  const statusFilter = c.req.query("status") as
    | "open"
    | "fulfilled"
    | "unfilled"
    | "expired"
    | "cancelled"
    | undefined;
  const chainId = chainIdParam !== undefined ? Number(chainIdParam) : undefined;

  // Step 1 — find all proxy / adapter addresses mapped to this EOA
  const mappingConditions: ReturnType<typeof eq>[] = [
    eq(schema.ownerMapping.owner, rawOwner),
  ];
  if (chainId !== undefined) {
    mappingConditions.push(eq(schema.ownerMapping.chainId, chainId));
  }
  const proxyRows = await db
    .select({ address: schema.ownerMapping.address })
    .from(schema.ownerMapping)
    .where(and(...mappingConditions));

  const proxyAddresses = proxyRows.map((r) => r.address) as `0x${string}`[];
  // Union of EOA + all its known proxies
  const allOwners = [rawOwner, ...proxyAddresses];

  // Step 2 — find generators owned by any of these addresses
  const generatorOwnerFilter =
    allOwners.length === 1
      ? or(
          eq(schema.conditionalOrderGenerator.owner, rawOwner),
          eq(schema.conditionalOrderGenerator.resolvedOwner, rawOwner),
        )
      : or(
          inArray(schema.conditionalOrderGenerator.owner, allOwners),
          eq(schema.conditionalOrderGenerator.resolvedOwner, rawOwner),
        );

  const generatorConditions = [generatorOwnerFilter];
  if (chainId !== undefined) {
    generatorConditions.push(eq(schema.conditionalOrderGenerator.chainId, chainId));
  }

  const generators = await db
    .select({
      eventId: schema.conditionalOrderGenerator.eventId,
      chainId: schema.conditionalOrderGenerator.chainId,
      orderType: schema.conditionalOrderGenerator.orderType,
      owner: schema.conditionalOrderGenerator.owner,
      resolvedOwner: schema.conditionalOrderGenerator.resolvedOwner,
      status: schema.conditionalOrderGenerator.status,
    })
    .from(schema.conditionalOrderGenerator)
    .where(and(...generatorConditions));

  if (generators.length === 0) {
    return c.json({ orders: [] });
  }

  // Step 3 — fetch discrete orders for those generators
  const generatorIds = generators.map((g) => g.eventId);

  const orderConditions = [
    inArray(schema.discreteOrder.conditionalOrderGeneratorId, generatorIds),
  ];
  if (chainId !== undefined) {
    orderConditions.push(eq(schema.discreteOrder.chainId, chainId));
  }
  if (statusFilter !== undefined) {
    orderConditions.push(eq(schema.discreteOrder.status, statusFilter));
  }

  const orders = await db
    .select({
      orderUid: schema.discreteOrder.orderUid,
      chainId: schema.discreteOrder.chainId,
      status: schema.discreteOrder.status,
      partIndex: schema.discreteOrder.partIndex,
      sellAmount: schema.discreteOrder.sellAmount,
      buyAmount: schema.discreteOrder.buyAmount,
      feeAmount: schema.discreteOrder.feeAmount,
      filledAtBlock: schema.discreteOrder.filledAtBlock,
      validTo: schema.discreteOrder.validTo,
      detectedBy: schema.discreteOrder.detectedBy,
      creationDate: schema.discreteOrder.creationDate,
      generatorId: schema.discreteOrder.conditionalOrderGeneratorId,
    })
    .from(schema.discreteOrder)
    .where(and(...orderConditions));

  // Attach generator metadata to each order
  const generatorById = Object.fromEntries(generators.map((g) => [g.eventId, g]));
  const enrichedOrders = orders.map((o) => ({
    ...o,
    generator: generatorById[o.generatorId],
  }));

  return c.json({ orders: enrichedOrders });
});

/**
 * GET /api/generator/:eventId/execution-summary
 *
 * Returns a count breakdown of discrete order parts for a conditional order generator.
 * Useful for showing "3 of 5 TWAP parts filled" in a UI.
 *
 * Query params:
 *   chainId — number, required
 */
app.get("/api/generator/:eventId/execution-summary", async (c) => {
  const eventId = c.req.param("eventId");
  const chainIdParam = c.req.query("chainId");
  if (!chainIdParam) {
    return c.json({ error: "chainId query parameter is required" }, 400);
  }
  const chainId = Number(chainIdParam);

  // Aggregate discrete order counts by status for this generator
  const rows = await db.execute<{ status: string; count: string }>(
    sql`SELECT status, COUNT(*)::text AS count
        FROM discrete_order
        WHERE conditional_order_generator_id = ${eventId}
          AND chain_id = ${chainId}
        GROUP BY status`,
  );

  const counts: Record<string, number> = {};
  for (const row of rows.rows) {
    counts[row.status] = Number(row.count);
  }

  const filledParts = counts["fulfilled"] ?? 0;
  const openParts = counts["open"] ?? 0;
  const unfilledParts = counts["unfilled"] ?? 0;
  const expiredParts = counts["expired"] ?? 0;
  const cancelledParts = counts["cancelled"] ?? 0;
  const totalParts = filledParts + openParts + unfilledParts + expiredParts + cancelledParts;

  return c.json({
    generatorId: eventId,
    chainId,
    totalParts,
    filledParts,
    openParts,
    unfilledParts,
    expiredParts,
    cancelledParts,
  });
});

export default app;
