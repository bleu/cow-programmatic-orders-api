# System Architecture

This document covers how the indexer works, from on-chain events to the GraphQL API. It's meant for developers who will maintain and extend this codebase.

## Overview

The system is a Ponder 0.16.x indexer that watches the ComposableCoW contract on all active chains (see `ponder.config.ts`). When a user creates a programmatic order (TWAP, Stop Loss, etc.), the contract emits a `ConditionalOrderCreated` event. The indexer picks that up, decodes the order parameters, resolves the actual owner (which may be behind a proxy), and writes the result to Postgres. A Hono HTTP server exposes the data through GraphQL and a SQL passthrough endpoint.

Ponder registers handlers for three independent on-chain event streams: `ComposableCow` (conditional order creation), `CoWShedFactory` (proxy wallet deployment), and `GPv2Settlement` (Aave adapter detection via `Settlement` events — `Trade` logs in the receipt identify the adapter address). During live sync, additional block handlers in `blockHandler.ts` poll contract state and the CoW orderbook API. See `blockHandler.ts` for the current handler list and responsibilities. `settlement.ts` detects Aave flash loan adapters via a queue-based approach: the `GPv2Settlement:Settlement` event handler enqueues tx hashes, and `SettlementResolver:block` drains the queue and does all RPC work so errors never crash the event handler.

## Contracts and Chains

Configuration lives in `src/chains/` (one file per chain). The ComposableCoW contract is deployed at the same CREATE2 address on every chain (`0xfdaFc9d1902f4e0b84f65F49f244b32b31013b74`), so each chain config only needs to specify the start block per chain.

Currently active chains, their start blocks, and contract addresses are defined in `src/chains/`. To add a chain, create a chain file there and register it in `src/chains/index.ts`.

Stub configs exist for all 12 chains in cow-sdk's `ALL_SUPPORTED_CHAIN_IDS`; contract addresses for the remaining chains need verification before enabling.

`ponder.config.ts` derives all config from `ACTIVE_CHAINS` in `src/chains/index.ts` and wires it into Ponder's `createConfig`. It never contains raw addresses or block numbers directly. It also registers the five live-only block handlers from `blockHandler.ts` (`OrderDiscoveryPoller`, `CandidateConfirmer`, `OrderStatusTracker`, `OwnerBackfill`, `CancellationWatcher`) — all run during live sync only (`startBlock: "latest"`).


Three contracts are indexed:

1. **ComposableCow** -- the main contract. Emits `ConditionalOrderCreated` for new programmatic orders.
2. **CoWShedFactory** -- emits `COWShedBuilt` when a user deploys a CoWShed proxy wallet. On Gnosis there are two factory addresses (the current `CoWShedForComposableCoW` factory and a legacy `COWShed` factory), both indexed through a single Ponder contract entry using an address array.
3. **GPv2Settlement** -- the CoW Protocol settlement contract. Filtered to only `Settlement` events where the solver is the FlashLoanRouter address, so the volume is very low.

## Data Flow

Three independent on-chain event streams feed into the same schema tables and are then served by the API layer:

```
ComposableCoW contract          CoWShedFactory contract        GPv2Settlement contract
(mainnet + gnosis)              (mainnet + gnosis)             (FlashLoanRouter filter only)
        |                               |                               |
ConditionalOrderCreated         COWShedBuilt events            Settlement events
        |                               |                               |
        v                               v                               v
composableCow.ts handler        cowshed.ts handler             settlement.ts handler
  - hash params tuple             - write ownerMapping:          - fetch receipt, scan Trade logs
  - resolve owner proxy             shed → user EOA              - check FACTORY() on each trader
  - decode staticInput            (used by composableCow.ts      - if Aave adapter: call owner(),
  - write transaction +             at next order creation)        write ownerMapping
    conditionalOrderGenerator
        |                               |                               |
        +---------------+---------------+-------------------------------+
                        |
                        v
               schema tables (Postgres)
                        |
                        |  (live sync only)
                        v
               blockHandler.ts — live block handlers
                 OrderDiscoveryPoller     — multicall getTradeableOrderWithSignature for
                                           non-deterministic generators; detects cancellation
                                           via SingleOrderNotAuthed error
                 CandidateConfirmer      — confirms candidates via orderbook API → discreteOrder;
                                           cascades parent Cancelled to orphan candidates
                 OrderStatusTracker      — polls API for status updates on open discrete orders;
                                           cascades parent Cancelled to orphan open rows
                 OwnerBackfill           — one-time backfill of non-deterministic historical orders
                 CancellationWatcher     — periodic singleOrders() read for deterministic generators;
                                           flips to Cancelled when remove() has been called on-chain
                        |
                        v
               Hono API server
                 GET /graphql      -- GraphQL endpoint (auto-generated from schema)
                 GET /sql/*        -- Ponder SQL passthrough
                 GET /api/*        -- custom REST endpoints (Swagger UI at /docs)
                 GET /healthz      -- health check
```

