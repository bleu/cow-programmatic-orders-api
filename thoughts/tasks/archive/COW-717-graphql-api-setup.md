---
linear_id: COW-717
linear_url: https://linear.app/bleu-builders/issue/COW-717/graphql-api-setup
status: Todo
linear_synced: true
created: 2026-02-27
milestone: M1
sprint: S2
priority: 2
estimate: 1
depends_on: [COW-711]
---

# GraphQL API Setup

## Problem

The indexed Composable CoW data needs to be queryable via GraphQL for frontend integration. The API must support common query patterns: listing orders by owner, filtering by type/chain/status, pagination, and nested queries for related data.

The PoC has basic GraphQL setup, but we need to enhance it with proper filtering and pagination for production use.

## Scope

- [ ] Set up Hono app with Ponder's GraphQL middleware
- [ ] Configure relations for nested GraphQL queries
- [ ] Implement common query patterns:
  - [ ] List all conditional orders (with filters)
  - [ ] Get conditional order by ID or hash
  - [ ] Get all orders for an owner
  - [ ] Filter by order type, chain, status
- [ ] Add pagination support
- [ ] Test queries against indexed data

## Technical Details

### API Setup (`src/api/index.ts`)

```typescript
import { db } from "ponder:api";
import schema from "ponder:schema";
import { Hono } from "hono";
import { client, graphql } from "ponder";

const app = new Hono();

// CORS middleware (if needed for frontend)
app.use("*", async (c, next) => {
  await next();
  c.res.headers.set("Access-Control-Allow-Origin", "*");
  c.res.headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
});

// Ponder's built-in SQL client
app.use("/sql/*", client({ db, schema }));

// GraphQL endpoints
app.use("/", graphql({ db, schema }));
app.use("/graphql", graphql({ db, schema }));

// Health check
app.get("/health", (c) => c.json({ status: "ok" }));

export default app;
```

### GraphQL Query Examples

With Ponder's automatic GraphQL generation from schema:

```graphql
# List conditional orders with filters
query ConditionalOrderGenerators($owner: String, $orderType: String, $chainId: Int) {
  conditionalOrderGenerators(
    where: {
      owner: $owner
      orderType: $orderType
      chainId: $chainId
    }
    orderBy: "createdAt"
    orderDirection: "desc"
    first: 50
  ) {
    items {
      eventId
      chainId
      owner
      handler
      orderType
      status
      decodedParams
      discreteOrders {
        items {
          orderUid
        }
      }
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}

# Get single order by chainId + eventId (composite PK)
query ConditionalOrderGenerator($chainId: Int!, $eventId: String!) {
  conditionalOrderGenerator(chainId: $chainId, eventId: $eventId) {
    eventId
    chainId
    owner
    handler
    salt
    staticInput
    hash
    orderType
    status
    decodedParams
    txHash
    transaction {
      blockNumber
      blockTimestamp
    }
  }
}

# Get orders by hash (for signature matching in M3)
query OrdersByHash($hash: String!) {
  conditionalOrderGenerators(where: { hash: $hash }) {
    items {
      eventId
      owner
      chainId
    }
  }
}
```

### Relations for Nested Queries

Ensure relations are properly defined in `schema/relations.ts` so GraphQL can resolve nested entities:

```typescript
// Already in schema task, but verify:
export const conditionalOrderGeneratorRelations = relations(conditionalOrderGenerator, ({ many }) => ({
  discreteOrders: many(discreteOrder),
}));
```

### Pagination Pattern

Ponder uses cursor-based pagination:

```graphql
query PaginatedOrders($cursor: String) {
  conditionalOrderGenerators(first: 50, after: $cursor) {
    items { ... }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}
```

### Query Patterns for Frontend

| Use Case | Query Pattern |
|----------|---------------|
| User's orders | `conditionalOrderGenerators(where: { owner: $address })` |
| TWAP orders only | `conditionalOrderGenerators(where: { orderType: "TWAP" })` |
| Orders on Gnosis | `conditionalOrderGenerators(where: { chainId: 100 })` |
| Active orders | `conditionalOrderGenerators(where: { status: "Active" })` |
| Order details | `conditionalOrderGenerator(chainId: $chainId, eventId: $eventId)` |

## Acceptance Criteria

- [ ] GraphQL endpoint accessible at `/graphql`
- [ ] Can query conditional orders with filters (owner, type, chain, status)
- [ ] Pagination works correctly
- [ ] Nested queries return related data (discreteOrders)
- [ ] SQL endpoint accessible at `/sql/*` for debugging
- [ ] Health check endpoint returns 200

## Open Questions

- [ ] Do we need custom resolvers beyond Ponder's auto-generated ones?
- [ ] What rate limiting should be applied?
- [ ] Should we add query complexity limits?

## References

- PoC API: `/Users/jefferson/Projects/Bleu/cow/reference_repos/cow-programmatic-orders-indexer/src/api/index.ts`
- Ponder GraphQL docs: https://ponder.sh/docs/api-reference/graphql
- Token Indexer Pattern: `thoughts/reference_docs/token-indexer-overview.md`
- Sprint Plan S2.2: `thoughts/plans/sprint_plan.md`
