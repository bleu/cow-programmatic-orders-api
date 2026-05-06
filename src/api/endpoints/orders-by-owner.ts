import type { RouteHandler } from "@hono/zod-openapi";
import { db } from "ponder:api";
import schema from "ponder:schema";
import { and, eq, inArray, or } from "ponder";
import type { ordersByOwnerRoute } from "../routes";

export const ordersByOwnerHandler: RouteHandler<
  typeof ordersByOwnerRoute
> = async (c) => {
  const { owner } = c.req.valid("param");
  const { chainId, status: statusFilter } = c.req.valid("query");
  const rawOwner = owner.toLowerCase() as `0x${string}`;

  const mappingConditions = [eq(schema.ownerMapping.owner, rawOwner)];
  if (chainId !== undefined) {
    mappingConditions.push(eq(schema.ownerMapping.chainId, chainId));
  }
  const proxyRows = await db
    .select({ address: schema.ownerMapping.address })
    .from(schema.ownerMapping)
    .where(and(...mappingConditions));

  const proxyAddresses = proxyRows.map((r) => r.address) as `0x${string}`[];
  const allOwners = [rawOwner, ...proxyAddresses];

  const generatorOwnerFilter =
    allOwners.length === 1
      ? or(
          eq(schema.conditionalOrderGenerator.owner, rawOwner),
          eq(schema.conditionalOrderGenerator.resolvedOwner, rawOwner),
        )
      : or(
          inArray(schema.conditionalOrderGenerator.owner, allOwners),
          eq(schema.conditionalOrderGenerator.resolvedOwner, rawOwner),
        );

  const generatorConditions = [generatorOwnerFilter];
  if (chainId !== undefined) {
    generatorConditions.push(
      eq(schema.conditionalOrderGenerator.chainId, chainId),
    );
  }

  const generators = await db
    .select({
      eventId: schema.conditionalOrderGenerator.eventId,
      chainId: schema.conditionalOrderGenerator.chainId,
      orderType: schema.conditionalOrderGenerator.orderType,
      owner: schema.conditionalOrderGenerator.owner,
      resolvedOwner: schema.conditionalOrderGenerator.resolvedOwner,
      status: schema.conditionalOrderGenerator.status,
    })
    .from(schema.conditionalOrderGenerator)
    .where(and(...generatorConditions));

  if (generators.length === 0) {
    return c.json({ orders: [] }, 200);
  }

  const generatorIds = generators.map((g) => g.eventId);

  const orderConditions = [
    inArray(schema.discreteOrder.conditionalOrderGeneratorId, generatorIds),
  ];
  if (chainId !== undefined) {
    orderConditions.push(eq(schema.discreteOrder.chainId, chainId));
  }
  if (statusFilter !== undefined) {
    orderConditions.push(eq(schema.discreteOrder.status, statusFilter));
  }

  const orders = await db
    .select({
      orderUid: schema.discreteOrder.orderUid,
      chainId: schema.discreteOrder.chainId,
      status: schema.discreteOrder.status,
      sellAmount: schema.discreteOrder.sellAmount,
      buyAmount: schema.discreteOrder.buyAmount,
      feeAmount: schema.discreteOrder.feeAmount,
      validTo: schema.discreteOrder.validTo,
      creationDate: schema.discreteOrder.creationDate,
      executedSellAmount: schema.discreteOrder.executedSellAmount,
      executedBuyAmount: schema.discreteOrder.executedBuyAmount,
      generatorId: schema.discreteOrder.conditionalOrderGeneratorId,
    })
    .from(schema.discreteOrder)
    .where(and(...orderConditions));

  const generatorById = Object.fromEntries(
    generators.map((g) => [g.eventId, g]),
  );
  const enrichedOrders = orders.map((o) => ({
    ...o,
    creationDate: o.creationDate.toString(),
    generator: generatorById[o.generatorId],
  }));

  return c.json({ orders: enrichedOrders }, 200);
};
