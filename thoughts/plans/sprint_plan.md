# Sprint Plan — Programmatic Orders API

**Duration:** 8 weeks (Sprints S1–S8)  
**Team:** bleu (@yvesfracari, @ribeirojose, @mendesfabio)  
**Technical Reviewer:** @anxolin (CoW Protocol)

---

## Overview

| Milestone | Sprints | Duration |
|---|---|---|
| M1: Composable CoW Tracking | S1–S2 | 2 weeks |
| M2: Flash Loan & CoWShed Ownership | S3 + ½ S4 | 1.5 weeks |
| M3: Orderbook Integration | ½ S4 – S7 | 3 weeks |
| M4: Review & Documentation | S7 (½) – S8 | 1.5 weeks |

---

## Sprint 1 — Project Setup & Composable CoW Indexing (Week 1)

### S1.1 — Project Bootstrap & Infrastructure
**Goal:** Working Ponder project with dev environment ready

- [ ] Initialize Ponder project (ponder, viem, hono, TypeScript, Vite)
- [ ] Project structure: `ponder.config.ts`, `ponder.schema.ts`, `schema/`, `src/data.ts`, `src/application/handlers/`, `src/api/`
- [ ] Configure supported chains (Ethereum Mainnet, Gnosis Chain, Arbitrum) with RPC URLs from env
- [ ] Docker Compose for local PostgreSQL
- [ ] CI/CD setup (linting, typecheck, basic pipeline)
- [ ] `.env.local.example` with all required env vars documented

### S1.2 — Research: Protocol Contracts & ABIs
**Goal:** Have all contract addresses, ABIs, and start blocks documented

- [ ] Research and document all ComposableCoW contract addresses per chain
- [ ] Research all handler contract addresses (TWAP, Stop Loss, Perpetual Swap, Good After Time, Trade Above Threshold)
- [ ] Research CoWShed / CoWShedForComposableCow factory addresses per chain
- [ ] Research AaveV3AdapterFactory addresses per chain
- [ ] Research GPv2Settlement addresses per chain
- [ ] Collect and organize all ABIs needed
- [ ] Document start blocks for each contract on each chain
- [ ] Create `src/data.ts` with all contract configurations

> **Questions to resolve:**
> - Which chains are officially supported? (Mainnet + Gnosis Chain + Arbitrum? Others?)
> - Are there multiple versions of ComposableCoW deployed?
> - What are the correct start blocks for historical backfilling?

### S1.3 — Composable CoW Event Indexing
**Goal:** Index `ConditionalOrderCreated` and cancellation events

- [ ] Define schema tables: `conditionalOrderGenerator` (eventId, chainId, owner, handler, hash, txHash, etc.), `transaction` (hash, chainId, blockNumber, blockTimestamp), `discreteOrder` (composite PK)
- [ ] Define enum for order types (TWAP, StopLoss, PerpetualSwap, GoodAfterTime, TradeAboveThreshold)
- [ ] Register handler for `ComposableCoW:ConditionalOrderCreated` event
- [ ] Compute and store `keccak256(abi.encode(handler, salt, staticInput))` as the conditional order hash
- [ ] Register handler for `ComposableCoW:ConditionalOrderCancelled` event (if exists) or equivalent cancellation mechanism
- [ ] Historical backfilling: verify all historical events are indexed correctly
- [ ] Real-time monitoring: verify new events are picked up

