/**
 * Block handlers — five responsibilities split into separate Ponder block entries.
 *
 * C1 (ContractPoller):      RPC multicall for non-deterministic generators. Every block.
 * C2 (CandidateConfirmer):  API batch check for unconfirmed candidates. Every block.
 * C3 (StatusUpdater):       API batch check for open discrete orders + expiry. Every block.
 * C4 (HistoricalBootstrap): One-time owner fetch for non-deterministic backfill orders.
 * C5 (DeterministicCancellationSweeper): singleOrders() mapping read for
 *                           deterministic generators (allCandidatesKnown=true) that
 *                           C1 skips. Runs every block but re-checks each generator
 *                           only every DETERMINISTIC_CANCEL_SWEEP_INTERVAL blocks.
 *
 * All handlers start at "latest" — only run during live sync.
 * C4 additionally has endBlock: "latest", so it fires exactly once.
 */

import { ponder } from "ponder:registry";
import { bootstrapRetryQueue, candidateDiscreteOrder, conditionalOrderGenerator, discreteOrder, discreteOrderStatusEnum } from "ponder:schema";
import { and, asc, eq, gt, inArray, isNull, lte, or, sql } from "ponder";
import type { Hex } from "viem";
import {
  COMPOSABLE_COW_ADDRESS_BY_CHAIN_ID,
  type SupportedChainId,
} from "../../data";
import {
  BLOCK_HANDLER_RPC_TIMEOUT_MS,
  BOOTSTRAP_OWNER_FETCH_TIMEOUT_MS,
  DEFAULT_MAX_DISCRETE_ORDERS_PER_BLOCK,
  DEFAULT_MAX_GENERATORS_PER_BLOCK,
  DETERMINISTIC_CANCEL_SWEEP_INTERVAL,
  RECHECK_INTERVAL,
  TRY_NEXT_BLOCK_WARMUP_THRESHOLD,
  TRY_NEXT_BLOCK_COOLDOWN_THRESHOLD,
  TRY_NEXT_BLOCK_BACKOFF_WARMUP,
  TRY_NEXT_BLOCK_BACKOFF_MID,
  TRY_NEXT_BLOCK_BACKOFF_COLD,
} from "../../constants";
import { fetchComposableOrders, fetchOrderStatusByUids, fetchOwnerOrderStatuses, upsertDiscreteOrders } from "../helpers/orderbookClient";
import { TimeoutError, withTimeout } from "../helpers/withTimeout";
import {
  GET_TRADEABLE_ORDER_WITH_ERRORS_ABI,
  parsePollError,
} from "../helpers/pollResultErrors";
import { computeOrderUid, type GPv2OrderData } from "../helpers/orderUid";
import { log } from "../helpers/logger";
import { type OrderType } from "../../utils/order-types";
type DiscreteStatus = (typeof discreteOrderStatusEnum.enumValues)[number];

const NON_DETERMINISTIC_TYPES: readonly OrderType[] = ["PerpetualSwap", "GoodAfterTime", "TradeAboveThreshold", "CurveCowSwapBurner", "BalancerCowSwapFeeBurner", "CowAmmConstantProduct", "Unknown"];
const SINGLE_SHOT_NON_DETERMINISTIC: readonly OrderType[] = ["GoodAfterTime", "TradeAboveThreshold"];
const BLOCK_NEVER = 2n ** 63n - 1n; // sentinel for epoch-scheduled generators (PollTryAtEpoch)
const VALID_DISCRETE_STATUSES = new Set(["fulfilled", "unfilled", "expired", "cancelled"]);

// Minimal ABI for C5: reads the singleOrders(owner, hash) mapping on ComposableCoW.
// `false` means the owner called remove() — generator is cancelled on-chain.
const SINGLE_ORDERS_ABI = [
  {
    inputs: [
      { internalType: "address", name: "", type: "address" },
      { internalType: "bytes32", name: "", type: "bytes32" },
    ],
    name: "singleOrders",
    outputs: [{ internalType: "bool", name: "", type: "bool" }],
    stateMutability: "view",
    type: "function",
  },
] as const;


// ─── C1: Contract Poller ─────────────────────────────────────────────────────
// Polls getTradeableOrderWithSignature for any active generator where
// allCandidatesKnown=false. Normally only non-deterministic types, but also
// serves as fallback for deterministic types whose precompute failed.

