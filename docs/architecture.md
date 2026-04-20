# System Architecture

This document covers how the indexer works, from on-chain events to the GraphQL API. It's meant for developers who will maintain and extend this codebase.

## Overview

The system is a Ponder 0.16.x indexer that watches the ComposableCoW contract on Ethereum mainnet and Gnosis Chain. When a user creates a programmatic order (TWAP, Stop Loss, etc.), the contract emits a `ConditionalOrderCreated` event. The indexer picks that up, decodes the order parameters, resolves the actual owner (which may be behind a proxy), and writes the result to Postgres. A Hono HTTP server exposes the data through GraphQL and a SQL passthrough endpoint.

There are seven handlers total: three event handlers and four live-only block handlers. The event handlers react to on-chain events in real time. The block handlers (C1–C4) poll contract state and the orderbook API during live sync. The settlement handler detects flash loan adapter contracts through Trade logs.

## Contracts and Chains

Configuration lives in `src/data.ts`. The ComposableCoW contract is deployed at the same CREATE2 address on every chain (`0xfdaFc9d1902f4e0b84f65F49f244b32b31013b74`), so `data.ts` only needs to specify the start block per chain.

Currently indexed:

- **Mainnet** (chain ID 1) -- ComposableCoW from block 17883049, CoWShedFactory from block 22939254, GPv2Settlement from block 23812751
- **Gnosis** (chain ID 100) -- ComposableCoW from block 29389123, CoWShedFactory from block 41469991

Arbitrum is stubbed out but not yet active.

`ponder.config.ts` imports everything from `data.ts` and wires it into Ponder's `createConfig`. It never contains raw addresses or block numbers directly. The config also sets up four live-only block handlers — C1 (`ContractPoller`), C2 (`CandidateConfirmer`), C3 (`StatusUpdater`), C4 (`HistoricalBootstrap`) — all running every block during live sync.

Three contracts are indexed:

1. **ComposableCow** -- the main contract. Emits `ConditionalOrderCreated` for new programmatic orders.
2. **CoWShedFactory** -- emits `COWShedBuilt` when a user deploys a CoWShed proxy wallet. On Gnosis there are two factory addresses (the current `CoWShedForComposableCoW` factory and a legacy `COWShed` factory), both indexed through a single Ponder contract entry using an address array.
3. **GPv2Settlement** -- the CoW Protocol settlement contract. Filtered to only `Settlement` events where the solver is the FlashLoanRouter address, so the volume is very low.

## Data Flow

```
ComposableCoW contract (mainnet + gnosis)
    |
    |  ConditionalOrderCreated events
    v
composableCow.ts handler
    |  - compute params hash (keccak256 of ABI-encoded handler/salt/staticInput)
    |  - look up owner in ownerMapping table (CoWShed proxy resolution)
    |  - identify order type from handler address
    |  - decode staticInput into structured params
    |  - write transaction + conditionalOrderGenerator rows
    v
CoWShedFactory contract
    |
    |  COWShedBuilt events
    v
cowshed.ts handler
    |  - write ownerMapping: shed address -> user EOA
    v
GPv2Settlement contract (FlashLoanRouter settlements only)
    |
    |  Settlement events
    v
settlement.ts handler
    |  - fetch transaction receipt, scan Trade logs
    |  - for each trade owner: check if it's an Aave adapter (FACTORY() call)
    |  - if yes: resolve EOA via owner(), write ownerMapping
    v
blockHandler.ts (four live-only block handlers)
    |  C1 (ContractPoller)      — multicall getTradeableOrderWithSignature for Active generators
    |                              detects cancellation via SingleOrderNotAuthed error
    |  C2 (CandidateConfirmer)  — confirms candidate orders via orderbook API → discreteOrder
    |  C3 (StatusUpdater)       — polls API for status updates on open discrete orders
    |  C4 (HistoricalBootstrap) — one-time backfill of non-deterministic historical orders
    v
schema tables (Postgres)
    |
    v
Hono API server
    |  GET /graphql      -- GraphQL endpoint (auto-generated from schema)
    |  GET /sql/*        -- Ponder SQL passthrough
    |  GET /api/*        -- custom REST endpoints (Swagger UI at /docs)
    |  GET /healthz      -- health check
```

## Schema

Four tables, defined in `schema/tables.ts`. All use composite primary keys with `chainId` as the first column, which is necessary for multi-chain support and prevents collisions between chains.

### transaction

Stores block metadata for each transaction the indexer processes. Multiple events in the same transaction share a row; inserts use `onConflictDoNothing`.

Columns: `hash`, `chainId`, `blockNumber`, `blockTimestamp`.
PK: `(chainId, hash)`.

### conditional_order_generator

The main table. One row per `ConditionalOrderCreated` event. Stores the raw order params, the decoded params (as JSON), and the resolved owner.

