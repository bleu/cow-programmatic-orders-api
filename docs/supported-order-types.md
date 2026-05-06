# Supported Order Types

The indexer decodes five programmatic order types from the ComposableCoW contract. Each order is created on-chain as a `ConditionalOrderCreated` event containing a handler address, a salt, and an opaque `staticInput` blob. The handler address determines the order type, and the `staticInput` is ABI-decoded into typed parameters stored in the `decodedParams` JSON field on `conditional_order_generator`.

All handler addresses are identical across mainnet and Gnosis Chain (CREATE2 deployments). Arbitrum support is planned but handler mappings are not yet registered.

A note on types in the API: all `bigint` values (uint256, int256) are converted to strings via `replaceBigInts(decoded, String)` before storage. When you query `decodedParams` through GraphQL or SQL, amounts, timestamps, and similar fields come back as decimal strings, not numbers.

---

## TWAP (Time-Weighted Average Price)

Splits a large sell order into `n` equal parts, each executed at a fixed interval. The classic use case: selling 100 ETH over 24 hours in 24 equal chunks, one per hour, to reduce price impact.

**Handler address**: `0x6cF1e9cA41f7611dEf408122793c358a3d11E5a5`

### Solidity struct

```solidity
struct TWAPOrder {
    address sellToken;       // token to sell
    address buyToken;        // token to buy
    address receiver;        // where proceeds go (address(0) = order owner)
    uint256 partSellAmount;  // amount to sell per part
    uint256 minPartLimit;    // minimum buy amount per part (slippage protection)
    uint256 t0;              // start time as unix epoch; 0 means "start at creation block time"
    uint256 n;               // total number of parts
    uint256 t;               // seconds between consecutive parts
    uint256 span;            // how long each part stays valid (0 = same as interval t)
    bytes32 appData;         // CoW Protocol app data hash
}
```

### Decoded fields in the API

| `decodedParams` field | Solidity field | Type in API | Notes |
|---|---|---|---|
| `sellToken` | sellToken | string | Lowercased address |
| `buyToken` | buyToken | string | Lowercased address |
| `receiver` | receiver | string | Lowercased address |
| `partSellAmount` | partSellAmount | string | Per-part sell amount (stringified bigint, raw token units) |
| `minPartLimit` | minPartLimit | string | Per-part minimum buy amount |
| `t0` | t0 | string | Unix epoch. "0" means the order starts at the block timestamp when it was mined |
| `n` | n | string | Number of parts |
| `t` | t | string | Seconds between parts |
| `span` | span | string | Part validity in seconds. "0" means each part is valid for the full interval `t` |
| `appData` | appData | string | bytes32 hex |

You can derive useful values from these fields:
- Total sell amount: `partSellAmount * n`
- Total minimum buy: `minPartLimit * n`
- End time: `t0 + (n * t)` when `t0 > 0`

### Discrete parts

TWAP generates `n` discrete orders, one per time slice. Each part covers `[t0 + i*t, t0 + i*t + span]` for `i` in `0..n-1`. When `span` is 0, each part is valid for the full interval between parts.

### Edge cases

- When `t0` is 0, the contract uses the block timestamp of the creation transaction as the start time. The `decodedParams` will still show `"0"` -- the actual resolved start time is not stored.
- If a part's validity window passes without execution, that part is simply skipped. There is no retry or rollover.
- Setting `span` shorter than `t` creates gaps where no part is active. Setting `span` longer than `t` creates overlapping validity windows.

---

## Stop Loss

Executes a swap when the price ratio between two tokens crosses a trigger threshold. Uses Chainlink price oracles to determine the current price. Once the strike price is hit, the order becomes tradeable.

**Handler address**: `0x412c36e5011cd2517016d243a2dfb37f73a242e7`

### Solidity struct

```solidity
struct StopLossOrder {
    address sellToken;
    address buyToken;
    uint256 sellAmount;
    uint256 buyAmount;                   // minimum buy amount
    bytes32 appData;
    address receiver;
    bool    isSellOrder;                 // true = sell exact amount; false = buy exact amount
    bool    isPartiallyFillable;
    uint32  validTo;                     // order validity duration in seconds
    address sellTokenPriceOracle;        // Chainlink aggregator for sell token
    address buyTokenPriceOracle;         // Chainlink aggregator for buy token
    int256  strike;                      // trigger price (signed -- can be negative)
    uint256 maxTimeSinceLastOracleUpdate; // staleness threshold in seconds
}
```

### Decoded fields in the API

