/**
 * ConditionalOrderCreated event handlers — indexes generators and triggers
 * UID pre-computation for deterministic order types.
 *
 * Two contract entries handle the same event with identical logic:
 *   - ComposableCow (historical backfill): inserts generator + pre-computes UIDs
 *   - ComposableCowLive (startBlock: "latest"): inserts generator + pre-computes UIDs
 *
 * For deterministic types (TWAP, StopLoss), precomputeAndDiscover computes all
 * UIDs, fetches their status from the API, upserts discrete orders, and marks
 * allCandidatesKnown=true. Non-deterministic types are left for the C1-C4
 * block handlers to discover at live sync.
 *
 * KNOWN LIMITATION — Off-chain cancellation gap:
 *   Orders cancelled via the CoW Orderbook API's DELETE endpoint (off-chain
 *   soft cancel) are NOT detected after the initial fetch. There is no on-chain
 *   event for API-only cancellations, and without periodic polling the indexer
 *   has no mechanism to discover them.
 *
 *   This affects only EIP-1271 composable orders where the user cancels through
 *   the API rather than calling ComposableCoW.remove() on-chain. In practice
 *   this is rare — the standard cancellation path for composable orders is
 *   on-chain, which emits ConditionalOrderCancelled (handled elsewhere) or
 *   triggers PollNever in the block handler.
 *
 *   If this gap proves significant in production, a lightweight periodic check
 *   can be added for owners with open orders. Track via issue tracker if needed.
 *
 */

import { ponder } from "ponder:registry";
import { and, eq, replaceBigInts } from "ponder";
import {
  conditionalOrderGenerator,
  ownerMapping,
  transaction,
} from "ponder:schema";
import { encodeAbiParameters, keccak256, type Hex } from "viem";
import { getOrderTypeFromHandler } from "../../utils/order-types";
import { decodeStaticInput } from "../../decoders/index";
import { precomputeAndDiscover } from "../helpers/uidPrecompute";

// ─── Shared helper — generator insert logic ─────────────────────────────────

async function insertGenerator(
  event: {
    id: string;
    args: { owner: Hex; params: { handler: Hex; salt: Hex; staticInput: Hex } };
    block: { number: bigint; timestamp: bigint };
    transaction: { hash: Hex };
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  context: any,
): Promise<{ ownerAddress: Hex; chainId: number }> {
  const { owner, params } = event.args;
  const { handler, salt, staticInput } = params;

  const encoded = encodeAbiParameters(
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
    [{ handler, salt, staticInput }],
  );
  const hash = keccak256(encoded);

  const ownerAddress = owner.toLowerCase() as `0x${string}`;
  const chainId = context.chain.id;
  const orderType = getOrderTypeFromHandler(handler, chainId);

  if (orderType === "Unknown") {
    console.warn(
      `[ComposableCow] Unknown handler ${handler} on chain ${chainId}, ` +
        `saving as Unknown — event=${event.id}`,
    );
  } else {
    console.log(
      `[ComposableCow] ConditionalOrderCreated event=${event.id} chain=${chainId} orderType=${orderType} block=${event.block.number}`,
    );
  }

  // Resolve EOA: look up owner_mapping in case owner is a known proxy (CoWShed).
  // For AAVE adapters the mapping won't exist yet; settlement.ts will backfill later.
  const mappingRows = await context.db.sql
    .select({ owner: ownerMapping.owner })
    .from(ownerMapping)
    .where(
      and(
        eq(ownerMapping.chainId, chainId),
        eq(ownerMapping.address, ownerAddress),
      ),
    )
    .limit(1);

  const resolvedOwner =
    mappingRows.length > 0 ? mappingRows[0]!.owner : ownerAddress;

  // Upsert transaction row (idempotent — multiple events may share a tx)
  await context.db
    .insert(transaction)
    .values({
      hash: event.transaction.hash,
      chainId,
      blockNumber: event.block.number,
      blockTimestamp: event.block.timestamp,
    })
    .onConflictDoNothing();

  await context.db
    .insert(conditionalOrderGenerator)
    .values({
      eventId: event.id,
      chainId,
      owner: ownerAddress,
      resolvedOwner,
      handler: handler.toLowerCase() as `0x${string}`,
      salt,
      staticInput,
      hash,
      orderType,
      status: "Active",
      ...(() => {
        if (orderType === "Unknown") {
          return { decodedParams: null, decodeError: null };
        }
        try {
          const decoded = decodeStaticInput(orderType, staticInput) ?? null;
          const decodedParams = decoded
            ? replaceBigInts(decoded, String)
            : null;
          console.log(
            `[ComposableCow] Decoded event=${event.id} orderType=${orderType} decodedParams=${decodedParams ? "ok" : "null"}`,
          );
          return { decodedParams, decodeError: null };
        } catch (err) {
          console.warn(
            `[ComposableCow] Decode failed event=${event.id} orderType=${orderType} err=${err}`,
          );
          return { decodedParams: null, decodeError: "invalid_static_input" };
        }
      })(),
      txHash: event.transaction.hash,
      nextCheckBlock: event.block.number,
    })
    .onConflictDoNothing();

  return { ownerAddress, chainId };
}

// ─── Backfill handler (ComposableCow — historical) ─────────────────────────

ponder.on(
  "ComposableCow:ConditionalOrderCreated",
  async ({ event, context }) => {
    const { ownerAddress, chainId } = await insertGenerator(event, context);

    // Pre-compute UIDs for deterministic order types (TWAP, StopLoss).
    // Fetches status from API by UID, upserts discrete orders, and
    // deactivates the generator if all orders are already terminal.
    const { handler, staticInput } = event.args.params;
    const orderType = getOrderTypeFromHandler(handler, chainId);
    const decoded = decodeStaticInput(orderType, staticInput);
    // Resolve t0=0: the contract uses block.timestamp when staticInput has t0=0.
    // Store the resolved value so precompute always has the real start time.
    if (decoded && orderType === "TWAP" && BigInt((decoded as Record<string, unknown>).t0 as bigint ?? 0n) === 0n) {
      (decoded as Record<string, unknown>).t0 = event.block.timestamp;
    }
    const decodedParams = decoded ? replaceBigInts(decoded, String) as Record<string, string> : null;

    await precomputeAndDiscover(
      context, chainId, event.id, ownerAddress, orderType, decodedParams, event.block.timestamp,
    );
  },
);

// ─── Live handler (ComposableCowLive — startBlock: "latest") ────────────────
// Same as backfill: pre-compute covers deterministic types.
// Non-deterministic types are discovered by C1-C4 block handlers at live sync.

ponder.on(
  "ComposableCowLive:ConditionalOrderCreated",
  async ({ event, context }) => {
    const { ownerAddress, chainId } = await insertGenerator(event, context);

    const { handler, staticInput } = event.args.params;
    const orderType = getOrderTypeFromHandler(handler, chainId);
    const decoded = decodeStaticInput(orderType, staticInput);
    if (decoded && orderType === "TWAP" && BigInt((decoded as Record<string, unknown>).t0 as bigint ?? 0n) === 0n) {
      (decoded as Record<string, unknown>).t0 = event.block.timestamp;
    }
    const decodedParams = decoded ? replaceBigInts(decoded, String) as Record<string, string> : null;

    await precomputeAndDiscover(
      context, chainId, event.id, ownerAddress, orderType, decodedParams, event.block.timestamp,
    );
  },
);
