---
status: draft
linear_synced: false
created: 2026-03-06
milestone: M3
estimate: 2
labels: [schema, feature]
---

# Schema: add orderbook_cache table (persistent across Ponder resyncs)

## Problem

Ponder drops all `onchainTable`-managed tables on a full resync. The orderbook API is an external dependency that we cannot re-query for all historical data on every resync — especially for perpetual swaps whose UIDs are non-deterministic. We need a persistent cache table that survives resyncs, so repeated Ponder redeployments don't hammer the CoW orderbook API.

## Details

```typescript
// orderbook_cache — persists orderbook API responses across Ponder redeployments
//   cacheKey      text     — PK: hash or composite of (endpoint + owner + orderUid)
//   responseJson  json     — full API response object
//   fetchedAt     bigint   — unix timestamp of last fetch
```

**Critical:** This table must NOT be an `onchainTable`. It must survive Ponder resyncs.

- Create as a plain Drizzle/PostgreSQL table outside of Ponder's sync-managed schema
- Use a Ponder `onApplicationStart` hook (or similar startup mechanism) to ensure the table exists before handlers run
- Intentionally excluded from Ponder's resync lifecycle — persists until DB is fully dropped

**Cache policy:**
- Orders in terminal states (`fulfilled`, `expired`, `cancelled`): cached indefinitely (terminal states cannot change)
- Open orders: not cached — always re-fetched

## Implementation Notes

- File additions: `schema/tables.ts` (or separate migration file)
- Startup hook to ensure table exists before handlers run
- Validate by: run `pnpm dev`, populate cache, simulate resync, confirm table not wiped

## Acceptance Criteria

- Table exists and persists after `pnpm dev` restart
- Table is NOT dropped during a Ponder full resync simulation
- `pnpm typecheck` passes

## Dependencies

None — can be done in parallel with Tasks 1, 2, 3.

## References

- Source: `thoughts/prompts/m3-linear-tasks-prompt.md` Task 4
- Macro plan: `thoughts/plans/2026-03-06-milestone-3-macro-plan.md` Phase D
