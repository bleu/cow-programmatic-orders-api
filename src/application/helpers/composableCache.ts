/**
 * Durable composable-order cache + drain-state coordination — Ponder-free.
 *
 * Lives in the `cow_cache` schema, which is NOT versioned by Ponder, so these rows
 * survive `ponder start` redeploys and reindexes. Deliberately free of `ponder` /
 * `ponder:schema` imports so both the Ponder handlers (via orderbookClient.ts) and
 * the standalone drain worker (src/worker/drain.ts) can use it — the worker runs
 * outside the Ponder runtime where the virtual `ponder:*` modules don't resolve.
 *
 * Two tables:
 *   - composable_order: a deployment-independent superset of every composable order,
 *     keyed by (chain_id, order_uid) and by the stable generator_hash (never the
 *     per-deployment generator eventId). The drain worker fills it; the OwnerBackfill
 *     projection reads it and maps hash → the current eventId.
 *   - owner_drain_state: the durable work queue coordinating the indexer and the worker.
 *     The ConditionalOrderCreated handler enqueues owners ('pending'); the worker claims
 *     and drains them ('draining' → 'complete'); the projection flips historyBackfilled
 *     once an owner is 'complete'.
 */

import { and, eq, inArray, sql } from "drizzle-orm";
import { pgSchema, integer, text, bigint } from "drizzle-orm/pg-core";
import { encodeAbiParameters, keccak256, type Hex } from "viem";
import { getOrderTypeFromHandler, type OrderType } from "../../utils/order-types";
import { COMPOSABLE_COW_HANDLER_ADDRESSES } from "../../data";
import { SIGNING_SCHEME_EIP1271 } from "../../constants";
import { decodeEip1271Signature } from "../decoders/erc1271Signature";
import { log } from "./logger";
import type { OrderbookOrder } from "./orderbookHttp";

// A Drizzle handle — Ponder passes `context.db.sql`; the worker passes its own
// node-postgres `drizzle(pool)`. Both expose the query-builder + `.execute`; we use
// `any` (as the surrounding handler code does) to avoid coupling to either driver's
// generic types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type DrizzleHandle = any;

export const cowCacheSchema = pgSchema("cow_cache");

/** Durable full composable-order rows (survives reindex). See createCowCacheTables for the DDL. */
export const composableOrderCache = cowCacheSchema.table("composable_order", {
  chainId: integer("chain_id").notNull(),
  orderUid: text("order_uid").notNull(),
  owner: text("owner").notNull(),
  generatorHash: text("generator_hash").notNull(),
  orderType: text("order_type").notNull(),
  status: text("status").notNull(),
  sellAmount: text("sell_amount").notNull(),
  buyAmount: text("buy_amount").notNull(),
  feeAmount: text("fee_amount").notNull(),
  validTo: integer("valid_to"),
  creationDate: bigint("creation_date", { mode: "bigint" }).notNull(),
  executedSellAmount: text("executed_sell_amount"),
  executedBuyAmount: text("executed_buy_amount"),
  fetchedAt: bigint("fetched_at", { mode: "bigint" }).notNull(),
});

/** Durable per-owner drain work queue. See createCowCacheTables for the DDL. */
export const ownerDrainState = cowCacheSchema.table("owner_drain_state", {
  chainId: integer("chain_id").notNull(),
  owner: text("owner").notNull(),
  status: text("status").notNull(), // 'pending' | 'draining' | 'complete'
  nextOffset: integer("next_offset").notNull(),
  claimedAt: bigint("claimed_at", { mode: "bigint" }),
  updatedAt: bigint("updated_at", { mode: "bigint" }).notNull(),
});

/** Durable-cache row shape for cow_cache.composable_order (owner passed separately). */
export interface ComposableCacheRow {
  orderUid: string;
  generatorHash: string;
  orderType: OrderType;
  status: string;
  sellAmount: string;
  buyAmount: string;
  feeAmount: string;
  validTo: number | null;
  creationDate: bigint;
  executedSellAmount: string | null;
  executedBuyAmount: string | null;
}

