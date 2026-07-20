import { conditionalOrderGenerator } from "ponder:schema";
import type { Context } from "ponder:registry";
import { and, eq, inArray } from "ponder";

/**
 * Bump the sync cursor (updatedAtBlock) on a set of generators after their own
 * state or any of their discrete orders changed. Dedupes ids so callers can
 * pass one id per changed part; issues a single bulk UPDATE.
 */
export async function bumpGeneratorsUpdatedAt(
  context: Context,
  chainId: number,
  generatorIds: string[],
  blockNumber: bigint,
): Promise<void> {
  if (generatorIds.length === 0) return;

  await context.db.sql
    .update(conditionalOrderGenerator)
    .set({ updatedAtBlock: blockNumber })
    .where(
      and(
        eq(conditionalOrderGenerator.chainId, chainId),
        inArray(conditionalOrderGenerator.eventId, [...new Set(generatorIds)]),
      ),
    );
}