ponder.on("OrderDiscoveryPoller:block", async ({ event, context }) => {
  if (process.env.DISABLE_POLL_RESULT_CHECK) return;

  const chainId = context.chain.id as SupportedChainId;
  const composableCowAddress = COMPOSABLE_COW_ADDRESS_BY_CHAIN_ID[chainId];
  if (!composableCowAddress) return;

  const currentBlock = event.block.number;
  const currentTimestamp = event.block.timestamp;

  const rawGeneratorCap = Number(process.env[`MAX_GENERATORS_PER_BLOCK_${chainId}`]);
  const maxGeneratorsPerBlock =
    Number.isFinite(rawGeneratorCap) && rawGeneratorCap > 0 ? rawGeneratorCap : DEFAULT_MAX_GENERATORS_PER_BLOCK;

  const dueOrders = await context.db.sql
    .select({
      generatorId: conditionalOrderGenerator.eventId,
      owner: conditionalOrderGenerator.owner,
      handler: conditionalOrderGenerator.handler,
      salt: conditionalOrderGenerator.salt,
      staticInput: conditionalOrderGenerator.staticInput,
      orderType: conditionalOrderGenerator.orderType,
      decodedParams: conditionalOrderGenerator.decodedParams,
      consecutiveTryNextBlock: conditionalOrderGenerator.consecutiveTryNextBlock,
    })
    .from(conditionalOrderGenerator)
    .where(
      and(
        eq(conditionalOrderGenerator.chainId, chainId),
        eq(conditionalOrderGenerator.status, "Active"),
        eq(conditionalOrderGenerator.allCandidatesKnown, false),
        or(
          lte(conditionalOrderGenerator.nextCheckBlock, currentBlock),
          lte(conditionalOrderGenerator.nextCheckTimestamp, currentTimestamp),
        ),
      ),
    )
    .orderBy(asc(conditionalOrderGenerator.lastCheckBlock))
    .limit(maxGeneratorsPerBlock) as {
    generatorId: string;
    owner: Hex;
    handler: Hex;
    salt: Hex;
    staticInput: Hex;
    orderType: OrderType;
    decodedParams: Record<string, string> | null;
    consecutiveTryNextBlock: number;
  }[];

  if (dueOrders.length === 0) return;

  log("info", "OrderDiscoveryPoller:ENTER", { block: String(currentBlock), chainId, due: dueOrders.length });

  const c1MulticallPromise = context.client.multicall({
    contracts: dueOrders.map((order) => ({
      address: composableCowAddress,
      abi: GET_TRADEABLE_ORDER_WITH_ERRORS_ABI,
      functionName: "getTradeableOrderWithSignature" as const,
      args: [
        order.owner,
        { handler: order.handler, salt: order.salt, staticInput: order.staticInput },
        "0x" as Hex,
        [] as Hex[],
      ] as const,
    })),
    allowFailure: true,
  });

  let results: Awaited<typeof c1MulticallPromise>;
  try {
    results = await withTimeout(
      c1MulticallPromise,
      BLOCK_HANDLER_RPC_TIMEOUT_MS,
      "c1:multicall",
    );
  } catch (err) {
    if (err instanceof TimeoutError) {
      log("warn", "OrderDiscoveryPoller:multicall_timeout", { block: String(currentBlock), chainId, due: dueOrders.length });
      return;
    }
    throw err;
  }

  let neverCount = 0;
  let successCount = 0;
  let backedOffCount = 0;  // tryNextBlock results that exceeded the warmup threshold
  const successPromises: Promise<unknown>[] = [];

  for (let i = 0; i < dueOrders.length; i++) {
    const result = results[i];
    const order = dueOrders[i]!;

    if (result === undefined) continue;

    if (result.status === "success") {
      const [orderData] = result.result as [GPv2OrderData, Hex];
      const orderUid = computeOrderUid(chainId, orderData, order.owner);

      let possibleValidAfterTimestamp: bigint | null = null;
      if (order.orderType === "TWAP" && order.decodedParams) {
        const t0 = BigInt(order.decodedParams["t0"] ?? "0");
        const t = BigInt(order.decodedParams["t"] ?? "0");
        if (t0 > 0n && t > 0n) {
          const partIndex = (BigInt(orderData.validTo) + 1n - t0) / t - 1n;
          possibleValidAfterTimestamp = t0 + partIndex * t;
        }
      }

      successPromises.push(
        context.db.sql
          .insert(candidateDiscreteOrder)
          .values({
            orderUid: orderUid.toLowerCase(),
            chainId,
            conditionalOrderGeneratorId: order.generatorId,
            possibleValidAfterTimestamp,
            sellAmount: orderData.sellAmount.toString(),
            buyAmount: orderData.buyAmount.toString(),
            feeAmount: orderData.feeAmount.toString(),
            validTo: orderData.validTo,
            creationDate: event.block.timestamp,
          })
          .onConflictDoNothing(),
      );

      const isSingleShot = SINGLE_SHOT_NON_DETERMINISTIC.includes(order.orderType);
      successPromises.push(
        updateGeneratorPollState(context, chainId, order.generatorId, currentBlock, {
          nextCheckBlock: currentBlock + RECHECK_INTERVAL,
          lastPollResult: "success",
          nextCheckTimestamp: null,
          allCandidatesKnown: isSingleShot ? true : undefined,
          consecutiveTryNextBlock: 0,
        }),
      );
      successCount++;
    } else {
      const pollResult = parsePollError(result.error);

      switch (pollResult.type) {
        case "tryNextBlock": {
          const consecutive = order.consecutiveTryNextBlock + 1;
          const backoff =
            consecutive > TRY_NEXT_BLOCK_COOLDOWN_THRESHOLD ? TRY_NEXT_BLOCK_BACKOFF_COLD
            : consecutive > TRY_NEXT_BLOCK_WARMUP_THRESHOLD ? TRY_NEXT_BLOCK_BACKOFF_MID
            : TRY_NEXT_BLOCK_BACKOFF_WARMUP;
          if (consecutive > TRY_NEXT_BLOCK_WARMUP_THRESHOLD) backedOffCount++;
          await updateGeneratorPollState(context, chainId, order.generatorId, currentBlock, {
            nextCheckBlock: currentBlock + backoff,
            lastPollResult: "tryNextBlock",
            nextCheckTimestamp: null,
            consecutiveTryNextBlock: consecutive,
          });
          break;
        }

        case "tryAtBlock":
          await updateGeneratorPollState(context, chainId, order.generatorId, currentBlock, {
            nextCheckBlock: pollResult.blockNumber > currentBlock
              ? pollResult.blockNumber
              : currentBlock + 1n,
            lastPollResult: "tryAtBlock",
            nextCheckTimestamp: null,
            consecutiveTryNextBlock: 0,
          });
          break;

        case "tryAtEpoch":
          await updateGeneratorPollState(context, chainId, order.generatorId, currentBlock, {
            nextCheckBlock: BLOCK_NEVER,
            lastPollResult: "tryAtEpoch",
            nextCheckTimestamp: pollResult.timestamp,
            consecutiveTryNextBlock: 0,
          });
          break;

        case "never":
          await context.db.sql
            .update(conditionalOrderGenerator)
            .set({
              status: "Completed",
              lastCheckBlock: currentBlock,
              lastPollResult: `pollNever:${pollResult.reason}`,
              consecutiveTryNextBlock: 0,
            })
            .where(
              and(
                eq(conditionalOrderGenerator.chainId, chainId),
                eq(conditionalOrderGenerator.eventId, order.generatorId),
              ),
            );
          log("info", "OrderDiscoveryPoller:NEVER", { block: String(currentBlock), chainId, generatorId: order.generatorId, reason: pollResult.reason });
          neverCount++;
          break;

        case "cancelled":
          await context.db.sql
            .update(conditionalOrderGenerator)
            .set({
              status: "Cancelled",
              lastCheckBlock: currentBlock,
              lastPollResult: "cancelled:SingleOrderNotAuthed",
              consecutiveTryNextBlock: 0,
            })
            .where(
              and(
                eq(conditionalOrderGenerator.chainId, chainId),
                eq(conditionalOrderGenerator.eventId, order.generatorId),
              ),
            );
          log("info", "OrderDiscoveryPoller:CANCELLED", { block: String(currentBlock), chainId, generatorId: order.generatorId });
          break;
      }
    }
  }

  await Promise.all(successPromises);

  const capped = dueOrders.length === maxGeneratorsPerBlock;
  log("info", "OrderDiscoveryPoller:DONE", { block: String(currentBlock), chainId, due: dueOrders.length, success: successCount, never: neverCount, backedOff: backedOffCount, capped });
});

