import { ponder } from "ponder:registry";
import { candidateDiscreteOrder, conditionalOrderGenerator } from "ponder:schema";
import { and, asc, eq, lte, or, sql } from "ponder";
import type { Hex } from "viem";
import {
  COMPOSABLE_COW_ADDRESS_BY_CHAIN_ID,
  RECHECK_INTERVAL_BLOCKS_BY_CHAIN_ID,
  type SupportedChainId,
} from "../../../data";
import {
  BLOCK_HANDLER_RPC_TIMEOUT_MS,
  DEFAULT_MAX_GENERATORS_PER_BLOCK,
  DEFAULT_RECHECK_INTERVAL_BLOCKS,
  TRY_NEXT_BLOCK_WARMUP_THRESHOLD,
  TRY_NEXT_BLOCK_COOLDOWN_THRESHOLD,
  TRY_NEXT_BLOCK_BACKOFF_WARMUP,
  TRY_NEXT_BLOCK_BACKOFF_MID,
  TRY_NEXT_BLOCK_BACKOFF_COLD,
} from "../../../constants";
import { TimeoutError, withTimeout } from "../../helpers/withTimeout";
import {
  GET_TRADEABLE_ORDER_WITH_ERRORS_ABI,
  parsePollError,
} from "../../helpers/pollResultErrors";
import { computeOrderUid, type GPv2OrderData } from "../../helpers/orderUid";
import { log } from "../../helpers/logger";
import { type OrderType } from "../../../utils/order-types";

const SINGLE_SHOT_NON_DETERMINISTIC: readonly OrderType[] = ["GoodAfterTime", "TradeAboveThreshold"];
const BLOCK_NEVER = 2n ** 63n - 1n; // sentinel for epoch-scheduled generators (PollTryAtEpoch)

// ─── OrderDiscoveryPoller ────────────────────────────────────────────────────
// Polls getTradeableOrderWithSignature for any active generator where
// allCandidatesKnown=false. Normally only non-deterministic types, but also
// serves as fallback for deterministic types whose precompute failed.

ponder.on("OrderDiscoveryPoller:block", async ({ event, context }) => {

  const chainId = context.chain.id as SupportedChainId;
  const composableCowAddress = COMPOSABLE_COW_ADDRESS_BY_CHAIN_ID[chainId];
  if (!composableCowAddress) return;

  // Per-chain recheck cadence (derived from ChainConfig.orderbookPollInterval); F17.
  const recheckInterval =
    RECHECK_INTERVAL_BLOCKS_BY_CHAIN_ID[chainId] ?? DEFAULT_RECHECK_INTERVAL_BLOCKS;

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
      "OrderDiscoveryPoller:multicall",
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
          nextCheckBlock: currentBlock + recheckInterval,
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
