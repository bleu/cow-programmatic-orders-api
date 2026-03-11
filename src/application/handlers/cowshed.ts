import { ponder } from "ponder:registry";
import { and, eq } from "ponder";
import {
  AddressType,
  conditionalOrderGenerator,
  ownerMapping,
  transaction,
} from "ponder:schema";

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

  // Backfill resolvedEoaOwner on any pre-existing orders for this proxy
  await context.db.sql
    .update(conditionalOrderGenerator)
    .set({ resolvedEoaOwner: user.toLowerCase() as `0x${string}` })
    .where(
      and(
        eq(conditionalOrderGenerator.chainId, context.chain.id),
        eq(
          conditionalOrderGenerator.owner,
          shed.toLowerCase() as `0x${string}`,
        ),
      ),
    );
});
