---
status: todo
linear_synced: true
linear_id: COW-728
linear_url: https://linear.app/bleu-builders/issue/COW-728/handler-flash-loan-adapter-eoa-mapping-via-gpv2settlement-trade-events
created: 2026-03-06
priority: medium
estimate: 3
labels: [feature, M2, handler]
depends_on: [DRAFT-m2-save-abis, DRAFT-m2-ponder-config-contracts, DRAFT-m2-owner-mapping-schema]
---

# Handler: Flash loan adapter → EOA mapping (via GPv2Settlement Trade events)

## Problem
AAVE flash loan adapters appear as the `owner` in GPv2Settlement Trade events. Each adapter is deployed per-user and exposes `FACTORY()` and `owner()`. Without detecting and mapping these to EOAs, flash loan orders are invisible when querying by the user's wallet.

## Details
**Detection flow** (one-time per new adapter address):

1. Trade event fires with `owner` = some address
2. Check if `owner` is already in `owner_mapping` → if yes, skip
3. Call `publicClient.getCode({ address: owner })` → if empty (`0x`), it's an EOA, skip
4. If contract: call `FACTORY()` on the address using `AaveV3AdapterHelperAbi`
5. If result equals the AaveV3AdapterFactory address from `src/data.ts` (`0xdeCc46a4b09162f5369c5c80383aaa9159bcf192`): it's an AAVE adapter
6. Call `owner()` on the adapter → returns the EOA directly (always 1 hop; no recursion)
7. Insert into `owner_mapping`:
   ```
   { address: owner, chainId, eoaOwner: <result>, addressType: 'flash_loan_helper', txHash, blockNumber, resolutionDepth: 1 }
   ```

**Handler file**: `src/application/handlers/settlement.ts` (new file; M3 will add more logic here)

**Important**: This handler writes to `owner_mapping` only. It does NOT attempt to match trades to composable cow orders — that is M3 scope.

**ABI note**: Use `AaveV3AdapterHelperAbi` for `FACTORY()` and `owner()` calls. The factory address constant must come from `src/data.ts`, not be hardcoded in the handler.

## Acceptance Criteria
- [ ] Handler created at `src/application/handlers/settlement.ts`
- [ ] Given a known AAVE adapter address from a real mainnet trade, querying `owner_mapping` returns the correct EOA
- [ ] Contracts that are NOT AAVE adapters (Safes, other ERC1271 signers) are correctly skipped without erroring
- [ ] `pnpm typecheck` and `pnpm lint` pass

## References
- Source: `thoughts/prompts/m2-linear-tasks-prompt.md`
- Contract research: `thoughts/reference_docs/m2-contract-research.md` §2
- AaveV3AdapterFactory deployed block: 23812751 (for test validation)
- Polygon example (pattern only, we are mainnet): `https://explorer.cow.fi/pol/orders/0x77726d17b9c6834fd79ff1ef65c743bf976cc63fbf51d4ac059b3700a00b631269f36c745e525a75332d00edb1a79edb084f18d26931b166`
