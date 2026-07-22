import { ponder } from "ponder:registry";
import { conditionalOrderGenerator, discreteOrder } from "ponder:schema";
import { and, asc, eq, inArray, lte, sql } from "ponder";
import { type SupportedChainId } from "../../../data";
import { DEFAULT_MAX_DISCRETE_ORDERS_PER_BLOCK } from "../../../constants";
import { fetchOrderStatusByUids } from "../../helpers/orderbookClient";
import { log } from "../../helpers/logger";
import { updateGeneratorWatermarks } from "../../helpers/changeWatermark";

const VALID_DISCRETE_STATUSES = new Set(["fulfilled", "unfilled", "expired", "cancelled"]);

// ─── OrderStatusTracker ──────────────────────────────────────────────────────
// Polls the API for status updates on open discrete orders. Expires past validTo.

ponder.on("OrderStatusTracker:block", async ({ event, context }) => {
  const chainId = context.chain.id as SupportedChainId;
  const currentTimestamp = event.block.timestamp;

  const rawOrderCap = Number(process.env[`MAX_DISCRETE_ORDERS_PER_BLOCK_${chainId}`]);
  const maxOrdersPerBlock =
    Number.isFinite(rawOrderCap) && rawOrderCap > 0 ? rawOrderCap : DEFAULT_MAX_DISCRETE_ORDERS_PER_BLOCK;

  const openOrders = await context.db.sql
    .select({
      orderUid: discreteOrder.orderUid,
      conditionalOrderGeneratorId: discreteOrder.conditionalOrderGeneratorId,
      sellAmount: discreteOrder.sellAmount,
      buyAmount: discreteOrder.buyAmount,
      feeAmount: discreteOrder.feeAmount,
      validTo: discreteOrder.validTo,
      creationDate: discreteOrder.creationDate,
      executedSellAmount: discreteOrder.executedSellAmount,
      executedBuyAmount: discreteOrder.executedBuyAmount,
      promotedAt: discreteOrder.promotedAt,
    })
    .from(discreteOrder)
    .where(
      and(
        eq(discreteOrder.chainId, chainId),
        eq(discreteOrder.status, "open"),
      ),
    )
    .orderBy(asc(discreteOrder.promotedAt))
    .limit(maxOrdersPerBlock) as {
    orderUid: string;
    conditionalOrderGeneratorId: string;
    sellAmount: string;
    buyAmount: string;
    feeAmount: string;
    validTo: number | null;
    creationDate: bigint;
    executedSellAmount: string | null;
    executedBuyAmount: string | null;
    promotedAt: bigint | null;
  }[];

  if (openOrders.length > 0) {
    const uids = openOrders.map((o) => o.orderUid);
    const statuses = await fetchOrderStatusByUids(context, chainId, uids);

    type DiscreteStatus = "open" | "fulfilled" | "unfilled" | "expired" | "cancelled";
    const rowsToUpdate: (typeof discreteOrder.$inferInsert)[] = [];

    for (const order of openOrders) {
      const info = statuses.get(order.orderUid);
      if (!info || !VALID_DISCRETE_STATUSES.has(info.status)) continue;
      const executedSellAmount = info.executedSellAmount ?? null;
      const executedBuyAmount = info.executedBuyAmount ?? null;
      if (
        info.status === "open" &&
        executedSellAmount === order.executedSellAmount &&
        executedBuyAmount === order.executedBuyAmount
      ) continue;
      rowsToUpdate.push({
        orderUid: order.orderUid,
        chainId,
        conditionalOrderGeneratorId: order.conditionalOrderGeneratorId,
        status: info.status as DiscreteStatus,
        sellAmount: order.sellAmount,
        buyAmount: order.buyAmount,
        feeAmount: order.feeAmount,
        validTo: order.validTo,
        creationDate: order.creationDate,
        executedSellAmount,
        executedBuyAmount,
        promotedAt: order.promotedAt,
        updatedAtBlock: event.block.number,
      });
    }

    // One multi-row upsert keeps the block TX open for one round-trip instead of N.
    if (rowsToUpdate.length > 0) {
      await context.db.sql
        .insert(discreteOrder)
        .values(rowsToUpdate)
        // promotedAt is intentionally omitted — preserve the original promotion timestamp across status updates.
        .onConflictDoUpdate({
          target: [discreteOrder.chainId, discreteOrder.orderUid],
          set: {
            status: sql`excluded.status`,
            executedSellAmount: sql`excluded.executed_sell_amount`,
            executedBuyAmount: sql`excluded.executed_buy_amount`,
            updatedAtBlock: sql`excluded.updated_at_block`,
          },
        });
      await updateGeneratorWatermarks(
        context,
        chainId,
        rowsToUpdate.map(({ conditionalOrderGeneratorId }) => conditionalOrderGeneratorId),
        event.block.number,
      );

      log("info", "OrderStatusTracker:DONE", { block: String(event.block.number), chainId, open: openOrders.length, updated: rowsToUpdate.length });
    }
  }

  // Parent-cancelled cascade: any open discrete_order whose parent generator
  // is Cancelled and whose API state is non-terminal (not fulfilled / unfilled
  // / expired / cancelled) should be cancelled from on-chain truth. The API
  // loop above already applied API-terminal statuses, so what remains as
  // status='open' here is exactly the "API silent" set.
  const cancelledGeneratorIds = (
    await context.db.sql
      .select({ id: conditionalOrderGenerator.eventId })
      .from(conditionalOrderGenerator)
      .where(
        and(
          eq(conditionalOrderGenerator.chainId, chainId),
          eq(conditionalOrderGenerator.status, "Cancelled"),
        ),
      )
  ).map((g) => g.id);

  if (cancelledGeneratorIds.length > 0) {
    const cancelledRows = await context.db.sql
      .update(discreteOrder)
      .set({ status: "cancelled", updatedAtBlock: event.block.number })
      .where(
        and(
          eq(discreteOrder.chainId, chainId),
          eq(discreteOrder.status, "open"),
          inArray(
            discreteOrder.conditionalOrderGeneratorId,
            cancelledGeneratorIds,
          ),
        ),
      )
      .returning({
        generatorId: discreteOrder.conditionalOrderGeneratorId,
      });
    await updateGeneratorWatermarks(
      context,
      chainId,
      cancelledRows.map(({ generatorId }) => generatorId),
      event.block.number,
    );
  }

  // Expire orders past validTo
  const expiredRows = await context.db.sql
    .update(discreteOrder)
    .set({ status: "expired", updatedAtBlock: event.block.number })
    .where(
      and(
        eq(discreteOrder.chainId, chainId),
        eq(discreteOrder.status, "open"),
        lte(discreteOrder.validTo, Number(currentTimestamp)),
      ),
    )
    .returning({
      generatorId: discreteOrder.conditionalOrderGeneratorId,
    });
  await updateGeneratorWatermarks(
    context,
    chainId,
    expiredRows.map(({ generatorId }) => generatorId),
    event.block.number,
  );
});
