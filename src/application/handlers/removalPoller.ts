import { ponder } from "ponder:registry";
import { conditionalOrderGenerator } from "ponder:schema";
import { and, eq } from "ponder";
import { COMPOSABLE_COW_DEPLOYMENTS, ComposableCowContract } from "../../data";

// chainId → deployment — extend when gnosis/arbitrum are added in src/data.ts
const DEPLOYMENTS_BY_CHAIN_ID: Record<number, { address: `0x${string}` }> = {
  [1]: COMPOSABLE_COW_DEPLOYMENTS.mainnet,
};

ponder.on("RemovalPoller:block", async ({ event, context }) => {
  // Dev: skip REMOVE poll (multicall singleOrders) to save RPC during sync.
  if (process.env.DISABLE_REMOVAL_POLL) {
    console.log(
      `[COW:REMOVE:POLL] DISABLE_REMOVAL_POLL=true — skipping removal poll`,
    );
    return;
  }

  const chainId = context.chain.id;

  const deployment = DEPLOYMENTS_BY_CHAIN_ID[chainId];
  if (!deployment) {
    console.warn(
      `[COW:REMOVE:POLL] UNKNOWN_CHAIN chain=${chainId} block=${event.block.number} — skipping`,
    );
    return;
  }

  // Fetch all Active orders for this chain
  const activeOrders = await context.db.sql
    .select()
    .from(conditionalOrderGenerator)
    .where(
      and(
        eq(conditionalOrderGenerator.chainId, chainId),
        eq(conditionalOrderGenerator.status, "Active"),
      ),
    );

  if (activeOrders.length === 0) return;

  console.log(
    `[COW:REMOVE:POLL] ENTER block=${event.block.number} chain=${chainId} activeOrders=${activeOrders.length}`,
  );

  // Batch all singleOrders(owner, hash) checks into a single multicall
  const results = await context.client.multicall({
    contracts: activeOrders.map((order) => ({
      address: deployment.address,
      abi: ComposableCowContract.abi,
      functionName: "singleOrders" as const,
      args: [order.owner, order.hash] as const,
    })),
  });

  for (let i = 0; i < activeOrders.length; i++) {
    const result = results[i];
    const order = activeOrders[i]!;

    if (result === undefined || result.status === "failure") {
      console.warn(
        `[COW:REMOVE:POLL] MULTICALL_FAIL hash=${order.hash} owner=${order.owner} block=${event.block.number} chain=${chainId} err=${result?.error}`,
      );
      continue;
    }

    if (!result.result) {
      await context.db.sql
        .update(conditionalOrderGenerator)
        .set({ status: "Cancelled" })
        .where(
          and(
            eq(conditionalOrderGenerator.chainId, chainId),
            eq(conditionalOrderGenerator.hash, order.hash),
            eq(conditionalOrderGenerator.owner, order.owner),
          ),
        );

      console.log(
        `[COW:REMOVE:POLL] CANCELLED hash=${order.hash} owner=${order.owner} block=${event.block.number} chain=${chainId}`,
      );
    }
  }
});
