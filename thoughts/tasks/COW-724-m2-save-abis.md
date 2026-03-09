---
status: todo
linear_synced: true
linear_id: COW-724
linear_url: https://linear.app/bleu-builders/issue/COW-724/save-m2-abis-to-codebase
created: 2026-03-06
priority: medium
estimate: 1
labels: [chores, M2]
depends_on: []
---

# Save M2 ABIs to codebase

## Problem
The M2 contract research produced ABI definitions for CoWShedFactory, AaveV3AdapterFactory, AaveV3AdapterHelper (per-user adapter), and GPv2Settlement. These need to be committed as TypeScript `as const` exports in `abis/` so that Ponder handlers and viem calls can use them with full type safety.

## Details
- `abis/CoWShedFactoryAbi.ts` — from contract research §1 (emits `COWShedBuilt(address user, address shed)`)
- `abis/AaveV3AdapterFactoryAbi.ts` — from contract research §2
- `abis/AaveV3AdapterHelperAbi.ts` — from contract research §2 (per-user adapter; exposes `FACTORY()` and `owner()`)
- `abis/GPv2SettlementAbi.ts` — from contract research §3 (includes `Trade` and `OrderInvalidated` events)
- Format: TypeScript `as const` exports, matching the pattern in `abis/ComposableCowAbi.ts`

## Acceptance Criteria
- [ ] All four files exist under `abis/` and export correctly typed ABIs
- [ ] `pnpm typecheck` passes

## References
- Source: `thoughts/prompts/m2-linear-tasks-prompt.md`
- ABI definitions: `thoughts/reference_docs/m2-contract-research.md`
- Pattern reference: `abis/ComposableCowAbi.ts`
