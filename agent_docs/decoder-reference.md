# cow-sdk Review & Decoder Planning

**Task:** COW-712 · **Sprint:** S1 · **Updated:** 2026-03-03

## Summary

- **TWAP**: decoder available in cow-sdk GitHub source (`packages/composable/src/orderTypes/Twap.ts`). Use as reference for ABI tuple and interface pattern.
- **StopLoss, GoodAfterTime, PerpetualSwap, TradeAboveThreshold**: no TypeScript decoders exist anywhere. Implement from Solidity struct layouts (documented below).
- The installed `@cowprotocol/cow-sdk@7.3.8` does NOT export the composable package. All decoders are implemented locally with viem.
- Grant scope (Forum Update #2): cow-sdk integration removed. Local implementation only.

---

## Decoder Interface Pattern

Decoders in this project are standalone functions, not class hierarchies. Pattern:

```typescript
// src/decoders/<order-type>.ts
import { decodeAbiParameters, type Hex } from "viem";

export interface <OrderType>DecodedParams {
  // typed fields matching the struct (addresses as string, uint as bigint, bool as boolean)
}

const <ORDER_TYPE>_ABI = [
  {
    type: "tuple",
    components: [
      { name: "fieldName", type: "address" | "uint256" | "bool" | "bytes32" | "bytes" | "uint32" | ... },
      // ...
    ],
  },
] as const;

export function decode<OrderType>StaticInput(staticInput: Hex): <OrderType>DecodedParams {
  const [decoded] = decodeAbiParameters(<ORDER_TYPE>_ABI, staticInput);
  return {
    fieldName: decoded.fieldName,
    // ...
  };
}
```

**Entry point** (`src/decoders/index.ts`):
```typescript
import type { OrderType } from "../utils/order-types";
import type { Hex } from "viem";

export function decodeStaticInput(orderType: OrderType, staticInput: Hex): unknown {
  switch (orderType) {
    case "TWAP":                return decodeTwapStaticInput(staticInput);
    case "StopLoss":            return decodeStopLossStaticInput(staticInput);
    case "PerpetualSwap":       return decodePerpetualSwapStaticInput(staticInput);
    case "GoodAfterTime":       return decodeGoodAfterTimeStaticInput(staticInput);
    case "TradeAboveThreshold": return decodeTradeAboveThresholdStaticInput(staticInput);
    default:                    return null;
  }
}
```

---

## Handler Addresses (all chains identical: mainnet/gnosis/arbitrum)

| Order Type | Handler Address |
|------------|----------------|
| TWAP | `0x6cF1e9cA41f7611dEf408122793c358a3d11E5a5` |
| StopLoss | `0x412c36e5011cd2517016d243a2dfb37f73a242e7` |
| GoodAfterTime | `0xdaf33924925e03c9cc3a10d434016d6cfad0add5` |
| PerpetualSwap | `0x519BA24e959E33b3B6220CA98bd353d8c2D89920` |
| TradeAboveThreshold | `0x812308712a6d1367f437e1c1e4af85c854e1e9f6` |

Source: `cowprotocol/composable-cow/networks.json`

---

## Struct Layouts & ABI Definitions

### TWAP

**Source:** cow-sdk `packages/composable/src/orderTypes/Twap.ts` (confirmed against `TWAPOrder.sol`)

```typescript
const TWAP_ABI = [
  {
    type: "tuple",
    components: [
      { name: "sellToken",      type: "address" },
      { name: "buyToken",       type: "address" },
      { name: "receiver",       type: "address" },
      { name: "partSellAmount", type: "uint256" },  // per-part sell amount
      { name: "minPartLimit",   type: "uint256" },  // per-part min buy amount
      { name: "t0",             type: "uint256" },  // start epoch (0 = at mining time)
      { name: "n",              type: "uint256" },  // number of parts
      { name: "t",              type: "uint256" },  // seconds between parts
      { name: "span",           type: "uint256" },  // part validity duration (0 = fill interval)
      { name: "appData",        type: "bytes32" },
    ],
  },
] as const;

export interface TwapDecodedParams {
  sellToken: string;       // address
  buyToken: string;        // address
  receiver: string;        // address
  partSellAmount: bigint;
  minPartLimit: bigint;
  t0: bigint;              // start epoch
  n: bigint;               // number of parts
  t: bigint;               // time between parts (seconds)
  span: bigint;            // part duration (seconds, 0 = auto)
  appData: string;         // bytes32
}
```

**Derived values (compute at decode time or query time):**
- `totalSellAmount = partSellAmount * n`
- `totalBuyAmount = minPartLimit * n`
- `endTime = t0 + (n * t)` (when t0 > 0)

---

### StopLoss

**Source:** `composable-cow/src/types/StopLoss.sol`

```typescript
const STOP_LOSS_ABI = [
  {
    type: "tuple",
    components: [
      { name: "sellToken",                  type: "address" },
      { name: "buyToken",                   type: "address" },
      { name: "sellAmount",                 type: "uint256" },
      { name: "buyAmount",                  type: "uint256" },  // minimum
      { name: "appData",                    type: "bytes32" },
      { name: "receiver",                   type: "address" },
      { name: "isSellOrder",               type: "bool"    },
      { name: "isPartiallyFillable",        type: "bool"    },
      { name: "validTo",                    type: "uint32"  },  // order validity window (seconds)
      { name: "sellTokenPriceOracle",       type: "address" },  // Chainlink aggregator
      { name: "buyTokenPriceOracle",        type: "address" },  // Chainlink aggregator
      { name: "strike",                     type: "int256"  },  // trigger price (signed)
      { name: "maxTimeSinceLastOracleUpdate", type: "uint256" }, // oracle staleness threshold
    ],
  },
] as const;

export interface StopLossDecodedParams {
  sellToken: string;
  buyToken: string;
  sellAmount: bigint;
  buyAmount: bigint;
  appData: string;          // bytes32
  receiver: string;
  isSellOrder: boolean;
  isPartiallyFillable: boolean;
  validTo: number;          // uint32
  sellTokenPriceOracle: string;
  buyTokenPriceOracle: string;
  strike: bigint;           // int256 — signed!
  maxTimeSinceLastOracleUpdate: bigint;
}
```

---

### PerpetualSwap (PerpetualStableSwap in contracts)

**Source:** `composable-cow/src/types/PerpetualStableSwap.sol`
**Handler alias:** called "PerpetualSwap" in this codebase

```typescript
const PERPETUAL_SWAP_ABI = [
  {
    type: "tuple",
    components: [
      { name: "tokenA",               type: "address" },
      { name: "tokenB",               type: "address" },
      { name: "validityBucketSeconds", type: "uint32"  },
      { name: "halfSpreadBps",        type: "uint256" },
      { name: "appData",              type: "bytes32" },
    ],
  },
] as const;

export interface PerpetualSwapDecodedParams {
  tokenA: string;
  tokenB: string;
  validityBucketSeconds: number;   // uint32
  halfSpreadBps: bigint;           // basis points / 2
  appData: string;                 // bytes32
}
```

**Note on non-determinism:** Order UIDs for Perpetual Swap depend on oracle state at execution time and cannot be pre-computed. `getTradableOrder` must be called at runtime (M3 scope).

---

### GoodAfterTime

**Source:** `composable-cow/src/types/GoodAfterTime.sol`

```typescript
const GOOD_AFTER_TIME_ABI = [
  {
    type: "tuple",
    components: [
      { name: "sellToken",           type: "address" },
      { name: "buyToken",            type: "address" },
      { name: "receiver",            type: "address" },
      { name: "sellAmount",          type: "uint256" },
      { name: "minSellBalance",      type: "uint256" },  // minimum balance to trigger
      { name: "startTime",           type: "uint256" },  // Unix timestamp
      { name: "endTime",             type: "uint256" },  // Unix timestamp
      { name: "allowPartialFill",    type: "bool"    },
      { name: "priceCheckerPayload", type: "bytes"   },  // ⚠️ dynamic — store raw
      { name: "appData",             type: "bytes32" },
    ],
  },
] as const;

export interface GoodAfterTimeDecodedParams {
  sellToken: string;
  buyToken: string;
  receiver: string;
  sellAmount: bigint;
  minSellBalance: bigint;
  startTime: bigint;
  endTime: bigint;
  allowPartialFill: boolean;
  priceCheckerPayload: string;   // hex bytes — opaque for M1
  appData: string;               // bytes32
}
```

**⚠️ Dynamic field warning:** `priceCheckerPayload` is `bytes` (dynamic length). viem handles this correctly with `decodeAbiParameters`, but the content itself is opaque — an optional secondary decoder could parse it if needed (not in M1 scope).

---

### TradeAboveThreshold

**Source:** `composable-cow/src/types/TradeAboveThreshold.sol`

```typescript
const TRADE_ABOVE_THRESHOLD_ABI = [
  {
    type: "tuple",
    components: [
      { name: "sellToken",             type: "address" },
      { name: "buyToken",              type: "address" },
      { name: "receiver",             type: "address" },
      { name: "validityBucketSeconds", type: "uint32"  },
      { name: "threshold",             type: "uint256" },
      { name: "appData",              type: "bytes32" },
    ],
  },
] as const;

export interface TradeAboveThresholdDecodedParams {
  sellToken: string;
  buyToken: string;
  receiver: string;
  validityBucketSeconds: number;   // uint32
  threshold: bigint;
  appData: string;                 // bytes32
}
```

---

## PollResultErrors — M3 Reference

From `packages/composable/src/types.ts`. Not exported in installed cow-sdk package — use values directly.

```typescript
// NOT importable from @cowprotocol/cow-sdk — reference only
enum PollResultCode {
  SUCCESS          = "SUCCESS",
  UNEXPECTED_ERROR = "UNEXPECTED_ERROR",
  TRY_NEXT_BLOCK   = "TRY_NEXT_BLOCK",
  TRY_ON_BLOCK     = "TRY_ON_BLOCK",
  TRY_AT_EPOCH     = "TRY_AT_EPOCH",
  DONT_TRY_AGAIN   = "DONT_TRY_AGAIN",
}
```

**Semantics for the M3 block handler:**

| Code | Meaning | Action |
|------|---------|--------|
| `TRY_NEXT_BLOCK` | Transient failure, retry immediately | Check again on next block |
| `TRY_ON_BLOCK` | Retry at a specific block number | Schedule future check |
| `TRY_AT_EPOCH` | Retry at a Unix timestamp | Schedule future check |
| `DONT_TRY_AGAIN` | Order is permanently done | Remove from active set |
| `UNEXPECTED_ERROR` | Unhandled error | Log and retry with backoff |

**Implementation note for M3:** Store a `nextCheckAt` field on `conditionalOrderGenerator` to track when to re-poll each order. This avoids calling `getTradableOrder` on every block for every order.

---

## Decision Log

| Decision | Rationale |
|----------|-----------|
| Local decoders, no cow-sdk integration | Grant scope Update #2 explicitly removes cow-sdk contribution |
| Standalone `decode<Type>StaticInput()` functions, not `ConditionalOrder<D,S>` class | M1 only needs decode; the full SDK class adds encoding, signing, polling complexity not needed yet |
| Store `priceCheckerPayload` as opaque hex in M1 | Payload parsing is context-dependent and out of M1 scope |
| All handler addresses identical on mainnet/gnosis/arbitrum | Confirmed from `networks.json` in composable-cow repo; safe to use same addresses for all chains |
| `strike` is `int256` (signed) on StopLoss | The Solidity struct uses `int256`; TypeScript must use `bigint` (handles negative values correctly) |

---

## References

- cow-sdk source: https://github.com/cowprotocol/cow-sdk/tree/main/packages/composable/src/orderTypes
- composable-cow types: https://github.com/cowprotocol/composable-cow/tree/main/src/types
- networks.json: https://github.com/cowprotocol/composable-cow/blob/main/networks.json
- Grant scope update: https://forum.cow.fi/t/grant-application-programmatic-orders-api/3346
- PollResultErrors: https://github.com/cowprotocol/cow-sdk/blob/main/packages/composable/src/types.ts
