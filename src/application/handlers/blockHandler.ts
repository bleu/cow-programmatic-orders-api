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
import { conditionalOrderGenerator, orderPollState } from "ponder:schema";
import { and, eq, lte } from "ponder";
import type { Hex } from "viem";
import {
  COMPOSABLE_COW_DEPLOYMENTS,
} from "../../data";
import {
  GET_TRADEABLE_ORDER_WITH_ERRORS_ABI,
  parsePollError,
} from "../helpers/pollResultErrors";

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * After a successful getTradeableOrderWithSignature call, schedule next check this
 * many blocks later. Avoids hammering RPC on every block for tradeable orders.
 * ~4 min on mainnet (12s/block), ~1.7 min on gnosis (5s/block).
 */
const RECHECK_INTERVAL = 20n;

/** Approximate block time in seconds per chain — used for PollTryAtEpoch estimation. */
const BLOCK_TIME_SECONDS: Record<number, number> = {
  1: 12,
  100: 5,
};

// ─── ComposableCoW address lookup ─────────────────────────────────────────────

const COMPOSABLE_COW_ADDRESS_BY_CHAIN: Record<number, Hex> = {
  1: COMPOSABLE_COW_DEPLOYMENTS.mainnet.address,
  100: COMPOSABLE_COW_DEPLOYMENTS.gnosis.address,
};

// ─── Handler registrations ────────────────────────────────────────────────────
// One entry per chain. Both call the shared implementation.
// To add a new chain: add a PollResultPoller<Chain> entry in ponder.config.ts
// and register a handler here.

ponder.on("PollResultPollerMainnet:block", async ({ event, context }) => {
  await runPollResultCheck(event, context);
});

ponder.on("PollResultPollerGnosis:block", async ({ event, context }) => {
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

  const chainId: number = context.chain.id;
  const composableCowAddress = COMPOSABLE_COW_ADDRESS_BY_CHAIN[chainId];
  if (!composableCowAddress) {
    console.warn(`[COW:POLL:RESULT] No address for chainId=${chainId}`);
    return;
  }

  const currentBlock: bigint = event.block.number;
  const currentTimestamp: bigint = event.block.timestamp;

  // Query due orders — uses checkBlockActiveIdx for O(1) lookup
  const dueOrders = await context.db.sql
    .select({
      generatorId: conditionalOrderGenerator.eventId,
      owner: conditionalOrderGenerator.owner,
      handler: conditionalOrderGenerator.handler,
      salt: conditionalOrderGenerator.salt,
      staticInput: conditionalOrderGenerator.staticInput,
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
      // Order is tradeable — schedule recheck after RECHECK_INTERVAL blocks
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

          console.log(
            `[COW:POLL:RESULT] NEVER generatorId=${order.generatorId} reason=${pollResult.reason} block=${currentBlock} chain=${chainId}`,
          );
          neverCount++;
          break;
      }
    }
  }

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
  chainId: number,
): bigint {
  const blockTime = BLOCK_TIME_SECONDS[chainId] ?? 12;
  const secondsUntil = Number(targetTimestamp) - Number(currentTimestamp);
  if (secondsUntil <= 0) return currentBlock + 1n;
  const blocksUntil = Math.ceil(secondsUntil / blockTime);
  return currentBlock + BigInt(blocksUntil);
}