// ─── C2: Candidate Confirmer ─────────────────────────────────────────────────
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
      // COW-990: preflight /by_uids before writing cancelled. A candidate could have
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
          "c2:cascade:preflight",
        );
      } catch {
        preflightStatuses = new Map();
      }

      // onConflictDoNothing: if C3 already promoted this UID with a terminal status
      // (e.g. 'fulfilled'), the existing row wins and this insert is a no-op.
      // Chunked to avoid PostgreSQL bind-message parameter limits on large cascades.
      // preflightKnown counts API hits, not rows actually written.
      const CASCADE_CHUNK_SIZE = 500;
      for (let i = 0; i < orphanCandidates.length; i += CASCADE_CHUNK_SIZE) {
        const chunk = orphanCandidates.slice(i, i + CASCADE_CHUNK_SIZE);
        await context.db.sql
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
                promotedAt: event.block.timestamp,
              };
            }),
          )
          .onConflictDoNothing();

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
      promotedAt: event.block.timestamp,
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
          promotedAt: sql`excluded.promoted_at`,
        },
      });
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

    // TWAP parts can age out of /by_uids before C2 sees them, causing fulfilled
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
            "c2:stale:accountFallback",
          );
          for (const [uid, info] of ownerStatuses) {
            if (ownerMissedUids.has(uid)) staleStatuses.set(uid, info);
          }
        } catch (err) {
          console.warn(`[COW:C2] block=${event.block.number} chain=${chainId} accountFallback failed owner=${owner}`, err);
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
        promotedAt: event.block.timestamp,
      };
    });

    await context.db.sql
      .insert(discreteOrder)
      .values(staleRows)
      .onConflictDoNothing();

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
    log("info", "CandidateConfirmer:DONE", { block: String(event.block.number), chainId, candidates: unconfirmed.length, confirmed, expired: stale.length });
  }
});

