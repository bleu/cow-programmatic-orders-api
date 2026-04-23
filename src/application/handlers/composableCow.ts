/**
 * ConditionalOrderCreated event handlers — indexes generators and triggers
 * UID pre-computation for deterministic order types.
 *
 * Two contract entries handle the same event with identical logic:
 *   - ComposableCow (historical backfill): inserts generator + pre-computes UIDs
 *   - ComposableCowLive (startBlock: "latest"): inserts generator + pre-computes UIDs
 *
 * For deterministic types (TWAP, StopLoss, CirclesBackingOrder), precomputeAndDiscover
 * computes all UIDs, fetches their status from the API, upserts discrete orders, and marks
 * allCandidatesKnown=true. Non-deterministic types are left for the C1-C4 block handlers to
 * discover at live sync.
 *
 * CirclesBackingOrder (Gnosis only) additionally reads two constructor immutables
 * (SELL_TOKEN, SELL_AMOUNT) from the handler contract at creation time and merges them
 * into decodedParams so the precompute flow has the full picture. A module-level cache
 * keeps this to one eth_call per handler address per process.
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
import { CirclesBackingOrderAbi } from "../../../abis/CirclesBackingOrderAbi";

// ─── CirclesBackingOrder immutables cache ───────────────────────────────────
//
// Handler-instance constants (set in the constructor) — identical for every generator
// that references the same handler address. Cached per `${chainId}:${handler}` so we
// make one eth_call per process, not one per generator.

// Never invalidated by design — the cached values are contract immutables.
const circlesImmutablesCache = new Map<
  string,
  { sellToken: Hex; sellAmount: bigint }
>();

async function fetchCirclesBackingImmutables(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  context: any,
  chainId: number,
  handler: Hex,
): Promise<{ sellToken: Hex; sellAmount: bigint }> {
  const key = `${chainId}:${handler.toLowerCase()}`;
  const hit = circlesImmutablesCache.get(key);
  if (hit) return hit;

  const [sellToken, sellAmount] = await Promise.all([
    context.client.readContract({
      address: handler,
      abi: CirclesBackingOrderAbi,
      functionName: "SELL_TOKEN",
    }) as Promise<Hex>,
    context.client.readContract({
      address: handler,
      abi: CirclesBackingOrderAbi,
      functionName: "SELL_AMOUNT",
    }) as Promise<bigint>,
  ]);

  const value = {
    sellToken: sellToken.toLowerCase() as Hex,
    sellAmount,
  };
  circlesImmutablesCache.set(key, value);
  return value;
}

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
): Promise<{
  ownerAddress: Hex;
  chainId: number;
  decodedParams: Record<string, string> | null;
}> {
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

  // Decode staticInput; for CirclesBackingOrder, also merge in handler immutables.
  let decodedParams: Record<string, string> | null = null;
  let decodeError: string | null = null;

  if (orderType !== "Unknown") {
    try {
      const decoded = decodeStaticInput(orderType, staticInput) ?? null;
      // Resolve t0=0: the contract uses block.timestamp when staticInput has t0=0.
      // Store the resolved value so precompute always has the real start time.
      if (
        decoded &&
        orderType === "TWAP" &&
        BigInt(((decoded as Record<string, unknown>).t0 as bigint) ?? 0n) === 0n
      ) {
        (decoded as Record<string, unknown>).t0 = event.block.timestamp;
      }
      decodedParams = decoded
        ? (replaceBigInts(decoded, String) as Record<string, string>)
        : null;

      if (orderType === "CirclesBackingOrder" && decodedParams) {
        const { sellToken, sellAmount } = await fetchCirclesBackingImmutables(
          context, chainId, handler,
        );
        decodedParams = {
          ...decodedParams,
          sellToken,
          sellAmount: sellAmount.toString(),
        };
      }

      console.log(
        `[ComposableCow] Decoded event=${event.id} orderType=${orderType} decodedParams=${decodedParams ? "ok" : "null"}`,
      );
    } catch (err) {
      console.warn(
        `[ComposableCow] Decode failed event=${event.id} orderType=${orderType} err=${err}`,
      );
      decodedParams = null;
      decodeError = "invalid_static_input";
    }
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
      decodedParams,
      decodeError,
      txHash: event.transaction.hash,
      nextCheckBlock: event.block.number,
    })
    .onConflictDoNothing();

  return { ownerAddress, chainId, decodedParams };
}

// ─── Backfill handler (ComposableCow — historical) ─────────────────────────

ponder.on(
  "ComposableCow:ConditionalOrderCreated",
  async ({ event, context }) => {
    const { ownerAddress, chainId, decodedParams } = await insertGenerator(event, context);

    // Pre-compute UIDs for deterministic order types (TWAP, StopLoss, CirclesBackingOrder).
    // Fetches status from API by UID, upserts discrete orders, and
    // deactivates the generator if all orders are already terminal.
    const orderType = getOrderTypeFromHandler(event.args.params.handler, chainId);
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
    const { ownerAddress, chainId, decodedParams } = await insertGenerator(event, context);

    const orderType = getOrderTypeFromHandler(event.args.params.handler, chainId);
    await precomputeAndDiscover(
      context, chainId, event.id, ownerAddress, orderType, decodedParams, event.block.timestamp,
    );
  },
);
