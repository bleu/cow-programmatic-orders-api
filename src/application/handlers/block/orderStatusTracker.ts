import { ponder } from "ponder:registry";
import { conditionalOrderGenerator, discreteOrder } from "ponder:schema";
import { and, asc, eq, gte, inArray, isNull, lte, notInArray, or, sql } from "ponder";
import { REORG_SAFETY_WINDOW_SECONDS, type SupportedChainId } from "../../../data";
import {
  DEFAULT_MAX_DISCRETE_ORDERS_PER_BLOCK,
  DEFAULT_REORG_SAFETY_WINDOW_SECONDS,
} from "../../../constants";
import { fetchOrderStatusByUids } from "../../helpers/orderbookClient";
import { bumpGeneratorsUpdatedAt } from "../../helpers/updatedAtBlock";
import { log } from "../../helpers/logger";
import { refreshTwapExecutedTotals } from "../../helpers/executedAmounts";

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
        executedSellAmount: info.executedSellAmount ?? null,
        executedBuyAmount: info.executedBuyAmount ?? null,
        executedFee: info.executedFee ?? null,
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
            // Statuses served from cow_cache can carry null executed amounts —
            // coalesce so they never erase values from an earlier fresh fetch.
            executedSellAmount: sql`coalesce(excluded.executed_sell_amount, ${discreteOrder.executedSellAmount})`,
            executedBuyAmount: sql`coalesce(excluded.executed_buy_amount, ${discreteOrder.executedBuyAmount})`,
            executedFee: sql`coalesce(excluded.executed_fee, ${discreteOrder.executedFee})`,
            updatedAtBlock: sql`excluded.updated_at_block`,
          },
        });

      await bumpGeneratorsUpdatedAt(
        context,
        chainId,
        rowsToUpdate.map((r) => r.conditionalOrderGeneratorId),
        event.block.number,
      );

      await refreshTwapExecutedTotals(
        context,
        chainId,
        rowsToUpdate.map((row) => row.conditionalOrderGeneratorId),
      );

      log("info", "OrderStatusTracker:DONE", { block: String(event.block.number), chainId, open: openOrders.length, updated: rowsToUpdate.length });
    }
  }

  // Generators cancelled on-chain — used by the soft-terminal re-poll below
  // (exclusion) and the parent-cancelled cascade after it.
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

  // ── Soft-terminal re-poll (reorg self-healing — COW-1183) ──────────────────
  // A terminal status written before a fork block survives Ponder's rollback,
  // so a reorged-out settlement can leave discreteOrder (and the cow_cache row
  // behind it) wrong. Terminal rows are therefore re-polled until the trust
  // rule (orderbook/trust.ts) hardens them: fetchOrderStatusByUids serves
  // hardened rows straight from cache, so only genuinely soft rows cost HTTP.
  // Open orders keep priority under the per-block cap. Cascade-cancelled rows
  // are excluded — their truth is the parent's on-chain Cancelled event
  // (reorg-safe in Ponder's journal) and the API is silent about them, so
  // polling would ping-pong them back to open.
  const softBudget = maxOrdersPerBlock - openOrders.length;
  if (softBudget > 0) {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const window =
      REORG_SAFETY_WINDOW_SECONDS[chainId] ?? DEFAULT_REORG_SAFETY_WINDOW_SECONDS;

    // validTo older than the window can't change anymore (fills are impossible
    // after validTo) — the candidate set is only recently-terminal rows, plus
    // future/null-validTo ones until their cache entry hardens.
    const softCandidates = await context.db.sql
      .select({
        orderUid: discreteOrder.orderUid,
        conditionalOrderGeneratorId: discreteOrder.conditionalOrderGeneratorId,
        status: discreteOrder.status,
        validTo: discreteOrder.validTo,
      })
      .from(discreteOrder)
      .where(
        and(
          eq(discreteOrder.chainId, chainId),
          inArray(discreteOrder.status, ["fulfilled", "cancelled", "expired"]),
          or(
            isNull(discreteOrder.validTo),
            gte(discreteOrder.validTo, nowSeconds - window),
          ),
          ...(cancelledGeneratorIds.length > 0
            ? [notInArray(discreteOrder.conditionalOrderGeneratorId, cancelledGeneratorIds)]
            : []),
        ),
      )
      .limit(softBudget) as {
      orderUid: string;
      conditionalOrderGeneratorId: string;
      status: string;
      validTo: number | null;
    }[];

    if (softCandidates.length > 0) {
      const softStatuses = await fetchOrderStatusByUids(
        context,
        chainId,
        softCandidates.map((o) => o.orderUid),
      );

      type SoftStatusInfo = NonNullable<ReturnType<typeof softStatuses.get>>;
      const revertedUids: string[] = [];
      const flipped: { orderUid: string; info: SoftStatusInfo }[] = [];
      const touchedGeneratorIds: string[] = [];

      for (const order of softCandidates) {
        const info = softStatuses.get(order.orderUid);
        if (!info || info.status === order.status) continue;
        if (info.status === "open") {
          // Reorg revert — back to open so the normal poll loop re-resolves it.
          // Skip when validTo already passed: the expiry sweep owns that row.
          if (order.validTo != null && order.validTo <= Number(currentTimestamp)) continue;
          revertedUids.push(order.orderUid);
          touchedGeneratorIds.push(order.conditionalOrderGeneratorId);
        } else if (VALID_DISCRETE_STATUSES.has(info.status)) {
          flipped.push({ orderUid: order.orderUid, info });
          touchedGeneratorIds.push(order.conditionalOrderGeneratorId);
        }
      }

      if (revertedUids.length > 0) {
        // Executed amounts came from the reorged-out settlement — clear them;
        // a later fill re-populates via the open-order loop.
        await context.db.sql
          .update(discreteOrder)
          .set({
            status: "open",
            executedSellAmount: null,
            executedBuyAmount: null,
            executedFee: null,
            updatedAtBlock: event.block.number,
          })
          .where(
            and(
              eq(discreteOrder.chainId, chainId),
              inArray(discreteOrder.orderUid, revertedUids),
            ),
          );
      }

      // Per-row updates: flips only happen while a reorg is healing, so this
      // path is cold. Null amounts (cache-served fallbacks) keep existing
      // values, mirroring the coalesce semantics of the open-order upsert.
      for (const { orderUid, info } of flipped) {
        await context.db.sql
          .update(discreteOrder)
          .set({
            status: info.status as "fulfilled" | "unfilled" | "expired" | "cancelled",
            ...(info.executedSellAmount != null && { executedSellAmount: info.executedSellAmount }),
            ...(info.executedBuyAmount != null && { executedBuyAmount: info.executedBuyAmount }),
            ...(info.executedFee != null && { executedFee: info.executedFee }),
            updatedAtBlock: event.block.number,
          })
          .where(
            and(
              eq(discreteOrder.chainId, chainId),
              eq(discreteOrder.orderUid, orderUid),
            ),
          );
      }

      if (touchedGeneratorIds.length > 0) {
        await bumpGeneratorsUpdatedAt(context, chainId, touchedGeneratorIds, event.block.number);
        await refreshTwapExecutedTotals(context, chainId, touchedGeneratorIds);
        log("info", "OrderStatusTracker:REORG_HEAL", {
          block: String(event.block.number),
          chainId,
          reverted: revertedUids.length,
          flipped: flipped.length,
        });
      }
    }
  }

  // Parent-cancelled cascade: any open discrete_order whose parent generator
  // is Cancelled and whose API state is non-terminal (not fulfilled / unfilled
  // / expired / cancelled) should be cancelled from on-chain truth. The API
  // loop above already applied API-terminal statuses, so what remains as
  // status='open' here is exactly the "API silent" set.
  if (cancelledGeneratorIds.length > 0) {
    const cascaded = await context.db.sql
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
      .returning({ generatorId: discreteOrder.conditionalOrderGeneratorId });

    await bumpGeneratorsUpdatedAt(
      context,
      chainId,
      cascaded.map((r) => r.generatorId),
      event.block.number,
    );
  }

  // Expire orders past validTo
  const expired = await context.db.sql
    .update(discreteOrder)
    .set({ status: "expired", updatedAtBlock: event.block.number })
    .where(
      and(
        eq(discreteOrder.chainId, chainId),
        eq(discreteOrder.status, "open"),
        lte(discreteOrder.validTo, Number(currentTimestamp)),
      ),
    )
    .returning({ generatorId: discreteOrder.conditionalOrderGeneratorId });

  await bumpGeneratorsUpdatedAt(
    context,
    chainId,
    expired.map((r) => r.generatorId),
    event.block.number,
  );
});
