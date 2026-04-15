# API Reference

## Endpoints

The API runs on Ponder 0.16.x and exposes three endpoints:

| Path | Method | Description |
|------|--------|-------------|
| `/graphql` | POST | GraphQL endpoint (also serves the playground via GET) |
| `/` | POST | Same GraphQL endpoint, aliased at root |
| `/sql/*` | GET | Ponder SQL client (read-only SQL over HTTP) |
| `/healthz` | GET | Returns `{ "status": "ok" }` |

The default local URL is `http://localhost:42069`.

## Entities

Ponder auto-generates a GraphQL API from the schema. Each table becomes a queryable entity with both singular (by primary key) and plural (with filters, sorting, pagination) access.

### conditionalOrderGenerator

A programmatic order registered on-chain via `ComposableCoW.create()` or `createWithContext()`. Each row represents one conditional order generator that may produce multiple discrete orders over time.

| Field | Type | Description |
|-------|------|-------------|
| `eventId` | `String` | Ponder-assigned event identifier. Part of the composite primary key (with `chainId`). |
| `chainId` | `Int` | Chain where the order was created. `1` = mainnet, `100` = Gnosis. |
| `owner` | `String` | Address that created the order. May be a CoWShed proxy or Aave adapter rather than the EOA. |
| `resolvedOwner` | `String` | The actual EOA behind the order. When the `owner` is a proxy (CoWShed or flash loan adapter), this field resolves through `ownerMapping` to the human. Null transiently if the mapping hasn't been indexed yet. |
| `handler` | `String` | The `IConditionalOrder` handler contract address. Determines the order type. |
| `salt` | `String` | `bytes32` salt used in the order params. |
| `staticInput` | `String` | ABI-encoded handler parameters. The raw input that gets decoded into `decodedParams`. |
| `hash` | `String` | `keccak256(abi.encode(handler, salt, staticInput))`. Uniquely identifies the order params on-chain. |
| `orderType` | `String` | One of: `TWAP`, `StopLoss`, `PerpetualSwap`, `GoodAfterTime`, `TradeAboveThreshold`, `Unknown`. Derived from the handler address. |
| `status` | `String` | `Active` or `Cancelled`. Orders start as Active and move to Cancelled when removed from the ComposableCoW contract. |
| `decodedParams` | `JSON` | Decoded `staticInput` as a JSON object with human-readable fields. Null if the order type is `Unknown` or decoding failed. The shape depends on `orderType` (see [Decoded Params by Order Type](#decoded-params-by-order-type)). |
| `decodeError` | `String` | `"invalid_static_input"` if decoding failed, otherwise null. |
| `txHash` | `String` | Transaction hash where this order was created. |

Relations:
- `transaction` -- the transaction that created this order
- `discreteOrders` -- individual CoW Protocol orders produced by this generator

### discreteOrder

An individual CoW Protocol order produced by a conditional order generator. These are the actual orders submitted to the CoW Protocol orderbook.

| Field | Type | Description |
|-------|------|-------------|
| `orderUid` | `String` | The CoW Protocol order UID. Part of the composite primary key (with `chainId`). |
| `chainId` | `Int` | Chain ID. |
| `conditionalOrderGeneratorId` | `String` | References the parent generator's `eventId`. |

Relations:
- `conditionalOrderGenerator` -- the generator that produced this order

### transaction

Block and timestamp metadata for indexed transactions.

| Field | Type | Description |
|-------|------|-------------|
| `hash` | `String` | Transaction hash. Part of the composite primary key (with `chainId`). |
| `chainId` | `Int` | Chain ID. |
| `blockNumber` | `BigInt` | Block number. |
| `blockTimestamp` | `BigInt` | Unix timestamp of the block. |

Relations:
- `conditionalOrderGenerators` -- orders created in this transaction

### ownerMapping

Maps proxy/adapter contract addresses to their underlying EOA. Used to resolve `resolvedOwner` on conditional order generators.

| Field | Type | Description |
|-------|------|-------------|
| `address` | `String` | The proxy or adapter contract address. Part of the composite primary key (with `chainId`). |
| `chainId` | `Int` | Chain ID. |
| `owner` | `String` | The resolved EOA address. |
| `addressType` | `String` | `cowshed_proxy` or `flash_loan_helper`. |
| `txHash` | `String` | Transaction where this mapping was discovered. |
| `blockNumber` | `BigInt` | Block number of discovery. |
| `resolutionDepth` | `Int` | Number of hops to reach the EOA. 0 for direct CoWShed mappings, 1 for Aave adapters. |

## Decoded Params by Order Type

The `decodedParams` JSON field on `conditionalOrderGenerator` contains different fields depending on the `orderType`. All `bigint` values are serialized as strings in the JSON.

### TWAP

```json
{
  "sellToken": "0x...",
  "buyToken": "0x...",
  "receiver": "0x...",
  "partSellAmount": "1000000000000000000",
  "minPartLimit": "950000000000000000",
  "t0": "1700000000",
  "n": "10",
  "t": "3600",
  "span": "0",
  "appData": "0x..."
}
```

- `t0`: start epoch. `"0"` means "start when mined".
- `n`: number of parts (sub-orders) the TWAP is split into.
- `t`: seconds between each part.
- `span`: how long each part stays valid. `"0"` means it fills the entire interval.
- Total sell: `partSellAmount * n`. Total duration: `n * t` seconds.

### StopLoss

```json
{
  "sellToken": "0x...",
  "buyToken": "0x...",
  "sellAmount": "5000000000000000000",
  "buyAmount": "4500000000000000000",
  "appData": "0x...",
  "receiver": "0x...",
  "isSellOrder": true,
  "isPartiallyFillable": false,
  "validTo": 3600,
  "sellTokenPriceOracle": "0x...",
  "buyTokenPriceOracle": "0x...",
  "strike": "-500000000000000000",
  "maxTimeSinceLastOracleUpdate": "86400"
}
```

- `strike`: signed int256 trigger price. Can be negative.
- `validTo`: order validity in seconds (uint32).
- Oracle addresses point to Chainlink aggregators.

### PerpetualSwap

```json
{
  "tokenA": "0x...",
  "tokenB": "0x...",
  "validityBucketSeconds": 300,
  "halfSpreadBps": "50",
  "appData": "0x..."
}
```

- `halfSpreadBps`: half the bid-ask spread, in basis points.
- `validityBucketSeconds`: time bucketing for order validity.

### GoodAfterTime

```json
{
  "sellToken": "0x...",
  "buyToken": "0x...",
  "receiver": "0x...",
  "sellAmount": "1000000000000000000",
  "minSellBalance": "500000000000000000",
  "startTime": "1700000000",
  "endTime": "1700100000",
  "allowPartialFill": true,
  "priceCheckerPayload": "0x...",
  "appData": "0x..."
}
```

- `startTime` / `endTime`: Unix timestamps defining the validity window.
- `priceCheckerPayload`: opaque bytes, specific to the price checker contract.

### TradeAboveThreshold

```json
{
  "sellToken": "0x...",
  "buyToken": "0x...",
  "receiver": "0x...",
  "validityBucketSeconds": 300,
  "threshold": "1000000000000000000",
  "appData": "0x..."
}
```

- `threshold`: minimum token balance to trigger a trade.

## Filtering

Ponder GraphQL supports filters on each field via a `where` argument. Available operators:

| Operator | Description | Example |
|----------|-------------|---------|
| (none) | Equals | `where: { status: "Active" }` |
| `_not` | Not equal | `where: { status_not: "Cancelled" }` |
| `_in` | In list | `where: { orderType_in: ["TWAP", "StopLoss"] }` |
| `_not_in` | Not in list | `where: { orderType_not_in: ["Unknown"] }` |
| `_gt` | Greater than | `where: { chainId_gt: 1 }` |
| `_gte` | Greater than or equal | |
| `_lt` | Less than | |
| `_lte` | Less than or equal | |
| `_contains` | String contains | `where: { owner_contains: "a1b2" }` |
| `_starts_with` | String starts with | |
| `_ends_with` | String ends with | |

Multiple filters in the same `where` object are combined with AND.

## Sorting

Use `orderBy` and `orderDirection` on plural queries:

```graphql
{
  conditionalOrderGenerators(
    orderBy: "eventId"
    orderDirection: "desc"
  ) {
    items { eventId orderType }
  }
}
```

## Pagination

Ponder supports both cursor-based and limit/offset pagination.

### Cursor-based (recommended for large datasets)

```graphql
{
  conditionalOrderGenerators(limit: 20) {
    items { eventId orderType owner }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}
```

To get the next page, pass the `endCursor` value as `after`:

```graphql
{
  conditionalOrderGenerators(limit: 20, after: "eyJldmVudElkIj...") {
    items { eventId orderType owner }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}
```

### Limit/offset

Works for smaller result sets where you need a specific page:

```graphql
{
  conditionalOrderGenerators(limit: 10, offset: 30) {
    items { eventId orderType }
  }
}
```

The maximum `limit` is 1000.

## Example Queries

### Fetch active TWAP orders with decoded params

```graphql
{
  conditionalOrderGenerators(
    where: { orderType: "TWAP", status: "Active" }
    limit: 10
  ) {
    items {
      eventId
      chainId
      owner
      resolvedOwner
      handler
      hash
      status
      decodedParams
      transaction {
        blockNumber
        blockTimestamp
      }
    }
  }
}
```

### Get all orders for a specific owner

```graphql
{
  conditionalOrderGenerators(
    where: { resolvedOwner: "0x1234...abcd" }
  ) {
    items {
      eventId
      orderType
      status
      decodedParams
      discreteOrders {
        items {
          orderUid
        }
      }
    }
  }
}
```

### List discrete orders for a generator

```graphql
{
  discreteOrders(
    where: { conditionalOrderGeneratorId: "some-event-id" }
  ) {
    items {
      orderUid
      conditionalOrderGenerator {
        orderType
        status
        decodedParams
      }
    }
  }
}
```

### Look up owner mappings (proxy resolution)

```graphql
{
  ownerMappings(
    where: { owner: "0x1234...abcd" }
  ) {
    items {
      address
      addressType
      chainId
      resolutionDepth
    }
  }
}
```

## SQL Endpoint

The `/sql/*` path exposes Ponder's SQL client, which provides read-only SQL access over HTTP. This is useful for ad-hoc queries, analytics, or cases where GraphQL filters aren't flexible enough.

See the [Ponder SQL client documentation](https://ponder.sh/docs/query/sql) for query syntax and available operations. The SQL client operates on the same tables described above, using their snake_case database names: `conditional_order_generator`, `discrete_order`, `transaction`, `owner_mapping`.

## Error Handling

The GraphQL endpoint returns standard GraphQL error responses:

```json
{
  "errors": [
    {
      "message": "Unknown field 'nonexistent' on type 'ConditionalOrderGenerator'",
      "locations": [{ "line": 3, "column": 5 }]
    }
  ]
}
```

The `/healthz` endpoint returns `200 OK` with `{ "status": "ok" }` when the server is running. This does not indicate indexing progress -- a freshly started instance will respond healthy before it has finished syncing historical blocks.
