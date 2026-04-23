import { z } from "zod";
import { ChainIdQuery } from "./common";

export const ExecutionSummaryQuery = z.object({
  chainId: ChainIdQuery,
});

export const ExecutionSummaryResponse = z.object({
  generatorId: z.string(),
  chainId: z.number().int(),
  totalParts: z.number().int(),
  filledParts: z.number().int(),
  openParts: z.number().int(),
  unfilledParts: z.number().int(),
  expiredParts: z.number().int(),
  cancelledParts: z.number().int(),
});
