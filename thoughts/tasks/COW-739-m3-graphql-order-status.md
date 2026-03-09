---
status: draft
linear_synced: false
created: 2026-03-06
milestone: M3
estimate: 2
labels: [api, feature]
---

# GraphQL API: expose discrete order status and execution summary

## Problem

Once M3 indexing is complete, the data is in the database but not queryable by API consumers. The GraphQL layer needs to expose discrete orders and execution summaries so that integrators can query "what happened to this TWAP order?" — including which parts filled, which expired, and what amounts were traded.

## Details

**No new indexing** — query layer only. All data is produced by Tasks 6, 7, 8.

**New queries and fields:**
- On `conditionalOrderGenerator`: add nested `discreteOrders` field (list of `discreteOrder`)
- Add `executionSummary` computed field: `{ totalParts, filledParts, openParts, unfilledParts, expiredParts }`
- Top-level query: `discreteOrders(owner: String, status: DiscreteOrderStatus, orderType: OrderType)` — paginated
- **Owner resolution:** queries accepting `owner` must resolve through `owner_mapping` (M2) — EOA → proxy/adapter → match

**Status enum:**
```graphql
enum DiscreteOrderStatus {
  open
  fulfilled
  unfilled
  expired
  cancelled
}
```

**File:** `src/api/index.ts` (extend existing Hono/GraphQL setup)

## Acceptance Criteria

- `conditionalOrderGenerator { discreteOrders { orderUid status sellAmount buyAmount filledAtBlock } }` works in GraphQL playground
- `discreteOrders(owner: "0xEOA", status: fulfilled)` returns orders placed via CoWShed proxy for that EOA
- `pnpm typecheck` passes

## Dependencies

- Task 6 (trade event handler — fills data)
- Task 7 (orderbook polling — open/expired data)
- Task 8 (block handler — unfilled/expired data)

## References

- Source: `thoughts/prompts/m3-linear-tasks-prompt.md` Task 9
- Macro plan: `thoughts/plans/2026-03-06-milestone-3-macro-plan.md` Phase E
- Architecture: `agent_docs/architecture.md`
