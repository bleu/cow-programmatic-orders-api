import type { RouteHandler } from "@hono/zod-openapi";
import { db } from "ponder:api";
import { sql } from "ponder";
import type { executionSummaryRoute } from "../routes";

export const executionSummaryHandler: RouteHandler<
  typeof executionSummaryRoute
> = async (c) => {
  const { eventId } = c.req.valid("param");
  const { chainId } = c.req.valid("query");

  const rows = await db.execute<{ status: string; count: string }>(
    sql`SELECT status, COUNT(*)::text AS count
        FROM discrete_order
        WHERE conditional_order_generator_id = ${eventId}
          AND chain_id = ${chainId}
        GROUP BY status`,
  );

  const counts: Record<string, number> = {};
  for (const row of rows.rows) {
    counts[row.status] = Number(row.count);
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