const TERMINAL_STATUSES = new Set(["fulfilled", "expired", "cancelled"]);

/** `db.execute()` returns a plain array on Ponder's handle but a pg QueryResult
 *  ({ rows }) on node-postgres. Normalize to the row array. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowsOf(result: any): any[] {
  if (Array.isArray(result)) return result;
  return result?.rows ?? [];
}

// ─── Decode + hash (shared by the worker's drain) ─────────────────────────────

/**
 * Filter raw API orders to composable EIP-1271, decode signatures, reconstruct the
 * generator hash, and resolve the order type from the static handler map — no DB.
 *
 * The cache is keyed by (stable) generator_hash, not the per-deployment eventId, so
 * this needs no generator lookup: the OwnerBackfill projection does the hash → eventId
 * join (and drops orphans) later. That keeps the worker off Ponder's versioned schema.
 */
export function filterAndProcessForCache(
  chainId: number,
  apiOrders: OrderbookOrder[],
): ComposableCacheRow[] {
  const results: ComposableCacheRow[] = [];

  for (const order of apiOrders) {
    if (order.signingScheme !== SIGNING_SCHEME_EIP1271) continue;
    if (order.status === "presignaturePending") continue;

    const decoded = decodeEip1271Signature(order.signature as Hex);
    if (!decoded) continue;

    if (!COMPOSABLE_COW_HANDLER_ADDRESSES.has(decoded.handler)) continue;

    // Reproduce the same hash stored in conditionalOrderGenerator.hash.
    const generatorHash = keccak256(
      encodeAbiParameters(
        [
          {
            type: "tuple",
            components: [
              { name: "handler", type: "address" },
              { name: "salt", type: "bytes32" },
              { name: "staticInput", type: "bytes" },
            ],
          },
        ],
        [{ handler: decoded.handler, salt: decoded.salt, staticInput: decoded.staticInput }],
      ),
    );

    results.push({
      orderUid: order.uid,
      generatorHash,
      orderType: getOrderTypeFromHandler(decoded.handler, chainId),
      status: order.status,
      sellAmount: order.sellAmount,
      buyAmount: order.buyAmount,
      feeAmount: order.feeAmount,
      validTo: order.validTo,
      creationDate: BigInt(Math.floor(new Date(order.creationDate).getTime() / 1000)),
      executedSellAmount: order.executedSellAmount,
      executedBuyAmount: order.executedBuyAmount,
    });
  }

  return results;
}

// ─── composable_order cache ────────────────────────────────────────────────────

/** Upsert durable composable rows; excluded status/validTo/executed overwrite on conflict. */
export async function upsertComposableCache(
  db: DrizzleHandle,
  chainId: number,
  owner: Hex,
  rows: ComposableCacheRow[],
): Promise<void> {
  if (rows.length === 0) return;
  const now = BigInt(Math.floor(Date.now() / 1000));
  try {
    await db
      .insert(composableOrderCache)
      .values(rows.map((r) => ({
        chainId,
        orderUid: r.orderUid,
        owner: owner.toLowerCase(),
        generatorHash: r.generatorHash,
        orderType: r.orderType,
        status: r.status,
        sellAmount: r.sellAmount,
        buyAmount: r.buyAmount,
        feeAmount: r.feeAmount,
        validTo: r.validTo,
        creationDate: r.creationDate,
        executedSellAmount: r.executedSellAmount,
        executedBuyAmount: r.executedBuyAmount,
        fetchedAt: now,
      })))
      .onConflictDoUpdate({
        target: [composableOrderCache.chainId, composableOrderCache.orderUid],
        set: {
          status: sql`excluded.status`,
          validTo: sql`excluded.valid_to`,
          executedSellAmount: sql`excluded.executed_sell_amount`,
          executedBuyAmount: sql`excluded.executed_buy_amount`,
          fetchedAt: now,
        },
      });
  } catch (err) {
    log("warn", "ob:composableCacheWriteFailed", { chainId, rows: rows.length, err: String(err) });
  }
}

