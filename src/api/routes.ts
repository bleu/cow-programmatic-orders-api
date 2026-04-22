import { createRoute } from "@hono/zod-openapi";
import { AddressParam, EventIdParam } from "./schemas/common";
import {
  OrdersByOwnerQuery,
  OrdersByOwnerResponse,
} from "./schemas/orders-by-owner";
import {
  ExecutionSummaryQuery,
  ExecutionSummaryResponse,
} from "./schemas/execution-summary";

export const ordersByOwnerRoute = createRoute({
  method: "get",
  path: "/orders/by-owner/{owner}",
  tags: ["Orders"],
  summary: "Discrete orders for an owner (with proxy resolution)",
  description:
    "Returns discrete orders for a wallet address. Follows proxy mappings (CoWShed, Aave flash loan adapters) so orders created through intermediaries resolve to the underlying EOA.",
  request: { params: AddressParam, query: OrdersByOwnerQuery },
  responses: {
    200: {
      description: "List of discrete orders enriched with generator metadata.",
      content: {
        "application/json": { schema: OrdersByOwnerResponse },
      },
    },
    400: { description: "Invalid address or query parameters." },
  },
});

export const executionSummaryRoute = createRoute({
  method: "get",
  path: "/generator/{eventId}/execution-summary",
  tags: ["Generators"],
  summary: "Part-count breakdown for a generator",
  description:
    "Counts discrete orders for a conditional order generator grouped by status. Useful for rendering TWAP progress (e.g. \"3 of 5 parts filled\").",
  request: { params: EventIdParam, query: ExecutionSummaryQuery },
  responses: {
    200: {
      description: "Part counts by status.",
      content: {
        "application/json": { schema: ExecutionSummaryResponse },
      },
    },
    400: { description: "Missing or invalid chainId." },
  },
});