Key columns:
- `eventId` -- Ponder's event ID, used as the entity identifier
- `owner` -- the address from the event (could be a proxy)
- `resolvedOwner` -- the actual EOA, resolved via `ownerMapping` at insert time
- `handler` -- the IConditionalOrder handler contract address
- `hash` -- keccak256 of the ABI-encoded params tuple (handler, salt, staticInput). This is what `singleOrders(owner, hash)` checks on-chain.
- `orderType` -- one of TWAP, StopLoss, PerpetualSwap, GoodAfterTime, TradeAboveThreshold, or Unknown
- `decodedParams` -- JSON blob with the decoded staticInput fields, or null if decode failed
- `decodeError` -- set to `"invalid_static_input"` if decoding threw, otherwise null
- `status` -- Active, Cancelled, or Completed

PK: `(chainId, eventId)`. Indexed on `owner`, `handler`, `hash`, `chainId+owner`, and `resolvedOwner`.

### discrete_order

Links individual order UIDs (from the CoW Protocol orderbook) back to their parent generator. One generator can produce many discrete orders over its lifetime — a TWAP with 10 parts creates 10 discrete orders. Populated by C2 (CandidateConfirmer) after confirmation against the orderbook API; status kept current by C3 (StatusUpdater).

Key columns: `orderUid`, `chainId`, `conditionalOrderGeneratorId` (references `eventId`), `status` (open/fulfilled/unfilled/expired/cancelled), `sellAmount`, `buyAmount`, `executedSellAmount`, `executedBuyAmount`.
PK: `(chainId, orderUid)`. See [api-reference.md](./api-reference.md) for full field docs.

### owner_mapping

Maps proxy/helper contract addresses to the actual owner EOA. Two types of proxies exist:

- `cowshed_proxy` -- CoWShed smart wallet proxy, mapped when the CoWShedFactory emits `COWShedBuilt`
- `flash_loan_helper` -- Aave V3 adapter contract, mapped when the settlement handler detects it through FACTORY() introspection

Columns: `address`, `chainId`, `owner`, `addressType`, `txHash`, `blockNumber`, `resolutionDepth`.
PK: `(chainId, address)`.

The `resolutionDepth` column records how many hops were needed to reach the EOA. For CoWShed proxies it's 0 (the `COWShedBuilt` event directly provides the user). For Aave adapters it's 1 (call `owner()` on the adapter to get the EOA).

## Handlers in Detail

### composableCow.ts -- ConditionalOrderCreated

This is the primary event handler. When a `ConditionalOrderCreated` fires:

1. ABI-encode the params tuple `(handler, salt, staticInput)` and hash it with keccak256. This hash matches what the on-chain `singleOrders` mapping uses.

2. Look up the `owner` address in `ownerMapping`. If there's a match (the owner is a known CoWShed proxy), use the mapped EOA as `resolvedOwner`. If no match exists, `resolvedOwner` defaults to `owner`. For Aave adapters, the mapping might not exist yet when the order is created -- the settlement handler will backfill it later.

3. Identify the order type by looking up the handler address in a map (`src/utils/order-types.ts`). The handler addresses are the same across all chains. If the handler isn't recognized, the order is stored as `Unknown`.

