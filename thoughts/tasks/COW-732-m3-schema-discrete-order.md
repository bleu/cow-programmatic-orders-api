---
status: draft
linear_synced: false
created: 2026-03-06
milestone: M3
estimate: 1
labels: [schema, feature]
---

# Schema: fill in discreteOrder table

## Problem

The `discreteOrder` table was stubbed in M1 but left empty — it has no columns beyond the PK. M3 requires this table to record every discrete execution of a composable cow order (filled parts, unfilled parts, expired parts). Without the complete schema, no M3 handler can write results.

## Details

Complete table definition (snake_case per code-patterns.md):

```typescript
// discrete_order — one row per discrete part of a composable cow order
//   orderUid                    text     — the 56-byte order UID (PK part)
//   chainId                     integer  — (PK part)
//   conditionalOrderGeneratorId text     — FK to conditional_order_generator
//   status                      enum     — open | fulfilled | unfilled | expired | cancelled
//   partIndex                   integer  — for TWAP: 0-indexed part number; null for others
//   sellAmount                  text     — actual sell amount (decimal string)
//   buyAmount                   text     — actual buy amount
//   feeAmount                   text     — fee amount
//   filledAtBlock               bigint   — block number when filled (null if not filled)
//   detectedBy                  enum     — trade_event | orderbook_api | block_handler
//   creationDate                text     — ISO 8601 from API response
```

- Composite PK: `(chainId, orderUid)`
- Index on `conditionalOrderGeneratorId` for reverse lookups
- Index on `status` for filtering active orders
- `status` and `detectedBy` as Ponder enums

## Implementation Notes

- File to edit: `schema/tables.ts`
- Run `pnpm codegen` after changes to regenerate `ponder-env.d.ts`

## Acceptance Criteria

- `schema/tables.ts` updated with complete `discreteOrder` definition
- `pnpm codegen` and `pnpm typecheck` pass

## Dependencies

None — can be done in parallel with Tasks 1, 3, 4.

## References

- Source: `thoughts/prompts/m3-linear-tasks-prompt.md` Task 2
- Macro plan: `thoughts/plans/2026-03-06-milestone-3-macro-plan.md` §5
- Patterns: `agent_docs/code-patterns.md`
