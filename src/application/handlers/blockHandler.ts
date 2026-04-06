/**
 * Block handler — polls ComposableCoW.getTradeableOrderWithSignature for due orders.
 *
 * Fires every block on each configured chain. Uses `order_poll_state` to decide
 * which orders are due for a check (`nextCheckBlock <= currentBlock`). For each due
 * order, multicalls `getTradeableOrderWithSignature` on ComposableCoW and updates
 * the poll state based on the PollResultError revert reason:
 *
 *   Success          → nextCheckBlock += RECHECK_INTERVAL
 *   PollTryNextBlock → nextCheckBlock = currentBlock + 1
 *   PollTryAtBlock   → nextCheckBlock = blockNumber (from error)
 *   PollTryAtEpoch   → nextCheckBlock = estimated block for timestamp
 *   PollNever        → isActive = false; conditionalOrderGenerator.status = "Invalid"
 *   OrderNotValid    → treated as TryNextBlock (transient)
 *   Unknown revert   → treated as TryNextBlock (never crash handler)
 *
 * Replaces the old RemovalPoller (singleOrders check) from M1.
 * Source: COW-738 | Reference: agent_docs/decoder-reference.md#PollResultErrors
 */

import { ponder } from "ponder:registry";
import { conditionalOrderGenerator, discreteOrder, orderPollState } from "ponder:schema";
import { and, eq, lte } from "ponder";
import type { Hex } from "viem";
import {
  BLOCK_TIME_SECONDS,
  COMPOSABLE_COW_ADDRESS_BY_CHAIN_ID,
  type SupportedChainId,
} from "../../data";
import { LIVE_LAG_THRESHOLD_SECONDS, RECHECK_INTERVAL } from "../../constants";
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

  // Skip expensive RPC multicall during backfill — historical results don't change
  // terminal state (orders are re-evaluated at live sync and correctly resolved then).
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (nowSeconds - Number(currentTimestamp) > LIVE_LAG_THRESHOLD_SECONDS) return;

  // Query due orders — uses checkBlockActiveIdx for O(1) lookup
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
    .from(orderPollState)
    .innerJoin(
      conditionalOrderGenerator,
      and(
        eq(orderPollState.chainId, conditionalOrderGenerator.chainId),
        eq(orderPollState.conditionalOrderGeneratorId, conditionalOrderGenerator.eventId),
      ),
    )
    .where(
      and(
        eq(orderPollState.chainId, chainId),
        eq(orderPollState.isActive, true),
        lte(orderPollState.nextCheckBlock, currentBlock),
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

      // Upsert discrete order — onConflictDoNothing so we don't overwrite
      // fulfilled/expired status set by trade events or expiry detection
      await context.db.sql
        .insert(discreteOrder)
        .values({
          orderUid: orderUid.toLowerCase(),
          chainId,
          conditionalOrderGeneratorId: order.generatorId,
          status: "open",
          partIndex,
          sellAmount: orderData.sellAmount.toString(),
          buyAmount: orderData.buyAmount.toString(),
          feeAmount: orderData.feeAmount.toString(),
          filledAtBlock: null,
          validTo: orderData.validTo,
          detectedBy: "block_handler" as const,
          creationDate: BigInt(Number(event.block.timestamp)),
        })
        .onConflictDoNothing();

      // Schedule recheck after RECHECK_INTERVAL blocks
      await updatePollState(context, chainId, order.generatorId, currentBlock, {
        nextCheckBlock: currentBlock + RECHECK_INTERVAL,
        lastPollResult: "success",
      });
      successCount++;
    } else {
      const pollResult = parsePollError(result.error);

      switch (pollResult.type) {
        case "tryNextBlock":
          await updatePollState(context, chainId, order.generatorId, currentBlock, {
            nextCheckBlock: currentBlock + 1n,
            lastPollResult: "tryNextBlock",
          });
          break;

        case "tryAtBlock":
          await updatePollState(context, chainId, order.generatorId, currentBlock, {
            nextCheckBlock: pollResult.blockNumber > currentBlock
              ? pollResult.blockNumber
              : currentBlock + 1n,
            lastPollResult: "tryAtBlock",
          });
          break;

        case "tryAtEpoch": {
          const estimated = estimateBlockForEpoch(
            pollResult.timestamp,
            currentBlock,
            currentTimestamp,
            chainId,
          );
          await updatePollState(context, chainId, order.generatorId, currentBlock, {
            nextCheckBlock: estimated,
            lastPollResult: "tryAtEpoch",
          });
          break;
        }

        case "never":
          // Order is permanently done — deactivate poll state and mark generator Invalid
          await context.db.sql
            .update(orderPollState)
            .set({
              isActive: false,
              lastCheckBlock: currentBlock,
              lastPollResult: `pollNever:${pollResult.reason}`,
            })
            .where(
              and(
                eq(orderPollState.chainId, chainId),
                eq(orderPollState.conditionalOrderGeneratorId, order.generatorId),
              ),
            );

          await context.db.sql
            .update(conditionalOrderGenerator)
            .set({ status: "Invalid" })
            .where(
              and(
                eq(conditionalOrderGenerator.chainId, chainId),
                eq(conditionalOrderGenerator.eventId, order.generatorId),
              ),
            );

          // Also expire any open discrete orders for this generator
          await context.db.sql
            .update(discreteOrder)
            .set({ status: "expired" })
            .where(
              and(
                eq(discreteOrder.chainId, chainId),
                eq(discreteOrder.conditionalOrderGeneratorId, order.generatorId),
                eq(discreteOrder.status, "open"),
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

  // Mark open discrete orders as expired if their validTo has passed
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

  console.log(
    `[COW:POLL:RESULT] DONE block=${currentBlock} chain=${chainId} due=${dueOrders.length} success=${successCount} never=${neverCount}`,
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function updatePollState(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  context: any,
  chainId: number,
  generatorId: string,
  currentBlock: bigint,
  fields: { nextCheckBlock: bigint; lastPollResult: string },
): Promise<void> {
  await context.db.sql
    .update(orderPollState)
    .set({
      nextCheckBlock: fields.nextCheckBlock,
      lastCheckBlock: currentBlock,
      lastPollResult: fields.lastPollResult,
    })
    .where(
      and(
        eq(orderPollState.chainId, chainId),
        eq(orderPollState.conditionalOrderGeneratorId, generatorId),
      ),
    );
}

function estimateBlockForEpoch(
  targetTimestamp: bigint,
  currentBlock: bigint,
  currentTimestamp: bigint,
  chainId: SupportedChainId,
): bigint {
  const blockTime = BLOCK_TIME_SECONDS[chainId];
  const secondsUntil = Number(targetTimestamp) - Number(currentTimestamp);
  if (secondsUntil <= 0) return currentBlock + 1n;
  const blocksUntil = Math.ceil(secondsUntil / blockTime);
  return currentBlock + BigInt(blocksUntil);
}
