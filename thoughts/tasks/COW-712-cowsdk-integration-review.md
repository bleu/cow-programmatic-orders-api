---
linear_id: COW-712
linear_url: https://linear.app/bleu-builders/issue/COW-712/cow-sdk-review-and-decoder-integration-planning
status: Todo
linear_synced: true
created: 2026-02-27
milestone: M1
sprint: S1
priority: 3
estimate: 1
depends_on: []
---

# cow-sdk Review & Decoder Integration Planning

## Problem

The grant requires integrating missing conditional order types into cow-sdk. Before implementing decoders, we need to understand:
- What's already available in cow-sdk
- What's missing and needs implementation
- Whether to implement locally first or contribute upstream immediately

This research task unblocks the decoder tasks in Sprint 2.

## Scope

- [ ] Review cow-sdk composable package structure
- [ ] Document which order types have decoders
- [ ] Identify exact gaps (decoders, encoders, types)
- [ ] Review `PollResultErrors` pattern for future use (M3)
- [ ] Decide: local implementation vs upstream PR
- [ ] Document findings for decoder tasks

## Technical Details

### cow-sdk Composable Package Location

```
cow-sdk/packages/composable/src/
├── orderTypes/
│   ├── Twap.ts          # TWAP implementation
│   ├── StopLoss.ts?     # Need to verify
│   └── ...
├── types.ts             # Type definitions, PollResultErrors
└── index.ts
```

### Key Files to Review

1. **Order type implementations** — What order types exist?
   - `packages/composable/src/orderTypes/`
   - Check for: Twap, StopLoss, PerpetualSwap, GoodAfterTime, TradeAboveThreshold

2. **Type definitions** — What interfaces exist?
   - `packages/composable/src/types.ts` (line 183 for PollResultErrors)

3. **Static input decoding** — How does TWAP decode `staticInput`?
   - Look for `decodeStaticInput` or similar functions

4. **PollResultErrors** — Watch-tower style polling pattern
   - `TRY_NEXT_BLOCK`, `TRY_AT_EPOCH`, `DONT_TRY`
   - Needed for M3 block handler optimization

### Questions to Answer

| Question | Answer |
|----------|--------|
| Is TWAP decoder available? | Expected: Yes |
| Is Stop Loss decoder available? | Expected: No (grant says "all except TWAP" missing) |
| Is Perpetual Swap decoder available? | Expected: No |
| Is Good After Time decoder available? | Expected: No |
| Is Trade Above Threshold decoder available? | Expected: No |
| What's the decoder interface/pattern? | TBD |
| Are encoders also missing? | TBD |

### Decision: Local vs Upstream

**Factors to consider:**
- Upstream contribution delays could block M1
- Local implementation allows faster iteration
- Eventually want everything in cow-sdk for ecosystem benefit

**Recommended approach (from Slack decisions):**
> "Implement locally first, upstream later"

This means:
1. Implement decoders in this project for M1
2. After grant completion, contribute back to cow-sdk
3. Structure code so it can be easily ported

### Output: Decoder Planning Document

Create a summary document with:
- Available decoders in cow-sdk
- Missing decoders we need to implement
- Interface pattern to follow
- Static input ABI for each order type
- Implementation priority

## Acceptance Criteria

- [ ] cow-sdk composable package reviewed
- [ ] All 5 order types assessed (available vs missing)
- [ ] Decoder interface pattern documented
- [ ] Static input struct for each order type documented (if found)
- [ ] Decision documented: local implementation for M1
- [ ] Findings shared with team

## Open Questions

- [ ] What's the contribution process for cow-sdk?
- [ ] Are there existing tests we can reference?
- [ ] Should we mirror cow-sdk's interface for easier porting?

## References

- cow-sdk repo: https://github.com/cowprotocol/cow-sdk
- cow-sdk Twap.ts: https://github.com/cowprotocol/cow-sdk/blob/main/packages/composable/src/orderTypes/Twap.ts
- cow-sdk types.ts: https://github.com/cowprotocol/cow-sdk/blob/main/packages/composable/src/types.ts
- Slack Decisions (cow-sdk section): `thoughts/reference_docs/slack_decisions_summary.md`
- Sprint Plan S1.4: `thoughts/plans/sprint_plan.md`
