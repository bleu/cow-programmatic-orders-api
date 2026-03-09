---
status: draft
linear_synced: false
created: 2026-03-06
milestone: M3
estimate: 3
labels: [handler, feature]
---

# Block handler: unfilled/expired detection via PollResultErrors

## Problem

For TWAP and other composable cow orders, discrete parts can expire with no on-chain event if no solver picks them up. The watch-tower pattern (used by CoW Protocol off-chain) calls `getTradableOrder` on each order to determine whether a part is currently tradeable, and uses PollResultErrors revert reasons to self-schedule the next check. Without this block handler, M3 has no way to detect unfilled or expired TWAP parts after the deployment date.

## Details

**Key decisions:**
- Does NOT run during historical backfill — only from deployment block onward
- Only processes orders where `nextCheckBlock <= currentBlock` (from `order_poll_state`)
- Uses viem multicall to batch `getTradableOrder` calls per block

**PollResultErrors outcomes:**
- Returns an order → upsert `discrete_order` with `status: "open"`, `detectedBy: "block_handler"`
- Reverts `TRY_NEXT_BLOCK` → set `nextCheckBlock = currentBlock + 1`
- Reverts `TRY_AT_EPOCH(t)` → set `nextCheckBlock` to block where `timestamp >= t`
- Reverts `DONT_TRY` or `DONT_TRY_WITH_REASON` → set `order_poll_state.isActive = false`
- Unknown revert → treat as `TRY_NEXT_BLOCK` (never crash handler)

**New files:**
- `src/application/handlers/blockHandler.ts` — the block handler
- `src/application/helpers/pollResultErrors.ts` — parse revert reasons into typed PollResultErrors values

**order_poll_state wiring:** When a new `conditionalOrderGenerator` is created (M1 handler), insert a corresponding `order_poll_state` row with `nextCheckBlock = deploymentBlock, isActive = true`.

## Acceptance Criteria

- For a TWAP order with N parts, after deployment date, unfilled parts appear in `discrete_order` with `status: "unfilled"` or `"expired"`
- Block handler only processes orders where `nextCheckBlock <= currentBlock` (verified by logging)
- `order_poll_state.isActive` set to `false` when DONT_TRY revert received
- `pnpm typecheck` and `pnpm lint` pass

## Dependencies

- Task 1 (ERC1271 decoder)
- Task 3 (orderPollState schema)

## References

- Source: `thoughts/prompts/m3-linear-tasks-prompt.md` Task 8
- Macro plan: `thoughts/plans/2026-03-06-milestone-3-macro-plan.md` Phase C
- PollResultErrors (TWAP): https://github.com/cowprotocol/cow-sdk/blob/main/packages/composable/src/orderTypes/Twap.ts#L354
- PollResultErrors (types): https://github.com/cowprotocol/cow-sdk/blob/main/packages/composable/src/types.ts#L183
- Decoder reference: `agent_docs/decoder-reference.md`
