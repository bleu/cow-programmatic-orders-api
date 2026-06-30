import type { RouteHandler } from "@hono/zod-openapi";
import { db } from "ponder:api";
import schema from "ponder:schema";
import { and, eq, inArray, or } from "ponder";
import type { ordersByOwnerRoute } from "../routes";

export const ordersByOwnerHandler: RouteHandler<
  typeof ordersByOwnerRoute
> = async (c) => {
  const { owner } = c.req.valid("param");
  const { chainId, status: statusFilter, ownerAddressType: ownerAddressTypeFilter } = c.req.valid("query");
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
  if (ownerAddressTypeFilter !== undefined) {
    generatorConditions.push(
      eq(schema.conditionalOrderGenerator.ownerAddressType, ownerAddressTypeFilter),
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
      hash: schema.conditionalOrderGenerator.hash,
      ownerAddressType: schema.conditionalOrderGenerator.ownerAddressType,
    })
    .from(schema.conditionalOrderGenerator)
    .where(and(...generatorConditions));

  // Discrete (conditional) orders — only meaningful when the owner has generators.
  let enrichedOrders: unknown[] = [];
  if (generators.length > 0) {
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
    enrichedOrders = orders.map((o) => ({
      ...o,
      creationDate: o.creationDate.toString(),
      generator: generatorById[o.generatorId],
    }));
  }

  // Flash-loan orders are standalone CoW orders settled by an Aave adapter —
  // independent of conditional generators. The table stores the resolved EOA in
  // `owner`, so query by it directly (no proxy join). Filter semantics:
  //  - ownerAddressType: include when unset or flash_loan_helper; exclude cowshed_proxy.
  //  - status: flash-loan orders have no status (always executed) — include when
  //    the status filter is unset or "fulfilled"; otherwise exclude.
  const includeFlashLoan =
    (ownerAddressTypeFilter === undefined ||
      ownerAddressTypeFilter === "flash_loan_helper") &&
    (statusFilter === undefined || statusFilter === "fulfilled");

  let flashLoanOrders: unknown[] = [];
  if (includeFlashLoan) {
    const flashLoanConditions = [eq(schema.flashLoanOrder.owner, rawOwner)];
    if (chainId !== undefined) {
      flashLoanConditions.push(eq(schema.flashLoanOrder.chainId, chainId));
    }

    const flashLoanRows = await db
      .select({
        orderUid: schema.flashLoanOrder.orderUid,
        chainId: schema.flashLoanOrder.chainId,
        adapter: schema.flashLoanOrder.adapter,
        sellToken: schema.flashLoanOrder.sellToken,
        buyToken: schema.flashLoanOrder.buyToken,
        executedSellAmount: schema.flashLoanOrder.executedSellAmount,
        executedBuyAmount: schema.flashLoanOrder.executedBuyAmount,
        feeAmount: schema.flashLoanOrder.feeAmount,
        validTo: schema.flashLoanOrder.validTo,
        owner: schema.flashLoanOrder.owner,
        receiver: schema.flashLoanOrder.receiver,
        kind: schema.flashLoanOrder.kind,
        sellAmountIntended: schema.flashLoanOrder.sellAmountIntended,
        buyAmountIntended: schema.flashLoanOrder.buyAmountIntended,
        flashLoanAmount: schema.flashLoanOrder.flashLoanAmount,
        flashLoanFeeAmount: schema.flashLoanOrder.flashLoanFeeAmount,
        source: schema.flashLoanOrder.source,
        type: schema.flashLoanOrder.type,
        txHash: schema.flashLoanOrder.txHash,
        blockNumber: schema.flashLoanOrder.blockNumber,
        blockTimestamp: schema.flashLoanOrder.blockTimestamp,
      })
      .from(schema.flashLoanOrder)
      .where(and(...flashLoanConditions));

    flashLoanOrders = flashLoanRows.map((o) => ({
      ...o,
      blockNumber: o.blockNumber.toString(),
      blockTimestamp: o.blockTimestamp.toString(),
    }));
  }

  return c.json({ orders: enrichedOrders, flashLoanOrders }, 200);
};
