# Orderbook Cache Refactor — Research & Planning Prompt

> **Mode:** Planning & Research only. No implementation code. Deliverables are documents and a validated plan.

---

## Background: The Problem

The team held a call to rethink how the orderbook fetch works. The core hypothesis is:

> We don't need to poll the orderbook API during historical sync. Instead, when a conditional order is first indexed (via `ConditionalOrderCreated` event), we can fetch all of that owner's orders once and persist them — then derive everything else from that snapshot.

After the initial fetch, order status resolution comes from two sources:
1. **`Trade(orderUid)` event** on GPv2Settlement → mark the discrete order as `fulfilled`
2. **Block handler** (`getTradeableOrderWithSignature` multicall) → detect expiry / invalidity via PollResultErrors

The block handler approach already exists (`blockHandler.ts`) but may be reducible once fetch-on-creation is in place. The question is: how much of the current polling architecture survives?

---

## What You Need to Know About This Codebase

**How discrete orders link back to generators:** The `conditionalOrderGenerator.hash` field is `keccak256(abi.encode({handler, salt, staticInput}))` — the ConditionalOrderParams struct hash. When a discrete order arrives (from the API or a Trade event), its EIP-1271 signature is decoded to extract `{handler, salt, staticInput}`, the same hash is recomputed, and a DB lookup on `(chainId, hash)` finds the parent generator. This is the only linkage mechanism — there's no on-chain `orderUid` → generator mapping.

**Current polling flow:** `orderbookPoller.ts` fires every N blocks per chain. For each owner with an Active generator, it fetches `GET /api/v1/account/{owner}/orders`, filters for `signingScheme === "eip1271"`, decodes each signature, computes the params hash, matches to a generator, and upserts a `discrete_order` row. It already skips during backfill (block lag > threshold). Terminal-status owners are cached indefinitely in `orderbook_cache` (raw DDL table that survives Ponder resyncs).

**Block handler flow:** `blockHandler.ts` fires every block. Uses `order_poll_state` to decide which generators are due for a check, multicalls `getTradeableOrderWithSignature` on ComposableCoW, and interprets PollResultError reverts to schedule next checks or deactivate generators.

**Key files:**
- `src/application/handlers/composableCow.ts` — indexes `ConditionalOrderCreated`, stores generator with computed hash
- `src/application/handlers/orderbookPoller.ts` — per-owner API polling, cache, discrete order upsert
- `src/application/handlers/tradeEvent.ts` — Trade event → fulfilled status + discrete order upsert
- `src/application/handlers/blockHandler.ts` — PollResultError-based order lifecycle
- `src/application/handlers/setup.ts` — raw DDL for `orderbook_cache` (survives resyncs)
- `schema/tables.ts` — all table definitions
- `src/constants.ts` — `LIVE_LAG_THRESHOLD_SECONDS`, `RECHECK_INTERVAL`, etc.

---

## Your Tasks

### Task 1 — Document the Current State

Read the source files and produce a markdown document at `thoughts/current-orderbook-flow.md`.

Cover: the full fetch flow, the params-hash linkage, order status transitions, the caching layer, backfill skip logic, and ownership resolution. Include Mermaid diagrams where helpful. **Every claim must cite a file path and function/line — do not assume.**

### Task 2 — Validate the Proposed Architecture

Critically evaluate the team's proposal — do not treat it as ground truth. For each assumption, state whether it is valid, partially valid, or problematic, with codebase references.

Key questions to investigate:
- Is polling during historical sync truly unnecessary? What about first deploy / full re-index scenarios?
- Will Ponder overwrite or invalidate persisted order data on reorg or re-index? (The `orderbook_cache` uses raw DDL precisely to survive resyncs — does the same concern apply to schema-managed tables?)
- Is a single fetch-on-creation sufficient, or can orders appear after the creation event (e.g., TWAP parts created over time)?
- Can orders expire during a gap in indexing (e.g., between deploys)?
- What happens to discrete orders that are in `open` status when we restart? Do they get re-evaluated?

### Task 3 — M3 Alignment Check

Check the M3 grant deliverables documented in `CLAUDE.md` and `thoughts/reference_docs/grant_aligned_summary.md`. Does this refactor serve M3, conflict with it, or fall outside its scope? Be specific about which tasks it touches.

### Task 4 — Produce a Refactor Plan

Save a plan to `thoughts/plan-orderbook-cache-refactor.md`.

Include: recommended architecture (with Mermaid diagram), numbered steps with clear sequencing, what can be deferred, risks, open questions, and any schema changes needed. Keep the plan actionable but don't over-prescribe implementation details — leave room for the implementer to make design decisions.

---

## Constraints

- No implementation code in this session
- Every claim about current behavior must cite a file path or function name
- Flag anything unclear as **"needs team clarification"** rather than assuming
- Do not consult `thoughts/tasks/LOCAL-orderbook-cache-persistence-prod.md` until after forming your own understanding — use it afterward only to cross-check
