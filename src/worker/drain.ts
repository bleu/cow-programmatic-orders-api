/**
 * OwnerBackfill drain worker — a standalone long-running process, separate from the
 * Ponder indexer.
 *
 * Why a separate process: draining an owner's full history from the orderbook is slow
 * (a fat owner is several ~5 s pages). Run inside a Ponder block handler it serialized
 * into the single indexing slot and a single un-drainable owner could wedge the whole
 * pipeline — and, worse, wedge `/readyz` forever (COW-1118). Here it runs on its own
 * clock and coordinates with the indexer only through the durable `cow_cache` schema:
 *
 *   1. The ConditionalOrderCreated handler enqueues non-deterministic owners into
 *      cow_cache.owner_drain_state ('pending').
 *   2. This worker claims owners (FOR UPDATE SKIP LOCKED), offset-walks their history
 *      newest→oldest committing each page to cow_cache.composable_order and bumping
 *      next_offset, and marks the owner 'complete' at the bottom.
 *   3. The Ponder OwnerBackfill projection sees 'complete' owners, projects their cached
 *      rows into discreteOrder (hash → current eventId), and flips historyBackfilled.
 *
 * The worker touches ONLY cow_cache — never Ponder's versioned schema — so blue-green
 * deploys and reindexes are invisible to it. One long-lived worker serves every
 * deployment. It is safe to run N-wide (SKIP LOCKED + stale-lease reclaim).
 *
 * Run with `pnpm drain` (dev) or as a sidecar container sharing DATABASE_URL (prod).
 */

import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import type { Hex } from "viem";
import { ORDERBOOK_API_URLS } from "../data";
import {
  DRAIN_IDLE_SLEEP_MS,
  DRAIN_LEASE_TTL_MS,
  DRAIN_OWNER_CONCURRENCY,
  SIGNING_SCHEME_EIP1271,
} from "../constants";
import {
  claimDrainOwners,
  commitDrainProgress,
  completeDrainOwner,
  createCowCacheTables,
  filterAndProcessForCache,
  releaseDrainOwner,
  upsertComposableCache,
  type DrainClaim,
  type DrizzleHandle,
} from "../application/helpers/composableCache";
import {
  fetchAccountOrderPage,
  OrderbookUnavailableError,
  PAGE_LIMIT,
} from "../application/helpers/orderbookHttp";
import { TimeoutError } from "../application/helpers/withTimeout";
import { log } from "../application/helpers/logger";

const { Pool } = pg;

function envInt(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

const OWNER_CONCURRENCY = envInt("DRAIN_OWNER_CONCURRENCY", DRAIN_OWNER_CONCURRENCY);
const IDLE_SLEEP_MS = envInt("DRAIN_IDLE_SLEEP_MS", DRAIN_IDLE_SLEEP_MS);
const LEASE_TTL_MS = envInt("DRAIN_LEASE_TTL_MS", DRAIN_LEASE_TTL_MS);

const nowSec = (): number => Math.floor(Date.now() / 1000);
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

let shuttingDown = false;

/**
 * Drain one owner: offset-walk /account newest→oldest, committing each page to the
 * durable cache and advancing next_offset, until a short page marks the bottom.
 *
 * Offset-based resume (not a MAX(creation_date) cursor) is required: with per-page
 * commit, a max-cursor would declare the owner complete after re-reading only the
 * newest page and silently drop the older pages. Re-fetches on restart are harmless —
 * composable_order upserts by (chain_id, order_uid).
 */
async function drainOwner(db: DrizzleHandle, claim: DrainClaim): Promise<void> {
  const { chainId, owner } = claim;
  const apiBaseUrl = ORDERBOOK_API_URLS[chainId];
  if (!apiBaseUrl) {
    // No orderbook for this chain — nothing to drain. Mark complete so it stops being
    // re-claimed; the projection will flip historyBackfilled against an empty cache.
    log("warn", "drain:noApiUrl", { chainId, owner });
    await completeDrainOwner(db, chainId, owner, nowSec());
    return;
  }

  let offset = claim.nextOffset;
  let pages = 0;
  let cached = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    let page;
    try {
      page = await fetchAccountOrderPage(apiBaseUrl, owner, offset, PAGE_LIMIT, SIGNING_SCHEME_EIP1271);
    } catch (err) {
      if (err instanceof OrderbookUnavailableError || err instanceof TimeoutError) {
        // Transient — return to the queue at the last committed offset. Re-claimed later.
        log("warn", "drain:owner_interrupted", { chainId, owner, offset, err: err.name });
        await releaseDrainOwner(db, chainId, owner, nowSec());
        return;
      }
      throw err;
    }

    const rows = filterAndProcessForCache(chainId, page);
    await upsertComposableCache(db, chainId, owner, rows);
    cached += rows.length;

    offset += page.length;
    pages++;
    await commitDrainProgress(db, chainId, owner, offset, nowSec());

    if (page.length < PAGE_LIMIT) {
      await completeDrainOwner(db, chainId, owner, nowSec());
      log("info", "drain:owner_complete", { chainId, owner, pages, cached, offset });
      return;
    }
  }
}

async function runLoop(db: DrizzleHandle): Promise<void> {
  log("info", "drain:start", { concurrency: OWNER_CONCURRENCY, idleSleepMs: IDLE_SLEEP_MS, leaseTtlMs: LEASE_TTL_MS });

  while (!shuttingDown) {
    let claims: DrainClaim[];
    try {
      claims = await claimDrainOwners(db, {
        batch: OWNER_CONCURRENCY,
        nowSec: nowSec(),
        staleBeforeSec: nowSec() - Math.floor(LEASE_TTL_MS / 1000),
      });
    } catch (err) {
      log("error", "drain:claimFailed", { err: String(err) });
      await sleep(IDLE_SLEEP_MS);
      continue;
    }

    if (claims.length === 0) {
      await sleep(IDLE_SLEEP_MS);
      continue;
    }

    log("info", "drain:claimed", { owners: claims.length });

    // Drain the batch concurrently; the batch size IS the concurrency bound. A single
    // owner failing must not sink the batch, so isolate each with its own catch.
    await Promise.all(
      claims.map((claim) =>
        drainOwner(db, claim).catch(async (err) => {
          log("error", "drain:owner_failed", { chainId: claim.chainId, owner: claim.owner, err: String(err) });
          // Unexpected error — return to the queue so the lease doesn't strand the owner
          // until the TTL. next_offset is preserved, so the walk resumes.
          await releaseDrainOwner(db, claim.chainId, claim.owner as Hex, nowSec()).catch(() => {});
        }),
      ),
    );
  }
}

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    log("error", "drain:noDatabaseUrl", {});
    process.exit(1);
  }

  const pool = new Pool({ connectionString });
  const db = drizzle(pool);

  // Idempotent — the tables also exist via the Ponder setup handler, but the worker may
  // start first, so it must not depend on startup ordering.
  await createCowCacheTables(db);

  const stop = (signal: string) => {
    if (shuttingDown) return;
    log("info", "drain:shutdown", { signal });
    shuttingDown = true;
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));

  try {
    await runLoop(db);
  } finally {
    await pool.end().catch(() => {});
    log("info", "drain:stopped", {});
  }
}

main().catch((err) => {
  log("error", "drain:fatal", { err: String(err) });
  process.exit(1);
});
