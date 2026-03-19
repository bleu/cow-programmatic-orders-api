---
status: todo
linear_synced: true
linear_id: COW-730
linear_url: https://linear.app/bleu-builders/issue/COW-730/m2-end-to-end-validation-against-mainnet-data
created: 2026-03-06
priority: medium
estimate: 2
labels: [chores, M2]
depends_on: [DRAFT-m2-graphql-owner-resolution]
---

# M2 end-to-end validation against mainnet data

## Problem
Before marking M2 complete, we need to confirm that CoWShed and AAVE adapter indexing works correctly against real mainnet data and that the grant deliverables are met.

## Details
**Validation checklist:**
- Find a known CoWShed user on mainnet — verify their proxy is in `owner_mapping` with correct EOA
- Find a known AAVE flash loan order on mainnet (AaveV3AdapterFactory deployed at block 23812751) — verify the adapter is in `owner_mapping` with correct EOA
- Query GraphQL by EOA — confirm orders from both proxy types are returned
- Verify `eoaOwner` values in `owner_mapping` are always EOAs (no contracts stored as owners)
- Verify `resolutionDepth` is `0` for CoWShed, `1` for AAVE adapters

**Reference blocks:**
- CoWShedFactory deployed: block 22939254 (use as CoWShed validation starting point)
- AaveV3AdapterFactory deployed: block 23812751 (use as AAVE validation starting point)

**After validation:**
- Add summary notes to `thoughts/reference_docs/m2-contract-research.md` under a new "Validation" section

## Acceptance Criteria
- [ ] All items in validation checklist confirmed on mainnet
- [ ] Validation summary notes added to `thoughts/reference_docs/m2-contract-research.md`

## References
- Source: `thoughts/prompts/m2-linear-tasks-prompt.md`
- Contract research: `thoughts/reference_docs/m2-contract-research.md`
- Macro plan: `thoughts/plans/2026-03-06-milestone-2-macro-plan.md`
