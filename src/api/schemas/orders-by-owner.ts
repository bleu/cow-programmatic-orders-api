import { z } from "zod";
import { ChainIdQuery, DiscreteOrderStatusQuery } from "./common";

export const OrdersByOwnerQuery = z.object({
  chainId: ChainIdQuery.optional(),
  status: DiscreteOrderStatusQuery.optional().describe(
    "Filter discrete orders by status.",
  ),
});

export const GeneratorSummary = z.object({
  eventId: z.string(),
  chainId: z.number().int(),
  orderType: z.string(),
  owner: z.string(),
  resolvedOwner: z.string().nullable(),
  status: z.string(),
});

export const OrderItem = z.object({
  orderUid: z.string(),
  chainId: z.number().int(),
  status: z.string(),
  sellAmount: z.string(),
  buyAmount: z.string(),
  feeAmount: z.string(),
  validTo: z
    .number()
    .int()
    .nullable()
    .describe(
      "Unix seconds (UTC) when the order expires. Returned as a JSON number — the CoW protocol encodes validTo as uint32 in the order UID. Null if not yet known. See docs/api-reference.md#timestamp-fields.",
    ),
  creationDate: z
    .string()
    .describe(
      "Unix seconds (UTC) when the discrete order was first observed, as a decimal string (BigInt scalar in GraphQL). Source depends on discovery path — see the GraphQL doc for discreteOrder.creationDate.",
    ),
  executedSellAmount: z.string().nullable(),
  executedBuyAmount: z.string().nullable(),
  generatorId: z.string(),
  generator: GeneratorSummary.optional(),
});

export const OrdersByOwnerResponse = z.object({
  orders: z.array(OrderItem),
});
