import { ponder } from "ponder:registry";
import { bootstrapRetryQueue, conditionalOrderGenerator, discreteOrder } from "ponder:schema";
import { and, eq, inArray, isNull, ne, or } from "ponder";
import type { Hex } from "viem";
import { type SupportedChainId } from "../../../data";
import {
  BOOTSTRAP_MAX_RETRY_COUNT,
  BOOTSTRAP_OWNER_FETCH_TIMEOUT_MS,
} from "../../../constants";
import { fetchComposableOrders, upsertDiscreteOrders } from "../../helpers/orderbookClient";
import { TimeoutError, withTimeout } from "../../helpers/withTimeout";
import { log } from "../../helpers/logger";
import { type OrderType } from "../../../utils/order-types";

const NON_DETERMINISTIC_TYPES: readonly OrderType[] = ["PerpetualSwap", "GoodAfterTime", "TradeAboveThreshold", "CurveCowSwapBurner", "BalancerCowSwapFeeBurner", "CowAmmConstantProduct", "Unknown"];

// ─── OwnerBackfill ───────────────────────────────────────────────────────────
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

  // Find Active non-deterministic generators with no discrete orders.
  // Skip generators already bootstrapped with 0 orders on a prior run
  // (marked lastPollResult='bootstrap:noop') to avoid re-fetching every restart.
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
        or(
          isNull(conditionalOrderGenerator.lastPollResult),
          ne(conditionalOrderGenerator.lastPollResult, "bootstrap:noop"),
        ),
      ),
    ) as {
    generatorId: string;
    owner: Hex;
    orderType: OrderType;
  }[];

  // Build owner → generatorIds map for marking owners as bootstrapped after 0-order fetch
  const ownerGeneratorIds = new Map<Hex, string[]>();
  for (const gen of generators) {
    const existing = ownerGeneratorIds.get(gen.owner) ?? [];
    existing.push(gen.generatorId);
    ownerGeneratorIds.set(gen.owner, existing);
  }

  let totalDiscovered = 0;
  const retriedOwners = new Set<Hex>();

  for (const { owner, retryCount } of queued) {
    retriedOwners.add(owner as Hex);

    if (retryCount >= BOOTSTRAP_MAX_RETRY_COUNT) {
      log("warn", "OwnerBackfill:owner_retry_abandoned", { block: String(currentBlock), chainId, owner, retryCount, maxRetries: BOOTSTRAP_MAX_RETRY_COUNT });
      await context.db.sql
        .delete(bootstrapRetryQueue)
        .where(and(eq(bootstrapRetryQueue.chainId, chainId), eq(bootstrapRetryQueue.owner, owner as Hex)));
      continue;
    }

    try {
      const orders = await withTimeout(
        fetchComposableOrders(context, chainId, owner as Hex),
        BOOTSTRAP_OWNER_FETCH_TIMEOUT_MS,
        `OwnerBackfill:retry:${owner}`,
      );
      const count = await upsertDiscreteOrders(context, chainId, orders);
      totalDiscovered += count;
      await context.db.sql
        .delete(bootstrapRetryQueue)
        .where(and(eq(bootstrapRetryQueue.chainId, chainId), eq(bootstrapRetryQueue.owner, owner as Hex)));
      if (count === 0) {
        await markOwnerBootstrapped(context, chainId, owner as Hex, ownerGeneratorIds);
      }
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
        `OwnerBackfill:owner:${owner}`,
      );
      const count = await upsertDiscreteOrders(context, chainId, orders);
      totalDiscovered += count;
      if (count === 0) {
        await markOwnerBootstrapped(context, chainId, owner, ownerGeneratorIds);
      }
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


async function markOwnerBootstrapped(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  context: any,
  chainId: number,
  owner: Hex,
  ownerGeneratorIds: Map<Hex, string[]>,
): Promise<void> {
  const genIds = ownerGeneratorIds.get(owner) ?? [];
  if (genIds.length === 0) return;
  await context.db.sql
    .update(conditionalOrderGenerator)
    .set({ lastPollResult: "bootstrap:noop" })
    .where(
      and(
        eq(conditionalOrderGenerator.chainId, chainId),
        inArray(conditionalOrderGenerator.eventId, genIds),
      ),
    );
  log("info", "OwnerBackfill:owner_noop", { chainId, owner, generators: genIds.length });
}
