/**
 * Block handlers — four responsibilities split into separate Ponder block entries.
 *
 * C1 (ContractPoller):      RPC multicall for non-deterministic generators. Every block.
 * C2 (CandidateConfirmer):  API batch check for unconfirmed candidates. Every block.
 * C3 (StatusUpdater):       API batch check for open discrete orders + expiry. Every block.
 * C4 (HistoricalBootstrap): One-time owner fetch for non-deterministic backfill orders.
 *
 * All handlers start at "latest" — only run during live sync.
 * C4 additionally has endBlock: "latest", so it fires exactly once.
 */

import { ponder } from "ponder:registry";
import { candidateDiscreteOrder, conditionalOrderGenerator, discreteOrder } from "ponder:schema";
import { and, eq, inArray, lte, or, sql } from "ponder";
import type { Hex } from "viem";
import {
  COMPOSABLE_COW_ADDRESS_BY_CHAIN_ID,
  type SupportedChainId,
} from "../../data";
import { RECHECK_INTERVAL } from "../../constants";
import { fetchComposableOrders, fetchOrderStatusByUids, upsertDiscreteOrders } from "../helpers/orderbookClient";
import {
  GET_TRADEABLE_ORDER_WITH_ERRORS_ABI,
  parsePollError,
} from "../helpers/pollResultErrors";
import { computeOrderUid, type GPv2OrderData } from "../helpers/orderUid";

const NON_DETERMINISTIC_TYPES = ["PerpetualSwap", "GoodAfterTime", "TradeAboveThreshold", "Unknown"] as const;

// ─── C1: Contract Poller ─────────────────────────────────────────────────────
// Polls getTradeableOrderWithSignature for non-deterministic active generators.
// Deterministic types (TWAP, StopLoss) are handled by UID pre-computation at
// creation and never reach this handler.