| `decodedParams` field | Solidity field | Type in API | Notes |
|---|---|---|---|
| `sellToken` | sellToken | string | Lowercased |
| `buyToken` | buyToken | string | Lowercased |
| `sellAmount` | sellAmount | string | Raw token units |
| `buyAmount` | buyAmount | string | Minimum acceptable buy amount |
| `appData` | appData | string | bytes32 hex |
| `receiver` | receiver | string | Lowercased |
| `isSellOrder` | isSellOrder | boolean | |
| `isPartiallyFillable` | isPartiallyFillable | boolean | |
| `validTo` | validTo | number | Seconds, stored as a number (uint32 fits in JS number) |
| `sellTokenPriceOracle` | sellTokenPriceOracle | string | Chainlink aggregator address, lowercased |
| `buyTokenPriceOracle` | buyTokenPriceOracle | string | Chainlink aggregator address, lowercased |
| `strike` | strike | string | Signed value (can be negative). Stringified bigint |
| `maxTimeSinceLastOracleUpdate` | maxTimeSinceLastOracleUpdate | string | Seconds. If the oracle hasn't updated within this window, the order won't trigger |

### Discrete parts

Stop Loss is a single-shot order. When the strike price is hit, one discrete order is placed. If it fills, the conditional order is done. If `isPartiallyFillable` is true, partial fills are accepted and the remainder can fill in subsequent settlements.

### Edge cases

- `strike` is `int256` (signed). The TypeScript type is `bigint` and the API returns it as a string that may start with `-`. Consumers need to handle negative values.
- Oracle staleness: if neither Chainlink feed has updated within `maxTimeSinceLastOracleUpdate` seconds, the order will not trigger even if the price condition is met. The contract reverts with an oracle-too-stale error in this case.
- `validTo` is a duration, not an absolute timestamp. The actual expiry is computed at execution time relative to the current block.

---

## Perpetual Swap

A recurring swap between two tokens that never expires. Designed for stablecoin rebalancing or similar use cases where you want to continuously trade one token for another at roughly 1:1, taking a configurable spread.

The contract name is `PerpetualStableSwap` but this codebase refers to it as `PerpetualSwap`.

**Handler address**: `0x519BA24e959E33b3B6220CA98bd353d8c2D89920`

### Solidity struct

```solidity
struct PerpetualStableSwapOrder {
    address tokenA;
    address tokenB;
    uint32  validityBucketSeconds;  // time-bucketing for order validity
    uint256 halfSpreadBps;          // half the spread in basis points
    bytes32 appData;
}
```

### Decoded fields in the API

| `decodedParams` field | Solidity field | Type in API | Notes |
|---|---|---|---|
| `tokenA` | tokenA | string | Lowercased |
| `tokenB` | tokenB | string | Lowercased |
| `validityBucketSeconds` | validityBucketSeconds | number | uint32, fits in JS number |
| `halfSpreadBps` | halfSpreadBps | string | Half the spread in basis points. A value of 50 means 0.5% half-spread (1% total spread) |
| `appData` | appData | string | bytes32 hex |

### Discrete parts

Perpetual Swap generates discrete orders on-demand based on the current oracle state and the owner's token balances at execution time. The direction (A-to-B or B-to-A) and the amounts are determined at runtime by calling `getTradableOrder` on the handler contract. Because of this, discrete order UIDs cannot be pre-computed from the static input alone.

Each discrete order is valid for `validityBucketSeconds`. Once it expires or fills, the next one is generated.

### Edge cases

- The order is truly perpetual -- there is no expiry field. It stays active until explicitly cancelled via `remove()` on the ComposableCoW contract.
- The direction of the swap flips depending on which token the owner holds more of relative to the desired ratio. You cannot know the direction from `decodedParams` alone.
- `halfSpreadBps` is half the spread, not the full spread. A value of `"100"` means 1% half-spread, so the total spread is 2%.

---

## Good After Time (GAT)

An order that only becomes active after a specific unix timestamp and before an end time. Useful for scheduling trades in advance or waiting for some off-chain condition to resolve before allowing execution.

**Handler address**: `0xdaf33924925e03c9cc3a10d434016d6cfad0add5`

### Solidity struct

```solidity
struct GoodAfterTimeOrder {
    address sellToken;
    address buyToken;
    address receiver;
    uint256 sellAmount;
    uint256 minSellBalance;       // owner must hold at least this much sellToken
    uint256 startTime;            // unix timestamp -- order is not valid before this
    uint256 endTime;              // unix timestamp -- order expires after this
    bool    allowPartialFill;
    bytes   priceCheckerPayload;  // opaque payload for external price verification
    bytes32 appData;
}
```

### Decoded fields in the API

