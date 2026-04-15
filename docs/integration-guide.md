# Integration Guide

Practical patterns for querying the Composable CoW programmatic orders API. Each section is self-contained with a query you can copy-paste and notes on what to expect.

The API base URL depends on your deployment. Locally it's `http://localhost:42069`. All queries go to the `/graphql` endpoint via POST.

## List all orders for an owner

Users interact with CoW Protocol through proxy contracts (CoWShed proxies, Aave flash loan adapters). The `owner` field on a conditional order generator may be one of these intermediary addresses, not the user's actual wallet.

The `resolvedOwner` field handles this. It follows proxy chains back to the EOA, so you can query by the user's wallet address regardless of how they created the order.

```graphql
{
  conditionalOrderGenerators(
    where: { resolvedOwner: "0xd8da6bf26964af9d7eed9e03e53415d37aa96045" }
    limit: 50
  ) {
    items {
      eventId
      chainId
      orderType
      status
      owner
      resolvedOwner
      decodedParams
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}
```

If `resolvedOwner` is null for some records (the proxy mapping hasn't been indexed yet), you can also search by `owner` directly. To find all proxy addresses associated with a wallet, query `ownerMappings`:

```graphql
{
  ownerMappings(where: { owner: "0xd8da6bf26964af9d7eed9e03e53415d37aa96045" }) {
    items {
      address
      addressType
      chainId
    }
  }
}
```

## Track TWAP progress

A TWAP order splits a large trade into `n` parts executed over time. To see how far along a TWAP is, fetch the generator and its discrete orders:

```graphql
{
  conditionalOrderGenerators(
    where: { orderType: "TWAP", status: "Active" }
    limit: 20
  ) {
    items {
      eventId
      decodedParams
      discreteOrders {
        items {
          orderUid
          status
          partIndex
          sellAmount
          buyAmount
          validTo
        }
      }
    }
  }
}
```

The `decodedParams.n` field tells you how many parts the TWAP has in total. Each discrete order has a `partIndex` and a `status`. Count `fulfilled` parts to see how many have been filled. You can also use the REST endpoint for a quick summary:

```
GET /api/generator/<eventId>/execution-summary?chainId=1
```

This returns `{ totalParts, filledParts, openParts, unfilledParts, expiredParts, cancelledParts }`.

You can also compute timing from the decoded params:

```typescript
const params = generator.decodedParams;
const startTime = BigInt(params.t0);
const interval = BigInt(params.t);
const numParts = BigInt(params.n);
const endTime = startTime + (numParts * interval);
const now = BigInt(Math.floor(Date.now() / 1000));

// When t0 is 0, the TWAP started at mining time (check transaction.blockTimestamp)
const progress = startTime === 0n
  ? "check blockTimestamp for actual start"
  : `${Number((now - startTime) * 100n / (endTime - startTime))}%`;
```

## Check if an order is active, expired, or cancelled

The `status` field on a generator tracks its lifecycle:

- `Active` -- the order is registered in the ComposableCoW contract and can still produce discrete orders.
- `Cancelled` -- the order has been removed from the contract (via `remove()` or `SingleOrderNotAuthed` during polling).
- `Completed` -- all discrete orders are known and the generator has nothing left to produce (e.g. a fully-resolved TWAP, or a `PollNever` response from the contract).

```graphql
{
  conditionalOrderGenerators(
    where: { hash: "0xabc123..." }
  ) {
    items {
      status
      orderType
      decodedParams
    }
  }
}
```

Discrete orders have their own status (`open`, `fulfilled`, `unfilled`, `expired`, `cancelled`) tracked via the orderbook API. A generator can be `Active` while its discrete orders are already `fulfilled`.

To check if a time-bound order has effectively expired, compare the current time against the decoded params:

- TWAP: expired when `now > t0 + (n * t)` (if `t0 > 0`)
- StopLoss: check `validTo`
- GoodAfterTime: check `endTime`

## Look up orders by handler/type

Filter by `orderType` to get all orders of a specific kind:

```graphql
{
  conditionalOrderGenerators(
    where: { orderType: "StopLoss" }
    limit: 50
  ) {
    items {
      eventId
      owner
      resolvedOwner
      status
      decodedParams
      chainId
    }
  }
}
```

You can also filter by multiple types:

```graphql
{
  conditionalOrderGenerators(
    where: { orderType_in: ["TWAP", "GoodAfterTime"] }
  ) {
    items {
      eventId
      orderType
      status
    }
  }
}
```

If you need to filter by the raw handler address instead (e.g., for a handler not yet recognized by the indexer), use the `handler` field:

```graphql
{
  conditionalOrderGenerators(
    where: { handler: "0x6cf1e9ca41f7611def408122793c358a3d11e5a5" }
  ) {
    items {
      eventId
      orderType
    }
  }
}
```

Known handler addresses (same on all chains):

| Order Type | Handler Address |
|------------|----------------|
| TWAP | `0x6cF1e9cA41f7611dEf408122793c358a3d11E5a5` |
| StopLoss | `0x412c36e5011cd2517016d243a2dfb37f73a242e7` |
| PerpetualSwap | `0x519BA24e959E33b3B6220CA98bd353d8c2D89920` |
| GoodAfterTime | `0xdaf33924925e03c9cc3a10d434016d6cfad0add5` |
| TradeAboveThreshold | `0x812308712a6d1367f437e1c1e4af85c854e1e9f6` |

## Find discrete orders for a generator

Each conditional order generator can produce multiple discrete orders (the actual CoW Protocol orders placed in the orderbook). Fetch them via the relation:

```graphql
{
  conditionalOrderGenerators(
    where: { eventId: "some-event-id", chainId: 1 }
  ) {
    items {
      orderType
      decodedParams
      discreteOrders {
        items {
          orderUid
          status
          partIndex
          sellAmount
          buyAmount
          validTo
        }
      }
    }
  }
}
```

Or query discrete orders directly and filter by status:

```graphql
{
  discreteOrders(
    where: { conditionalOrderGeneratorId: "some-event-id", status: "fulfilled" }
    limit: 100
  ) {
    items {
      orderUid
      status
      sellAmount
      buyAmount
      validTo
      conditionalOrderGenerator {
        orderType
        owner
        resolvedOwner
      }
    }
  }
}
```

For owner-based lookups with proxy resolution, the REST endpoint is simpler:

```
GET /api/orders/by-owner/0x1234...abcd?chainId=1&status=open
```

## Pagination for large result sets

The API caps results at 1000 per request. For larger datasets, use cursor-based pagination.

First request:

```graphql
{
  conditionalOrderGenerators(limit: 100) {
    items {
      eventId
      orderType
      status
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}
```

Subsequent requests pass the cursor:

```graphql
{
  conditionalOrderGenerators(limit: 100, after: "eyJldmVudElkIj...") {
    items {
      eventId
      orderType
      status
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}
```

Keep fetching while `hasNextPage` is `true`.

## TypeScript examples

### Using fetch

```typescript
const API_URL = "http://localhost:42069/graphql";

async function queryAPI(query: string, variables?: Record<string, unknown>) {
  const response = await fetch(API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const json = await response.json();
  if (json.errors) {
    throw new Error(json.errors.map((e: { message: string }) => e.message).join(", "));
  }
  return json.data;
}

// Fetch all active TWAP orders for a wallet
const data = await queryAPI(`
  query ActiveTwaps($owner: String!) {
    conditionalOrderGenerators(
      where: { resolvedOwner: $owner, orderType: "TWAP", status: "Active" }
    ) {
      items {
        eventId
        decodedParams
        discreteOrders {
          items { orderUid }
        }
      }
    }
  }
`, { owner: "0xd8da6bf26964af9d7eed9e03e53415d37aa96045" });

for (const gen of data.conditionalOrderGenerators.items) {
  const params = gen.decodedParams;
  const filledParts = gen.discreteOrders.items.length;
  const totalParts = Number(params.n);
  console.log(`TWAP ${gen.eventId}: ${filledParts}/${totalParts} parts`);
}
```

### Using graphql-request

```typescript
import { gql, GraphQLClient } from "graphql-request";

const client = new GraphQLClient("http://localhost:42069/graphql");

const query = gql`
  query OrdersByOwner($owner: String!) {
    conditionalOrderGenerators(
      where: { resolvedOwner: $owner }
      limit: 50
    ) {
      items {
        eventId
        orderType
        status
        chainId
        decodedParams
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

const data = await client.request(query, {
  owner: "0xd8da6bf26964af9d7eed9e03e53415d37aa96045",
});
```

### Paginating through all results

```typescript
async function fetchAllGenerators(owner: string) {
  const results = [];
  let cursor: string | undefined;

  while (true) {
    const data = await queryAPI(`
      query($owner: String!, $after: String) {
        conditionalOrderGenerators(
          where: { resolvedOwner: $owner }
          limit: 200
          after: $after
        ) {
          items {
            eventId
            orderType
            status
            decodedParams
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
    `, { owner, after: cursor });

    const page = data.conditionalOrderGenerators;
    results.push(...page.items);

    if (!page.pageInfo.hasNextPage) break;
    cursor = page.pageInfo.endCursor;
  }

  return results;
}
```

## Indexed chains

| Chain | Chain ID |
|-------|----------|
| Ethereum mainnet | 1 |
| Gnosis Chain | 100 |

Filter by `chainId` to scope queries to a specific chain:

```graphql
{
  conditionalOrderGenerators(
    where: { chainId: 1, status: "Active" }
  ) {
    items { eventId orderType }
  }
}
```
