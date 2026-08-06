import { db } from "ponder:api";
import schema from "ponder:schema";
import { Hono } from "hono";
import { client, graphql } from "ponder";
import { and, count, eq, inArray } from "drizzle-orm";
import { swaggerUI } from "@hono/swagger-ui";
import { apiRouter } from "./router";
import { gqlDocsMiddleware } from "./gql-docs";
import { OWNER_BACKFILL_TYPES } from "../utils/order-types";
import {
  describeStaleChains,
  fetchChainStatus,
  findStaleChains,
} from "./freshness";

const app = new Hono();

app.use("/sql/*", client({ db, schema }));

app.use("/", gqlDocsMiddleware);
app.use("/", graphql({ db, schema }));
app.use("/graphql", gqlDocsMiddleware);
app.use("/graphql", graphql({ db, schema }));

app.get("/healthz", (c) => c.json({ status: "ok" }));

// Readiness for blue-green promotion and for the container healthcheck. Ponder's
// built-in /ready flips once historical sync reaches the tip and then stays 200
// forever — it says nothing about whether live indexing is still advancing, so a
// stalled indexer keeps reporting itself ready. OwnerBackfill also drains historical
// orders across the following live blocks, so /ready alone would promote an indexer
// with history still filling. /readyz returns 200 only when Ponder is synced, every
// active chain is still keeping up with the tip, and the owner backfill is complete.
// Ponder reserves /ready, so it can't be shadowed — hence a distinct path.
app.get("/readyz", async (c) => {
  const origin = new URL(c.req.url).origin;

  // 1. Ponder historical sync complete? Reuse the built-in /ready on the same origin
  //    (also guards the empty-DB false positive: a fresh pod with zero generators would
  //    otherwise have a pending count of 0 and look ready before indexing anything).
  let synced = false;
  try {
    const res = await fetch(`${origin}/ready`);
    synced = res.status === 200;
  } catch {
    synced = false;
  }
  if (!synced) return c.text("Historical indexing is not complete.", 503);

  // 2. Live indexing still advancing? A dead RPC subscription leaves the process
  //    healthy and serving while the newest indexed block silently ages. /status
  //    decodes _ponder_checkpoint, so this reads committed database state.
  const stale = findStaleChains(
    await fetchChainStatus(origin),
    Math.floor(Date.now() / 1000),
  );
  if (stale.length > 0) return c.text(describeStaleChains(stale), 503);

  // 3. OwnerBackfill drained? Count matches OwnerBackfill's eligibility set exactly.
  const rows = await db
    .select({ pending: count() })
    .from(schema.conditionalOrderGenerator)
    .where(
      and(
        eq(schema.conditionalOrderGenerator.status, "Active"),
        eq(schema.conditionalOrderGenerator.historyBackfilled, false),
        inArray(schema.conditionalOrderGenerator.orderType, [...OWNER_BACKFILL_TYPES]),
      ),
    );
  const pending = Number(rows[0]?.pending ?? 0);
  if (pending > 0) {
    return c.text(`Owner backfill incomplete: ${pending} generators pending.`, 503);
  }
  return c.text("", 200);
});

app.route("/api", apiRouter);

app.get("/openapi.json", (c) =>
  c.json(
    apiRouter.getOpenAPIDocument({
      openapi: "3.0.0",
      info: {
        title: "Composable CoW Programmatic Orders API",
        version: "1.0.0",
        description:
          "REST endpoints for the Composable CoW programmatic orders indexer. The indexer also exposes a full GraphQL API — see / or /graphql.",
      },
      servers: [{ url: "/api" }],
    }),
  ),
);

app.get("/docs", swaggerUI({ url: "/openapi.json" }));

export default app;
