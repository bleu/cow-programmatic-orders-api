import { ponder } from "ponder:registry";
import { type SupportedChainId } from "../../../data";
import { FLASH_LOAN_BACKFILL_SLICE_SIZE } from "../../../constants";
import { log } from "../../helpers/logger";
import { selectPendingFlashLoanOrders, enrichFlashLoanOrders } from "./shared";

// FlashLoanOrderBackfiller — fires once at go-live (startBlock=endBlock="latest"),
// mirroring OwnerBackfill. Bulk-drains the historical backlog the settlement
// handler recorded during backfill, in bounded sequential slices to cap orderbook
// concurrency. The whole drain happens in this one firing, so the incomplete-data
// window after promotion is one firing, not hours of every-block draining.
ponder.on("FlashLoanOrderBackfiller:block", async ({ event, context }) => {
  const chainId = context.chain.id as SupportedChainId;

  const pending = await selectPendingFlashLoanOrders(context, chainId);
  log("info", "FlashLoanOrderBackfiller:START", { block: String(event.block.number), chainId, pending: pending.length });
  if (pending.length === 0) return;

  let enriched = 0;
  let missing = 0;
  for (let i = 0; i < pending.length; i += FLASH_LOAN_BACKFILL_SLICE_SIZE) {
    const slice = pending.slice(i, i + FLASH_LOAN_BACKFILL_SLICE_SIZE);
    const r = await enrichFlashLoanOrders(context, chainId, event.block.timestamp, slice);
    enriched += r.enriched;
    missing += r.missing;
  }

  log("info", "FlashLoanOrderBackfiller:DONE", { block: String(event.block.number), chainId, pending: pending.length, enriched, missing });
});
