/**
 * ConditionalOrderCreated event handler — indexes generators and triggers
 * initial order discovery.
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
 *   can be added for owners with open orders. Track via Linear if needed.
 *
 */

import { ponder } from "ponder:registry";
import { and, eq, replaceBigInts } from "ponder";
import {
  conditionalOrderGenerator,
  orderPollState,
  ownerMapping,
  transaction,
} from "ponder:schema";
import { encodeAbiParameters, keccak256 } from "viem";
import { getOrderTypeFromHandler } from "../../utils/order-types";
import { decodeStaticInput } from "../../decoders/index";
import { ORDERBOOK_API_URLS } from "../../data";
import { fetchComposableOrders, invalidateOwnerCache, upsertDiscreteOrders } from "../helpers/orderbookClient";

ponder.on(
  "ComposableCow:ConditionalOrderCreated",
  async ({ event, context }) => {
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
      })
      .onConflictDoNothing();

    // Create initial poll state so the block handler starts checking this order
    await context.db
      .insert(orderPollState)
      .values({
        chainId,
        conditionalOrderGeneratorId: event.id,
        nextCheckBlock: event.block.number,
        isActive: true,
      })
      .onConflictDoNothing();

    // Fetch owner's orders from the Orderbook API (live sync only).
    // During backfill, discrete orders will be discovered at live sync
    // by the block handler + API fetch.
    const isLive = Math.floor(Date.now() / 1000) - Number(event.block.timestamp) < 600;
    if (isLive) {
      await invalidateOwnerCache(context, chainId, ownerAddress);
      const apiBaseUrl = ORDERBOOK_API_URLS[chainId];
      if (apiBaseUrl) {
        const orders = await fetchComposableOrders(context, chainId, apiBaseUrl, ownerAddress);
        await upsertDiscreteOrders(context, chainId, orders);
      }
    }
  },
);
