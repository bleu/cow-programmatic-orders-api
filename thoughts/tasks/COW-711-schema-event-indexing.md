---
linear_id: COW-711
linear_url: https://linear.app/bleu-builders/issue/COW-711/schema-design-and-conditionalordercreated-event-indexing
status: Todo
linear_synced: true
created: 2026-02-27
milestone: M1
sprint: S1
priority: 2
estimate: 2
depends_on: [COW-709, COW-710]
---

# Schema Design & ConditionalOrderCreated Event Indexing

## Problem

To track Composable CoW orders, we need a well-designed database schema and event handlers that capture all relevant data. The schema must support:
- All 5 order types with their decoded parameters
- Order lifecycle (created, cancelled)
- Multi-chain indexing
- Future extensibility for orderbook matching (M3)

The PoC has a basic schema but lacks order type classification, decoded parameters, and cancellation handling.

## Scope

- [ ] Define `conditionalOrderGenerator` table with all required fields
- [ ] Define `transaction` table for tx metadata (blockNumber, blockTimestamp, hash)
- [ ] Define enum for order types (TWAP, StopLoss, PerpetualSwap, GoodAfterTime, TradeAboveThreshold)
- [ ] Define `discreteOrder` table for discrete orders (orderbook orders)
- [ ] Define relations between tables
- [ ] Implement `ComposableCow:ConditionalOrderCreated` event handler
- [ ] Implement cancellation handler (if cancellation event exists)
- [ ] Compute and store conditional order hash
- [ ] Verify historical backfilling works correctly

## Technical Details

### Schema Design (`schema/tables.ts`)

```typescript
import { index, onchainEnum, onchainTable, primaryKey } from "ponder";

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
    owner: t.hex().notNull(),
    handler: t.hex().notNull(),
    salt: t.hex().notNull(),
    staticInput: t.hex().notNull(),
    hash: t.hex().notNull(),
    orderType: orderTypeEnum("order_type").notNull(),
    status: orderStatusEnum("order_status").notNull().default("Active"),
    decodedParams: t.json(),
    txHash: t.hex().notNull(),              // FK → transaction.hash
  }),
  (table) => ({
    pk: primaryKey({ columns: [table.chainId, table.eventId] }),
    ownerIdx: index().on(table.owner),
    handlerIdx: index().on(table.handler),
    hashIdx: index().on(table.hash),
    chainOwnerIdx: index().on(table.chainId, table.owner),
  })
);

export const discreteOrder = onchainTable(
  "discrete_order",
  (t) => ({
    orderUid: t.text().notNull(),
    chainId: t.integer().notNull(),
    conditionalOrderGeneratorId: t.text().notNull(),
  }),
  (table) => ({
    pk: primaryKey({ columns: [table.chainId, table.orderUid] }),
    generatorIdx: index().on(table.conditionalOrderGeneratorId),
  })
);
```

### Relations (`schema/relations.ts`)

```typescript
import { relations } from "ponder";
import { conditionalOrderGenerator, discreteOrder, transaction } from "./tables";

export const transactionRelations = relations(transaction, ({ many }) => ({
  conditionalOrderGenerators: many(conditionalOrderGenerator),
}));

export const conditionalOrderGeneratorRelations = relations(
  conditionalOrderGenerator,
  ({ one, many }) => ({
    transaction: one(transaction, {
      fields: [conditionalOrderGenerator.chainId, conditionalOrderGenerator.txHash],
      references: [transaction.chainId, transaction.hash],
    }),
    discreteOrders: many(discreteOrder),
  })
);

export const discreteOrderRelations = relations(discreteOrder, ({ one }) => ({
  conditionalOrderGenerator: one(conditionalOrderGenerator, {
    fields: [discreteOrder.chainId, discreteOrder.conditionalOrderGeneratorId],
    references: [conditionalOrderGenerator.chainId, conditionalOrderGenerator.eventId],
  }),
}));
```

### Event Handler (`src/application/handlers/composable-cow.ts`)

```typescript
import { ponder } from "ponder:registry";
import { conditionalOrderGenerator, transaction } from "ponder:schema";
import { encodeAbiParameters, keccak256 } from "viem";
import { getOrderTypeFromHandler } from "../utils/order-types";

ponder.on("ComposableCow:ConditionalOrderCreated", async ({ event, context }) => {
  const { owner, params } = event.args;
  const { handler, salt, staticInput } = params;

  const encoded = encodeAbiParameters(
    [{ type: "tuple", components: [
      { name: "handler", type: "address" },
      { name: "salt", type: "bytes32" },
      { name: "staticInput", type: "bytes" },
    ]}],
    [{ handler, salt, staticInput }]
  );
  const hash = keccak256(encoded);
  const orderType = getOrderTypeFromHandler(handler, context.chain.id);

  // Upsert transaction row first (idempotent)
  await context.db.insert(transaction).values({
    hash: event.transaction.hash,
    chainId: context.chain.id,
    blockNumber: event.block.number,
    blockTimestamp: event.block.timestamp,
  }).onConflictDoNothing();

  await context.db.insert(conditionalOrderGenerator).values({
    eventId: event.id,
    chainId: context.chain.id,
    owner: owner.toLowerCase() as `0x${string}`,
    handler: handler.toLowerCase() as `0x${string}`,
    salt,
    staticInput,
    hash,
    orderType,
    status: "Active",
    decodedParams: null,
    txHash: event.transaction.hash,
  }).onConflictDoNothing();
});
```

### Handler → Order Type Mapping

```typescript
// src/utils/order-types.ts
const HANDLER_MAP: Record<number, Record<string, string>> = {
  1: { // Mainnet
    "0x...": "TWAP",
    "0x519ba24e959e33b3b6220ca98bd353d8c2d89920": "PerpetualSwap",
    // ... other handlers
  },
  100: { /* Gnosis */ },
  42161: { /* Arbitrum */ },
};

export function getOrderTypeFromHandler(handler: string, chainId: number): string {
  return HANDLER_MAP[chainId]?.[handler.toLowerCase()] ?? "Unknown";
}
```

### Cancellation Handling

Research needed: Does ComposableCoW emit a cancellation event?
- Check for `ConditionalOrderCancelled` event or similar
- Alternative: `remove(bytes32 singleOrderHash)` function call (may need call traces)

## Acceptance Criteria

- [ ] Schema compiles without errors (`pnpm codegen`)
- [ ] `ConditionalOrderCreated` handler stores all events
- [ ] Hash computation matches PoC implementation
- [ ] Order type correctly identified from handler address
- [ ] Historical events indexed (verify with known data)
- [ ] Real-time events captured (test with new order if possible)
- [ ] Indexes created for common query patterns

## Open Questions

- [ ] Is there a `ConditionalOrderCancelled` event or do we need call traces?
- [ ] Should decoded params be stored as JSON or separate type-specific tables?
- [ ] What fields are needed for M3 orderbook integration?

## References

- PoC Schema: `/Users/jefferson/Projects/Bleu/cow/reference_repos/cow-programmatic-orders-indexer/ponder.schema.ts`
- PoC Handler: `/Users/jefferson/Projects/Bleu/cow/reference_repos/cow-programmatic-orders-indexer/src/index.ts`
- Token Indexer Schema Pattern: `thoughts/reference_docs/token-indexer-overview.md`
- Sprint Plan S1.3: `thoughts/plans/sprint_plan.md`