// ─── C3: Status Updater ──────────────────────────────────────────────────────
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
        promotedAt: order.promotedAt,
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
          },
        });

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
    await context.db.sql
      .update(discreteOrder)
      .set({ status: "cancelled" })
      .where(
        and(
          eq(discreteOrder.chainId, chainId),
          eq(discreteOrder.status, "open"),
          inArray(
            discreteOrder.conditionalOrderGeneratorId,
            cancelledGeneratorIds,
          ),
        ),
      );
  }

  // Expire orders past validTo
  await context.db.sql
    .update(discreteOrder)
    .set({ status: "expired" })
    .where(
      and(
        eq(discreteOrder.chainId, chainId),
        eq(discreteOrder.status, "open"),
        lte(discreteOrder.validTo, Number(currentTimestamp)),
      ),
    );
});

// ─── C4: Historical Bootstrap ────────────────────────────────────────────────
// One-time discovery of historical discrete orders for non-deterministic
// generators created during backfill. Fires once at startBlock=endBlock="latest".

ponder.on("OwnerBackfill:block", async ({ event, context }) => {
  const chainId = context.chain.id as SupportedChainId;
  const currentBlock = event.block.number;

  // Drain the retry queue first — owners that timed out in a previous run
  const queued = await context.db.sql
    .select({ owner: bootstrapRetryQueue.owner, retryCount: bootstrapRetryQueue.retryCount })
    .from(bootstrapRetryQueue)
    .where(eq(bootstrapRetryQueue.chainId, chainId));

  log("info", "OwnerBackfill:START", { block: String(currentBlock), chainId, pendingRetry: queued.length });

  let totalDiscovered = 0;
  const retriedOwners = new Set<Hex>();

  for (const { owner, retryCount } of queued) {
    retriedOwners.add(owner as Hex);
    try {
      const orders = await withTimeout(
        fetchComposableOrders(context, chainId, owner as Hex),
        BOOTSTRAP_OWNER_FETCH_TIMEOUT_MS,
        `c4:retry:${owner}`,
      );
      const count = await upsertDiscreteOrders(context, chainId, orders);
      totalDiscovered += count;
      await context.db.sql
        .delete(bootstrapRetryQueue)
        .where(and(eq(bootstrapRetryQueue.chainId, chainId), eq(bootstrapRetryQueue.owner, owner as Hex)));
    } catch (err) {
      if (err instanceof TimeoutError) {
        log("warn", "OwnerBackfill:owner_retry_timeout", { block: String(currentBlock), chainId, owner, retryCount: retryCount + 1, timeoutMs: BOOTSTRAP_OWNER_FETCH_TIMEOUT_MS });
        await context.db.sql
          .update(bootstrapRetryQueue)
          .set({ retryCount: retryCount + 1, lastRetryAt: currentBlock })
          .where(and(eq(bootstrapRetryQueue.chainId, chainId), eq(bootstrapRetryQueue.owner, owner as Hex)));
        continue;
      }
      throw err;
    }
  }

  // Find Active non-deterministic generators with no discrete orders
  const generators = await context.db.sql
    .select({
      generatorId: conditionalOrderGenerator.eventId,
      owner: conditionalOrderGenerator.owner,
      orderType: conditionalOrderGenerator.orderType,
    })
    .from(conditionalOrderGenerator)
    .leftJoin(
      discreteOrder,
      and(
        eq(conditionalOrderGenerator.chainId, discreteOrder.chainId),
        eq(conditionalOrderGenerator.eventId, discreteOrder.conditionalOrderGeneratorId),
      ),
    )
    .where(
      and(
        eq(conditionalOrderGenerator.chainId, chainId),
        eq(conditionalOrderGenerator.status, "Active"),
        inArray(conditionalOrderGenerator.orderType, [...NON_DETERMINISTIC_TYPES]),
        isNull(discreteOrder.orderUid),
      ),
    ) as {
    generatorId: string;
    owner: Hex;
    orderType: OrderType;
  }[];

  // Exclude owners already retried above — they were just attempted this run
  const freshOwners = new Set(generators.map((g) => g.owner).filter((o) => !retriedOwners.has(o)));

  if (freshOwners.size === 0 && retriedOwners.size === 0) {
    log("info", "OwnerBackfill:no_bootstrap_needed", { block: String(currentBlock), chainId });
    return;
  }

  if (freshOwners.size > 0) {
    log("info", "OwnerBackfill:bootstrap_start", { block: String(currentBlock), chainId, generators: generators.length, freshOwners: freshOwners.size });
  }

  for (const owner of freshOwners) {
    try {
      const orders = await withTimeout(
        fetchComposableOrders(context, chainId, owner),
        BOOTSTRAP_OWNER_FETCH_TIMEOUT_MS,
        `c4:owner:${owner}`,
      );
      const count = await upsertDiscreteOrders(context, chainId, orders);
      totalDiscovered += count;
    } catch (err) {
      if (err instanceof TimeoutError) {
        log("warn", "OwnerBackfill:owner_timeout", { block: String(currentBlock), chainId, owner, timeoutMs: BOOTSTRAP_OWNER_FETCH_TIMEOUT_MS });
        await context.db.sql
          .insert(bootstrapRetryQueue)
          .values({ chainId, owner, firstTimeoutAt: currentBlock, retryCount: 1, lastRetryAt: currentBlock })
          .onConflictDoNothing();
        continue;
      }
      throw err;
    }
  }

  log("info", "OwnerBackfill:DONE", { block: String(currentBlock), chainId, discovered: totalDiscovered });
});