| `decodedParams` field | Solidity field | Type in API | Notes |
|---|---|---|---|
| `sellToken` | sellToken | string | Lowercased |
| `buyToken` | buyToken | string | Lowercased |
| `receiver` | receiver | string | Lowercased |
| `sellAmount` | sellAmount | string | Raw token units |
| `minSellBalance` | minSellBalance | string | Minimum balance of sellToken the owner must hold for the order to trigger |
| `startTime` | startTime | string | Unix timestamp (stringified bigint) |
| `endTime` | endTime | string | Unix timestamp (stringified bigint) |
| `allowPartialFill` | allowPartialFill | boolean | |
| `priceCheckerPayload` | priceCheckerPayload | string | Raw hex bytes. Content is opaque -- the format depends on the external price checker contract being used |
| `appData` | appData | string | bytes32 hex |

### Discrete parts

GAT produces a single discrete order that is valid within the `[startTime, endTime]` window. If the owner's sellToken balance is below `minSellBalance`, the handler reverts and no order is created for that polling cycle.

### Edge cases

- `priceCheckerPayload` is a `bytes` field (dynamic length). The decoder stores it as raw hex. Interpreting its contents requires knowledge of which price checker contract the order was configured with, which is not part of the struct itself.
- If `startTime` is in the past at creation time, the order is immediately eligible (assuming the balance check passes).
- If the owner's balance of `sellToken` drops below `minSellBalance` after the order becomes active, the handler will revert until the balance is restored.

---

## Trade Above Threshold (TAT)

Triggers a swap whenever the owner's balance of the sell token exceeds a threshold. Useful for automated treasury management -- for example, converting any USDC balance above 10,000 into ETH.

**Handler address**: `0x812308712a6d1367f437e1c1e4af85c854e1e9f6`

### Solidity struct

```solidity
struct TradeAboveThresholdOrder {
    address sellToken;
    address buyToken;
    address receiver;
    uint32  validityBucketSeconds;   // time-bucketing for order validity
    uint256 threshold;               // minimum sellToken balance to trigger
    bytes32 appData;
}
```

### Decoded fields in the API

| `decodedParams` field | Solidity field | Type in API | Notes |
|---|---|---|---|
| `sellToken` | sellToken | string | Lowercased |
| `buyToken` | buyToken | string | Lowercased |
| `receiver` | receiver | string | Lowercased |
| `validityBucketSeconds` | validityBucketSeconds | number | uint32, fits in JS number |
| `threshold` | threshold | string | Raw token units. The owner's sellToken balance must exceed this for the order to fire |
| `appData` | appData | string | bytes32 hex |

### Discrete parts

TAT generates discrete orders on-demand, similar to Perpetual Swap. When the owner's sell token balance is above `threshold`, the handler computes the sell amount (balance minus threshold, approximately) and creates a discrete order. Each discrete order is valid for `validityBucketSeconds`.

Because the sell amount depends on the owner's live balance, the discrete order parameters are determined at runtime and cannot be derived from `decodedParams`.

### Edge cases

- Like Perpetual Swap, TAT has no expiry. It fires every time the balance exceeds the threshold, indefinitely, until cancelled.
- If the balance is exactly equal to the threshold (not above it), the order does not trigger.
- After a successful fill brings the balance below the threshold, the order goes dormant until the balance rises again. No manual re-activation is needed.

---

## Decode failures

When `staticInput` cannot be decoded for a known order type, the indexer stores `decodedParams: null` and sets `decodeError` to `"invalid_static_input"`. This happens when the on-chain data doesn't match the expected ABI layout -- corrupted calldata, a different handler version, or a handler address collision with a non-standard contract.

For `Unknown` order types (handler address not in the registry), `decodedParams` is null and `decodeError` is null. The raw `staticInput` hex is always available on the `conditional_order_generator` record regardless of decode outcome.

## PollResultErrors (M3 reference)

The ComposableCoW system uses poll result codes to coordinate when orders should be re-checked. These are relevant if you're working on the block handler that polls `getTradableOrder`:

| Code | What it means | What the indexer should do |
|---|---|---|
| `TRY_NEXT_BLOCK` | Transient failure | Re-poll on the next block |
| `TRY_ON_BLOCK` | Not ready yet | Re-poll at the specified block number |
| `TRY_AT_EPOCH` | Not ready yet | Re-poll at the specified unix timestamp |
| `DONT_TRY_AGAIN` | Permanently done | Remove from the active polling set |
| `UNEXPECTED_ERROR` | Something broke | Log and retry with backoff |

These codes come from `composable-cow` and are not exported by the installed `@cowprotocol/cow-sdk` package. The indexer uses the string values directly.
