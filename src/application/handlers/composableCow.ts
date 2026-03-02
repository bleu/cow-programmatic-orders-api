import { ponder } from "ponder:registry";
import { conditionalOrder } from "ponder:schema";
import { encodeAbiParameters, keccak256 } from "viem";

ponder.on(
  "ComposableCow:ConditionalOrderCreated",
  async ({ event, context }) => {
    const { handler, salt, staticInput } = event.args.params;

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

    await context.db
      .insert(conditionalOrder)
      .values({
        id: event.id,
        owner: event.args.owner,
        handler,
        salt,
        staticInput,
        hash,
        txHash: event.transaction.hash,
      })
      .onConflictDoNothing();
  }
);