/** All durably-cached composable rows for an owner. */
export async function readOwnerComposableCache(
  db: DrizzleHandle,
  chainId: number,
  owner: Hex,
): Promise<ComposableCacheRow[]> {
  try {
    return (await db
      .select({
        orderUid: composableOrderCache.orderUid,
        generatorHash: composableOrderCache.generatorHash,
        orderType: composableOrderCache.orderType,
        status: composableOrderCache.status,
        sellAmount: composableOrderCache.sellAmount,
        buyAmount: composableOrderCache.buyAmount,
        feeAmount: composableOrderCache.feeAmount,
        validTo: composableOrderCache.validTo,
        creationDate: composableOrderCache.creationDate,
        executedSellAmount: composableOrderCache.executedSellAmount,
        executedBuyAmount: composableOrderCache.executedBuyAmount,
      })
      .from(composableOrderCache)
      .where(
        and(
          eq(composableOrderCache.chainId, chainId),
          eq(composableOrderCache.owner, owner.toLowerCase()),
        ),
      )) as ComposableCacheRow[];
  } catch {
    return [];
  }
}

// ─── owner_drain_state work queue ────────────────────────────────────────────────

/** A claimed drain job returned by claimDrainOwners. */
export interface DrainClaim {
  chainId: number;
  owner: Hex;
  nextOffset: number;
}

/**
 * Enqueue an owner for a historical drain (idempotent). ON CONFLICT DO NOTHING so a
 * reindex replaying ConditionalOrderCreated never resets an already-'complete' owner
 * back to 'pending'. Called from the Ponder handler with `context.db.sql`.
 */
export async function enqueueOwnerDrain(
  db: DrizzleHandle,
  chainId: number,
  owner: Hex,
): Promise<void> {
  const now = BigInt(Math.floor(Date.now() / 1000));
  await db
    .insert(ownerDrainState)
    .values({ chainId, owner: owner.toLowerCase(), status: "pending", nextOffset: 0, claimedAt: null, updatedAt: now })
    .onConflictDoNothing();
}

/** Owners that are fully drained ('complete'), among the given candidate owners. */
export async function selectCompleteDrainOwners(
  db: DrizzleHandle,
  chainId: number,
  owners: Hex[],
): Promise<Set<string>> {
  if (owners.length === 0) return new Set();
  const rows = (await db
    .select({ owner: ownerDrainState.owner })
    .from(ownerDrainState)
    .where(
      and(
        eq(ownerDrainState.chainId, chainId),
        eq(ownerDrainState.status, "complete"),
        inArray(ownerDrainState.owner, owners.map((o) => o.toLowerCase())),
      ),
    )) as { owner: string }[];
  return new Set(rows.map((r) => r.owner));
}

/**
 * Atomically claim up to `batch` drainable owners: those 'pending', plus 'draining'
 * owners whose lease went stale (claimed before `staleBeforeSec` — crash recovery).
 * FOR UPDATE SKIP LOCKED so multiple worker instances never claim the same owner,
 * making the worker safe to scale horizontally later.
 */
export async function claimDrainOwners(
  db: DrizzleHandle,
  opts: { batch: number; nowSec: number; staleBeforeSec: number },
): Promise<DrainClaim[]> {
  const { batch, nowSec, staleBeforeSec } = opts;
  const result = await db.execute(sql`
    UPDATE cow_cache.owner_drain_state AS s
    SET status = 'draining', claimed_at = ${nowSec}, updated_at = ${nowSec}
    WHERE (s.chain_id, s.owner) IN (
      SELECT chain_id, owner
      FROM cow_cache.owner_drain_state
      WHERE status = 'pending'
         OR (status = 'draining' AND (claimed_at IS NULL OR claimed_at < ${staleBeforeSec}))
      ORDER BY updated_at ASC
      LIMIT ${batch}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING s.chain_id AS "chainId", s.owner AS owner, s.next_offset AS "nextOffset"
  `);
  return rowsOf(result).map((r) => ({
    chainId: Number(r.chainId),
    owner: r.owner as Hex,
    nextOffset: Number(r.nextOffset),
  }));
}

