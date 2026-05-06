import { db } from "ponder:api";
import schema from "ponder:schema";
import { Hono } from "hono";
import { client, graphql } from "ponder";
import { swaggerUI } from "@hono/swagger-ui";
import { apiRouter } from "./router";
import { gqlDocsMiddleware } from "./gql-docs";

const app = new Hono();

app.use("/sql/*", client({ db, schema }));

app.use("/", gqlDocsMiddleware);
app.use("/", graphql({ db, schema }));
app.use("/graphql", gqlDocsMiddleware);
app.use("/graphql", graphql({ db, schema }));

app.get("/healthz", (c) => c.json({ status: "ok" }));

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
