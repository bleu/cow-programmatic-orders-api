import { z } from "zod";

export const AddressParam = z.object({
  owner: z
    .string()
    .regex(
      /^0x[a-fA-F0-9]{40}$/,
      "Invalid EVM address — must be 0x followed by 40 hex characters",
    ),
});

export const EventIdParam = z.object({
  eventId: z.string().min(1),
});

export const DiscreteOrderStatusQuery = z.enum([
  "open",
  "fulfilled",
  "unfilled",
  "expired",
  "cancelled",
]);

export const ChainIdQuery = z.coerce
  .number()
  .int()
  .positive()
  .describe("EVM chain ID. Indexed chains: 1 (mainnet), 100 (Gnosis).");
