import { ponder } from "ponder:registry";
import { candidateDiscreteOrder, conditionalOrderGenerator, discreteOrder } from "ponder:schema";
import { and, eq, gt, inArray, isNull, lte, or, sql } from "ponder";
import type { Hex } from "viem";
import { type SupportedChainId } from "../../../data";
import {
  BOOTSTRAP_OWNER_FETCH_TIMEOUT_MS,
  ORDERBOOK_HTTP_TIMEOUT_MS,
} from "../../../constants";
import { fetchOrderStatusByUids, fetchOwnerOrderStatuses } from "../../helpers/orderbookClient";
import { withTimeout } from "../../helpers/withTimeout";
import { bumpGeneratorsUpdatedAt } from "../../helpers/updatedAtBlock";
import { log } from "../../helpers/logger";
import { type DiscreteStatus } from "./shared";
import { refreshGeneratorExecutedAmounts } from "../../helpers/executedAmounts";

// ─── CandidateConfirmer ──────────────────────────────────────────────────────
// Checks if candidate discrete orders exist on the Orderbook API.
// When confirmed, promotes them to discreteOrder.

ponder.on("CandidateConfirmer:block", async ({ event, context }) => {
  const chainId = context.chain.id as SupportedChainId;

  // Parent-cancelled cascade: candidates whose parent generator flipped to
  // Cancelled never hit the orderbook, so skip the API and promote them
  // directly to discrete_order as cancelled. Drains before the normal flow so
  // the unconfirmed SELECT below won't see these rows.
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
    const orphanCandidates = await context.db.sql
      .select({
        orderUid: candidateDiscreteOrder.orderUid,
        generatorId: candidateDiscreteOrder.conditionalOrderGeneratorId,
        sellAmount: candidateDiscreteOrder.sellAmount,
        buyAmount: candidateDiscreteOrder.buyAmount,
        feeAmount: candidateDiscreteOrder.feeAmount,
        validTo: candidateDiscreteOrder.validTo,
        creationDate: candidateDiscreteOrder.creationDate,
      })
      .from(candidateDiscreteOrder)
      .where(
        and(
          eq(candidateDiscreteOrder.chainId, chainId),
          inArray(
            candidateDiscreteOrder.conditionalOrderGeneratorId,
            cancelledGeneratorIds,
          ),
        ),
      ) as {
      orderUid: string;
      generatorId: string;
      sellAmount: string;
      buyAmount: string;
      feeAmount: string;
      validTo: number | null;
      creationDate: bigint;
    }[];

    if (orphanCandidates.length > 0) {
      // Preflight /by_uids before writing cancelled. A candidate could have
      // been posted by the watch-tower and filled/expired between generator creation
      // and the cancellation cascade (~0.17% observed rate). Use the API status when
      // available; fall back to 'cancelled' for UIDs not yet on the orderbook.
      // Bounded by ORDERBOOK_HTTP_TIMEOUT_MS * 2; on timeout the empty map fallback
      // keeps correctness degraded-gracefully (all orphans written as 'cancelled').
      let preflightStatuses: Awaited<ReturnType<typeof fetchOrderStatusByUids>>;
      try {
        preflightStatuses = await withTimeout(
          fetchOrderStatusByUids(context, chainId, orphanCandidates.map((c) => c.orderUid)),
          ORDERBOOK_HTTP_TIMEOUT_MS * 2,
          "CandidateConfirmer:cascade:preflight",
        );
      } catch {
        preflightStatuses = new Map();
      }

      // onConflictDoNothing: if OrderStatusTracker already promoted this UID with a terminal status
      // (e.g. 'fulfilled'), the existing row wins and this insert is a no-op.
      // Chunked to avoid PostgreSQL bind-message parameter limits on large cascades.
      // preflightKnown counts API hits, not rows actually written.
      const CASCADE_CHUNK_SIZE = 500;
      const cascadedGeneratorIds: string[] = [];
      for (let i = 0; i < orphanCandidates.length; i += CASCADE_CHUNK_SIZE) {
        const chunk = orphanCandidates.slice(i, i + CASCADE_CHUNK_SIZE);
        const insertedRows = await context.db.sql
          .insert(discreteOrder)
          .values(
            chunk.map((c) => {
              const apiEntry = preflightStatuses.get(c.orderUid);
              return {
                orderUid: c.orderUid,
                chainId,
                conditionalOrderGeneratorId: c.generatorId,
                status: (apiEntry?.status ?? "cancelled") as DiscreteStatus,
                sellAmount: c.sellAmount,
                buyAmount: c.buyAmount,
                feeAmount: c.feeAmount,
                validTo: c.validTo,
                creationDate: c.creationDate,
                executedSellAmount: apiEntry?.executedSellAmount ?? null,
                executedBuyAmount: apiEntry?.executedBuyAmount ?? null,
                executedFeeAmount:
                  apiEntry?.executedFeeAmount ??
                  (apiEntry?.status === "fulfilled" ? c.feeAmount : null),
                promotedAt: event.block.timestamp,
                updatedAtBlock: event.block.number,
              };
            }),
          )
          .onConflictDoNothing()
          .returning({ generatorId: discreteOrder.conditionalOrderGeneratorId });
        cascadedGeneratorIds.push(...insertedRows.map((r) => r.generatorId));

        await context.db.sql
          .delete(candidateDiscreteOrder)
          .where(
            and(
              eq(candidateDiscreteOrder.chainId, chainId),
              inArray(
                candidateDiscreteOrder.orderUid,
                chunk.map((c) => c.orderUid),
              ),
            ),
          );
      }

      // returning() only yields rows actually inserted — conflicts (UIDs already
      // promoted with a terminal status) are no-ops and must not bump the cursor.
      await bumpGeneratorsUpdatedAt(
        context,
        chainId,
        cascadedGeneratorIds,
        event.block.number,
      );

      await refreshGeneratorExecutedAmounts(
        context,
        chainId,
        orphanCandidates.map((candidate) => candidate.generatorId),
      );

      const preflightKnown = preflightStatuses.size;
      log("info", "CandidateConfirmer:parent_cancelled", { block: String(event.block.number), chainId, parentCancelled: orphanCandidates.length, preflightKnown });
    }
  }

  // Promoted candidates are always deleted below — no join needed to filter them.
  // Skip TWAP parts whose validity window hasn't started (possibleValidAfterTimestamp).
  // Also exclude already-expired candidates (validTo in the past) — the stale path
  // below handles those via /account/{owner}/orders fallback. Without this filter,
  // every block would call /by_uids for all remaining stale UIDs (which always miss),
  // wasting API quota until the stale drain completes.
  const unconfirmed = await context.db.sql
    .select({
      orderUid: candidateDiscreteOrder.orderUid,
      generatorId: candidateDiscreteOrder.conditionalOrderGeneratorId,
      sellAmount: candidateDiscreteOrder.sellAmount,
      buyAmount: candidateDiscreteOrder.buyAmount,
      feeAmount: candidateDiscreteOrder.feeAmount,
      validTo: candidateDiscreteOrder.validTo,
      creationDate: candidateDiscreteOrder.creationDate,
    })
    .from(candidateDiscreteOrder)
    .where(
      and(
        eq(candidateDiscreteOrder.chainId, chainId),
        or(
          isNull(candidateDiscreteOrder.possibleValidAfterTimestamp),
          lte(candidateDiscreteOrder.possibleValidAfterTimestamp, event.block.timestamp),
        ),
        or(
          isNull(candidateDiscreteOrder.validTo),
          gt(candidateDiscreteOrder.validTo, Number(event.block.timestamp)),
        ),
      ),
    ) as {
    orderUid: string;
    generatorId: string;
    sellAmount: string;
    buyAmount: string;
    feeAmount: string;
    validTo: number | null;
    creationDate: bigint;
  }[];

  if (unconfirmed.length === 0) return;

  const uids = unconfirmed.map((c) => c.orderUid);
  const statuses = await fetchOrderStatusByUids(context, chainId, uids);

  const rowsToUpsert: (typeof discreteOrder.$inferInsert)[] = [];
  const confirmedUids: string[] = [];

  for (const candidate of unconfirmed) {
    const orderbookEntry = statuses.get(candidate.orderUid);
    if (!orderbookEntry) continue; // not on API yet — retry next block

    rowsToUpsert.push({
      orderUid: candidate.orderUid,
      chainId,
      conditionalOrderGeneratorId: candidate.generatorId,
      status: orderbookEntry.status as DiscreteStatus,
      sellAmount: candidate.sellAmount,
      buyAmount: candidate.buyAmount,
      feeAmount: candidate.feeAmount,
      validTo: candidate.validTo,
      creationDate: candidate.creationDate,
      executedSellAmount: orderbookEntry.executedSellAmount,
      executedBuyAmount: orderbookEntry.executedBuyAmount,
      executedFeeAmount:
        orderbookEntry.executedFeeAmount ??
        (orderbookEntry.status === "fulfilled" ? candidate.feeAmount : null),
      promotedAt: event.block.timestamp,
      updatedAtBlock: event.block.number,
    });
    confirmedUids.push(candidate.orderUid);
  }

  // One multi-row upsert keeps the block TX open for one round-trip instead of N.
  if (rowsToUpsert.length > 0) {
    await context.db.sql
      .insert(discreteOrder)
      .values(rowsToUpsert)
      .onConflictDoUpdate({
        target: [discreteOrder.chainId, discreteOrder.orderUid],
        set: {
          status: sql`excluded.status`,
          executedSellAmount: sql`excluded.executed_sell_amount`,
          executedBuyAmount: sql`excluded.executed_buy_amount`,
          executedFeeAmount: sql`excluded.executed_fee_amount`,
          promotedAt: sql`excluded.promoted_at`,
          updatedAtBlock: sql`excluded.updated_at_block`,
        },
      });

    await bumpGeneratorsUpdatedAt(
      context,
      chainId,
      rowsToUpsert.map((r) => r.conditionalOrderGeneratorId),
      event.block.number,
    );
  }

  const confirmed = rowsToUpsert.length;

  // Clean up promoted candidates
  if (confirmedUids.length > 0) {
    await context.db.sql
      .delete(candidateDiscreteOrder)
      .where(
        and(
          eq(candidateDiscreteOrder.chainId, chainId),
          inArray(candidateDiscreteOrder.orderUid, confirmedUids),
        ),
      );
  }

  // Promote expired candidates — do a final API check so submitted-but-expired orders
  // land in discreteOrder rather than disappearing silently.
  const stale = await context.db.sql
    .select({
      orderUid: candidateDiscreteOrder.orderUid,
      generatorId: candidateDiscreteOrder.conditionalOrderGeneratorId,
      sellAmount: candidateDiscreteOrder.sellAmount,
      buyAmount: candidateDiscreteOrder.buyAmount,
      feeAmount: candidateDiscreteOrder.feeAmount,
      validTo: candidateDiscreteOrder.validTo,
      creationDate: candidateDiscreteOrder.creationDate,
    })
    .from(candidateDiscreteOrder)
    .where(
      and(
        eq(candidateDiscreteOrder.chainId, chainId),
        lte(candidateDiscreteOrder.validTo, Number(event.block.timestamp)),
      ),
    )
    .limit(500) as {
    orderUid: string;
    generatorId: string;
    sellAmount: string;
    buyAmount: string;
    feeAmount: string;
    validTo: number | null;
    creationDate: bigint;
  }[];

  if (stale.length > 0) {
    const staleStatuses = await fetchOrderStatusByUids(context, chainId, stale.map((c) => c.orderUid));

    // TWAP parts can age out of /by_uids before CandidateConfirmer sees them, causing fulfilled
    // parts to be recorded as "expired". For any missed UIDs, fall back to
    // /account/{owner}/orders — one fetch per unique owner.
    const missed = stale.filter((c) => !staleStatuses.has(c.orderUid));
    if (missed.length > 0) {
      const generatorIds = [...new Set(missed.map((c) => c.generatorId))];
      const ownerRows = (await context.db.sql
        .select({ eventId: conditionalOrderGenerator.eventId, owner: conditionalOrderGenerator.owner })
        .from(conditionalOrderGenerator)
        .where(inArray(conditionalOrderGenerator.eventId, generatorIds))) as {
        eventId: string;
        owner: string;
      }[];
      const ownerByGeneratorId = new Map(ownerRows.map((g) => [g.eventId, g.owner as Hex]));

      const missedByOwner = new Map<Hex, Set<string>>();
      for (const c of missed) {
        const owner = ownerByGeneratorId.get(c.generatorId);
        if (!owner) continue;
        const ownerKey = owner.toLowerCase() as Hex;
        if (!missedByOwner.has(ownerKey)) missedByOwner.set(ownerKey, new Set());
        missedByOwner.get(ownerKey)!.add(c.orderUid);
      }

      for (const [owner, ownerMissedUids] of missedByOwner) {
        try {
          const ownerStatuses = await withTimeout(
            fetchOwnerOrderStatuses(chainId, owner),
            BOOTSTRAP_OWNER_FETCH_TIMEOUT_MS,
            "CandidateConfirmer:stale:accountFallback",
          );
          for (const [uid, info] of ownerStatuses) {
            if (ownerMissedUids.has(uid)) staleStatuses.set(uid, info);
          }
        } catch (err) {
          log("warn", "CandidateConfirmer:accountFallback_failed", { block: String(event.block.number), chainId, owner, err: err instanceof Error ? err.message : String(err) });
        }
      }
    }

    const staleRows: (typeof discreteOrder.$inferInsert)[] = stale.map((c) => {
      const entry = staleStatuses.get(c.orderUid);
      return {
        orderUid: c.orderUid,
        chainId,
        conditionalOrderGeneratorId: c.generatorId,
        status: (entry?.status ?? "expired") as DiscreteStatus,
        sellAmount: c.sellAmount,
        buyAmount: c.buyAmount,
        feeAmount: c.feeAmount,
        validTo: c.validTo,
        creationDate: c.creationDate,
        executedSellAmount: entry?.executedSellAmount ?? null,
        executedBuyAmount: entry?.executedBuyAmount ?? null,
        executedFeeAmount:
          entry?.executedFeeAmount ??
          (entry?.status === "fulfilled" ? c.feeAmount : null),
        promotedAt: event.block.timestamp,
        updatedAtBlock: event.block.number,
      };
    });

    const insertedStaleRows = await context.db.sql
      .insert(discreteOrder)
      .values(staleRows)
      .onConflictDoNothing()
      .returning({ generatorId: discreteOrder.conditionalOrderGeneratorId });

    await bumpGeneratorsUpdatedAt(
      context,
      chainId,
      insertedStaleRows.map((r) => r.generatorId),
      event.block.number,
    );

    await context.db.sql
      .delete(candidateDiscreteOrder)
      .where(
        and(
          eq(candidateDiscreteOrder.chainId, chainId),
          inArray(candidateDiscreteOrder.orderUid, stale.map((c) => c.orderUid)),
        ),
      );
  }

  if (confirmed > 0 || stale.length > 0) {
    await refreshGeneratorExecutedAmounts(context, chainId, [
      ...rowsToUpsert.map((row) => row.conditionalOrderGeneratorId),
      ...stale.map((candidate) => candidate.generatorId),
    ]);
    log("info", "CandidateConfirmer:DONE", { block: String(event.block.number), chainId, candidates: unconfirmed.length, confirmed, expired: stale.length });
  }
});
