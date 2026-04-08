/**
 * Block handler — polls ComposableCoW.getTradeableOrderWithSignature for due orders.
 *
 * Fires every block on each configured chain. Uses poll state columns on
 * conditionalOrderGenerator to decide which orders are due for a check
 * (`nextCheckBlock <= currentBlock` or `nextCheckTimestamp <= currentTimestamp`).
 * For each due order, multicalls `getTradeableOrderWithSignature` on ComposableCoW
 * and updates the generator based on the PollResultError revert reason:
 *
 *   Success          → nextCheckBlock += RECHECK_INTERVAL
 *   PollTryNextBlock → nextCheckBlock = currentBlock + 1
 *   PollTryAtBlock   → nextCheckBlock = blockNumber (from error)
 *   PollTryAtEpoch   → nextCheckTimestamp = epoch (stored directly)
 *   PollNever        → status = "Invalid"
 *   OrderNotValid    → treated as TryNextBlock (transient)
 *   Unknown revert   → treated as TryNextBlock (never crash handler)
 *
 * Reference: composable-cow/src/interfaces/IConditionalOrder.sol
 */

import { ponder } from "ponder:registry";
import { candidateDiscreteOrder, conditionalOrderGenerator, discreteOrder } from "ponder:schema";
import { and, eq, lte, or, sql } from "ponder";
import type { Hex } from "viem";
import {
  COMPOSABLE_COW_ADDRESS_BY_CHAIN_ID,
  type SupportedChainId,
} from "../../data";
import { RECHECK_INTERVAL } from "../../constants";
import { fetchComposableOrders, upsertDiscreteOrders } from "../helpers/orderbookClient";
import {
  GET_TRADEABLE_ORDER_WITH_ERRORS_ABI,
  parsePollError,
} from "../helpers/pollResultErrors";
import { computeOrderUid, type GPv2OrderData } from "../helpers/orderUid";

// ─── Handler registration ────────────────────────────────────────────────────
// Single multi-chain block handler. To add a new chain: update PollResultPoller
// in ponder.config.ts and add the chain's config to src/data.ts.

ponder.on("PollResultPoller:block", async ({ event, context }) => {
  await runPollResultCheck(event, context);
});

// ─── Shared implementation ────────────────────────────────────────────────────

async function runPollResultCheck(
  event: { block: { number: bigint; timestamp: bigint } },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  context: any,
): Promise<void> {
  if (process.env.DISABLE_POLL_RESULT_CHECK) {
    return;
  }

  const chainId = context.chain.id as SupportedChainId;
  const composableCowAddress = COMPOSABLE_COW_ADDRESS_BY_CHAIN_ID[chainId];
  if (!composableCowAddress) {
    console.warn(`[COW:POLL:RESULT] No address for chainId=${chainId}`);
    return;
  }

  const currentBlock: bigint = event.block.number;
  const currentTimestamp: bigint = event.block.timestamp;

  // No backfill skip needed — PollResultPoller starts at "latest" in ponder.config.ts,
  // so this handler only fires at live sync.

  // Query due orders — generators with nextCheckBlock <= currentBlock OR
  // nextCheckTimestamp <= currentTimestamp
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
    `[COW:POLL:RESULT] ENTER block=${currentBlock} chain=${chainId} due=${dueOrders.length}`,
  );

  // Batch multicall — allowFailure:true so PollResultErrors come back as failures
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
  const ownersWithTradeableOrders = new Set<Hex>();

  for (let i = 0; i < dueOrders.length; i++) {
    const result = results[i];
    const order = dueOrders[i]!;

    if (result === undefined) continue;

    if (result.status === "success") {
      // Extract order data from multicall result
      const [orderData] = result.result as [GPv2OrderData, Hex];

      // Compute orderUid for this order
      const orderUid = computeOrderUid(chainId, orderData, order.owner);

      // Derive TWAP partIndex when t0 is known
      let partIndex: bigint | null = null;
      if (order.orderType === "TWAP" && order.decodedParams) {
        const t0 = BigInt(order.decodedParams["t0"] ?? "0");
        const t = BigInt(order.decodedParams["t"] ?? "0");
        if (t0 > 0n && t > 0n) {
          partIndex = (BigInt(orderData.validTo) + 1n - t0) / t - 1n;
        }
      }

      // Upsert candidate discrete order — onConflictDoNothing so we don't overwrite
      // fulfilled/expired status set by trade events or expiry detection
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

      ownersWithTradeableOrders.add(order.owner);

      // Schedule recheck after RECHECK_INTERVAL blocks
      await updateGeneratorPollState(context, chainId, order.generatorId, currentBlock, {
        nextCheckBlock: currentBlock + RECHECK_INTERVAL,
        lastPollResult: "success",
        nextCheckTimestamp: null,
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
          // Store the target timestamp directly — the due-order query checks
          // nextCheckTimestamp <= currentTimestamp, no block estimation needed
          await updateGeneratorPollState(context, chainId, order.generatorId, currentBlock, {
            nextCheckBlock: null,
            lastPollResult: "tryAtEpoch",
            nextCheckTimestamp: pollResult.timestamp,
          });
          break;

        case "never":
          // Order is permanently done — deactivate generator
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
            `[COW:POLL:RESULT] NEVER generatorId=${order.generatorId} reason=${pollResult.reason} block=${currentBlock} chain=${chainId}`,
          );
          neverCount++;
          break;
      }
    }
  }

  // Fetch from API for owners with tradeable orders — updates discrete order
  // status from the authoritative API (may already be fulfilled/expired).
  if (ownersWithTradeableOrders.size > 0) {
    for (const owner of ownersWithTradeableOrders) {
      const orders = await fetchComposableOrders(context, chainId, owner);
      await upsertDiscreteOrders(context, chainId, orders);
    }
  }

  await expireOpenOrders(context, chainId, currentTimestamp);

  console.log(
    `[COW:POLL:RESULT] DONE block=${currentBlock} chain=${chainId} due=${dueOrders.length} success=${successCount} never=${neverCount}`,
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function updateGeneratorPollState(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  context: any,
  chainId: number,
  generatorId: string,
  currentBlock: bigint,
  fields: { nextCheckBlock: bigint | null; lastPollResult: string; nextCheckTimestamp: bigint | null },
): Promise<void> {
  await context.db.sql
    .update(conditionalOrderGenerator)
    .set({
      nextCheckBlock: fields.nextCheckBlock,
      nextCheckTimestamp: fields.nextCheckTimestamp,
      lastCheckBlock: currentBlock,
      lastPollResult: fields.lastPollResult,
    })
    .where(
      and(
        eq(conditionalOrderGenerator.chainId, chainId),
        eq(conditionalOrderGenerator.eventId, generatorId),
      ),
    );
}

/**
 * Mark all open discrete orders as expired if their validTo has passed.
 * Runs once per block handler invocation, across all generators on this chain.
 */
async function expireOpenOrders(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  context: any,
  chainId: SupportedChainId,
  currentTimestamp: bigint,
): Promise<void> {
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
}