// ─── C5: Deterministic Cancellation Sweeper ──────────────────────────────────
// C1 skips generators with allCandidatesKnown=true (deterministic types: TWAP,
// StopLoss, CirclesBackingOrder), so SingleOrderNotAuthed is never observed
// for them. This handler closes that gap by reading
// ComposableCoW.singleOrders(owner, hash) on a DETERMINISTIC_CANCEL_SWEEP_INTERVAL
// cadence. A `false` result means the owner called remove() on-chain → flip to
// Cancelled, which lets the C2/C3 parent-cancelled cascade (COW-918) reconcile
// the child discrete / candidate rows on the next block.

ponder.on("CancellationWatcher:block", async ({ event, context }) => {
  if (process.env.DISABLE_DETERMINISTIC_CANCEL_SWEEP) return;

  const chainId = context.chain.id as SupportedChainId;
  const composableCowAddress = COMPOSABLE_COW_ADDRESS_BY_CHAIN_ID[chainId];
  if (!composableCowAddress) return;

  const currentBlock = event.block.number;

  const rawGeneratorCap2 = Number(process.env[`MAX_GENERATORS_PER_BLOCK_${chainId}`]);
  const maxGeneratorsPerBlock =
    Number.isFinite(rawGeneratorCap2) && rawGeneratorCap2 > 0 ? rawGeneratorCap2 : DEFAULT_MAX_GENERATORS_PER_BLOCK;

  const dueGenerators = await context.db.sql
    .select({
      generatorId: conditionalOrderGenerator.eventId,
      owner: conditionalOrderGenerator.owner,
      hash: conditionalOrderGenerator.hash,
      orderType: conditionalOrderGenerator.orderType,
    })
    .from(conditionalOrderGenerator)
    .where(
      and(
        eq(conditionalOrderGenerator.chainId, chainId),
        eq(conditionalOrderGenerator.status, "Active"),
        eq(conditionalOrderGenerator.allCandidatesKnown, true),
        or(
          isNull(conditionalOrderGenerator.nextCheckBlock),
          lte(conditionalOrderGenerator.nextCheckBlock, currentBlock),
        ),
      ),
    )
    .orderBy(asc(conditionalOrderGenerator.lastCheckBlock))
    .limit(maxGeneratorsPerBlock) as {
    generatorId: string;
    owner: Hex;
    hash: Hex;
    orderType: OrderType;
  }[];

  if (dueGenerators.length === 0) return;

  log("info", "CancellationWatcher:ENTER", { block: String(currentBlock), chainId, due: dueGenerators.length });

  const c5MulticallPromise = context.client.multicall({
    contracts: dueGenerators.map((g) => ({
      address: composableCowAddress,
      abi: SINGLE_ORDERS_ABI,
      functionName: "singleOrders" as const,
      args: [g.owner, g.hash] as const,
    })),
    allowFailure: true,
  });

  let results: Awaited<typeof c5MulticallPromise>;
  try {
    results = await withTimeout(
      c5MulticallPromise,
      BLOCK_HANDLER_RPC_TIMEOUT_MS,
      "c5:multicall",
    );
  } catch (err) {
    if (err instanceof TimeoutError) {
      log("warn", "CancellationWatcher:multicall_timeout", { block: String(currentBlock), chainId, due: dueGenerators.length });
      return;
    }
    throw err;
  }

  let cancelledCount = 0;
  let stillActiveCount = 0;
  let errorCount = 0;

  for (let i = 0; i < dueGenerators.length; i++) {
    const result = results[i];
    const gen = dueGenerators[i]!;

    if (result === undefined || result.status === "failure") {
      errorCount++;
      // Leave state untouched — retry next sweep cycle.
      continue;
    }

    const stillAuthorized = result.result as boolean;

    if (!stillAuthorized) {
      await context.db.sql
        .update(conditionalOrderGenerator)
        .set({
          status: "Cancelled",
          lastCheckBlock: currentBlock,
          lastPollResult: "cancelled:removeMapping",
          nextCheckBlock: null,
        })
        .where(
          and(
            eq(conditionalOrderGenerator.chainId, chainId),
            eq(conditionalOrderGenerator.eventId, gen.generatorId),
          ),
        );
      log("info", "CancellationWatcher:CANCELLED", { block: String(currentBlock), chainId, generatorId: gen.generatorId, orderType: gen.orderType });
      cancelledCount++;
    } else {
      await context.db.sql
        .update(conditionalOrderGenerator)
        .set({
          lastCheckBlock: currentBlock,
          nextCheckBlock: currentBlock + DETERMINISTIC_CANCEL_SWEEP_INTERVAL,
          lastPollResult: "sweep:stillAuthorized",
        })
        .where(
          and(
            eq(conditionalOrderGenerator.chainId, chainId),
            eq(conditionalOrderGenerator.eventId, gen.generatorId),
          ),
        );
      stillActiveCount++;
    }
  }

  log("info", "CancellationWatcher:DONE", { block: String(currentBlock), chainId, due: dueGenerators.length, cancelled: cancelledCount, stillActive: stillActiveCount, errors: errorCount });
});

// ─── Shared helpers ──────────────────────────────────────────────────────────

async function updateGeneratorPollState(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  context: any,
  chainId: number,
  generatorId: string,
  currentBlock: bigint,
  fields: {
    nextCheckBlock: bigint | null;
    lastPollResult: string;
    nextCheckTimestamp: bigint | null;
    allCandidatesKnown?: boolean;
    consecutiveTryNextBlock?: number;
  },
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const setFields: Record<string, any> = {
    nextCheckBlock: fields.nextCheckBlock,
    nextCheckTimestamp: fields.nextCheckTimestamp,
    lastCheckBlock: currentBlock,
    lastPollResult: fields.lastPollResult,
  };
  if (fields.allCandidatesKnown !== undefined) {
    setFields.allCandidatesKnown = fields.allCandidatesKnown;
  }
  if (fields.consecutiveTryNextBlock !== undefined) {
    setFields.consecutiveTryNextBlock = fields.consecutiveTryNextBlock;
  }

  await context.db.sql
    .update(conditionalOrderGenerator)
    .set(setFields)
    .where(
      and(
        eq(conditionalOrderGenerator.chainId, chainId),
        eq(conditionalOrderGenerator.eventId, generatorId),
      ),
    );
}
