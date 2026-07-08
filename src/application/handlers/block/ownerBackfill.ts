import { ponder } from "ponder:registry";
import { conditionalOrderGenerator } from "ponder:schema";
import { and, eq, inArray } from "ponder";
import type { Hex } from "viem";
import { type SupportedChainId } from "../../../data";
import { DEFAULT_MAX_OWNERS_BACKFILL_PER_BLOCK } from "../../../constants";
import { remapToCurrentGenerators, upsertDiscreteOrders } from "../../helpers/orderbookClient";
import { readOwnerComposableCache, selectCompleteDrainOwners } from "../../helpers/composableCache";
import { log } from "../../helpers/logger";
import { NON_DETERMINISTIC_TYPES } from "../../../utils/order-types";

// ─── OwnerBackfill (projection-only) ───────────────────────────────────────────
// Projects historical discrete orders for non-deterministic generators from the durable
// cow_cache.composable_order table into discreteOrder. HTTP-free: the standalone drain
// worker (src/worker/drain.ts) does the orderbook fetching and fills the cache; this
// handler only reads the cache and flips historyBackfilled once an owner is fully drained.
//
// Two consequences of moving the drain out of the pipeline (COW-1118):
//   - No HTTP here means no owner can park the single indexing slot for 30 s, and no
//     un-drainable owner can wedge readiness — the worker resumes a fat owner across
//     restarts via next_offset, then this projection flips the flag.
//   - It re-runs correctly after a reindex: the warm cache survives, so a fresh
//     discreteOrder table is repopulated from cache with no new orderbook calls.
//
// One registration (startBlock = composableCow start block, no endBlock) covers both the
// historical backfill and realtime — the old OwnerBackfillLive registration is gone; the
// worker, not a second block handler, handles late/live owners. The coarse interval keeps
// per-firing overhead low; a completed owner is projected within one interval, so a
// post-tip straggler adds at most one interval to time-to-ready — it can never wedge.
//
// Eligibility is the historyBackfilled flag, set at generator creation for the cases that
// never need a drain (deterministic types, and generators created live) — see
// composableCow.ts. The only false rows are non-deterministic historical generators; this
// handler flips them to true once their owner is 'complete' in owner_drain_state.

function resolveOwnerCap(chainId: number): number {
  const raw = Number(process.env[`MAX_OWNERS_BACKFILL_PER_BLOCK_${chainId}`]);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_OWNERS_BACKFILL_PER_BLOCK;
}

ponder.on("OwnerBackfill:block", async ({ event, context }) => {
  const chainId = context.chain.id as SupportedChainId;
  const currentBlock = event.block.number;
  const cap = resolveOwnerCap(chainId);
  const db = context.db.sql;

  const eligibleWhere = and(
    eq(conditionalOrderGenerator.chainId, chainId),
    eq(conditionalOrderGenerator.status, "Active"),
    inArray(conditionalOrderGenerator.orderType, [...NON_DETERMINISTIC_TYPES]),
    eq(conditionalOrderGenerator.historyBackfilled, false),
  );

  // Pending owners (the readiness set — shrinks to 0). Ordering by owner keeps progress
  // deterministic and lets already-projected owners fall out of the set.
  const ownerRows = (await db
    .selectDistinct({ owner: conditionalOrderGenerator.owner })
    .from(conditionalOrderGenerator)
    .where(eligibleWhere)
    .orderBy(conditionalOrderGenerator.owner)
    .limit(cap)) as { owner: Hex }[];

  if (ownerRows.length === 0) return; // nothing pending — cheap no-op every firing

  const owners = ownerRows.map((r) => r.owner);

  // Only project owners the worker has fully drained; partially-drained owners stay pending.
  const complete = await selectCompleteDrainOwners(db, chainId, owners);
  const readyOwners = owners.filter((o) => complete.has(o.toLowerCase()));
  if (readyOwners.length === 0) return; // worker hasn't finished any of these yet

  // Generator ids for the ready owners, to flip historyBackfilled after projection.
  const genRows = (await db
    .select({
      generatorId: conditionalOrderGenerator.eventId,
      owner: conditionalOrderGenerator.owner,
    })
    .from(conditionalOrderGenerator)
    .where(and(eligibleWhere, inArray(conditionalOrderGenerator.owner, readyOwners)))) as {
    generatorId: string;
    owner: Hex;
  }[];

  const ownerGeneratorIds = new Map<Hex, string[]>();
  for (const row of genRows) {
    const existing = ownerGeneratorIds.get(row.owner) ?? [];
    existing.push(row.generatorId);
    ownerGeneratorIds.set(row.owner, existing);
  }

  let projected = 0;
  for (const owner of readyOwners) {
    // Read the owner's cached history and map the stable generator_hash → the current
    // per-deployment eventId (drops orphans whose generator isn't in this deployment).
    const cachedRows = await readOwnerComposableCache(db, chainId, owner);
    const orders = await remapToCurrentGenerators(db, chainId, cachedRows);
    projected += await upsertDiscreteOrders(context, chainId, orders);
    await markOwnerHistoryBackfilled(context, chainId, owner, ownerGeneratorIds);
  }

  log("info", "OwnerBackfill:PROJECTED", {
    block: String(currentBlock),
    chainId,
    pending: owners.length,
    ready: readyOwners.length,
    projected,
  });
});

// Mark every eligible generator of this owner as history-backfilled so it drops out
// of the eligibility set (and the readiness count). Set only after projection.
async function markOwnerHistoryBackfilled(
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
    .set({ historyBackfilled: true })
    .where(
      and(
        eq(conditionalOrderGenerator.chainId, chainId),
        inArray(conditionalOrderGenerator.eventId, genIds),
      ),
    );
}
