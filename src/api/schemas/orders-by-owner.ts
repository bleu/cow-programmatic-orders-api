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
  hash: z
    .string()
    .describe(
      "On-chain canonical identifier: keccak256(abi.encode(ConditionalOrderParams { handler, salt, staticInput })) — the value returned by ComposableCow.hash(params) and used as the key in singleOrders(owner, hash) and remove(owner, hash).",
    ),
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

export const FlashLoanOrderItem = z.object({
  orderUid: z.string(),
  chainId: z.number().int(),
  adapter: z
    .string()
    .describe(
      "Per-order Aave V3 flash-loan adapter contract (1:1 with the order, deployed via CREATE2).",
    ),
  sellToken: z.string(),
  buyToken: z.string(),
  executedSellAmount: z
    .string()
    .describe("Settled sell amount as a decimal string (uint256)."),
  executedBuyAmount: z
    .string()
    .describe("Settled buy amount as a decimal string (uint256)."),
  feeAmount: z.string(),
  validTo: z
    .number()
    .int()
    .describe(
      "Unix seconds (UTC) when the order expires — the trailing uint32 of the order UID. See docs/api-reference.md#timestamp-fields.",
    ),
  owner: z
    .string()
    .nullable()
    .describe(
      "Resolved EOA owner from getHookData(). Null when getHookData() was unavailable at settlement.",
    ),
  receiver: z.string().nullable(),
  kind: z
    .enum(["sell", "buy"])
    .nullable()
    .describe("CoW order kind from getHookData(). Null when undetermined."),
  sellAmountIntended: z.string().nullable(),
  buyAmountIntended: z.string().nullable(),
  flashLoanAmount: z.string().nullable(),
  flashLoanFeeAmount: z.string().nullable(),
  source: z.literal("aave"),
  type: z
    .enum(["RepayWithCollateral", "CollateralSwap", "DebtSwap"])
    .nullable()
    .describe(
      "Adapter operation, derived from the EIP-1167 implementation address. Null when the clone bytecode did not match a known implementation.",
    ),
  txHash: z.string(),
  blockNumber: z.string().describe("Block number as a decimal string (BigInt scalar)."),
  blockTimestamp: z
    .string()
    .describe(
      "Settlement block time, Unix seconds (UTC) as a decimal string (BigInt scalar).",
    ),
});

export const OrdersByOwnerResponse = z.object({
  orders: z.array(OrderItem),
  flashLoanOrders: z
    .array(FlashLoanOrderItem)
    .describe(
      "Aave flash-loan orders for this owner — independent of the conditional-order generators in `orders`. Executed-only (no status).",
    ),
});
