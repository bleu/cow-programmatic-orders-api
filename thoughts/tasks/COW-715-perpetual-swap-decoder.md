---
linear_id: COW-715
linear_url: https://linear.app/bleu-builders/issue/COW-715/perpetual-swap-order-type-decoder
status: Todo
linear_synced: true
created: 2026-02-27
milestone: M1
sprint: S2
priority: 2
estimate: 1
depends_on: [COW-711, COW-712]
---

# Perpetual Swap Order Type Decoder

## Problem

Perpetual Swap orders continuously swap between two tokens to maintain a target ratio. Unlike TWAP where order UIDs are deterministic, Perpetual Swap order UIDs depend on on-chain state (oracle prices), making them non-deterministic.

The PoC already demonstrates matching Perpetual Swap orders via signature decoding, but we need to decode the `staticInput` to display order parameters in UIs.

## Scope

- [ ] Research Perpetual Swap static input structure from composable-cow contracts
- [ ] Implement Perpetual Swap static input decoder
- [ ] Store decoded parameters in `conditionalOrder.decodedParams`
- [ ] Update event handler to call decoder for Perpetual Swap orders
- [ ] Add unit tests against known on-chain Perpetual Swap orders (PoC example)

## Technical Details

### PoC Reference

The PoC has a Perpetual Swap example order:
- Handler: `0x519ba24e959e33b3b6220ca98bd353d8c2d89920` (mainnet)
- See `/Users/jefferson/Projects/Bleu/cow/reference_repos/cow-programmatic-orders-indexer/src/perpetualOrderExample.ts`

### Expected Static Input Structure

Based on PoC example signature decoding:

```solidity
// From composable-cow contracts
struct Data {
    IERC20 buyToken;       // Token to buy
    IERC20 sellToken;      // Token to sell
    uint256 validityBucket; // Time bucket for validity
    // ... additional fields TBD
}
```

Looking at the PoC example `staticInput`, we can reverse-engineer the struct.

### Decoder Implementation

```typescript
// src/decoders/perpetual-swap.ts
import { decodeAbiParameters, Hex } from "viem";

export interface PerpetualSwapParams {
  buyToken: string;
  sellToken: string;
  validityBucket: bigint;
  // ... additional fields based on contract
}

const PERPETUAL_SWAP_STATIC_INPUT_ABI = [
  // TBD - decode from PoC example
] as const;

export function decodePerpetualSwapStaticInput(staticInput: Hex): PerpetualSwapParams {
  const decoded = decodeAbiParameters(PERPETUAL_SWAP_STATIC_INPUT_ABI, staticInput);
  return { /* ... */ };
}
```

### Key Insight: Non-Deterministic Order UIDs

From Slack discussions:
> "Perpetual Swap: Non-deterministic; can call `getTradableOrder` for the same owner and match returned orders."

This means:
- We can't pre-compute order UIDs like TWAP
- Need signature decoding (already in PoC) for M3 order matching
- For M1, we just decode the static input for display

### Research Approach

1. Take the `staticInput` from PoC example
2. Find Perpetual Swap handler contract in composable-cow
3. Match struct fields to bytes
4. Implement decoder
5. Verify against PoC data

## Acceptance Criteria

- [ ] Perpetual Swap struct layout documented
- [ ] Decoder correctly extracts all parameters
- [ ] Verified against PoC example order
- [ ] Decoded params stored in database as JSON
- [ ] Unit tests pass
- [ ] No TypeScript errors

## Open Questions

- [ ] What's the exact struct layout?
- [ ] What parameters control the swap behavior (ratio, threshold)?
- [ ] How does validity bucket work?

## References

- PoC Example: `/Users/jefferson/Projects/Bleu/cow/reference_repos/cow-programmatic-orders-indexer/src/perpetualOrderExample.ts`
- PoC Handler: `/Users/jefferson/Projects/Bleu/cow/reference_repos/cow-programmatic-orders-indexer/src/index.ts`
- composable-cow repo: https://github.com/cowprotocol/composable-cow
- Slack Decisions: `thoughts/reference_docs/slack_decisions_summary.md`
- Sprint Plan S2.1: `thoughts/plans/sprint_plan.md`
