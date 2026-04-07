---
status: todo
linear_synced: true
created: 2026-03-06
milestone: M3
estimate: 3
labels: [handler, feature]
linear_url: https://linear.app/bleu-builders/issue/COW-738/block-handler-unfilledexpired-detection-via-pollresulterrors
git_branch: jefferson/cow-738-block-handler-unfilledexpired-detection-via-pollresulterrors
---

# Block handler: unfilled/expired detection via PollResultErrors

## Problem

For TWAP and other composable cow orders, discrete parts can expire with no on-chain event if no solver picks them up. The watch-tower pattern (used by CoW Protocol off-chain) calls `getTradableOrder` on each order to determine whether a part is currently tradeable, and uses PollResultErrors revert reasons to self-schedule the next check. Without this block handler, M3 has no way to detect unfilled or expired TWAP parts after the deployment date.

## Details

**Key decisions:**
- Does NOT run during historical backfill — only from deployment block onward
- Only processes orders where `nextCheckBlock <= currentBlock` (from `order_poll_state`)
- Uses viem multicall to batch `getTradableOrder` calls per block

**PollResultErrors outcomes — only persist “when is the next run”:** For each error/revert, do not store the error itself for scheduling logic; store **only** what defines the next time this order should be checked (i.e. update only `nextCheckBlock` and `isActive` when DONT_TRY). The `lastPollResult` field (if present) is optional/debug only.

- Returns an order → upsert `discrete_order` with `status: "open"`, `detectedBy: "block_handler"`; update `nextCheckBlock` per rule (e.g. next block or order's next epoch).
- Reverts `TRY_NEXT_BLOCK` → set `nextCheckBlock = currentBlock + 1`
- Reverts `TRY_AT_EPOCH(t)` → set `nextCheckBlock` to block where `timestamp >= t`
- Reverts `DONT_TRY` or `DONT_TRY_WITH_REASON` → set `order_poll_state.isActive = false`; also update `conditionalOrderGenerator.status` (see "Order finalisation on DONT_TRY" below)
- Unknown revert → treat as `TRY_NEXT_BLOCK` (never crash handler)

**Order finalisation on DONT_TRY:**

When `DONT_TRY` / `DONT_TRY_WITH_REASON` is received, the order is permanently done. The implementing agent must decide how to reflect this in `conditionalOrderGenerator.status`. Two options — discuss with Jefferson before implementing:

**Decision:** Use a single `"Invalid"` status (Option A). No separate "Cancelled" / "Expired" statuses are required. On `DONT_TRY` / `DONT_TRY_WITH_REASON`, mark `conditionalOrderGenerator.status = "Invalid"` — no `singleOrders` RPC call needed. The `removalPoller.ts` handler and its `RemovalPoller` block config in `ponder.config.ts` are now redundant and should be removed as part of this task.

**Research item for the implementing agent:**
- Does `DONT_TRY_WITH_REASON` carry a reason string? If so, does it map cleanly to a sub-reason (e.g. "cancelled" vs "expired")? This is low priority given the decision above, but worth a quick look — if the reason is free, it could be stored as a debug field without changing the status model.

**New files:**
- `src/application/handlers/blockHandler.ts` — the block handler
- `src/application/helpers/pollResultErrors.ts` — parse revert reasons into typed PollResultErrors values

**order_poll_state wiring:** When a new `conditionalOrderGenerator` is created (M1 handler), insert a corresponding `order_poll_state` row with `nextCheckBlock = deploymentBlock, isActive = true`.

**Query every block:** The block handler runs every block and must answer "which orders can we monitor now?". This lookup on `order_poll_state` (e.g. `nextCheckBlock <= currentBlock AND isActive = true`) is run **once per block** — it must be indexed and very fast (see schema task COW-733: index required). Avoid heavy or unindexed queries or the indexer will not scale.

## Acceptance Criteria

- For a TWAP order with N parts, after deployment date, unfilled parts appear in `discrete_order` with `status: "unfilled"` or `"expired"`
- Block handler only processes orders where `nextCheckBlock <= currentBlock` (verified by logging)
- Only "next run" is persisted from each PollResultError (nextCheckBlock / isActive), not full error history for scheduling
- Query "which orders are due this block?" uses indexed lookup (see COW-733) — confirm it is fast
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