## Schema

Five tables, defined in `schema/tables.ts`. All use composite primary keys with `chainId` as the first column, which is necessary for multi-chain support and prevents collisions between chains.

### transaction

Stores block metadata for each transaction the indexer processes. Multiple events in the same transaction share a row; inserts use `onConflictDoNothing`.

Columns: `hash`, `chainId`, `blockNumber`, `blockTimestamp`.
PK: `(chainId, hash)`.

### conditional_order_generator

The main table. One row per `ConditionalOrderCreated` event. Stores the raw order params, the decoded params (as JSON), and the resolved owner.

Key columns:
- `eventId` -- Ponder's event ID, used as the entity identifier
- `owner` -- the address from the event (could be a proxy)
- `resolvedOwner` -- EOA from `ownerMapping` when `owner` already has a row at insert time; otherwise the same as `owner`. Not rewritten when a new `owner_mapping` row is added later.
- `handler` -- the IConditionalOrder handler contract address
- `hash` -- keccak256 of the ABI-encoded params tuple (handler, salt, staticInput). This is what `singleOrders(owner, hash)` checks on-chain.
- `orderType` -- one of TWAP, StopLoss, PerpetualSwap, GoodAfterTime, TradeAboveThreshold, CirclesBackingOrder, SwapOrderHandler, ERC4626CowSwapFeeBurner, or Unknown
- `decodedParams` -- JSON blob with the decoded staticInput fields, or null if decode failed
- `decodeError` -- set to `"invalid_static_input"` if decoding threw, otherwise null
- `status` -- Active, Cancelled, or Completed

PK: `(chainId, eventId)`. Indexed on `owner`, `handler`, `hash`, `chainId+owner`, and `resolvedOwner`.

### discrete_order

Links individual order UIDs (from the CoW Protocol orderbook) back to their parent generator. One generator can produce many discrete orders over its lifetime — a TWAP with 10 parts creates 10 discrete orders. Populated by C2 (CandidateConfirmer) after confirmation against the orderbook API; status kept current by C3 (StatusUpdater).

Key columns: `orderUid`, `chainId`, `conditionalOrderGeneratorId` (references `eventId`), `status` (open/fulfilled/unfilled/expired/cancelled), `sellAmount`, `buyAmount`, `executedSellAmount`, `executedBuyAmount`.
PK: `(chainId, orderUid)`. See [api-reference.md](./api-reference.md) for full field docs.

### candidate_discrete_order

**Why candidate orders?** The CoW watch-tower submits orders to the orderbook API on behalf of generators. There is a gap between when the indexer discovers a valid order UID (via `getTradeableOrderWithSignature` or precompute) and when it actually appears in the orderbook API (after the watch-tower posts it). Storing candidates immediately lets the indexer track all UIDs it knows about, confirm them against the API in a later block, and avoid polling the API for UIDs that haven't been posted yet. Without this staging table, the indexer would either poll the API every block for every possible UID (expensive), or miss orders entirely.

Staging rows for discrete orders discovered by `OrderDiscoveryPoller` (`getTradeableOrderWithSignature`) or precomputed at creation time before the orderbook API lists them. When `CandidateConfirmer` confirms a UID against the API, the row is promoted to `discrete_order` and removed from candidates. Stale candidates (past `validTo`) are pruned on each `CandidateConfirmer` block.

Key columns: `orderUid`, `chainId`, `conditionalOrderGeneratorId`, amounts, `validTo`, `creationDate`, `possibleValidAfterTimestamp` (TWAP scheduling). PK: `(chainId, orderUid)`.

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

