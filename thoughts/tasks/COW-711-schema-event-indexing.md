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

- [ ] Define `conditionalOrder` table with all required fields
- [ ] Define enum for order types (TWAP, StopLoss, PerpetualSwap, GoodAfterTime, TradeAboveThreshold)
- [ ] Define `orders` table for discrete orders (orderbook orders)
- [ ] Define relations between tables
- [ ] Implement `ComposableCow:ConditionalOrderCreated` event handler
- [ ] Implement cancellation handler (if cancellation event exists)
- [ ] Compute and store conditional order hash
- [ ] Verify historical backfilling works correctly

## Technical Details

### Schema Design (`schema/tables.ts`)

```typescript
import { onchainTable, onchainEnum, primaryKey, index } from "ponder";

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

export const conditionalOrder = onchainTable(
  "conditional_order",
  (t) => ({
    id: t.text().primaryKey(),          // Event ID
    chainId: t.integer().notNull(),
    owner: t.hex().notNull(),            // Order owner address
    handler: t.hex().notNull(),          // Handler contract address
    salt: t.hex().notNull(),
    staticInput: t.hex().notNull(),      // Raw encoded params
    hash: t.hex().notNull(),             // keccak256(handler, salt, staticInput)
    orderType: orderTypeEnum("order_type").notNull(),
    status: orderStatusEnum("order_status").notNull().default("Active"),
    // Decoded params stored as JSON (type-specific fields added by decoders)
    decodedParams: t.json(),
    // Metadata
    txHash: t.hex().notNull(),
    blockNumber: t.bigint().notNull(),
    blockTimestamp: t.bigint().notNull(),
    createdAt: t.bigint().notNull(),
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
    orderUid: t.text().primaryKey(),     // CoW Protocol order UID
    conditionalOrderId: t.text().notNull(),
    chainId: t.integer().notNull(),
    // Additional fields for M3 (orderbook integration)
  }),
  (table) => ({
    conditionalOrderIdx: index().on(table.conditionalOrderId),
  })
);
```

### Relations (`schema/relations.ts`)

```typescript
import { relations } from "ponder";
import { conditionalOrder, discreteOrder } from "./tables";

export const conditionalOrderRelations = relations(conditionalOrder, ({ many }) => ({
  discreteOrders: many(discreteOrder),
}));

export const discreteOrderRelations = relations(discreteOrder, ({ one }) => ({
  conditionalOrder: one(conditionalOrder, {
    fields: [discreteOrder.conditionalOrderId],
    references: [conditionalOrder.id],
  }),
}));
```

### Event Handler (`src/application/handlers/composable-cow.ts`)

```typescript
import { ponder } from "ponder:registry";
import { conditionalOrder } from "ponder:schema";
import { encodeAbiParameters, keccak256 } from "viem";
import { getOrderTypeFromHandler } from "../utils/order-types";

ponder.on("ComposableCow:ConditionalOrderCreated", async ({ event, context }) => {
  const { owner, params } = event.args;
  const { handler, salt, staticInput } = params;

  // Compute hash (same as PoC)
  const encoded = encodeAbiParameters(
    [{ type: "tuple", components: [
      { name: "handler", type: "address" },
      { name: "salt", type: "bytes32" },
      { name: "staticInput", type: "bytes" },
    ]}],
    [{ handler, salt, staticInput }]
  );
  const hash = keccak256(encoded);

  // Determine order type from handler address
  const orderType = getOrderTypeFromHandler(handler, context.chain.id);

  await context.db.insert(conditionalOrder).values({
    id: event.id,
    chainId: context.chain.id,
    owner,
    handler,
    salt,
    staticInput,
    hash,
    orderType,
    status: "Active",
    decodedParams: null, // Populated by decoder tasks
    txHash: event.transaction.hash,
    blockNumber: event.block.number,
    blockTimestamp: event.block.timestamp,
    createdAt: event.block.timestamp,
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
