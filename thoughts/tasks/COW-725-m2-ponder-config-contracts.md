---
status: todo
linear_synced: true
linear_id: COW-725
linear_url: https://linear.app/bleu-builders/issue/COW-725/add-cowshedfactory-and-gpv2settlement-to-ponder-config
created: 2026-03-06
priority: medium
estimate: 1
labels: [chores, M2]
depends_on: [DRAFT-m2-save-abis]
---

# Add CoWShedFactory and GPv2Settlement to Ponder config

## Problem
CoWShedFactory and GPv2Settlement need to be wired into `src/data.ts` and `ponder.config.ts` so Ponder will index their events. Without this, no handlers for M2 can run.

## Details
- **CoWShedFactory**: address `0x312f92fe5f1710408b20d52a374fa29e099cfa86`, start block `22939254`
- **GPv2Settlement**: address `0x9008D19f58AAbD9eD0D60971565AA8510560ab41`, start block `17883049`
  - Use 17883049 (ComposableCoW start), NOT 12593265 (Settlement genesis) — starting from genesis would sync 2+ years of unrelated trades
- **AaveV3AdapterFactory** does NOT need a Ponder config entry — it emits no useful events; adapters are detected via Trade events (see Task 5)
- Both contracts are mainnet only
- Run `pnpm codegen` after config changes

## Acceptance Criteria
- [ ] `src/data.ts` has entries for both contracts with correct addresses and start blocks
- [ ] `ponder.config.ts` references both contracts with their ABIs
- [ ] `pnpm codegen` completes without errors
- [ ] `pnpm typecheck` passes

## References
- Source: `thoughts/prompts/m2-linear-tasks-prompt.md`
- Contract addresses & start blocks: `thoughts/reference_docs/m2-contract-research.md`
- Pattern reference: `src/data.ts`, `ponder.config.ts`
