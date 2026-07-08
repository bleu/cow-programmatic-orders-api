import { ponder, type Context, type Event } from "ponder:registry";
import { conditionalOrderGenerator } from "ponder:schema";
import { and, eq, inArray } from "ponder";
import type { Hex } from "viem";
import { type SupportedChainId } from "../../../data";
import {
  BOOTSTRAP_OWNER_FETCH_TIMEOUT_MS,
  DEFAULT_MAX_OWNERS_BACKFILL_PER_BLOCK,
  DEFAULT_OWNER_BACKFILL_CONCURRENCY,
} from "../../../constants";
import {
  fetchComposableOrders,
  upsertDiscreteOrders,
} from "../../helpers/orderbookClient";
import { TimeoutError, withTimeout } from "../../helpers/withTimeout";
import { mapWithConcurrency } from "../../helpers/concurrency";
import { log } from "../../helpers/logger";
import { NON_DETERMINISTIC_TYPES } from "../../../utils/order-types";

// ─── OwnerBackfill ───────────────────────────────────────────────────────────
// Discovers historical discrete orders for non-deterministic generators (the realtime
// poller only ever returns the *current* tradeable order, never past ones). Each firing
// drains a bounded batch of not-yet-backfilled owners, so the work spreads across blocks
// (rate-limit friendly) and no single transaction holds thousands of owners.
//
// Registered as OwnerBackfillLive (startBlock = "latest", fine interval): the drain runs
// only from the tip onward, so its orderbook API calls never run during historical sync
// (they would otherwise slow Ponder's path to the tip). Every eligible owner — including
// those created during the event backfill — is drained here once sync reaches "latest".
//
// Readiness is gated on the drain completing (see /readyz), so promotion never ships an
// indexer with history still missing.
//
// Eligibility is the historyBackfilled flag, set at generator creation for the cases
// that never need a drain (deterministic types, and generators created live) — see
// composableCow.ts. So the only false rows are non-deterministic historical generators,
// which this handler flips to true once their owner is fully drained.

function resolveOwnerCap(chainId: number): number {
  const raw = Number(process.env[`MAX_OWNERS_BACKFILL_PER_BLOCK_${chainId}`]);
  return Number.isFinite(raw) && raw > 0
    ? raw
    : DEFAULT_MAX_OWNERS_BACKFILL_PER_BLOCK;
}

function resolveOwnerConcurrency(chainId: number): number {
  const raw = Number(process.env[`MAX_OWNERS_BACKFILL_CONCURRENCY_${chainId}`]);
  return Number.isFinite(raw) && raw > 0
    ? raw
    : DEFAULT_OWNER_BACKFILL_CONCURRENCY;
}

// Drain one owner's full history: fetch (timeout-bounded), upsert discovered orders,
// and — only on a full drain — flip historyBackfilled. Returns the per-owner tallies
// so the concurrent caller can aggregate. A per-owner timeout is swallowed (the owner
// stays eligible and is retried next firing); any other error propagates to abort the
// batch (the block handler is idempotent, so the block simply retries).
async function drainOwner(
  context: Context,
  chainId: SupportedChainId,
  currentBlock: bigint,
  owner: Hex,
  ownerGeneratorIds: Map<Hex, string[]>
): Promise<{ discovered: number; drained: number }> {
  try {
    const { orders, complete } = await withTimeout(
      fetchComposableOrders(context, chainId, owner),
      BOOTSTRAP_OWNER_FETCH_TIMEOUT_MS,
      `OwnerBackfill:owner:${owner}`
    );
    const discovered = await upsertDiscreteOrders(context, chainId, orders);

    // Only flip the flag when the owner's history was drained in full. A partial
    // drain (rate limit / timeout) leaves the owner eligible → retried next block.
    if (complete) {
      await markOwnerHistoryBackfilled(context, chainId, owner, ownerGeneratorIds);
      return { discovered, drained: 1 };
    }

    log("warn", "OwnerBackfill:owner_incomplete", {
      block: String(currentBlock),
      chainId,
      owner,
    });
    return { discovered, drained: 0 };
  } catch (err) {
    if (err instanceof TimeoutError) {
      log("warn", "OwnerBackfill:owner_timeout", {
        block: String(currentBlock),
        chainId,
        owner,
        timeoutMs: BOOTSTRAP_OWNER_FETCH_TIMEOUT_MS,
      });
      return { discovered: 0, drained: 0 }; // leave eligible — retried next block
    }
    throw err;
  }
}

