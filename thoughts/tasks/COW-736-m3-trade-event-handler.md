---
status: draft
linear_synced: false
created: 2026-03-06
milestone: M3
estimate: 3
labels: [handler, feature]
---

# Trade event handler: discrete order matching and status tracking

## Problem

After M1+M2 we know which composable cow orders were *created*, but not whether they *executed*. The `GPv2Settlement:Trade` event is the authoritative on-chain signal that a discrete order part was filled. Without a handler for this event, `discrete_order` remains empty and we have no fill data.

## Details

**Handler file:** `src/application/handlers/settlement.ts`
- May already exist from M2 Phase B (AAVE adapter owner mapping) — add Trade logic without removing M2 logic

**Processing flow per `GPv2Settlement:Trade` event:**
1. Extract `orderUid` (bytes → hex string), `owner`, `sellAmount`, `buyAmount`, `feeAmount`, `blockNumber`
2. Check if `owner` is a known composable cow participant:
   - Direct match in `conditionalOrderGenerator.owner`
   - OR present in `owner_mapping.address` (M2 table — CoWShed proxy or AAVE adapter)
   - If neither: skip
3. Check `orderbook_cache` for this `orderUid` (may already be cached from polling)
4. If not in cache: fetch `GET /api/v1/orders/{orderUid}` from API and cache
5. Decode `order.signature` using `decodeEip1271Signature`
6. Verify decoded `handler` is in `COMPOSABLE_COW_HANDLER_ADDRESSES`; if not, skip
7. Compute `hash = keccak256(abi.encode(handler, salt, staticInput))`, look up `conditionalOrderGenerator` by `hash`
8. Upsert into `discrete_order`: `{ orderUid, chainId, conditionalOrderGeneratorId, status: "fulfilled", sellAmount, buyAmount, feeAmount, filledAtBlock, detectedBy: "trade_event" }`

**GPv2Settlement ABI:** `abis/GPv2SettlementAbi.ts` — verify before adding to config.

**Start block:** `17883049` (ComposableCoW genesis) — NOT GPv2Settlement genesis (12593265). Avoids 2+ years of unrelated trades.

## Acceptance Criteria

- A known TWAP order that was filled on mainnet appears in `discrete_order` with `status = "fulfilled"` and correct amounts
- `conditionalOrderGeneratorId` FK is correctly populated
- `pnpm typecheck` and `pnpm lint` pass

## Dependencies

- Task 1 (ERC1271 decoder)
- Task 2 (discreteOrder schema)
- Task 5 (orderbook API client)
- M2 `owner_mapping` table

## References

- Source: `thoughts/prompts/m3-linear-tasks-prompt.md` Task 6
- Macro plan: `thoughts/plans/2026-03-06-milestone-3-macro-plan.md` Phase B
- ABI: `abis/GPv2SettlementAbi.ts`
