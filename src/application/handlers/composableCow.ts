import { ponder } from "ponder:registry";
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

    if (!orderType) {
      console.warn(`[ComposableCow] Unknown handler ${handler} on chain ${context.chain.id}, skipping event ${event.id}`);
      return;
    }

    console.debug(`[ComposableCow] ConditionalOrderCreated id=${event.id} chain=${context.chain.id} owner=${owner} orderType=${orderType} block=${event.block.number}`);

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
        decodedParams: (() => {
          try {
            return decodeStaticInput(orderType, staticInput) ?? null;
          } catch (err) {
            console.warn(
              `[ComposableCow] Failed to decode staticInput for ${orderType} event=${event.id}: ${err}`
            );
            return null;
          }
        })(),
        txHash: event.transaction.hash,
      })
      .onConflictDoNothing();
  }
);
