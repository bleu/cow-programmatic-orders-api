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
| `/healthz` | GET | Returns `{ "status": "ok" }` when the server is up. Does not reflect indexer sync progress. |

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

Two custom endpoints mounted at `/api`, documented in Swagger UI at `/docs`:

- `GET /api/orders/by-owner/{owner}` — discrete orders for a wallet, with automatic proxy resolution.
- `GET /api/generator/{eventId}/execution-summary` — part-count breakdown by status for a generator.

Open `/docs` for request/response shapes and to try them out.

## Order type decoding

The `decodedParams` JSON field on `conditionalOrderGenerator` has a different shape per order type (TWAP, Stop Loss, Perpetual Swap, Good After Time, Trade Above Threshold). Full breakdown — handler addresses, Solidity structs, and field-by-field decoding — lives in [supported-order-types.md](./supported-order-types.md).

## Indexed chains

| Chain | Chain ID |
|-------|----------|
| Ethereum mainnet | 1 |
| Gnosis Chain | 100 |

Filter queries with `where: { chainId: 1 }` (GraphQL) or `?chainId=1` (REST).
