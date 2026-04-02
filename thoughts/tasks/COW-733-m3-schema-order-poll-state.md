---
status: todo
linear_synced: true
created: 2026-03-06
milestone: M3
estimate: 1
labels: [schema, feature]
linear_url: https://linear.app/bleu-builders/issue/COW-733/schema-add-orderpollstate-table-for-block-handler-scheduling
git_branch: jefferson/cow-733-schema-add-orderpollstate-table-for-block-handler-scheduling
---

# Schema: add orderPollState table for block handler scheduling

## Problem

The M3 block handler needs to call `getTradableOrder` on active composable cow orders — but calling it on every order every block would be prohibitively expensive. The `order_poll_state` table enables PollResultErrors-based per-order scheduling: each order self-schedules its next check time, so the block handler only processes orders that are actually due.

## Details

```typescript
// order_poll_state — per-order scheduling state for the block handler
//   conditionalOrderGeneratorEventId  text     — (PK part, matches conditionalOrderGenerator.eventId)
//   chainId                           integer  — (PK part)
//   nextCheckBlock                    bigint   — skip this order until this block number
//   lastCheckBlock                    bigint   — last block we actually processed
//   lastPollResult                    text     — raw PollResultErrors string (for debugging)
//   isActive                          boolean  — false = DONT_TRY received; stop scheduling
```

- Composite PK: `(chainId, conditionalOrderGeneratorEventId)`
- Insert record with `nextCheckBlock = 0, isActive = true` when a new conditional order is created
  - Wire into M1 composableCow handler (or as separate step in M3 handler)

## Implementation Notes

- File to edit: `schema/tables.ts`
- Run `pnpm codegen` after changes

**Index required for the block handler:** The block handler runs **every block** and needs the query "which orders are due now?" (`nextCheckBlock <= currentBlock AND isActive = true`). This query runs every time a block is processed — it **must be indexed** and fast, or the indexer will be slow. E.g. index on `(isActive, nextCheckBlock)` or whatever Ponder/schema recommends for this filter. **Warning:** do not implement without an index; a per-block query without an index makes the block handler unusable in production.

## Acceptance Criteria

- Table defined in `schema/tables.ts`
- **Index** created for the block handler query (orders due: `nextCheckBlock <= N` and `isActive = true`) — verify the query is fast
- `pnpm codegen` and `pnpm typecheck` pass

## Dependencies

None — can be done in parallel with Tasks 1, 2, 4.

## References

- Source: `thoughts/prompts/m3-linear-tasks-prompt.md` Task 3
- Macro plan: `thoughts/plans/2026-03-06-milestone-3-macro-plan.md` Phase C
- PollResultErrors reference: https://github.com/cowprotocol/cow-sdk/blob/main/packages/composable/src/orderTypes/Twap.ts#L354
