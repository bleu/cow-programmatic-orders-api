import { ponder, type Context, type Event } from "ponder:registry";
import { conditionalOrderGenerator } from "ponder:schema";
import { and, eq, inArray, sql } from "ponder";
import type { Hex } from "viem";
import { type SupportedChainId } from "../../../data";
import {
  BOOTSTRAP_OWNER_FETCH_TIMEOUT_MS,
  DEFAULT_MAX_OWNERS_BACKFILL_PER_BLOCK,
  DEFAULT_OWNER_BACKFILL_CONCURRENCY,
} from "../../../constants";
import { drainOwnerSlice } from "../../helpers/orderbookClient";
import { ownerDrain, stampOwnerAttempt } from "../../helpers/orderbook/cache";
import { mapWithConcurrency } from "../../helpers/concurrency";
import { log } from "../../helpers/logger";
import { OWNER_BACKFILL_TYPES } from "../../../utils/order-types";

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
// Each owner attempt is a bounded, RESUMABLE slice: an AbortController ends the attempt
// at BOOTSTRAP_OWNER_FETCH_TIMEOUT_MS (tearing down the in-flight request — no zombie
// fetches), and progress is persisted page-by-page in cow_cache.owner_drain, so the next
// attempt continues from the stored offset instead of re-fetching from scratch. Owners
// are picked least-recently-attempted first (never-attempted first), so a slow owner
// can't monopolize the batch and starve the rest. See drainOwnerSlice for the two drain
// modes (resumable full drain vs post-redeploy delta).
//
// Readiness is gated on the drain completing (see /readyz), so promotion never ships an
// indexer with history still missing.
//
// Eligibility is the historyBackfilled flag, set at generator creation for the cases
// that never need a drain (deterministic types, and generators created live) — see
// composableCow.ts. So the only false rows are non-deterministic historical generators,
// which this handler flips to true once their owner is fully drained.
//
// Unknown and CowAmmConstantProduct generators are stored but never drained here —
// see OWNER_BACKFILL_EXCLUDED in utils/order-types.ts.

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

// Run one drain slice for an owner: stamp the attempt (rotation), give the slice a hard
// deadline via AbortController, and — only when the owner's history is fully covered —
// flip historyBackfilled. An incomplete slice needs no special handling: its pages are
// already persisted along with the resume offset, and the owner stays eligible for a
// later firing. Errors propagate to abort the batch (the block handler is idempotent,
// so the block simply retries).
async function drainOwner(
  context: Context,
  chainId: SupportedChainId,
  currentBlock: bigint,
  owner: Hex,
  ownerGeneratorIds: Map<Hex, string[]>
): Promise<{ discovered: number; drained: number }> {
  await stampOwnerAttempt(context, chainId, owner);

  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), BOOTSTRAP_OWNER_FETCH_TIMEOUT_MS);
  try {
    const { discovered, complete } = await drainOwnerSlice(context, chainId, owner, controller.signal);

    if (complete) {
      await markOwnerHistoryBackfilled(context, chainId, owner, ownerGeneratorIds);
      return { discovered, drained: 1 };
    }

    log("info", "OwnerBackfill:owner_paused", {
      block: String(currentBlock),
      chainId,
      owner,
      aborted: controller.signal.aborted,
    });
    return { discovered, drained: 0 };
  } finally {
    clearTimeout(deadline);
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
    inArray(conditionalOrderGenerator.orderType, [...OWNER_BACKFILL_TYPES]),
    eq(conditionalOrderGenerator.historyBackfilled, false)
  );

  // Take up to `cap` distinct owners this block, least-recently-attempted first
  // (never-attempted first) so a repeatedly slow owner rotates to the back of the
  // queue instead of occupying every batch. lastAttemptAt must appear in the DISTINCT
  // select list for Postgres to allow ordering by it; it is constant per owner, so it
  // introduces no duplicate owners.
  const ownerRows = (await context.db.sql
    .selectDistinct({
      owner: conditionalOrderGenerator.owner,
      lastAttemptAt: ownerDrain.lastAttemptAt,
    })
    .from(conditionalOrderGenerator)
    .leftJoin(
      ownerDrain,
      and(
        eq(ownerDrain.chainId, conditionalOrderGenerator.chainId),
        eq(ownerDrain.owner, conditionalOrderGenerator.owner)
      )
    )
    .where(eligibleWhere)
    .orderBy(sql`${ownerDrain.lastAttemptAt} ASC NULLS FIRST`, conditionalOrderGenerator.owner)
    .limit(cap)) as { owner: Hex; lastAttemptAt: number | null }[];

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
