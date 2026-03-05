---
linear_id: COW-713
linear_url: https://linear.app/bleu-builders/issue/COW-713/twap-order-type-decoder
status: Todo
linear_synced: true
created: 2026-02-27
milestone: M1
sprint: S2
priority: 2
estimate: 1
depends_on: [COW-711, COW-712]
---

# TWAP Order Type Decoder

## Problem

TWAP (Time-Weighted Average Price) orders split a large trade into smaller parts executed over time. To display TWAP orders properly in UIs, we need to decode the `staticInput` field and extract parameters like part amounts, number of parts, time span, etc.

TWAP is the most common Composable CoW order type and is already supported in cow-sdk, making it a good starting point.

## Scope

- [ ] Implement TWAP static input decoder
- [ ] Store decoded parameters in `conditionalOrderGenerator.decodedParams`
- [ ] Update event handler to call decoder for TWAP orders
- [ ] Add unit tests against known on-chain TWAP orders

## Technical Details

### TWAP Static Input Structure

From cow-sdk and composable-cow contracts:

```solidity
struct Data {
    IERC20 sellToken;
    IERC20 buyToken;
    address receiver;
    uint256 partSellAmount;      // Amount to sell per part
    uint256 minPartLimit;        // Minimum buy amount per part
    uint256 t0;                  // Start time (Unix timestamp)
    uint256 n;                   // Number of parts
    uint256 t;                   // Time between parts (seconds)
    uint256 span;                // Valid duration for each part
    bytes32 appData;
}
```

### Decoder Implementation

```typescript
// src/decoders/twap.ts
import { decodeAbiParameters, Hex } from "viem";

export interface TwapParams {
  sellToken: string;
  buyToken: string;
  receiver: string;
  partSellAmount: bigint;
  minPartLimit: bigint;
  startTime: bigint;        // t0
  numParts: bigint;         // n
  timeBetweenParts: bigint; // t
  span: bigint;
  appData: string;
}

const TWAP_STATIC_INPUT_ABI = [
  { name: "sellToken", type: "address" },
  { name: "buyToken", type: "address" },
  { name: "receiver", type: "address" },
  { name: "partSellAmount", type: "uint256" },
  { name: "minPartLimit", type: "uint256" },
  { name: "t0", type: "uint256" },
  { name: "n", type: "uint256" },
  { name: "t", type: "uint256" },
  { name: "span", type: "uint256" },
  { name: "appData", type: "bytes32" },
] as const;

export function decodeTwapStaticInput(staticInput: Hex): TwapParams {
  const decoded = decodeAbiParameters(TWAP_STATIC_INPUT_ABI, staticInput);

  return {
    sellToken: decoded[0],
    buyToken: decoded[1],
    receiver: decoded[2],
    partSellAmount: decoded[3],
    minPartLimit: decoded[4],
    startTime: decoded[5],
    numParts: decoded[6],
    timeBetweenParts: decoded[7],
    span: decoded[8],
    appData: decoded[9],
  };
}
```

### Integration with Event Handler

```typescript
// In composable-cow.ts handler
if (orderType === "TWAP") {
  const decodedParams = decodeTwapStaticInput(staticInput as Hex);
  // Store as JSON in decodedParams field
}
```

### Derived Values (for UI)

From decoded params, we can compute:
- `totalSellAmount = partSellAmount * numParts`
- `endTime = startTime + (numParts * timeBetweenParts)`
- `currentPart = floor((now - startTime) / timeBetweenParts)`

### Reference: cow-sdk TWAP

Check how cow-sdk handles TWAP decoding:
- `packages/composable/src/orderTypes/Twap.ts`
- May be able to import directly from `@cowprotocol/cow-sdk`

## Acceptance Criteria

- [ ] TWAP decoder correctly extracts all parameters
- [ ] Decoded params stored in database as JSON
- [ ] Unit tests pass against known TWAP orders
- [ ] GraphQL can query TWAP-specific fields via `decodedParams`
- [ ] No TypeScript errors

## Open Questions

- [ ] Can we import TWAP decoder from cow-sdk or implement from scratch?
- [ ] What's the exact ABI struct layout? (verify against on-chain data)
- [ ] Should we compute derived values (totalSellAmount, endTime) at index time?

## References

- cow-sdk Twap.ts: https://github.com/cowprotocol/cow-sdk/blob/main/packages/composable/src/orderTypes/Twap.ts
- composable-cow TWAP handler: https://github.com/cowprotocol/composable-cow/tree/main/src/types/twap
- Sprint Plan S2.1: `thoughts/plans/sprint_plan.md`