### S1.4 — Decoder Planning (Local Implementation)
**Goal:** Plan local decoder implementation; use cow-sdk as reference only (upstream integration was removed from grant scope per [forum Update #2](https://forum.cow.fi/t/grant-application-programmatic-orders-api/3346))

- [ ] Review cow-sdk composable package as reference: which order types have decoders we can mirror?
- [ ] Document staticInput ABI / struct for each order type (TWAP, Stop Loss, Perpetual Swap, GAT, TAT)
- [ ] Document decoder interface pattern for use in S2 decoder tasks
- [ ] Note: all decoders are implemented locally in this project; no upstream PR to cow-sdk required for M1

---

## Sprint 2 — Order Type Decoders & GraphQL API (Week 2)

### S2.1 — Order Type Decoders
**Goal:** Decode all 5 order types from `staticInput`

- [ ] TWAP decoder: decode static input to get partSellAmount, minPartLimit, startTime, numParts, span, etc.
- [ ] Stop Loss decoder: decode static input to get trigger price, max time since last oracle update, etc.
- [ ] Perpetual Swap decoder: decode static input to get parameters
- [ ] Good After Time decoder: decode static input
- [ ] Trade Above Threshold decoder: decode static input
- [ ] Store decoded parameters in schema (either as JSON field or typed columns per order type)
- [ ] Unit tests for each decoder against known on-chain data

> **Questions to resolve:**
> - What is the ABI / struct layout for each handler's staticInput?
> - Use cow-sdk (e.g. TWAP) as reference; implement all decoders locally in this project.
> - Should decoded data be stored as separate tables per type or a single polymorphic table?

### S2.2 — GraphQL API Setup
**Goal:** Expose indexed data via GraphQL

- [ ] Set up Hono app with Ponder's `graphql` and `client` middleware
- [ ] Define relations between tables for nested GraphQL queries
- [ ] Query: list all conditional orders (filterable by owner, handler/type, chain, status)
- [ ] Query: get conditional order by ID or hash
- [ ] Query: get all conditional orders for an owner
- [ ] Basic pagination support
- [ ] Test queries against indexed data

### S2.3 — Milestone 1 Validation
**Goal:** End-to-end verification of M1 deliverables

- [ ] Verify historical indexing completeness (compare with known data)
- [ ] Verify real-time event detection (create a test order if possible)
- [ ] Verify all 5 order types decode correctly
- [ ] Verify GraphQL queries return expected data
- [ ] Performance check: indexing speed, query latency
- [ ] Prepare M1 demo/summary for Anxo review

---

## Sprint 3 — Flash Loan Tracking & CoWShed Mapping (Week 3)

### S3.1 — AaveV3 Flash Loan Order Tracking (Solution 1: Factory Events)
**Goal:** Map flash loan helper contracts to their EOA owners via factory

- [ ] Add `AaveV3AdapterFactory` contract to ponder config
- [ ] Schema: `flashLoanHelper` table (helperAddress, eaoOwner, txHash, chainId, etc.)
- [ ] Handler for `AaveV3AdapterFactory:deployAndTransferFlashLoan` (or equivalent event/call trace)
- [ ] Map: deployed helper contract address → EOA owner
- [ ] Test with known AAVE flash loan orders (e.g., the Polygon example from Anxo)

> **Questions to resolve:**
> - Does `deployAndTransferFlashLoan` emit an event or do we need call traces?
> - If call traces are needed, which chains support them? Cost implications?
> - What is the exact function signature and event structure?

### S3.2 — Flash Loan Order Tracking (Solution 2: Trade Event Fallback)
**Goal:** Detect flash loan orders from trade events when factory monitoring isn't available

- [ ] Listen to `GPv2Settlement:Trade` events
- [ ] Heuristic: check if the `owner` field follows the helper contract pattern
- [ ] For suspected helpers: call ABI methods to verify and extract EOA owner
- [ ] Fallback: works on all chains without call traces
- [ ] Merge/reconcile with Solution 1 data

### S3.3 — CoWShed Proxy to EOA Mapping
**Goal:** Map CoWShed proxy contracts to their controlling EOAs

- [ ] Add CoWShed factory contract to ponder config
- [ ] Schema: `cowShedProxy` table (proxyAddress, eoaOwner, chainId, txHash, etc.)
- [ ] Handler for `COWShedBuilt` event (or equivalent factory creation event)
- [ ] Map: CoWShed proxy address → EOA owner
- [ ] Integration: when querying orders by owner, also resolve through CoWShed proxies

> **Questions to resolve:**
> - What is the exact event name and structure for CoWShed proxy creation?
> - Is `COWShedBuilt` the correct event or is it named differently?
> - Are there multiple factory versions?

### S3.4 — Unified Owner Resolution
**Goal:** Single system to resolve "true owner" for any order

- [ ] Schema: `ownerMapping` table or view combining CoWShed + flash loan mappings
- [ ] API: query orders by EOA and get all orders across direct ownership, CoWShed proxies, and flash loan helpers
- [ ] GraphQL: add owner resolution to order queries

---

## Sprint 4 — M2 Wrap-up & Orderbook Integration Start (Week 4)

### S4.1 — Milestone 2 Validation (first half of week)
**Goal:** Verify M2 deliverables

- [ ] Test flash loan helper → owner mapping end-to-end
- [ ] Test CoWShed proxy → owner mapping end-to-end
- [ ] Test unified owner resolution queries
- [ ] Test fallback solution on chains without call trace support
- [ ] Prepare M2 demo/summary for Anxo review

### S4.2 — Orderbook Integration: Signature Decoding
**Goal:** Decode EIP-1271 signatures to link orderbook orders to composable cow orders

- [ ] Implement signature decoding (reuse/adapt from PoC repo):
  - Check for Safe's `safeSignature` selector
  - Decode Safe signature to extract payload
  - Decode ComposableCoW payload (proof, params, offchainInput)
  - Hash params and match with indexed conditional orders
- [ ] Schema: `order` table (orderUid, conditionalOrderId, chainId, status, fillAmount, etc.)
- [ ] Schema: relations between `order` and `conditionalOrderGenerator`
- [ ] Unit tests for signature decoding against known orders

### S4.3 — Research: Orderbook API Integration
**Goal:** Understand orderbook API requirements and caching strategy

- [ ] Document orderbook API endpoints needed (historical orders, current auction, order by UID)
- [ ] Test API access (do we have credentials/access?)
- [ ] Design persistent cache layer for off-chain API responses
- [ ] Plan polling strategy for live data

> **Questions to resolve:**
> - Which orderbook API endpoints do we need?
> - Do we need access to the "current auction" endpoints?
> - How to handle rate limiting?
> - What's the data format for orderbook responses?

---

## Sprint 5 — Orderbook Polling & Trade Event Matching (Week 5)

### S5.1 — Persistent Off-Chain Cache Layer
**Goal:** Cache orderbook API responses across Ponder redeployments

- [ ] Design cache storage (separate PostgreSQL table? Redis? File-based?)
- [ ] Implement cache middleware for orderbook API requests
- [ ] Cache invalidation strategy
- [ ] Verify cache survives Ponder redeployments
- [ ] Performance testing: cache hit rates, latency

### S5.2 — Trade Event Handler
**Goal:** Track executed orders via on-chain trade events

- [ ] Handler for `GPv2Settlement:Trade` event
- [ ] Decode trade event: extract orderUid, owner, sellToken, buyToken, amounts, etc.
- [ ] Match trade to conditional order via signature decoding
- [ ] Update order status (filled, partially filled)
- [ ] Schema update: add trade/execution data to order table

### S5.3 — Orderbook API Polling
**Goal:** Fetch and sync orderbook data for composable cow orders

- [ ] Implement polling service for orderbook API
- [ ] Fetch orders for known composable cow owners
- [ ] Match fetched orders to indexed conditional orders
- [ ] Handle both historical (backfill) and live (real-time) modes
- [ ] Rate limiting and error handling

---

## Sprint 6 — Unfilled/Expired Parts & Block Handler (Week 6)

### S6.1 — Block Handler for Tradable Order Generation
**Goal:** Detect unfilled/expired discrete parts using watch-tower style logic

- [ ] Implement block handler that calls `getTradableOrder` on active conditional orders
- [ ] Integrate cow-sdk `PollResultErrors` to optimize:
  - `TRY_NEXT_BLOCK` → check next block
  - `TRY_AT_EPOCH` → schedule check at specific timestamp
  - `DONT_TRY` → stop checking
- [ ] Store "next check" metadata per conditional order
- [ ] Generate orderUid for expected-but-unfilled parts (TWAP)
- [ ] Mark unfilled parts with appropriate status

### S6.2 — Block Handler Optimization
**Goal:** Ensure block handler is performant enough for production

- [ ] Minimize RPC calls per block (batch calls, smart scheduling)
- [ ] Only check orders that are "due" based on PollResultErrors
- [ ] Benchmark: how many orders can we process per block?
- [ ] Handle edge cases: reorgs, missed blocks, handler reverts

### S6.3 — Order Status Tracking
**Goal:** Complete order lifecycle tracking

- [ ] States: pending, active, partially_filled, filled, expired, cancelled
- [ ] For TWAP: track individual part status (n of m parts filled)
- [ ] For Perpetual Swap: track ongoing execution
- [ ] GraphQL: filter orders by status
- [ ] GraphQL: get order execution history/timeline

---

## Sprint 7 — M3 Finalization & Documentation Start (Week 7)

### S7.1 — Orderbook Integration Finalization
**Goal:** Complete and stabilize orderbook integration

- [ ] End-to-end testing: composable cow creation → order generation → trade → status update
- [ ] Verify unfilled/expired parts are correctly tracked
- [ ] Verify signature decoding matches orders correctly
- [ ] Edge cases: orders with merkle proofs, multiple handlers, cross-chain
- [ ] Performance: indexing speed with block handler + trade events + API polling
- [ ] Prepare M3 demo/summary for Anxo review

### S7.2 — Streaming API (SSE/WS)
**Goal:** Real-time order updates for frontend integration

- [ ] Research Ponder's real-time capabilities (`usePonderQuery`, subscriptions)
- [ ] Implement SSE or WebSocket endpoint for order changes
- [ ] Events: order created, filled, partially filled, expired, cancelled
- [ ] Filter by owner, order type, chain
- [ ] Test with frontend consumption patterns

> **Questions to resolve:**
> - Does Ponder natively support real-time subscriptions?
> - SSE vs WebSocket — what does the CoW frontend prefer?
> - What event format does Sasha's team expect?

### S7.3 — API Hardening
**Goal:** Production-ready API

- [ ] Error handling and validation
- [ ] Rate limiting on API endpoints
- [ ] Health check endpoint
- [ ] Pagination optimization
- [ ] Response caching for frequently queried data

---

## Sprint 8 — Review & Documentation (Week 8)

### S8.1 — Technical Review with Anxo
**Goal:** Pass technical review, fix any issues

- [ ] Schedule review sessions with @anxolin
- [ ] Address feedback and fix bugs
- [ ] Performance benchmarks and optimization if needed
- [ ] Security review: any sensitive data exposure?

### S8.2 — API Documentation
**Goal:** Complete GraphQL API documentation

- [ ] GraphQL schema documentation (all types, queries, mutations)
- [ ] Query examples for common use cases:
  - Get all TWAP orders for an address
  - Get order status with all parts
  - Find flash loan orders by EOA
  - Search orders via CoWShed proxy
- [ ] Error codes and handling documentation
- [ ] Rate limiting documentation

### S8.3 — Integration Guides
**Goal:** Enable frontend and third-party integration

- [ ] Integration guide for CoW Swap frontend team
- [ ] Integration guide for third-party developers
- [ ] Streaming API usage guide
- [ ] Example code snippets (TypeScript, Python)

### S8.4 — Deployment & Handoff Documentation
**Goal:** CoW Protocol team can run and maintain the system

- [ ] README: how to run locally (dev mode)
- [ ] README: how to deploy to production
- [ ] Environment variables documentation
- [ ] Database setup and migration guide
- [ ] Monitoring and troubleshooting guide
- [ ] Architecture overview diagram

---

## Cross-Sprint Dependencies & Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Block handler performance | Slow indexing, unusable in production | Early benchmarking (S6), optimize per-block work |
| Orderbook API access | Can't integrate without access | Request access early (S1), design with mocks |
| Decoder implementation delays | M1 delivery blocked | cow-sdk is reference only; decoders are local (scope per forum Update #2) |
| MFW composable cow changes | Indexing logic may change | Monitor upstream, design for flexibility |
| RPC costs / rate limits | Slow or failed indexing | Use CoW's private RPC, batch calls, caching |
| Call trace support per chain | Flash loan Solution 1 may not work everywhere | Solution 2 as fallback |

---

## Key Metrics for Success

- All 5 composable cow order types decoded and queryable
- Flash loan and CoWShed ownership correctly resolved
- < 30s latency from on-chain event to API availability
- All historical orders indexed (mainnet, gnosis, arbitrum)
- API handles 100+ concurrent queries
- Documentation sufficient for CoW frontend team to integrate
