/**
 * Trade event handler — marks discrete orders as fulfilled on settlement.
 *
 * Listens to GPv2Settlement:Trade events. For each trade:
 *
 * Gate 1 (cheap): Check if owner has an Active generator on this chain.
 *   Most trades are not composable-cow — skip immediately if owner is unknown.
 *
 * Gate 2 (cheap): Look up discrete_order by orderUid.
 *   If already discovered by the fetch-on-creation path, just update status + filledAtBlock.
 *
 * Gate 3 (rare): Order not yet in DB — use the shared fetch utility to discover
 *   all of the owner's orders, then mark this specific order as fulfilled.
 *
 * The trade event is the most authoritative signal for fill status. Gate 3 handles
 * the race where a Trade fires before the fetch-on-creation path has run.
 */

import { ponder } from "ponder:registry";
import {
  conditionalOrderGenerator,
  discreteOrder,
  ownerMapping,
} from "ponder:schema";
import { and, eq } from "ponder";
import type { Hex } from "viem";
import { ORDERBOOK_API_URLS } from "../../data";
import { fetchAndMatchOwnerOrders } from "../helpers/orderbookFetch";

// ─── Handler ──────────────────────────────────────────────────────────────────

ponder.on("GPv2SettlementTrade:Trade", async ({ event, context }) => {
  const chainId = context.chain.id;

  // owner is indexed — available directly from event args, no extra decoding
  const owner = event.args.owner.toLowerCase() as Hex;
  // orderUid is bytes in the ABI — comes as a 0x-prefixed hex string
  const orderUid = (event.args.orderUid as string).toLowerCase();

  // ── Gate 1: skip if owner has no Active generator on this chain ──────────────
  const knownInGenerators = (await context.db.sql
    .select({ owner: conditionalOrderGenerator.owner })
    .from(conditionalOrderGenerator)
    .where(
      and(
        eq(conditionalOrderGenerator.chainId, chainId),
        eq(conditionalOrderGenerator.owner, owner),
        eq(conditionalOrderGenerator.status, "Active"),
      ),
    )
    .limit(1)) as { owner: string }[];

  if (knownInGenerators.length === 0) {
    // Also check owner_mapping (CoWShed proxies, flash loan adapters)
    const knownInMappings = (await context.db.sql
      .select({ address: ownerMapping.address })
      .from(ownerMapping)
      .where(
        and(eq(ownerMapping.chainId, chainId), eq(ownerMapping.address, owner)),
      )
      .limit(1)) as { address: string }[];

    if (knownInMappings.length === 0) return;
  }

  // ── Gate 2: if discrete_order already exists, just mark it fulfilled ─────────
  const existing = (await context.db.sql
    .select({ orderUid: discreteOrder.orderUid })
    .from(discreteOrder)
    .where(
      and(
        eq(discreteOrder.chainId, chainId),
        eq(discreteOrder.orderUid, orderUid),
      ),
    )
    .limit(1)) as { orderUid: string }[];

  if (existing.length > 0) {
    await context.db.sql
      .update(discreteOrder)
      .set({
        status: "fulfilled",
        filledAtBlock: event.block.number,
      })
      .where(
        and(
          eq(discreteOrder.chainId, chainId),
          eq(discreteOrder.orderUid, orderUid),
        ),
      );
    console.log(
      `[COW:TRADE] FULFILLED uid=${orderUid} block=${event.block.number} chain=${chainId}`,
    );
    return;
  }

  // ── Gate 3: order not yet in DB — fetch all owner orders, then mark fulfilled ─
  const apiBaseUrl = ORDERBOOK_API_URLS[chainId];
  if (!apiBaseUrl) return;

  // Use the shared fetch utility to discover all of this owner's orders.
  // This populates the cache and upserts any matching discrete orders.
  const discovered = await fetchAndMatchOwnerOrders(
    context,
    chainId,
    apiBaseUrl,
    owner,
    Number(event.block.timestamp),
  );

  // Now mark this specific order as fulfilled (fetchAndMatchOwnerOrders doesn't
  // know about the trade event context — it sets status from the API response).
  await context.db.sql
    .update(discreteOrder)
    .set({
      status: "fulfilled",
      filledAtBlock: event.block.number,
    })
    .where(
      and(
        eq(discreteOrder.chainId, chainId),
        eq(discreteOrder.orderUid, orderUid),
      ),
    );

  console.log(
    `[COW:TRADE] GATE3 uid=${orderUid} block=${event.block.number} chain=${chainId} discovered=${discovered}`,
  );
});
