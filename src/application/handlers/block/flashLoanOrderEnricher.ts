import { ponder } from "ponder:registry";
import { type SupportedChainId } from "../../../data";
import { DEFAULT_MAX_FLASH_LOAN_ORDERS_PER_BLOCK } from "../../../constants";
import { log } from "../../helpers/logger";
import { selectPendingFlashLoanOrders, enrichFlashLoanOrders } from "./shared";

// FlashLoanOrderEnricher — every block. Enriches orders that settle during live
// sync, plus any stragglers the backfiller left (timeouts / not-yet-on-API).
// Capped per block (MAX_FLASH_LOAN_ORDERS_PER_BLOCK_<chainId>), oldest-first.
ponder.on("FlashLoanOrderEnricher:block", async ({ event, context }) => {
  const chainId = context.chain.id as SupportedChainId;

  const rawCap = Number(process.env[`MAX_FLASH_LOAN_ORDERS_PER_BLOCK_${chainId}`]);
  const maxPerBlock =
    Number.isFinite(rawCap) && rawCap > 0 ? rawCap : DEFAULT_MAX_FLASH_LOAN_ORDERS_PER_BLOCK;

  const pending = await selectPendingFlashLoanOrders(context, chainId, maxPerBlock);
  if (pending.length === 0) return;

  const { enriched, missing } = await enrichFlashLoanOrders(context, chainId, event.block.timestamp, pending);

  log("info", "FlashLoanOrderEnricher:DONE", { block: String(event.block.number), chainId, pending: pending.length, enriched, missing });
});
