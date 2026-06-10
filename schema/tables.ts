import { index, onchainEnum, onchainTable, primaryKey } from "ponder";

// ── Enums ────────────────────────────────────────────────────────────────────

export const orderTypeEnum = onchainEnum("order_type", [
  "TWAP",
  "StopLoss",
  "PerpetualSwap",
  "GoodAfterTime",
  "TradeAboveThreshold",
  "CirclesBackingOrder",
  "SwapOrderHandler",
  "ERC4626CowSwapFeeBurner",
  "CurveCowSwapBurner",
  "BalancerCowSwapFeeBurner",
  "CowAmmConstantProduct",
  "Unknown",
]);

export const orderStatusEnum = onchainEnum("order_status", [
  "Active",
  "Cancelled",
  "Completed",
]);

export const addressTypeEnum = onchainEnum("address_type", [
  "cowshed_proxy",
  "flash_loan_helper",
]);

export const AddressType = {
  CowshedProxy: "cowshed_proxy",
  FlashLoanHelper: "flash_loan_helper",
} as const;

export const discreteOrderStatusEnum = onchainEnum("discrete_order_status", [
  "open",
  "fulfilled",
  "unfilled",
  "expired",
  "cancelled",
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
    resolvedOwner: t.hex(),                 // mapped EOA at insert time; falls back to owner if no mapping exists yet
    ownerAddressType: addressTypeEnum("owner_address_type"), // null = direct EOA or Aave adapter not yet discovered
    handler: t.hex().notNull(),             // IConditionalOrder handler address
    salt: t.hex().notNull(),                // bytes32
    staticInput: t.hex().notNull(),         // encoded handler params
    hash: t.hex().notNull(),               // keccak256(abi.encode(params))
    orderType: orderTypeEnum("order_type").notNull(),
    status: orderStatusEnum("order_status").notNull().default("Active"),
    decodedParams: t.json(),               // null if unknown type or decode failed
    decodeError: t.text(),                 // "invalid_static_input" | null
    txHash: t.hex().notNull(),             // FK → transaction.hash
    allCandidatesKnown: t.boolean().notNull().default(false),
    nextCheckBlock: t.bigint(),            // block handler scheduling
    lastCheckBlock: t.bigint(),
    lastPollResult: t.text(),
    nextCheckTimestamp: t.bigint(),        // for PollTryAtEpoch — store epoch directly
    consecutiveTryNextBlock: t.integer().notNull().default(0),  // Backoff counter for stuck generators
  }),
  (table) => ({
    pk: primaryKey({ columns: [table.chainId, table.eventId] }),
    ownerIdx: index().on(table.owner),
    handlerIdx: index().on(table.handler),
    hashIdx: index().on(table.hash),
    chainOwnerIdx: index().on(table.chainId, table.owner),
    resolvedOwnerIdx: index().on(table.resolvedOwner),
    ownerAddressTypeIdx: index().on(table.ownerAddressType),
    // C1 (OrderDiscoveryPoller) + C5 (CancellationWatcher): per-block SELECT with
    // chainId + status + allCandidatesKnown equality filters, ORDER BY lastCheckBlock.
    // Covers both handlers — C1 queries allCandidatesKnown=false, C5 queries true.
    c1c5PollIdx: index("generator_c1c5_poll_idx")
      .on(table.chainId, table.status, table.allCandidatesKnown, table.lastCheckBlock),
  })
);

export const discreteOrder = onchainTable(
  "discrete_order",
  (t) => ({
    orderUid: t.text().notNull(),
    chainId: t.integer().notNull(),
    conditionalOrderGeneratorId: t.text().notNull(),  // references eventId
    status: discreteOrderStatusEnum("status").notNull(),
    sellAmount: t.text().notNull(),                   // uint256 as decimal string
    buyAmount: t.text().notNull(),
    feeAmount: t.text().notNull(),
    validTo: t.integer(),                             // uint32 Unix timestamp — from API or getTradeableOrderWithSignature
    creationDate: t.bigint().notNull(),               // block timestamp (seconds)
    executedSellAmount: t.text(),                     // actual executed amount (from API, post-settlement)
    executedBuyAmount: t.text(),                      // actual executed amount (from API, post-settlement)
    promotedAt: t.bigint(),                           // block timestamp when C2 promoted from candidate; null = created directly (precompute or C4)
  }),
  (table) => ({
    pk: primaryKey({ columns: [table.chainId, table.orderUid] }),
    generatorIdx: index("discrete_order_generator_idx")
      .on(table.chainId, table.conditionalOrderGeneratorId),
    // C3 (OrderStatusTracker): per-block SELECT with chainId + status='open', ORDER BY promotedAt.
    c3StatusIdx: index("discrete_order_c3_status_idx")
      .on(table.chainId, table.status, table.promotedAt),
  })
);

export const candidateDiscreteOrder = onchainTable(
  "candidate_discrete_order",
  (t) => ({
    orderUid: t.text().notNull(),
    chainId: t.integer().notNull(),
    conditionalOrderGeneratorId: t.text().notNull(),
    sellAmount: t.text().notNull(),
    buyAmount: t.text().notNull(),
    feeAmount: t.text().notNull(),
    validTo: t.integer(),
    creationDate: t.bigint().notNull(),
    possibleValidAfterTimestamp: t.bigint(),   // TWAP: t0 + partIndex * t — skip API calls before this
  }),
  (table) => ({
    pk: primaryKey({ columns: [table.chainId, table.orderUid] }),
    generatorIdx: index("candidate_discrete_order_generator_idx")
      .on(table.chainId, table.conditionalOrderGeneratorId),
    // C2 stale sweep: SELECT WHERE chainId + validTo <= timestamp LIMIT 500.
    staleIdx: index("candidate_discrete_order_stale_idx")
      .on(table.chainId, table.validTo),
  })
);

export const bootstrapRetryQueue = onchainTable(
  "bootstrap_retry_queue",
  (t) => ({
    owner: t.hex().notNull(),
    chainId: t.integer().notNull(),
    firstTimeoutAt: t.bigint().notNull(),   // block number of first timeout
    retryCount: t.integer().notNull().default(1),
    lastRetryAt: t.bigint().notNull(),      // block number of most recent attempt
  }),
  (table) => ({
    pk: primaryKey({ columns: [table.chainId, table.owner] }),
  })
);

export const settlementQueue = onchainTable(
  "settlement_queue",
  (t) => ({
    txHash: t.hex().notNull(),
    chainId: t.integer().notNull(),
    blockNumber: t.bigint().notNull(),
    blockTimestamp: t.bigint().notNull(),
  }),
  (table) => ({
    pk: primaryKey({ columns: [table.chainId, table.txHash] }),
  })
);

export const ownerMapping = onchainTable(
  "owner_mapping",
  (t) => ({
    address: t.hex().notNull(),             // the proxy or helper contract address (PK part)
    chainId: t.integer().notNull(),         // (PK part)
    owner: t.hex().notNull(),               // fully resolved owner (never an intermediate proxy)
    addressType: addressTypeEnum("address_type").notNull(),
    txHash: t.hex().notNull(),              // transaction where this mapping was discovered
    blockNumber: t.bigint().notNull(),
    resolutionDepth: t.integer().notNull(), // hops walked to reach EOA (0 = direct)
  }),
  (table) => ({
    pk: primaryKey({ columns: [table.chainId, table.address] }),
    ownerIdx: index().on(table.owner),
  })
);
