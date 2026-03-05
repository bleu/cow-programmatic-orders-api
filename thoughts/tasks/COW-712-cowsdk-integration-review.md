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

# cow-sdk Review & Decoder Planning (Reference Only)

## Problem

Decoders for all five order types are implemented **locally** in this project. The grant scope was revised on the forum ([Update #2](https://forum.cow.fi/t/grant-application-programmatic-orders-api/3346)): *"We're removing the cow-sdk integration for new conditional orders from the scope."* Before implementing decoders, we need to understand:
- What's already available in cow-sdk (as reference, e.g. TWAP)
- What we need to implement locally for each order type
- The decoder interface pattern to follow

This research task unblocks the decoder tasks in Sprint 2.

## Scope

- [ ] Review cow-sdk composable package structure (reference only; no upstream contribution required)
- [ ] Document which order types have decoders we can mirror or reference
- [ ] Document staticInput ABI / struct for each order type
- [ ] Review `PollResultErrors` pattern for future use (M3)
- [ ] Document decoder interface and findings for local decoder implementation

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

### Decision: Local Implementation (Grant Scope)

**Grant scope (forum Update #2):** cow-sdk integration was removed. Decoders are implemented locally in this project.

- Implement all decoders in this repo for M1
- Use cow-sdk as reference (e.g. TWAP, PollResultErrors pattern)
- Upstream contribution to cow-sdk is out of scope for the grant; can be considered after handoff if desired

### Output: Decoder Planning Document

Create a summary document with:
- Available decoders in cow-sdk (as reference)
- What we need to implement locally for each order type
- Interface pattern to follow
- Static input ABI for each order type
- Implementation priority for S2 decoder tasks

## Acceptance Criteria

- [ ] cow-sdk composable package reviewed
- [ ] All 5 order types assessed (available vs missing)
- [ ] Decoder interface pattern documented
- [ ] Static input struct for each order type documented (if found)
- [ ] Decision documented: local implementation only (cow-sdk integration out of scope per grant)
- [ ] Findings shared with team

## Open Questions

- [ ] Are there existing tests in cow-sdk we can reference for decoder behavior?
- [ ] Should we mirror cow-sdk's interface for easier porting (if we contribute upstream later)?

## References

- cow-sdk repo: https://github.com/cowprotocol/cow-sdk
- cow-sdk Twap.ts: https://github.com/cowprotocol/cow-sdk/blob/main/packages/composable/src/orderTypes/Twap.ts
- cow-sdk types.ts: https://github.com/cowprotocol/cow-sdk/blob/main/packages/composable/src/types.ts
- Slack Decisions (cow-sdk section): `thoughts/reference_docs/slack_decisions_summary.md`
- Sprint Plan S1.4: `thoughts/plans/sprint_plan.md`
