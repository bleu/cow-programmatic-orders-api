import type { RouteHandler } from "@hono/zod-openapi";
import { db } from "ponder:api";
import { discreteOrder } from "ponder:schema";
import { and, count, eq } from "ponder";
import type { executionSummaryRoute } from "../routes";

export const executionSummaryHandler: RouteHandler<
  typeof executionSummaryRoute
> = async (c) => {
  const { eventId } = c.req.valid("param");
  const { chainId } = c.req.valid("query");

  const rows = await db
    .select({ status: discreteOrder.status, count: count() })
    .from(discreteOrder)
    .where(
      and(
        eq(discreteOrder.conditionalOrderGeneratorId, eventId),
        eq(discreteOrder.chainId, chainId),
      ),
    )
    .groupBy(discreteOrder.status);

  const counts: Record<string, number> = {};
  for (const row of rows) {
    counts[row.status] = row.count;
  }

  const filledParts = counts["fulfilled"] ?? 0;
  const openParts = counts["open"] ?? 0;
  const unfilledParts = counts["unfilled"] ?? 0;
  const expiredParts = counts["expired"] ?? 0;
  const cancelledParts = counts["cancelled"] ?? 0;
  const totalParts =
    filledParts + openParts + unfilledParts + expiredParts + cancelledParts;

  return c.json(
    {
      generatorId: eventId,
      chainId,
      totalParts,
      filledParts,
      openParts,
      unfilledParts,
      expiredParts,
      cancelledParts,
    },
    200,
  );
};