async function drainOwnerBatch(
  event: Event<"OwnerBackfillLive:block">,
  context: Context
): Promise<void> {
  const chainId = context.chain.id as SupportedChainId;
  const currentBlock = event.block.number;
  const cap = resolveOwnerCap(chainId);

  const eligibleWhere = and(
    eq(conditionalOrderGenerator.chainId, chainId),
    eq(conditionalOrderGenerator.status, "Active"),
    inArray(conditionalOrderGenerator.orderType, [...NON_DETERMINISTIC_TYPES]),
    eq(conditionalOrderGenerator.historyBackfilled, false)
  );

  // Take up to `cap` distinct owners this block; ordering by owner keeps progress
  // deterministic and lets already-drained owners fall out of the set.
  const ownerRows = (await context.db.sql
    .selectDistinct({ owner: conditionalOrderGenerator.owner })
    .from(conditionalOrderGenerator)
    .where(eligibleWhere)
    .orderBy(conditionalOrderGenerator.owner)
    .limit(cap)) as { owner: Hex }[];

  if (ownerRows.length === 0) return; // nothing pending — cheap no-op every block

  const owners = ownerRows.map((r) => r.owner);

  // Generator ids for the selected owners, to flip historyBackfilled after a clean drain.
  const genRows = (await context.db.sql
    .select({
      generatorId: conditionalOrderGenerator.eventId,
      owner: conditionalOrderGenerator.owner,
    })
    .from(conditionalOrderGenerator)
    .where(
      and(eligibleWhere, inArray(conditionalOrderGenerator.owner, owners))
    )) as {
    generatorId: string;
    owner: Hex;
  }[];

  const ownerGeneratorIds = new Map<Hex, string[]>();
  for (const row of genRows) {
    const existing = ownerGeneratorIds.get(row.owner) ?? [];
    existing.push(row.generatorId);
    ownerGeneratorIds.set(row.owner, existing);
  }

  const concurrency = resolveOwnerConcurrency(chainId);

  log("info", "OwnerBackfill:START", {
    block: String(currentBlock),
    chainId,
    owners: owners.length,
    cap,
    concurrency,
  });

  // Owner fetches are independent HTTP round-trips, so run them concurrently
  // (bounded) rather than one-at-a-time. Wall-clock per firing drops from
  // cap × timeout to ~ceil(cap / concurrency) × timeout.
  const tallies = await mapWithConcurrency(owners, concurrency, (owner) =>
    drainOwner(context, chainId, currentBlock, owner, ownerGeneratorIds)
  );

  const discovered = tallies.reduce((sum, t) => sum + t.discovered, 0);
  const drained = tallies.reduce((sum, t) => sum + t.drained, 0);

  log("info", "OwnerBackfill:DONE", {
    block: String(currentBlock),
    chainId,
    owners: owners.length,
    drained,
    discovered,
  });
}

// Runs from "latest" onward, draining every eligible owner once sync reaches the tip.
ponder.on("OwnerBackfillLive:block", ({ event, context }) =>
  drainOwnerBatch(event, context)
);

// Mark every eligible generator of this owner as history-backfilled so it drops out
// of the eligibility set (and the readiness count). Set only after a full drain.
async function markOwnerHistoryBackfilled(
  context: Context,
  chainId: number,
  owner: Hex,
  ownerGeneratorIds: Map<Hex, string[]>
): Promise<void> {
  const genIds = ownerGeneratorIds.get(owner) ?? [];
  if (genIds.length === 0) return;
  await context.db.sql
    .update(conditionalOrderGenerator)
    .set({ historyBackfilled: true })
    .where(
      and(
        eq(conditionalOrderGenerator.chainId, chainId),
        inArray(conditionalOrderGenerator.eventId, genIds)
      )
    );
}
