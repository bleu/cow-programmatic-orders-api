# API Reference

The indexer exposes three ways to query indexed data: a Ponder-generated GraphQL endpoint, a read-only SQL passthrough, and two custom REST endpoints for queries that require cross-table logic.

The default local URL is `http://localhost:42069`.

## Endpoints

| Path | Method | What it is |
|------|--------|------------|
| `/` and `/graphql` | GET, POST | GraphQL endpoint and interactive playground. |
| `/sql/*` | GET | Ponder SQL client — raw read-only SQL over HTTP. See [Ponder SQL docs](https://ponder.sh/docs/query/sql). |
| `/api/*` | GET | Custom REST endpoints. Full reference in Swagger UI at `/docs`. |
| `/docs` | GET | Swagger UI for the REST endpoints. |
| `/openapi.json` | GET | OpenAPI 3.0 spec for the REST endpoints. |
| `/healthz` | GET | Liveness probe. Always returns `200 { "status": "ok" }` if the process is up. |
| `/ready` | GET | Readiness probe. Returns `200` once historical sync is complete; `503` with `{ "message": "Historical indexing is not complete." }` while still backfilling. |
| `/status` | GET | Sync progress per chain. Returns current indexed block, latest chain block, and a completion percentage. Useful for monitoring backfill progress. |
| `/metrics` | GET | Prometheus metrics. Exposes Ponder internals (block lag, handler latency, RPC call counts). |

## GraphQL

Ponder auto-generates the GraphQL schema from the tables in `ponder.schema.ts`. Open `/graphql` (or `/`) in a browser for GraphiQL — every table, field, and query argument is documented inline.

High-level map of what's queryable:

- **`conditionalOrderGenerator`** — one row per programmatic order registered via `ComposableCoW.create()` or `createWithContext()`. Holds decoded params, order type, `owner` (raw on-chain address), `resolvedOwner` (looked up in `ownerMapping` at insert time; falls back to `owner` if no mapping exists yet), and lifecycle status.
- **`discreteOrder`** — individual CoW Protocol orders produced by a generator (a TWAP with 10 parts produces 10 discrete orders). Tracks orderbook status and executed amounts.
- **`candidateDiscreteOrder`** — unconfirmed discrete orders discovered by the block handler, awaiting confirmation against the orderbook API.
- **`transaction`** — block and timestamp metadata for indexed transactions.
- **`ownerMapping`** — proxy/adapter → EOA mappings. Populated from CoWShed factory events and Aave flash loan adapter detection.

For schema details (columns, indexes, relations), see [architecture.md](./architecture.md).

## REST endpoints

Custom endpoints mounted at `/api`, documented in Swagger UI at `/docs`:

- `GET /api/orders/by-owner/{owner}` — discrete orders for a wallet, with automatic proxy resolution.
- `GET /api/generator/{eventId}/execution-summary` — part-count breakdown by status for a generator.
- `GET /api/sync-progress` — per-chain historical sync progress (total blocks, processed blocks, percentage, realtime mode flag).

Open `/docs` for request/response shapes and to try them out.

### `GET /api/sync-progress`

Returns the indexer's historical backfill progress per chain, parsed from Ponder's built-in Prometheus metrics. Useful for monitoring first-run sync without reading raw metrics.

Example response:

```json
{
  "mainnet": {
    "totalBlocks": 7000000,
    "processedBlocks": 3000000,
    "progressPct": 42.9,
    "isRealtime": false,
    "isComplete": false
  },
  "gnosis": {
    "totalBlocks": 17000000,
    "processedBlocks": 17000000,
    "progressPct": 100.0,
    "isRealtime": true,
    "isComplete": true
  }
}
```

- `progressPct` is rounded to one decimal place (0–100).
- `isRealtime` flips to `true` once the chain enters live-sync mode.
- `isComplete` flips to `true` once all historical blocks are processed.
- Returns `{}` if the `/metrics` endpoint is unreachable.

## Order type decoding

The `decodedParams` JSON field on `conditionalOrderGenerator` has a different shape per order type (TWAP, Stop Loss, Perpetual Swap, Good After Time, Trade Above Threshold). Full breakdown — handler addresses, Solidity structs, and field-by-field decoding — lives in [supported-order-types.md](./supported-order-types.md).

## Owner address type

`conditionalOrderGenerator.ownerAddressType` identifies the proxy channel through which the order was created. This is **distinct from `orderType`** (which describes the handler contract logic — TWAP, Stop Loss, etc.).

| Value | Meaning |
|---|---|
| `"flash_loan_helper"` | Order was created through an Aave V3 flash loan adapter. Detected via `FACTORY()` introspection in the settlement handler. |
| `"cowshed_proxy"` | Order was created through a CoWShed smart wallet proxy. |
| `null` | Direct EOA (no proxy), or an Aave adapter whose mapping has not yet been discovered. |

### Late discovery

Aave adapter mappings are written reactively when the adapter first appears in a settlement transaction. If a generator was indexed before its adapter settled a trade, `ownerAddressType` will be `null` until the settlement handler runs and backfills it. Once backfilled, GraphQL filters and REST filters reflect the correct value.

### Filtering examples

**GraphQL**
```graphql
{
  conditionalOrderGenerators(where: { ownerAddressType: { eq: "flash_loan_helper" } }) {
    items { eventId owner orderType ownerAddressType }
  }
}
```

**REST**
```
GET /api/orders/by-owner/0x<address>?ownerAddressType=flash_loan_helper
```

## Timestamp fields

All timestamp-like values in this API are **Unix seconds (UTC)**. No milliseconds, no ISO 8601.

The on-the-wire shape follows the underlying storage type:

- Columns stored as `t.bigint()` are serialized as **decimal strings** — in GraphQL via the `BigInt` scalar, in REST via explicit `.toString()` coercion.
- Columns stored as `t.integer()` are serialized as **JSON numbers** — in GraphQL via the `Int` scalar, in REST passed through directly.

There is one principled exception to "everything as string": `discreteOrder.validTo` and `candidateDiscreteOrder.validTo` are stored as `t.integer()` and exposed as numbers. The CoW protocol's order UID is `abi.encodePacked(orderDigest, owner, uint32(validTo))` (`src/application/helpers/orderUid.ts`), so validity is structurally a `uint32` — a 32-bit integer column matches the protocol and avoids implying more range than exists.

### Field matrix

| Field | Wire shape | Nullable | Meaning |
|---|---|---|---|
| `transaction.blockTimestamp` | string | no | Unix seconds of the block where the transaction was mined. |
| `conditionalOrderGenerator.nextCheckTimestamp` | string | yes | For `PollTryAtEpoch`, the Unix-seconds epoch to wait for before the next poll. |
| `discreteOrder.validTo` | number | yes | Unix seconds when this discrete order expires. `uint32` per CoW protocol. |
| `discreteOrder.creationDate` | string | no | Unix seconds when the discrete order was first observed. Source varies — see the GraphQL field doc. |
| `candidateDiscreteOrder.validTo` | number | yes | Same as `discreteOrder.validTo`. |
| `candidateDiscreteOrder.creationDate` | string | no | Block timestamp at C1 discovery. |
| `candidateDiscreteOrder.possibleValidAfterTimestamp` | string | yes | TWAP only: `t0 + partIndex*t`. Earliest Unix-seconds time the part can be valid. |

### Timestamp-like values inside `decodedParams`

The `conditionalOrderGenerator.decodedParams` JSON encodes Solidity struct fields via `replaceBigInts(_, String)`. Concretely: `uint256` fields arrive as decimal strings, `uint32` fields arrive as numbers. The full per-order-type breakdown is in [supported-order-types.md](./supported-order-types.md). Two consumer-facing pitfalls worth noting here:

- **Absolute timestamps**: TWAP `t0`, Good-After-Time `startTime` / `endTime`. Strings.
- **Durations, not timestamps** — these *look* like timestamps but are seconds-from-some-other-event:
  - StopLoss `validTo` (number) — duration in seconds added to the strike-trigger block time at execution. Reading this as a Unix timestamp gives January 1970.
  - PerpetualSwap and TradeAboveThreshold `validityBucketSeconds` (number) — bucket size.
  - StopLoss `maxTimeSinceLastOracleUpdate` (string) — oracle staleness window.

## Indexed chains

The active chain list is the `SupportedChainId` type and `CHAIN_NAMES` map in `src/data.ts`. Currently:

| Chain | Chain ID |
|-------|----------|
| Ethereum mainnet | 1 |
| Gnosis Chain | 100 |

Filter queries with `where: { chainId: 1 }` (GraphQL) or `?chainId=1` (REST).

> Adding a chain: extend `SupportedChainId`, `CHAIN_NAMES`, and the per-chain config maps in `src/data.ts`. The API schema descriptions derive from `CHAIN_NAMES` automatically.
