import { z } from "zod";
import { ChainIdQuery, DiscreteOrderStatusQuery } from "./common";

export const OrdersByOwnerQuery = z.object({
  chainId: ChainIdQuery.optional(),
  status: DiscreteOrderStatusQuery.optional().describe(
    "Filter discrete orders by status.",
  ),
  ownerAddressType: z
    .enum(["cowshed_proxy", "flash_loan_helper"])
    .optional()
    .describe("Filter orders to generators created through a specific proxy type."),
});

export const GeneratorSummary = z.object({
  eventId: z.string(),
  chainId: z.number().int(),
  orderType: z.string(),
  owner: z.string(),
  resolvedOwner: z.string().nullable(),
  status: z.string(),
  ownerAddressType: z
    .enum(["cowshed_proxy", "flash_loan_helper"])
    .nullable()
    .describe(
      "Proxy channel through which this order was created. 'flash_loan_helper' = Aave V3 adapter; 'cowshed_proxy' = CoWShed smart wallet; null = direct EOA (or Aave adapter not yet discovered — see docs/api-reference.md#owner-address-type).",
    ),
});

export const OrderItem = z.object({
  orderUid: z.string(),
  chainId: z.number().int(),
  status: z.string(),
  sellAmount: z.string(),
  buyAmount: z.string(),
  feeAmount: z.string(),
  validTo: z.number().int().nullable(),
  creationDate: z.string(),
  executedSellAmount: z.string().nullable(),
  executedBuyAmount: z.string().nullable(),
  generatorId: z.string(),
  generator: GeneratorSummary.optional(),
});

export const OrdersByOwnerResponse = z.object({
  orders: z.array(OrderItem),
});
