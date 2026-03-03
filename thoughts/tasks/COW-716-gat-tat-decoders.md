---
linear_id: COW-716
linear_url: https://linear.app/bleu-builders/issue/COW-716/good-after-time-and-trade-above-threshold-decoders
status: Todo
linear_synced: true
created: 2026-02-27
milestone: M1
sprint: S2
priority: 2
estimate: 1
depends_on: [COW-711, COW-712]
---

# Good After Time & Trade Above Threshold Decoders

## Problem

Good After Time (GAT) and Trade Above Threshold (TAT) are two additional Composable CoW order types that need decoders. These are likely simpler than TWAP or Perpetual Swap, so they're combined into a single task.

- **Good After Time**: Order becomes valid after a specified timestamp
- **Trade Above Threshold**: Order executes when a price/amount exceeds a threshold

Both are NOT in cow-sdk (per grant), so we need to implement from scratch.

## Scope

- [ ] Research Good After Time static input structure
- [ ] Research Trade Above Threshold static input structure
- [ ] Implement GAT decoder
- [ ] Implement TAT decoder
- [ ] Store decoded parameters in `conditionalOrder.decodedParams`
- [ ] Update event handler to call decoders for these order types
- [ ] Add unit tests

## Technical Details

### Good After Time (GAT)

Expected purpose: Delay order execution until a specific time.

Hypothetical struct (verify against contract):
```solidity
struct Data {
    IERC20 sellToken;
    IERC20 buyToken;
    address receiver;
    uint256 sellAmount;
    uint256 buyAmount;
    uint256 validFrom;       // Unix timestamp - order valid after this
    uint256 validTo;         // Unix timestamp - order expires
    bytes32 appData;
}
```

### Trade Above Threshold (TAT)

Expected purpose: Execute when price/balance exceeds threshold.

Hypothetical struct (verify against contract):
```solidity
struct Data {
    IERC20 sellToken;
    IERC20 buyToken;
    address receiver;
    uint256 sellAmount;
    uint256 buyAmount;
    address oracle;           // Price oracle
    uint256 threshold;        // Price/amount threshold
    bool isAbove;             // Trade when above threshold
    bytes32 appData;
}
```

### Decoder Implementations

```typescript
// src/decoders/good-after-time.ts
export interface GoodAfterTimeParams {
  sellToken: string;
  buyToken: string;
  receiver: string;
  sellAmount: bigint;
  buyAmount: bigint;
  validFrom: bigint;
  validTo: bigint;
  appData: string;
}

export function decodeGoodAfterTimeStaticInput(staticInput: Hex): GoodAfterTimeParams {
  // Implementation TBD based on contract research
}

// src/decoders/trade-above-threshold.ts
export interface TradeAboveThresholdParams {
  sellToken: string;
  buyToken: string;
  receiver: string;
  sellAmount: bigint;
  buyAmount: bigint;
  oracle: string;
  threshold: bigint;
  isAbove: boolean;
  appData: string;
}

export function decodeTradeAboveThresholdStaticInput(staticInput: Hex): TradeAboveThresholdParams {
  // Implementation TBD based on contract research
}
```

### Decoder Index Pattern

```typescript
// src/decoders/index.ts
export { decodeTwapStaticInput } from "./twap";
export { decodeStopLossStaticInput } from "./stop-loss";
export { decodePerpetualSwapStaticInput } from "./perpetual-swap";
export { decodeGoodAfterTimeStaticInput } from "./good-after-time";
export { decodeTradeAboveThresholdStaticInput } from "./trade-above-threshold";

export function decodeStaticInput(orderType: string, staticInput: Hex) {
  switch (orderType) {
    case "TWAP": return decodeTwapStaticInput(staticInput);
    case "StopLoss": return decodeStopLossStaticInput(staticInput);
    case "PerpetualSwap": return decodePerpetualSwapStaticInput(staticInput);
    case "GoodAfterTime": return decodeGoodAfterTimeStaticInput(staticInput);
    case "TradeAboveThreshold": return decodeTradeAboveThresholdStaticInput(staticInput);
    default: return null;
  }
}
```

### Research Steps

1. Find GAT and TAT handlers in composable-cow repo
2. Extract `Data` struct definitions
3. Find any on-chain examples for testing
4. Implement decoders
5. Test against real data (if available)

## Acceptance Criteria

- [ ] GAT struct layout documented from contract
- [ ] TAT struct layout documented from contract
- [ ] Both decoders correctly extract parameters
- [ ] Decoded params stored in database as JSON
- [ ] Unit tests pass (may need mock data if no on-chain examples)
- [ ] No TypeScript errors

## Open Questions

- [ ] Are GAT and TAT heavily used? May have few on-chain examples.
- [ ] What are the exact struct layouts?
- [ ] Do these order types have variations?

## References

- composable-cow repo: https://github.com/cowprotocol/composable-cow
- Sprint Plan S2.1: `thoughts/plans/sprint_plan.md`
- Grant Proposal (order types): `thoughts/reference_docs/grant_proposal.md`
