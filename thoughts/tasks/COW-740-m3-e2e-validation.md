---
status: draft
linear_synced: false
created: 2026-03-06
milestone: M3
estimate: 2
labels: [chores, feature]
---

# M3 end-to-end validation against real mainnet data

## Problem

M3 has four interacting subsystems (decoder, trade event handler, polling, block handler) and a persistent cache that must survive Ponder resyncs. Without a structured end-to-end validation pass against real mainnet data, subtle issues (wrong status, missing FK links, cache being dropped on resync) can go undetected until after handoff to CoW Protocol.

## Details

**Validation checklist:**
- [ ] Find a TWAP order on mainnet with multiple filled parts → verify all filled parts in `discrete_order` with `status: fulfilled` and correct amounts
- [ ] Find a TWAP order where some parts expired → verify those parts appear with `status: expired` or `unfilled`
- [ ] Verify decoded `handler` addresses match constants in `src/data.ts`
- [ ] Verify `eip1271` filter correctly excludes non-composable-cow orders from same owner
- [ ] Query GraphQL by EOA → confirm orders across CoWShed proxies appear with their discrete parts
- [ ] Trigger a Ponder resync with populated `orderbook_cache` → verify cache is NOT wiped
- [ ] Known limitation documented: TWAP parts that expired before deployment date are not tracked

**Reference test data:**
- Owner `0xf486a56311a09e3e4abba4a3e136afb02e0a576d` has 25 eip1271 orders on mainnet (from API research)
- Example orders: `tmp/m3-research/example-orders-by-owner.json`

## Acceptance Criteria

- All checklist items confirmed against live mainnet data
- Known limitation (no historical unfilled/expired parts before deployment date) noted in API documentation stub (will be completed in M4)

## Dependencies

- Task 9 (GraphQL layer — all M3 indexing must be complete)

## References

- Source: `thoughts/prompts/m3-linear-tasks-prompt.md` Task 10
- Macro plan: `thoughts/plans/2026-03-06-milestone-3-macro-plan.md` §8 (Done Criteria)
- API research: `thoughts/reference_docs/m3-orderbook-api-research.md`
- Example data: `tmp/m3-research/example-orders-by-owner.json`
