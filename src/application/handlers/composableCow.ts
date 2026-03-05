import { ponder } from "ponder:registry";
import { replaceBigInts } from "ponder";
import { conditionalOrderGenerator, transaction } from "ponder:schema";
import { encodeAbiParameters, keccak256 } from "viem";
import { getOrderTypeFromHandler } from "../../utils/order-types";
import { decodeStaticInput } from "../../decoders/index";

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
      [{ handler, salt, staticInput }]
    );
    const hash = keccak256(encoded);

    const orderType = getOrderTypeFromHandler(handler, context.chain.id);

    if (orderType === "Unknown") {
      console.warn(
        `[ComposableCow] Unknown handler ${handler} on chain ${context.chain.id}, ` +
        `saving as Unknown — event=${event.id}`
      );
    } else {
      console.log(`[ComposableCow] ConditionalOrderCreated event=${event.id} chain=${context.chain.id} orderType=${orderType} block=${event.block.number}`);
    }

    // Upsert transaction row (idempotent — multiple events may share a tx)
    await context.db
      .insert(transaction)
      .values({
        hash: event.transaction.hash,
        chainId: context.chain.id,
        blockNumber: event.block.number,
        blockTimestamp: event.block.timestamp,
      })
      .onConflictDoNothing();

    await context.db
      .insert(conditionalOrderGenerator)
      .values({
        eventId: event.id,
        chainId: context.chain.id,
        owner: owner.toLowerCase() as `0x${string}`,
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
            const decodedParams = decoded ? replaceBigInts(decoded, String) : null;
            console.log(`[ComposableCow] Decoded event=${event.id} orderType=${orderType} decodedParams=${decodedParams ? "ok" : "null"}`);
            return { decodedParams, decodeError: null };
          } catch (err) {
            console.warn(`[ComposableCow] Decode failed event=${event.id} orderType=${orderType} err=${err}`);
            return { decodedParams: null, decodeError: "invalid_static_input" };
          }
        })(),
        txHash: event.transaction.hash,
      })
      .onConflictDoNothing();
  }
);
