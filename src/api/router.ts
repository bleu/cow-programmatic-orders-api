import { OpenAPIHono } from "@hono/zod-openapi";
import {
  ordersByOwnerRoute,
  executionSummaryRoute,
  syncProgressRoute,
} from "./routes";
import { ordersByOwnerHandler } from "./endpoints/orders-by-owner";
import { executionSummaryHandler } from "./endpoints/execution-summary";
import { syncProgressHandler } from "./endpoints/sync-progress";
import { log } from "../application/helpers/logger";

export const apiRouter = new OpenAPIHono();

apiRouter.onError((err, c) => {
  log("error", "api:error", { err: err instanceof Error ? err.message : String(err) });
  return c.json(
    {
      error: "Internal server error",
      message: "An unexpected error occurred",
    },
    500,
  );
});

apiRouter.openapi(ordersByOwnerRoute, ordersByOwnerHandler);
apiRouter.openapi(executionSummaryRoute, executionSummaryHandler);
apiRouter.openapi(syncProgressRoute, syncProgressHandler);
