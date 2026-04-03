/**
 * Trade event handler — marks discrete orders as fulfilled on settlement.
 *
 * Listens to GPv2Settlement:Trade events. For each trade:
 *
 * Gate 1 (cheap): Check if owner is a known composable cow participant.
 *   Most trades are not composable-cow — skip immediately if owner is unknown.
 *
 * Gate 2 (cheap): Look up discrete_order by orderUid.
 *   If already discovered by the polling handler, just update status + filledAtBlock.
 *
 * Gate 3 (rare): Order not yet in DB — fetch from Orderbook API, decode EIP-1271
 *   signature, find generator, upsert the full discrete_order row.
 *
 * The trade event is the most authoritative signal for fill status. Gate 3 handles
 * the race where a Trade fires before the orderbook poller has seen the order.
 *
 * Source: COW-736 | Reference: thoughts/reference_docs/m3-orderbook-api-research.md
 */

import { ponder } from "ponder:registry";
import {
  conditionalOrderGenerator,
  discreteOrder,
  ownerMapping,
} from "ponder:schema";
import { and, eq } from "ponder";
import { encodeAbiParameters, keccak256, type Hex } from "viem";
import { COMPOSABLE_COW_HANDLER_ADDRESSES, ORDERBOOK_API_URLS } from "../../data";
import { decodeEip1271Signature } from "../decoders/erc1271Signature";

// ─── API response shape (single order) ───────────────────────────────────────

interface OrderbookOrder {
  uid: string;
  status: string;
  sellAmount: string;
  buyAmount: string;
  feeAmount: string;
  validTo: number;
  creationDate: string;
  signingScheme: string;
  signature: string;
}

// ─── Handler ──────────────────────────────────────────────────────────────────

ponder.on("GPv2SettlementTrade:Trade", async ({ event, context }) => {
  const chainId = context.chain.id;

  // owner is indexed — available directly from event args, no extra decoding
  const owner = event.args.owner.toLowerCase() as Hex;
  // orderUid is bytes in the ABI — comes as a 0x-prefixed hex string
  const orderUid = (event.args.orderUid as string).toLowerCase();

  // ── Gate 1: skip if owner is not a known composable cow participant ──────────
  const knownInGenerators = await context.db.sql
    .select({ owner: conditionalOrderGenerator.owner })
    .from(conditionalOrderGenerator)
    .where(
      and(
        eq(conditionalOrderGenerator.chainId, chainId),
        eq(conditionalOrderGenerator.owner, owner),
      ),
    )
    .limit(1) as { owner: string }[];

  if (knownInGenerators.length === 0) {
    // Also check owner_mapping (CoWShed proxies, flash loan adapters)
    const knownInMappings = await context.db.sql
      .select({ address: ownerMapping.address })
      .from(ownerMapping)
      .where(
        and(
          eq(ownerMapping.chainId, chainId),
          eq(ownerMapping.address, owner),
        ),
      )
      .limit(1) as { address: string }[];

    if (knownInMappings.length === 0) return;
  }

  // ── Gate 2: if discrete_order already exists, just mark it fulfilled ─────────
  const existing = await context.db.sql
    .select({ orderUid: discreteOrder.orderUid })
    .from(discreteOrder)
    .where(
      and(
        eq(discreteOrder.chainId, chainId),
        eq(discreteOrder.orderUid, orderUid),
      ),
    )
    .limit(1) as { orderUid: string }[];

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

  // ── Gate 3: new order from known owner — fetch signature from API ─────────────
  const apiBaseUrl = ORDERBOOK_API_URLS[chainId];
  if (!apiBaseUrl) return;

  let order: OrderbookOrder;
  try {
    const response = await fetch(`${apiBaseUrl}/api/v1/orders/${orderUid}`);
    if (!response.ok) {
      console.warn(
        `[COW:TRADE] API ${response.status} uid=${orderUid} chain=${chainId}`,
      );
      return;
    }
    order = (await response.json()) as OrderbookOrder;
  } catch (err) {
    console.warn(`[COW:TRADE] Fetch failed uid=${orderUid} err=${err}`);
    return;
  }

  // Only composable cow orders use eip1271 signing
  if (order.signingScheme !== "eip1271") return;

  // Decode signature to extract handler/salt/staticInput
  const decoded = decodeEip1271Signature(order.signature as Hex);
  if (!decoded) {
    console.warn(`[COW:TRADE] Decode failed uid=${orderUid}`);
    return;
  }

  if (!COMPOSABLE_COW_HANDLER_ADDRESSES.has(decoded.handler)) return;

  // Compute param hash — must match what composableCow.ts stores in generator.hash
  const paramHash = keccak256(
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

  const generators = await context.db.sql
    .select({
      eventId: conditionalOrderGenerator.eventId,
      orderType: conditionalOrderGenerator.orderType,
      decodedParams: conditionalOrderGenerator.decodedParams,
    })
    .from(conditionalOrderGenerator)
    .where(
      and(
        eq(conditionalOrderGenerator.chainId, chainId),
        eq(conditionalOrderGenerator.hash, paramHash),
      ),
    )
    .limit(1) as {
      eventId: string;
      orderType: string;
      decodedParams: Record<string, string> | null;
    }[];

  if (generators.length === 0) {
    // Generator not yet indexed — should be rare; the composableCow handler
    // runs before the trade event because it has an earlier start block.
    console.warn(
      `[COW:TRADE] Generator not found uid=${orderUid} hash=${paramHash} chain=${chainId}`,
    );
    return;
  }

  const generator = generators[0]!;

  // Derive TWAP partIndex when t0 is known
  let partIndex: bigint | null = null;
  if (generator.orderType === "TWAP" && generator.decodedParams) {
    const t0 = BigInt(generator.decodedParams["t0"] ?? "0");
    const t = BigInt(generator.decodedParams["t"] ?? "0");
    if (t0 > 0n && t > 0n) {
      const validTo = BigInt(order.validTo);
      partIndex = (validTo + 1n - t0) / t - 1n;
    }
  }

  const creationDate = BigInt(
    Math.floor(new Date(order.creationDate).getTime() / 1000),
  );

  // Upsert via raw Drizzle (context.db.sql) — Ponder's branded insert only supports
  // onConflictDoNothing; for onConflictDoUpdate we need the Drizzle path.
  await context.db.sql
    .insert(discreteOrder)
    .values({
      orderUid,
      chainId,
      conditionalOrderGeneratorId: generator.eventId,
      status: "fulfilled" as const,
      partIndex,
      sellAmount: order.sellAmount,
      buyAmount: order.buyAmount,
      feeAmount: order.feeAmount,
      filledAtBlock: event.block.number,
      validTo: order.validTo,
      detectedBy: "trade_event" as const,
      creationDate,
    })
    .onConflictDoUpdate({
      target: [discreteOrder.chainId, discreteOrder.orderUid],
      set: {
        status: "fulfilled" as const,
        filledAtBlock: event.block.number,
        validTo: order.validTo,
      },
    });

  console.log(
    `[COW:TRADE] UPSERTED uid=${orderUid} block=${event.block.number} chain=${chainId} generator=${generator.eventId}`,
  );
});