4. Decode the `staticInput` bytes using the appropriate decoder from `src/decoders/`. Each order type has its own decoder that unpacks the ABI-encoded struct into typed fields. BigInts are converted to strings before storing as JSON (Ponder's `replaceBigInts`). If decoding fails, `decodeError` is set and `decodedParams` is null.

5. Insert the `transaction` and `conditionalOrderGenerator` rows, both with `onConflictDoNothing` for idempotency.

### cowshed.ts -- COWShedBuilt

When a CoWShed proxy wallet is deployed, this handler stores the mapping from the proxy address (`shed`) to the deploying user address in `ownerMapping`. This mapping is then available for the composableCow handler to resolve owners.

### settlement.ts -- GPv2Settlement Settlement

This handler detects Aave V3 flash loan adapter contracts. The GPv2Settlement contract is filtered (in `ponder.config.ts`) to only index settlements from the FlashLoanRouter solver, which keeps the event volume low.

For each Settlement event:

1. Fetch the full transaction receipt and iterate over all logs.
2. Filter for Trade logs emitted by the settlement contract (matching the Trade event topic).
3. For each trade, extract the `owner` from the indexed topic.
4. Skip if already mapped, skip if the address is an EOA (no bytecode).
5. Call `FACTORY()` on the address using raw `eth_call` (not `readContract`, which would log warnings on reverts). If the returned address matches the known AaveV3AdapterFactory address, this is a flash loan adapter.
6. Call `owner()` on the adapter to get the EOA, then write the `ownerMapping` entry.

The handler uses raw `eth_call` for the FACTORY() check specifically to avoid Ponder's built-in WARN logging on contract call reverts. Most trade addresses are not Aave adapters, so FACTORY() reverts are the common case, and the warnings would flood the logs.

Stats are accumulated and logged every 30 seconds to track throughput without per-event log spam.

### blockHandler.ts -- C1 / C2 / C3 / C4

Four live-only block handlers, all in a single file. They only run during live sync (startBlock: "latest") to avoid hammering the orderbook API during historical backfill.

**C1 — ContractPoller** (every block, mainnet + gnosis): Multicalls `getTradeableOrderWithSignature` on ComposableCoW for each `Active` generator where `allCandidatesKnown=false`. A success result creates a `candidateDiscreteOrder` entry. A `SingleOrderNotAuthed` error marks the generator as `Cancelled`. Other errors (tryNextBlock, tryAtEpoch, etc.) advance the generator's `nextCheckBlock` accordingly. Single-shot non-deterministic types (GoodAfterTime, TradeAboveThreshold) set `allCandidatesKnown=true` after first success. Can be disabled with `DISABLE_POLL_RESULT_CHECK=true`.

**C2 — CandidateConfirmer** (every block, mainnet + gnosis): Checks all `candidateDiscreteOrder` rows against the orderbook API. When a candidate appears in the API, it's promoted to `discreteOrder` and deleted from candidates. Candidates past their `validTo` are also pruned.

**C3 — StatusUpdater** (every block, mainnet + gnosis): Polls the orderbook API for all `open` discrete orders and updates their status. Also expires any orders past their `validTo` timestamp.

**C4 — HistoricalBootstrap** (fires once at latest block, mainnet + gnosis): One-time fetch of historical orders for non-deterministic generators (PerpetualSwap, GoodAfterTime, TradeAboveThreshold, Unknown) that were active during backfill but have no discrete orders yet. Queries the CoW Protocol `/orders?owner=` endpoint per owner.

## Order Types and Decoders

Five order types are supported, each with a dedicated decoder in `src/decoders/`: TWAP, StopLoss, PerpetualSwap (non-deterministic), GoodAfterTime (non-deterministic), and TradeAboveThreshold (non-deterministic). Handler addresses are identical across all chains and are hardcoded in `src/utils/order-types.ts`.

When a handler address isn't recognized, the order is stored with type `Unknown` and null decoded params.

For handler addresses, Solidity struct layouts, and field-by-field decoding for each type, see [supported-order-types.md](./supported-order-types.md).

## Owner Resolution

Users interact with CoW Protocol through several layers of proxy contracts, so the `owner` field in a `ConditionalOrderCreated` event often isn't the actual human behind the order. The indexer resolves this using the `ownerMapping` table.

Two proxy patterns exist:

**CoWShed proxies**: CoWShed is a smart wallet system for CoW Protocol. When a user deploys a CoWShed proxy through the factory, the `COWShedBuilt` event provides the user address directly. The cowshed.ts handler writes this mapping as it sees factory events. Later, when a `ConditionalOrderCreated` fires with a CoWShed proxy as owner, the composableCow handler looks up the mapping and sets `resolvedOwner` to the actual user.

**Aave V3 flash loan adapters**: These are per-user proxy contracts created by the AaveV3AdapterFactory. They're trickier to detect because there's no factory event -- the adapter is just a contract that happens to trade through CoW Protocol. The settlement handler identifies them by checking whether a trade address implements `FACTORY()` returning the known AaveV3AdapterFactory address, then calls `owner()` to get the EOA.

The ordering matters: CoWShed mappings are typically available before the order is created (the user deploys the proxy first). Aave adapter mappings might not be -- the adapter might trade before it creates a conditional order. In that case, `resolvedOwner` will initially be the adapter address and can be updated later.

## API Layer

`src/api/index.ts` is a Hono app. Routes:

- `/` and `/graphql` -- GraphQL endpoint, auto-generated by Ponder from the schema. Field descriptions are injected by `ponder-enrich-gql-docs-middleware` at runtime.
- `/sql/*` -- Ponder's SQL passthrough client for raw read-only SQL.
- `/api/*` -- custom REST endpoints (`src/api/router.ts`), defined with `@hono/zod-openapi`.
- `/docs` -- Swagger UI for the REST endpoints.
- `/healthz` -- returns `{"status": "ok"}`.

See [api-reference.md](./api-reference.md) for the full endpoint list.

## Adding a New Chain

1. Add the deployment entry to the relevant export in `src/data.ts` (start block, address if it differs).
2. Wire it into the contract config objects (`ComposableCowContract`, `CoWShedFactoryContract`, etc.) in the same file.
3. Add the chain to `ponder.config.ts` under `chains` with its RPC URL env var.
4. Add the chain's handler addresses to `HANDLER_MAP` in `src/utils/order-types.ts` (they're currently the same across all chains).
5. Add the RPC URL to `.env.local`.
6. Run `pnpm codegen` to regenerate types.

The block handlers (C1–C4) already run on both mainnet and gnosis. Adding a new chain requires adding entries to each block handler's `chain` config in `ponder.config.ts`.

## Known Limitations

- Cancellation of deterministic generators (TWAP) isn't detected after all parts are discovered. Once `allCandidatesKnown=true`, C1 stops polling — so on-chain removal via `ComposableCoW.remove()` won't be reflected in the status. There's no on-chain event for removals; detecting it would require re-polling completed generators periodically.
- Aave adapter owner resolution is reactive — it happens when the adapter trades, not when the order is created. Orders from adapters that haven't traded yet will have `resolvedOwner` equal to the adapter address.
- Arbitrum addresses are stubbed in `src/data.ts` but not wired into the config.
- The GPv2Settlement handler is mainnet-only in the Ponder config, though the deployment data for gnosis exists in `data.ts`.
