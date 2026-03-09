---
status: todo
linear_synced: true
linear_id: COW-729
linear_url: https://linear.app/bleu-builders/issue/COW-729/graphql-owner-resolution-for-proxyadapter-addresses
created: 2026-03-06
priority: medium
estimate: 2
labels: [feature, M2, api]
depends_on: [DRAFT-m2-cowshed-handler, DRAFT-m2-aave-flash-loan-handler]
---

# GraphQL: owner resolution for proxy/adapter addresses

## Problem
Currently, `conditionalOrderGenerators(owner: "0xEOA")` only returns orders where `owner` exactly matches the queried address. Orders placed via CoWShed proxies or AAVE adapters are invisible to the controlling EOA. This breaks the primary user-facing query pattern for M2 users.

## Details
- **What changes**: `conditionalOrderGenerators(owner: "0xEOA")` should return orders where `conditionalOrderGenerator.owner` either:
  - Matches the EOA directly, OR
  - Is an address in `owner_mapping` where `eoaOwner` matches the EOA
- This is a **query-layer change only** — no new indexing logic
- Optionally expose an `ownerMappings(eoaOwner: "0x...")` query for debugging/introspection

## Acceptance Criteria
- [ ] A TWAP order created via a CoWShed proxy is queryable by the controlling EOA
- [ ] A flash loan order where `adapter.owner` is an EOA is queryable by that EOA
- [ ] Direct EOA orders are unaffected (still returned correctly)
- [ ] `pnpm typecheck` and `pnpm lint` pass

## References
- Source: `thoughts/prompts/m2-linear-tasks-prompt.md`
- API layer: `src/api/index.ts`
- Macro plan: `thoughts/plans/2026-03-06-milestone-2-macro-plan.md`
