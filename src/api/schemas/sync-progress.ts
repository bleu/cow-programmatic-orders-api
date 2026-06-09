import { z } from "zod";

export const ChainProgressSchema = z.object({
  totalBlocks: z
    .number()
    .int()
    .describe("Total number of historical blocks to process."),
  processedBlocks: z
    .number()
    .int()
    .describe("Blocks already processed (completed + served from cache)."),
  historicalBlocksFetchedPct: z
    .number()
    .describe("Completion percentage (0–100). Rounded to one decimal place."),
  isRealtime: z
    .boolean()
    .describe("True when the chain has caught up and is in live-sync mode."),
  isComplete: z
    .boolean()
    .describe("True when all historical blocks have been fully processed."),
});

export const SyncProgressResponse = z
  .record(z.string(), ChainProgressSchema)
  .describe(
    "Per-chain sync progress. Keys are chain names (e.g. 'mainnet', 'gnosis').",
  );
