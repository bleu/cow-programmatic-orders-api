import { index, onchainEnum, onchainTable, primaryKey } from "ponder";

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

export const addressTypeEnum = onchainEnum("address_type", [
  "cowshed_proxy",
  "flash_loan_helper",
]);

// ── Tables ───────────────────────────────────────────────────────────────────

export const transaction = onchainTable(
  "transaction",
  (t) => ({
    hash: t.hex().notNull(),
    chainId: t.integer().notNull(),
    blockNumber: t.bigint().notNull(),
    blockTimestamp: t.bigint().notNull(),
  }),
  (table) => ({
    pk: primaryKey({ columns: [table.chainId, table.hash] }),
    blockIdx: index().on(table.blockNumber),
  })
);

export const conditionalOrderGenerator = onchainTable(
  "conditional_order_generator",
  (t) => ({
    eventId: t.text().notNull(),            // ponder event.id
    chainId: t.integer().notNull(),
    owner: t.hex().notNull(),               // indexed address from event
    resolvedEoaOwner: t.hex(),              // EOA controlling this owner (null transiently; set at insert)
    handler: t.hex().notNull(),             // IConditionalOrder handler address
    salt: t.hex().notNull(),                // bytes32
    staticInput: t.hex().notNull(),         // encoded handler params
    hash: t.hex().notNull(),               // keccak256(abi.encode(params))
    orderType: orderTypeEnum("order_type").notNull(),
    status: orderStatusEnum("order_status").notNull().default("Active"),
    decodedParams: t.json(),               // null if unknown type or decode failed
    decodeError: t.text(),                 // "invalid_static_input" | null
    txHash: t.hex().notNull(),             // FK → transaction.hash
  }),
  (table) => ({
    pk: primaryKey({ columns: [table.chainId, table.eventId] }),
    ownerIdx: index().on(table.owner),
    handlerIdx: index().on(table.handler),
    hashIdx: index().on(table.hash),
    chainOwnerIdx: index().on(table.chainId, table.owner),
    resolvedEoaOwnerIdx: index().on(table.resolvedEoaOwner),
  })
);

export const discreteOrder = onchainTable(
  "discrete_order",
  (t) => ({
    orderUid: t.text().notNull(),
    chainId: t.integer().notNull(),
    conditionalOrderGeneratorId: t.text().notNull(),  // references eventId
  }),
  (table) => ({
    pk: primaryKey({ columns: [table.chainId, table.orderUid] }),
    generatorIdx: index().on(table.conditionalOrderGeneratorId),
  })
);

export const ownerMapping = onchainTable(
  "owner_mapping",
  (t) => ({
    address: t.hex().notNull(),             // the proxy or helper contract address (PK part)
    chainId: t.integer().notNull(),         // (PK part)
    eoaOwner: t.hex().notNull(),            // fully resolved EOA (never an intermediate proxy)
    addressType: addressTypeEnum("address_type").notNull(),
    txHash: t.hex().notNull(),              // transaction where this mapping was discovered
    blockNumber: t.bigint().notNull(),
    resolutionDepth: t.integer().notNull(), // hops walked to reach EOA (0 = direct)
  }),
  (table) => ({
    pk: primaryKey({ columns: [table.chainId, table.address] }),
    eoaOwnerIdx: index().on(table.eoaOwner),
  })
);
