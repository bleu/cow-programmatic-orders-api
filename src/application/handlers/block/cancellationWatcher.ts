import { ponder } from "ponder:registry";
import { conditionalOrderGenerator } from "ponder:schema";
import { and, asc, eq, isNull, lte, or } from "ponder";
import type { Hex } from "viem";
import {
  COMPOSABLE_COW_ADDRESS_BY_CHAIN_ID,
  type SupportedChainId,
} from "../../../data";
import {
  BLOCK_HANDLER_RPC_TIMEOUT_MS,
  DEFAULT_MAX_GENERATORS_PER_BLOCK,
  DETERMINISTIC_CANCEL_SWEEP_INTERVAL,
} from "../../../constants";
import { TimeoutError, withTimeout } from "../../helpers/withTimeout";
import { log } from "../../helpers/logger";
import { type OrderType } from "../../../utils/order-types";

// Minimal ABI for CancellationWatcher: reads the singleOrders(owner, hash) mapping on ComposableCoW.
// `false` means the owner called remove() — generator is cancelled on-chain.
const SINGLE_ORDERS_ABI = [
  {
    inputs: [
      { internalType: "address", name: "", type: "address" },
      { internalType: "bytes32", name: "", type: "bytes32" },
    ],
    name: "singleOrders",
    outputs: [{ internalType: "bool", name: "", type: "bool" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

// ─── CancellationWatcher ─────────────────────────────────────────────────────
// OrderDiscoveryPoller skips generators with allCandidatesKnown=true (deterministic types: TWAP,
// StopLoss, CirclesBackingOrder), so SingleOrderNotAuthed is never observed
// for them. This handler closes that gap by reading
// ComposableCoW.singleOrders(owner, hash) on a DETERMINISTIC_CANCEL_SWEEP_INTERVAL
// cadence. A `false` result means the owner called remove() on-chain -> flip to
// Cancelled, which lets the CandidateConfirmer/OrderStatusTracker parent-cancelled cascade reconcile
// the child discrete / candidate rows on the next block.

ponder.on("CancellationWatcher:block", async ({ event, context }) => {

  const chainId = context.chain.id as SupportedChainId;
  const composableCowAddress = COMPOSABLE_COW_ADDRESS_BY_CHAIN_ID[chainId];
  if (!composableCowAddress) return;

  const currentBlock = event.block.number;

  const rawGeneratorCap2 = Number(process.env[`MAX_GENERATORS_PER_BLOCK_${chainId}`]);
  const maxGeneratorsPerBlock =
    Number.isFinite(rawGeneratorCap2) && rawGeneratorCap2 > 0 ? rawGeneratorCap2 : DEFAULT_MAX_GENERATORS_PER_BLOCK;

  const dueGenerators = await context.db.sql
    .select({
      generatorId: conditionalOrderGenerator.eventId,
      owner: conditionalOrderGenerator.owner,
      hash: conditionalOrderGenerator.hash,
      orderType: conditionalOrderGenerator.orderType,
    })
    .from(conditionalOrderGenerator)
    .where(
      and(
        eq(conditionalOrderGenerator.chainId, chainId),
        eq(conditionalOrderGenerator.status, "Active"),
        eq(conditionalOrderGenerator.allCandidatesKnown, true),
        or(
          isNull(conditionalOrderGenerator.nextCheckBlock),
          lte(conditionalOrderGenerator.nextCheckBlock, currentBlock),
        ),
      ),
    )
    .orderBy(asc(conditionalOrderGenerator.lastCheckBlock))
    .limit(maxGeneratorsPerBlock) as {
    generatorId: string;
    owner: Hex;
    hash: Hex;
    orderType: OrderType;
  }[];

  if (dueGenerators.length === 0) return;

  log("info", "CancellationWatcher:ENTER", { block: String(currentBlock), chainId, due: dueGenerators.length });

  const c5MulticallPromise = context.client.multicall({
    contracts: dueGenerators.map((g) => ({
      address: composableCowAddress,
      abi: SINGLE_ORDERS_ABI,
      functionName: "singleOrders" as const,
      args: [g.owner, g.hash] as const,
    })),
    allowFailure: true,
  });

  let results: Awaited<typeof c5MulticallPromise>;
  try {
    results = await withTimeout(
      c5MulticallPromise,
      BLOCK_HANDLER_RPC_TIMEOUT_MS,
      "CancellationWatcher:multicall",
    );
  } catch (err) {
    if (err instanceof TimeoutError) {
      log("warn", "CancellationWatcher:multicall_timeout", { block: String(currentBlock), chainId, due: dueGenerators.length });
      return;
    }
    throw err;
  }

  let cancelledCount = 0;
  let stillActiveCount = 0;
  let errorCount = 0;

  for (let i = 0; i < dueGenerators.length; i++) {
    const result = results[i];
    const gen = dueGenerators[i]!;

    if (result === undefined || result.status === "failure") {
      errorCount++;
      // Leave state untouched — retry next sweep cycle.
      continue;
    }

    const stillAuthorized = result.result as boolean;

    if (!stillAuthorized) {
      await context.db.sql
        .update(conditionalOrderGenerator)
        .set({
          status: "Cancelled",
          lastCheckBlock: currentBlock,
          lastPollResult: "cancelled:removeMapping",
          nextCheckBlock: null,
        })
        .where(
          and(
            eq(conditionalOrderGenerator.chainId, chainId),
            eq(conditionalOrderGenerator.eventId, gen.generatorId),
          ),
        );
      log("info", "CancellationWatcher:CANCELLED", { block: String(currentBlock), chainId, generatorId: gen.generatorId, orderType: gen.orderType });
      cancelledCount++;
    } else {
      await context.db.sql
        .update(conditionalOrderGenerator)
        .set({
          lastCheckBlock: currentBlock,
          nextCheckBlock: currentBlock + DETERMINISTIC_CANCEL_SWEEP_INTERVAL,
          lastPollResult: "sweep:stillAuthorized",
        })
        .where(
          and(
            eq(conditionalOrderGenerator.chainId, chainId),
            eq(conditionalOrderGenerator.eventId, gen.generatorId),
          ),
        );
      stillActiveCount++;
    }
  }

  log("info", "CancellationWatcher:DONE", { block: String(currentBlock), chainId, due: dueGenerators.length, cancelled: cancelledCount, stillActive: stillActiveCount, errors: errorCount });
});

