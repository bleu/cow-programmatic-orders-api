import { ponder } from "ponder:registry";
import { conditionalOrder } from "ponder:schema";
import { encodeAbiParameters, keccak256 } from "viem";
import { getOrderTypeFromHandler } from "../../utils/order-types";

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

    console.debug(`[ComposableCow] ConditionalOrderCreated id=${event.id} chain=${context.chain.id} owner=${owner} orderType=${orderType} block=${event.block.number}`);

    await context.db
      .insert(conditionalOrder)
      .values({
        id: event.id,
        chainId: context.chain.id,
        owner: owner.toLowerCase() as `0x${string}`,
        handler: handler.toLowerCase() as `0x${string}`,
        salt,
        staticInput,
        hash,
        orderType,
        status: "Active",
        decodedParams: null,
        txHash: event.transaction.hash,
        blockNumber: event.block.number,
        blockTimestamp: event.block.timestamp,
        createdAt: event.block.timestamp,
      })
      .onConflictDoNothing();
  }
);