/** Persist drain progress mid-walk: advance next_offset and refresh the lease heartbeat. */
export async function commitDrainProgress(
  db: DrizzleHandle,
  chainId: number,
  owner: Hex,
  nextOffset: number,
  nowSec: number,
): Promise<void> {
  await db
    .update(ownerDrainState)
    .set({ nextOffset, claimedAt: BigInt(nowSec), updatedAt: BigInt(nowSec) })
    .where(and(eq(ownerDrainState.chainId, chainId), eq(ownerDrainState.owner, owner.toLowerCase())));
}

/** Mark an owner fully drained. Terminal — never revisited (its cache survives reindex). */
export async function completeDrainOwner(
  db: DrizzleHandle,
  chainId: number,
  owner: Hex,
  nowSec: number,
): Promise<void> {
  await db
    .update(ownerDrainState)
    .set({ status: "complete", claimedAt: null, updatedAt: BigInt(nowSec) })
    .where(and(eq(ownerDrainState.chainId, chainId), eq(ownerDrainState.owner, owner.toLowerCase())));
}

/** Return a partially-drained owner to the queue (transient error). next_offset is kept,
 *  so the next claim resumes where the walk stopped. */
export async function releaseDrainOwner(
  db: DrizzleHandle,
  chainId: number,
  owner: Hex,
  nowSec: number,
): Promise<void> {
  await db
    .update(ownerDrainState)
    .set({ status: "pending", claimedAt: null, updatedAt: BigInt(nowSec) })
    .where(and(eq(ownerDrainState.chainId, chainId), eq(ownerDrainState.owner, owner.toLowerCase())));
}

// ─── DDL ─────────────────────────────────────────────────────────────────────

/**
 * Create the cow_cache schema and the tables the drain owns, idempotently.
 * Called by BOTH the Ponder setup handler (with `context.db.sql`) and the worker
 * bootstrap (with its own pool) so table existence is not startup-ordering-dependent.
 */
export async function createCowCacheTables(db: DrizzleHandle): Promise<void> {
  await db.execute(sql`CREATE SCHEMA IF NOT EXISTS cow_cache`);

  // Durable per-owner composable-order rows, keyed by (chain_id, order_uid). Holds every
  // field needed to rebuild a discreteOrder row without re-hitting the orderbook. Stored
  // by the stable generator_hash (not the per-deployment eventId) so rows survive reindex
  // and re-map to the current generator by hash.
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS cow_cache.composable_order (
      chain_id              INTEGER NOT NULL,
      order_uid             TEXT NOT NULL,
      owner                 TEXT NOT NULL,
      generator_hash        TEXT NOT NULL,
      order_type            TEXT NOT NULL,
      status                TEXT NOT NULL,
      sell_amount           TEXT NOT NULL,
      buy_amount            TEXT NOT NULL,
      fee_amount            TEXT NOT NULL,
      valid_to              INTEGER,
      creation_date         BIGINT NOT NULL,
      executed_sell_amount   TEXT,
      executed_buy_amount    TEXT,
      fetched_at            BIGINT NOT NULL,
      PRIMARY KEY (chain_id, order_uid)
    )
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS composable_order_owner_idx
      ON cow_cache.composable_order (chain_id, owner)
  `);

  // Durable per-owner drain work queue, keyed by (chain_id, owner). Coordinates the
  // indexer (enqueue on discovery, project on complete) with the standalone worker
  // (claim → drain → complete). Survives reindex, so a redeploy never re-drains a
  // 'complete' owner — its rows are already in composable_order.
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS cow_cache.owner_drain_state (
      chain_id     INTEGER NOT NULL,
      owner        TEXT NOT NULL,
      status       TEXT NOT NULL DEFAULT 'pending',
      next_offset  INTEGER NOT NULL DEFAULT 0,
      claimed_at   BIGINT,
      updated_at   BIGINT NOT NULL,
      PRIMARY KEY (chain_id, owner)
    )
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS owner_drain_state_status_idx
      ON cow_cache.owner_drain_state (status, updated_at)
  `);
}

export { TERMINAL_STATUSES };
