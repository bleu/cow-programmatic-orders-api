---
linear_id: COW-714
linear_url: https://linear.app/bleu-builders/issue/COW-714/stop-loss-order-type-decoder
status: Todo
linear_synced: true
created: 2026-02-27
milestone: M1
sprint: S2
priority: 2
estimate: 1
depends_on: [COW-711, COW-712]
---

# Stop Loss Order Type Decoder

## Problem

Stop Loss orders trigger a sell when the price drops below a threshold. They rely on oracle prices to determine when to execute. To display Stop Loss orders in UIs, we need to decode the `staticInput` and extract trigger conditions.

This decoder is NOT in cow-sdk (per grant), so we need to implement it from scratch based on the composable-cow contract.

## Scope

- [ ] Research Stop Loss static input structure from composable-cow contracts
- [ ] Implement Stop Loss static input decoder
- [ ] Store decoded parameters in `conditionalOrderGenerator.decodedParams`
- [ ] Update event handler to call decoder for Stop Loss orders
- [ ] Add unit tests against known on-chain Stop Loss orders

## Technical Details

### Stop Loss Handler Contract

Location in composable-cow repo:
- `src/types/StopLoss.sol` (or similar)

Research needed to determine exact struct layout.

### Expected Static Input Structure

Based on typical stop loss patterns:

```solidity
// Hypothetical - verify against actual contract
struct Data {
    IERC20 sellToken;
    IERC20 buyToken;
    address receiver;
    uint256 sellAmount;
    uint256 buyAmount;           // Minimum expected
    address oracle;              // Price oracle address
    uint256 triggerPrice;        // Price threshold
    uint256 maxTimeSinceLastOracleUpdate; // Oracle staleness check
    bytes32 appData;
    // ... additional fields TBD
}
```

### Decoder Pattern

```typescript
// src/decoders/stop-loss.ts
import { decodeAbiParameters, Hex } from "viem";

export interface StopLossParams {
  sellToken: string;
  buyToken: string;
  receiver: string;
  sellAmount: bigint;
  buyAmount: bigint;
  oracle: string;
  triggerPrice: bigint;
  maxTimeSinceLastOracleUpdate: bigint;
  appData: string;
  // ... additional fields TBD
}

// ABI to be determined from contract research
const STOP_LOSS_STATIC_INPUT_ABI = [
  // TBD based on contract
] as const;

export function decodeStopLossStaticInput(staticInput: Hex): StopLossParams {
  const decoded = decodeAbiParameters(STOP_LOSS_STATIC_INPUT_ABI, staticInput);
  // Map to typed object
  return { /* ... */ };
}
```

### Integration

```typescript
// In composable-cow.ts handler
if (orderType === "StopLoss") {
  const decodedParams = decodeStopLossStaticInput(staticInput as Hex);
}
```

### Research Steps

1. Find Stop Loss handler in composable-cow repo
2. Extract `Data` struct definition
3. Verify against known on-chain Stop Loss orders
4. Implement decoder
5. Test against real data

## Acceptance Criteria

- [ ] Stop Loss struct layout documented from contract
- [ ] Decoder correctly extracts all parameters
- [ ] Decoded params stored in database as JSON
- [ ] Unit tests pass against known Stop Loss orders
- [ ] No TypeScript errors

## Open Questions

- [ ] What's the exact Stop Loss struct layout?
- [ ] Which oracles are supported (Chainlink, etc.)?
- [ ] Are there variations of Stop Loss (trailing stop, etc.)?

## References

- composable-cow repo: https://github.com/cowprotocol/composable-cow
- bleu Stop Loss Safe App (previous work): https://github.com/bleu/composable-cow-api
- Sprint Plan S2.1: `thoughts/plans/sprint_plan.md`