2. Look up the `owner` address in `ownerMapping`. If there's a match (e.g. a known CoWShed proxy), use the mapped EOA as `resolvedOwner`. If no match exists, `resolvedOwner` is set to `owner`. For Aave adapters there is often no row yet at insert time; settlement may later insert `owner_mapping` for the adapter, but existing `conditional_order_generator` rows are not updated—queries and REST endpoints use `owner_mapping` (e.g. `/api/orders/by-owner`) to resolve EOAs.

3. Identify the order type by looking up the handler address in a map (`src/utils/order-types.ts`). The handler addresses are the same across all chains. If the handler isn't recognized, the order is stored as `Unknown`.

4. Decode the `staticInput` bytes using the appropriate decoder from `src/decoders/`. Each order type has its own decoder that unpacks the ABI-encoded struct into typed fields. BigInts are converted to strings before storing as JSON (Ponder's `replaceBigInts`). If decoding fails, `decodeError` is set and `decodedParams` is null.

5. Insert the `transaction` and `conditionalOrderGenerator` rows, both with `onConflictDoNothing` for idempotency.

### cowshed.ts -- COWShedBuilt

When a CoWShed proxy wallet is deployed, this handler stores the mapping from the proxy address (`shed`) to the deploying user address in `ownerMapping`. This mapping is then available for the composableCow handler to resolve owners.

### settlement.ts -- Flash Loan Adapter Detection

This file detects Aave V3 flash loan adapter contracts using a queue-based two-stage approach. The GPv2Settlement contract is filtered (in `ponder.config.ts`) to only index settlements from the FlashLoanRouter solver, so the event volume is very low.

**Stage 1 — `GPv2Settlement:Settlement` event handler (enqueue only):**

When a Settlement event fires, the handler writes the transaction hash into the `settlementQueue` table and returns immediately. No RPC calls are made here — errors in RPC never crash the event handler, keeping the indexer stable.

**Stage 2 — `SettlementResolver:block` block handler (drain and resolve):**

Every block, this handler drains up to `MAX_SETTLEMENTS_PER_BLOCK` rows from `settlementQueue` for the current chain. For each queued transaction:

1. Fetch the full transaction receipt (with timeout). On error, log a warning and delete the queue row (skip it).
2. Iterate over all logs in the receipt. Keep only Trade logs emitted by the GPv2Settlement contract.
3. For each trade, extract the `owner` address from the indexed topic.
4. Skip if already in `ownerMapping` (adapter seen in a prior settlement).
5. Call `getCode` on the address (with timeout). Skip if EOA (no bytecode).
6. Call `FACTORY()` via raw `eth_call` (not `readContract`, which logs a WARN on every revert). If the returned address doesn't match the known AaveV3AdapterFactory address, skip.
7. Call `owner()` on the adapter to retrieve the underlying EOA.
8. Write a row to `ownerMapping` (`address` → `owner`, `addressType = FlashLoanHelper`).
9. Update any `conditionalOrderGenerator` rows owned by the adapter address to set `ownerAddressType = FlashLoanHelper`.
10. Delete the queue row.

The raw `eth_call` for `FACTORY()` avoids Ponder's built-in WARN logs on reverts — most addresses are not Aave adapters, so reverts are the common case and would flood the logs if `readContract` were used.

Stats (total settlements, trade logs found, EOA skips, adapter mappings, avg FACTORY() latency) are accumulated and logged every 30 seconds.

### blockHandler.ts -- live block handlers

All block handlers run only during live sync (`startBlock: "latest"`) to avoid hammering the orderbook API during historical backfill. `OrderDiscoveryPoller` and `CancellationWatcher` share a per-chain batch cap (`MAX_GENERATORS_PER_BLOCK_<chainId>`, default 200) and pull from a priority queue ordered by oldest `lastCheckBlock` first. Generators past the cap defer to the next block.

**TWAP aged-out fallback**: When a candidate's `orderUid` is no longer served by `/orders/by_uids` (typically after the order expires from the orderbook cache), `CandidateConfirmer` falls back to fetching the owner's full order list from `/account/{owner}/orders`. This resolves TWAP parts that the orderbook stopped tracking before `CandidateConfirmer` processed them. On timeout or API failure, the candidate defaults to `expired`.

**OrderStatusTracker** (every block, mainnet + gnosis): Polls the orderbook API for all `open` discrete orders and updates their status from the API response. Then sweeps any remaining `open` rows whose parent generator is `Cancelled` to `status='cancelled'` (API-terminal statuses from the loop above still win for children that were traded before on-chain cancellation). Finally expires any orders past their `validTo` timestamp.

**OrderDiscoveryPoller** (every block, mainnet + gnosis): Multicalls `getTradeableOrderWithSignature` on ComposableCoW for each `Active` generator where `allCandidatesKnown=false`. A success result creates a `candidateDiscreteOrder` entry. A `SingleOrderNotAuthed` error marks the generator as `Cancelled` with `lastPollResult='cancelled:SingleOrderNotAuthed'`. Other errors (tryNextBlock, tryAtEpoch, etc.) advance the generator's `nextCheckBlock` accordingly. Single-shot non-deterministic types (GoodAfterTime, TradeAboveThreshold) set `allCandidatesKnown=true` after first success. Can be disabled with `DISABLE_POLL_RESULT_CHECK=true`.

**CandidateConfirmer** (every block, mainnet + gnosis): First drains any `candidateDiscreteOrder` rows whose parent generator is `Cancelled` — promoting them into `discreteOrder` with `status='cancelled'` and deleting the candidate rows. Then checks remaining `candidateDiscreteOrder` rows against the orderbook API: when a candidate appears in the API, it's promoted to `discreteOrder` and deleted from candidates. Candidates past their `validTo` are also pruned.

**TWAP aged-out fallback**: When a candidate's `orderUid` is no longer served by `/orders/by_uids` (typically after the order expires from the orderbook cache), `CandidateConfirmer` falls back to fetching the owner's full order list from `/account/{owner}/orders`. This resolves TWAP parts that the orderbook stopped tracking before C2 processed them. On timeout or API failure, the candidate defaults to `expired`.


**OrderStatusTracker** (every block, mainnet + gnosis): Polls the orderbook API for all `open` discrete orders and updates their status from the API response. Then sweeps any remaining `open` rows whose parent generator is `Cancelled` to `status='cancelled'` (API-terminal statuses from the loop above still win for children that were traded before on-chain cancellation). Finally expires any orders past their `validTo` timestamp.

**OwnerBackfill** (fires once at latest block, mainnet + gnosis): One-time fetch of historical orders for non-deterministic generators (PerpetualSwap, GoodAfterTime, TradeAboveThreshold, Unknown) that were active during backfill but have no discrete orders yet. Queries the CoW Protocol `/orders?owner=` endpoint per owner.

**CancellationWatcher** (every block, mainnet + gnosis): Closes `OrderDiscoveryPoller`'s blind spot. `OrderDiscoveryPoller` skips `allCandidatesKnown=true` generators, so removals via `ComposableCoW.remove()` on deterministic types (TWAP, StopLoss, CirclesBackingOrder) would otherwise go undetected — `remove()` emits no event. `CancellationWatcher` multicalls `singleOrders(owner, hash)` on a per-generator cadence of `DETERMINISTIC_CANCEL_SWEEP_INTERVAL` blocks (default 100). A `false` return means the owner called `remove()` on-chain: the generator is flipped to `Cancelled` with `lastPollResult='cancelled:removeMapping'`, after which `CandidateConfirmer` and `OrderStatusTracker`'s parent-cancelled cascades reconcile the children on the next block. `true` reschedules the next check. Can be disabled with `DISABLE_DETERMINISTIC_CANCEL_SWEEP=true`.

## Order Types and Decoders

All order types supported by the indexer have a dedicated decoder in `src/decoders/` (see that directory for the current list). Two categories exist based on how UIDs are discovered:

- **Deterministic** (`allCandidatesKnown=true`): UIDs are precomputed at order creation time from the params alone, so all candidate UIDs are known immediately. Currently: TWAP, StopLoss, CirclesBackingOrder. Not polled by `OrderDiscoveryPoller`.
- **Non-deterministic** (`allCandidatesKnown=false`): UIDs depend on runtime state and cannot be precomputed. Currently: PerpetualSwap, GoodAfterTime, TradeAboveThreshold, SwapOrderHandler, ERC4626CowSwapFeeBurner. Polled every block by `OrderDiscoveryPoller`.

Core handler addresses are identical across all chains; some newer handlers (SwapOrderHandler, ERC4626CowSwapFeeBurner) are per-chain overlays. Both are tracked in `src/utils/order-types.ts`.

When a handler address isn't recognized, the order is stored with type `Unknown` and null decoded params.

For handler addresses, Solidity struct layouts, and field-by-field decoding for each type, see [supported-order-types.md](./supported-order-types.md).

## Owner Resolution

Users interact with CoW Protocol through several layers of proxy contracts, so the `owner` field in a `ConditionalOrderCreated` event often isn't the actual human behind the order. The indexer resolves this using the `ownerMapping` table.

Two proxy patterns exist:

**CoWShed proxies**: CoWShed is a smart wallet system for CoW Protocol. When a user deploys a CoWShed proxy through the factory, the `COWShedBuilt` event provides the user address directly. The cowshed.ts handler writes this mapping as it sees factory events. Later, when a `ConditionalOrderCreated` fires with a CoWShed proxy as owner, the composableCow handler looks up the mapping and sets `resolvedOwner` to the actual user.

**Aave V3 flash loan adapters**: These are per-user proxy contracts created by the AaveV3AdapterFactory. They're trickier to detect because there's no factory event -- the adapter is just a contract that happens to trade through CoW Protocol. The settlement handler identifies them by checking whether a trade address implements `FACTORY()` returning the known AaveV3AdapterFactory address, then calls `owner()` to get the EOA.

CoWShed mappings are usually available before the conditional order is created. Aave adapter mappings may appear only after a settlement trade. The `resolvedOwner` column on `conditional_order_generator` is set once at insert and does not change when `owner_mapping` later gains a matching row; join `owner_mapping` or use owner-aware APIs for current proxy-to-EOA resolution.

## API Layer

`src/api/index.ts` is a Hono app. Routes:

- `/` and `/graphql` -- GraphQL endpoint, auto-generated by Ponder from the schema. Field descriptions are injected by `ponder-enrich-gql-docs-middleware` at runtime.
- `/sql/*` -- Ponder's SQL passthrough client for raw read-only SQL.
- `/api/*` -- custom REST endpoints (`src/api/router.ts`), defined with `@hono/zod-openapi`.
- `/docs` -- Swagger UI for the REST endpoints.
- `/healthz` -- returns `{"status": "ok"}`.

See [api-reference.md](./api-reference.md) for the full endpoint list.

## Adding a New Chain

1. Create `src/chains/<name>.ts` implementing the `ChainConfig` interface (use `src/chains/base.ts` as a template). Fill in confirmed contract addresses; leave `null` for any that aren't deployed yet.
2. Import and add the new chain to `ALL_DEFINED_CHAINS` in `src/chains/index.ts`.
3. When all required addresses are confirmed, add it to `ACTIVE_CHAINS` in the same file.
4. Add its RPC URL env var to `.env.local` (or `.env` in production) and to the `ponder` service environment in `docker-compose.yml`.
5. Run `pnpm codegen` to regenerate types.

## Known Limitations

- Cancellation detection has a small lag. For non-deterministic generators, `OrderDiscoveryPoller` catches `SingleOrderNotAuthed` on the next poll (every block). For deterministic generators, `CancellationWatcher` reads `singleOrders(owner, hash)` every `DETERMINISTIC_CANCEL_SWEEP_INTERVAL` blocks (default 100) — so on-chain removal is reflected with worst-case latency of ~100 blocks (~20 min mainnet, ~8 min Gnosis). There is no on-chain event for `remove()`, so shorter detection latency would require a higher-cadence sweep. Once the generator is marked `Cancelled`, `CandidateConfirmer` and `OrderStatusTracker` cascade the state to children on the next block; the `CandidateConfirmer` cascade does a preflight `/by_uids` query so that candidates already on the orderbook get their actual status rather than defaulting to `cancelled`; API-terminal statuses (`fulfilled` / `unfilled` / `expired`) still win for children already promoted to `discrete_order`.
- Aave adapter owner resolution is reactive — `owner_mapping` is written when the adapter appears in settlement, which may be after the conditional order is created. The generator row keeps `resolvedOwner` equal to the adapter address when no mapping existed at insert time; that column is not backfilled when the mapping is inserted later. `ownerAddressType` on the generator IS backfilled when the mapping is inserted — after which GraphQL and REST filters on `ownerAddressType = "flash_loan_helper"` reflect the correct value. `resolvedOwner` is still not backfilled (set once at insert, unchanged thereafter).
