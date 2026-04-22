import { OpenAPIHono } from "@hono/zod-openapi";
import { ordersByOwnerRoute, executionSummaryRoute } from "./routes";
import { ordersByOwnerHandler } from "./endpoints/orders-by-owner";
import { executionSummaryHandler } from "./endpoints/execution-summary";

export const apiRouter = new OpenAPIHono();

apiRouter.onError((err, c) => {
  console.error("API Error:", err);
  return c.json(
    {
      error: "Internal server error",
      message: err instanceof Error ? err.message : "Unknown error",
    },
    500,
  );
});

apiRouter.openapi(ordersByOwnerRoute, ordersByOwnerHandler);
apiRouter.openapi(executionSummaryRoute, executionSummaryHandler);
