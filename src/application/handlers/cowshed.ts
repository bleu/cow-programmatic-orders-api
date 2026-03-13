import { ponder } from "ponder:registry";
import { AddressType, ownerMapping, transaction } from "ponder:schema";

ponder.on("CoWShedFactory:COWShedBuilt", async ({ event, context }) => {
  const { user, shed } = event.args;

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
    .insert(ownerMapping)
    .values({
      chainId: context.chain.id,
      address: shed.toLowerCase() as `0x${string}`,
      owner: user.toLowerCase() as `0x${string}`,
      addressType: AddressType.CowshedProxy,
      txHash: event.transaction.hash,
      blockNumber: event.block.number,
      resolutionDepth: 0,
    })
    .onConflictDoNothing();

});
