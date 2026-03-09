---
status: todo
linear_synced: true
linear_id: COW-726
linear_url: https://linear.app/bleu-builders/issue/COW-726/add-owner-mapping-schema-table-for-m2
created: 2026-03-06
priority: medium
estimate: 1
labels: [feature, M2, schema]
depends_on: []
---

# Add owner_mapping schema table for M2

## Problem
To resolve CoWShed proxies and AAVE flash loan adapters back to their controlling EOA, we need a unified mapping table. Without it, GraphQL queries by EOA will miss orders placed through these proxy contracts.

## Details
Table definition for `schema/tables.ts`:

```typescript
// owner_mapping
//   address          hex     — the proxy or helper contract address (PK part)
//   chainId          integer — (PK part)
//   eoaOwner         hex     — the fully resolved EOA (never an intermediate proxy)
//   addressType      enum    — 'cowshed_proxy' | 'flash_loan_helper'
//   txHash           hex
//   blockNumber      bigint
//   resolutionDepth  integer — hops walked to reach EOA (0 = CoWShed; 1 = AAVE adapter)
```

- Use snake_case column names (per `agent_docs/code-patterns.md`)
- Composite PK on `(address, chainId)`
- Index on `eoaOwner` for reverse lookups
- Add `addressType` enum to schema enums

## Acceptance Criteria
- [ ] `owner_mapping` table compiles in `schema/tables.ts`
- [ ] `addressType` enum defined with values `'cowshed_proxy'` and `'flash_loan_helper'`
- [ ] Composite PK on `(address, chainId)` is defined
- [ ] Index on `eoaOwner` is defined
- [ ] `pnpm codegen` passes
- [ ] `pnpm typecheck` passes

## References
- Source: `thoughts/prompts/m2-linear-tasks-prompt.md`
- Schema conventions: `agent_docs/code-patterns.md`
- Macro plan §4: `thoughts/plans/2026-03-06-milestone-2-macro-plan.md`