ponder.on("ContractPoller:block", async ({ event, context }) => {
  if (process.env.DISABLE_POLL_RESULT_CHECK) return;

  const chainId = context.chain.id as SupportedChainId;
  const composableCowAddress = COMPOSABLE_COW_ADDRESS_BY_CHAIN_ID[chainId];
  if (!composableCowAddress) return;

  const currentBlock = event.block.number;
  const currentTimestamp = event.block.timestamp;

  const dueOrders = await context.db.sql
    .select({
      generatorId: conditionalOrderGenerator.eventId,
      owner: conditionalOrderGenerator.owner,
      handler: conditionalOrderGenerator.handler,
      salt: conditionalOrderGenerator.salt,
      staticInput: conditionalOrderGenerator.staticInput,
      orderType: conditionalOrderGenerator.orderType,
      decodedParams: conditionalOrderGenerator.decodedParams,
    })
    .from(conditionalOrderGenerator)
    .where(
      and(
        eq(conditionalOrderGenerator.chainId, chainId),
        eq(conditionalOrderGenerator.status, "Active"),
        eq(conditionalOrderGenerator.allCandidatesKnown, false),
        inArray(conditionalOrderGenerator.orderType, [...NON_DETERMINISTIC_TYPES]),
        or(
          lte(conditionalOrderGenerator.nextCheckBlock, currentBlock),
          and(
            sql`${conditionalOrderGenerator.nextCheckTimestamp} IS NOT NULL`,
            lte(conditionalOrderGenerator.nextCheckTimestamp, currentTimestamp),
          ),
        ),
      ),
    ) as {
    generatorId: string;
    owner: Hex;
    handler: Hex;
    salt: Hex;
    staticInput: Hex;
    orderType: string;
    decodedParams: Record<string, string> | null;
  }[];

  if (dueOrders.length === 0) return;

  console.log(
    `[COW:C1] ENTER block=${currentBlock} chain=${chainId} due=${dueOrders.length}`,
  );

  const results = await context.client.multicall({
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

  let neverCount = 0;
  let successCount = 0;

  for (let i = 0; i < dueOrders.length; i++) {
    const result = results[i];
    const order = dueOrders[i]!;

    if (result === undefined) continue;

    if (result.status === "success") {
      const [orderData] = result.result as [GPv2OrderData, Hex];
      const orderUid = computeOrderUid(chainId, orderData, order.owner);

      let partIndex: bigint | null = null;
      if (order.orderType === "TWAP" && order.decodedParams) {
        const t0 = BigInt(order.decodedParams["t0"] ?? "0");
        const t = BigInt(order.decodedParams["t"] ?? "0");
        if (t0 > 0n && t > 0n) {
          partIndex = (BigInt(orderData.validTo) + 1n - t0) / t - 1n;
        }
      }

      await context.db.sql
        .insert(candidateDiscreteOrder)
        .values({
          orderUid: orderUid.toLowerCase(),
          chainId,
          conditionalOrderGeneratorId: order.generatorId,
          status: "open",
          partIndex,
          sellAmount: orderData.sellAmount.toString(),
          buyAmount: orderData.buyAmount.toString(),
          feeAmount: orderData.feeAmount.toString(),
          validTo: orderData.validTo,
          creationDate: BigInt(Number(event.block.timestamp)),
        })
        .onConflictDoNothing();

      // For single-part non-deterministic types, first success means the UID is known
      const isSinglePart = order.orderType !== "PerpetualSwap";
      await updateGeneratorPollState(context, chainId, order.generatorId, currentBlock, {
        nextCheckBlock: currentBlock + RECHECK_INTERVAL,
        lastPollResult: "success",
        nextCheckTimestamp: null,
        allCandidatesKnown: isSinglePart ? true : undefined,
      });
      successCount++;
    } else {
      const pollResult = parsePollError(result.error);

      switch (pollResult.type) {
        case "tryNextBlock":
          await updateGeneratorPollState(context, chainId, order.generatorId, currentBlock, {
            nextCheckBlock: currentBlock + 1n,
            lastPollResult: "tryNextBlock",
            nextCheckTimestamp: null,
          });
          break;

        case "tryAtBlock":
          await updateGeneratorPollState(context, chainId, order.generatorId, currentBlock, {
            nextCheckBlock: pollResult.blockNumber > currentBlock
              ? pollResult.blockNumber
              : currentBlock + 1n,
            lastPollResult: "tryAtBlock",
            nextCheckTimestamp: null,
          });
          break;

        case "tryAtEpoch":
          await updateGeneratorPollState(context, chainId, order.generatorId, currentBlock, {
            nextCheckBlock: null,
            lastPollResult: "tryAtEpoch",
            nextCheckTimestamp: pollResult.timestamp,
          });
          break;

        case "never":
          await context.db.sql
            .update(conditionalOrderGenerator)
            .set({
              status: "Invalid",
              lastCheckBlock: currentBlock,
              lastPollResult: `pollNever:${pollResult.reason}`,
            })
            .where(
              and(
                eq(conditionalOrderGenerator.chainId, chainId),
                eq(conditionalOrderGenerator.eventId, order.generatorId),
              ),
            );
          console.log(
            `[COW:C1] NEVER generatorId=${order.generatorId} reason=${pollResult.reason} block=${currentBlock} chain=${chainId}`,
          );
          neverCount++;
          break;
      }
    }
  }

  console.log(
    `[COW:C1] DONE block=${currentBlock} chain=${chainId} due=${dueOrders.length} success=${successCount} never=${neverCount}`,
  );
});

// ─── C2: Candidate Confirmer ─────────────────────────────────────────────────
// Checks if candidate discrete orders exist on the Orderbook API.
// When confirmed, promotes them to discreteOrder.

ponder.on("CandidateConfirmer:block", async ({ event, context }) => {
  const chainId = context.chain.id as SupportedChainId;

  const unconfirmed = await context.db.sql
    .select({
      orderUid: candidateDiscreteOrder.orderUid,
      generatorId: candidateDiscreteOrder.conditionalOrderGeneratorId,
      partIndex: candidateDiscreteOrder.partIndex,
      sellAmount: candidateDiscreteOrder.sellAmount,
      buyAmount: candidateDiscreteOrder.buyAmount,
      feeAmount: candidateDiscreteOrder.feeAmount,
      validTo: candidateDiscreteOrder.validTo,
      creationDate: candidateDiscreteOrder.creationDate,
    })
    .from(candidateDiscreteOrder)
    .leftJoin(
      discreteOrder,
      and(
        eq(candidateDiscreteOrder.chainId, discreteOrder.chainId),
        eq(candidateDiscreteOrder.orderUid, discreteOrder.orderUid),
      ),
    )
    .where(
      and(
        eq(candidateDiscreteOrder.chainId, chainId),
        sql`${discreteOrder.orderUid} IS NULL`,
      ),
    ) as {
    orderUid: string;
    generatorId: string;
    partIndex: bigint | null;
    sellAmount: string;
    buyAmount: string;
    feeAmount: string;
    validTo: number | null;
    creationDate: bigint;
  }[];

  if (unconfirmed.length === 0) return;

  const uids = unconfirmed.map((c) => c.orderUid);
  const statuses = await fetchOrderStatusByUids(context, chainId, uids);

  let confirmed = 0;
  const confirmedUids: string[] = [];

  for (const candidate of unconfirmed) {
    const apiStatus = statuses.get(candidate.orderUid);
    if (!apiStatus) continue; // not on API yet — retry next block

    await context.db.sql
      .insert(discreteOrder)
      .values({
        orderUid: candidate.orderUid,
        chainId,
        conditionalOrderGeneratorId: candidate.generatorId,
        status: apiStatus as "open" | "fulfilled" | "unfilled" | "expired" | "cancelled",
        partIndex: candidate.partIndex,
        sellAmount: candidate.sellAmount,
        buyAmount: candidate.buyAmount,
        feeAmount: candidate.feeAmount,
        validTo: candidate.validTo,
        creationDate: candidate.creationDate,
      })
      .onConflictDoUpdate({
        target: [discreteOrder.chainId, discreteOrder.orderUid],
        set: { status: apiStatus as "open" | "fulfilled" | "unfilled" | "expired" | "cancelled" },
      });
    confirmedUids.push(candidate.orderUid);
    confirmed++;
  }

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

  // Clean up stale candidates past their validTo — watch-tower likely never submitted them
  await context.db.sql
    .delete(candidateDiscreteOrder)
    .where(
      and(
        eq(candidateDiscreteOrder.chainId, chainId),
        lte(candidateDiscreteOrder.validTo, Number(event.block.timestamp)),
      ),
    );

  if (confirmed > 0) {
    console.log(
      `[COW:C2] block=${event.block.number} chain=${chainId} candidates=${unconfirmed.length} confirmed=${confirmed}`,
    );
  }
});

// ─── C3: Status Updater ──────────────────────────────────────────────────────
// Polls the API for status updates on open discrete orders. Expires past validTo.

ponder.on("StatusUpdater:block", async ({ event, context }) => {
  const chainId = context.chain.id as SupportedChainId;
  const currentTimestamp = event.block.timestamp;

  const openOrders = await context.db.sql
    .select({
      orderUid: discreteOrder.orderUid,
    })
    .from(discreteOrder)
    .where(
      and(
        eq(discreteOrder.chainId, chainId),
        eq(discreteOrder.status, "open"),
      ),
    ) as { orderUid: string }[];

  if (openOrders.length > 0) {
    const uids = openOrders.map((o) => o.orderUid);
    const statuses = await fetchOrderStatusByUids(context, chainId, uids);

    let updated = 0;
    for (const [uid, status] of statuses) {
      if (status !== "open") {
        await context.db.sql
          .update(discreteOrder)
          .set({ status: status as "fulfilled" | "unfilled" | "expired" | "cancelled" })
          .where(
            and(
              eq(discreteOrder.chainId, chainId),
              eq(discreteOrder.orderUid, uid),
            ),
          );
        updated++;
      }
    }

    if (updated > 0) {
      console.log(
        `[COW:C3] block=${event.block.number} chain=${chainId} open=${openOrders.length} updated=${updated}`,
      );
    }
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

ponder.on("HistoricalBootstrap:block", async ({ event, context }) => {
  const chainId = context.chain.id as SupportedChainId;

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
        sql`${discreteOrder.orderUid} IS NULL`,
      ),
    ) as {
    generatorId: string;
    owner: Hex;
    orderType: string;
  }[];

  if (generators.length === 0) {
    console.log(`[COW:C4] block=${event.block.number} chain=${chainId} no generators need bootstrap`);
    return;
  }

  const owners = new Set(generators.map((g) => g.owner));
  console.log(
    `[COW:C4] block=${event.block.number} chain=${chainId} generators=${generators.length} owners=${owners.size}`,
  );

  let totalDiscovered = 0;
  for (const owner of owners) {
    const orders = await fetchComposableOrders(context, chainId, owner);
    const count = await upsertDiscreteOrders(context, chainId, orders);
    totalDiscovered += count;
  }

  console.log(
    `[COW:C4] DONE block=${event.block.number} chain=${chainId} discovered=${totalDiscovered}`,
  );
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
