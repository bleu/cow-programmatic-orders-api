import { index, onchainEnum, onchainTable } from "ponder";

// ── Enums ────────────────────────────────────────────────────────────────────

export const orderTypeEnum = onchainEnum("order_type", [
  "TWAP",
  "StopLoss",
  "PerpetualSwap",
  "GoodAfterTime",
  "TradeAboveThreshold",
  "Unknown",
]);

export const orderStatusEnum = onchainEnum("order_status", [
  "Active",
  "Cancelled",
]);

// ── Tables ───────────────────────────────────────────────────────────────────

export const conditionalOrder = onchainTable(
  "conditional_order",
  (t) => ({
    id: t.text().primaryKey(),              // ponder event.id
    chainId: t.integer().notNull(),
    owner: t.hex().notNull(),               // indexed address from event
    handler: t.hex().notNull(),             // IConditionalOrder handler address
    salt: t.hex().notNull(),               // bytes32
    staticInput: t.hex().notNull(),         // encoded handler params
    hash: t.hex().notNull(),               // keccak256(abi.encode(params))
    orderType: orderTypeEnum("order_type").notNull(),
    status: orderStatusEnum("order_status").notNull().default("Active"),
    decodedParams: t.json(),               // null until decoder tasks populate it
    txHash: t.hex().notNull(),
    blockNumber: t.bigint().notNull(),
    blockTimestamp: t.bigint().notNull(),
    createdAt: t.bigint().notNull(),       // same as blockTimestamp for now
  }),
  (table) => ({
    ownerIdx: index().on(table.owner),
    handlerIdx: index().on(table.handler),
    hashIdx: index().on(table.hash),
    chainOwnerIdx: index().on(table.chainId, table.owner),
  })
);

export const discreteOrder = onchainTable(
  "discrete_order",
  (t) => ({
    orderUid: t.text().primaryKey(),        // CoW Protocol order UID
    conditionalOrderId: t.text().notNull(),
    chainId: t.integer().notNull(),
  }),
  (table) => ({
    conditionalOrderIdx: index().on(table.conditionalOrderId),
  })
);
