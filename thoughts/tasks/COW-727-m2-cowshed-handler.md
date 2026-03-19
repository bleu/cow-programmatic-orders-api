---
status: todo
linear_synced: true
linear_id: COW-727
linear_url: https://linear.app/bleu-builders/issue/COW-727/handler-cowshed-proxy-eoa-mapping-cowshedbuilt
created: 2026-03-06
priority: medium
estimate: 3
labels: [feature, M2, handler]
depends_on: [DRAFT-m2-save-abis, DRAFT-m2-ponder-config-contracts, DRAFT-m2-owner-mapping-schema]
---

# Handler: CoWShed proxy → EOA mapping (COWShedBuilt)

## Problem
When a user deploys a CoWShed proxy via CoWShedFactory, the proxy address becomes the `owner` field in composable cow orders — not the user's EOA. We need to index the `COWShedBuilt` event to record this proxy→EOA relationship so orders can be queried by the controlling wallet.

## Details
- **Event**: `COWShedBuilt(address user, address shed)` — **neither param is indexed** (confirmed in contract research — do not filter by topic)
- `user` = EOA (true owner), `shed` = proxy address
- Insert into `owner_mapping`:
  ```
  { address: shed, chainId, eoaOwner: user, addressType: 'cowshed_proxy', txHash, blockNumber, resolutionDepth: 0 }
  ```
- Use `onConflictDoNothing()` — proxy addresses are unique, but handle duplicates gracefully
- Handler file: `src/application/handlers/cowshed.ts`
- Follow the pattern in `src/application/handlers/composableCow.ts`

## Acceptance Criteria
- [ ] Handler file created at `src/application/handlers/cowshed.ts`
- [ ] All historical `COWShedBuilt` events on mainnet are indexed into `owner_mapping`
- [ ] Querying `owner_mapping` by a known CoWShed proxy address returns the correct EOA
- [ ] `pnpm typecheck` and `pnpm lint` pass

## References
- Source: `thoughts/prompts/m2-linear-tasks-prompt.md`
- Contract research: `thoughts/reference_docs/m2-contract-research.md` §1
- Pattern reference: `src/application/handlers/composableCow.ts`
