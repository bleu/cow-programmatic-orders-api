---
status: draft
linear_synced: false
created: 2026-03-06
milestone: M3
estimate: 1
labels: [decoder, feature]
---

# Add ERC1271 signature decoder for M3 order matching

## Problem

M3 requires linking filled orderbook orders back to their originating `conditionalOrderGenerator` record. The matching key lives inside the ERC1271 `signature` field of every filled composable cow order — but that bytes field must be decoded to extract `handler`, `salt`, `staticInput`, and compute the `hash`. Without this decoder, M3 cannot match trade events or API responses to on-chain orders.

## Details

- Working implementation already exists at `tmp/m3-research/decode-signature.ts` (produced by API research agent)
- Move to `src/application/decoders/erc1271Signature.ts`
- Export `decodeEip1271Signature(signature: Hex): { handler, salt, staticInput, proof } | null`
  - Returns `null` on any decode failure (never throws)
- Two signature formats to handle:
  - `0x5fd7e97d` prefix → ISafeSignatureVerifier (Safe + ExtensibleFallbackHandler, most common)
  - Other → ERC1271Forwarder (`abi.encode(GPv2Order.Data, PayloadStruct)`, rare)
- Also add handler address constants to `src/data.ts`:
  ```typescript
  export const COMPOSABLE_COW_HANDLER_ADDRESSES = new Set([
    "0x6cF1e9cA41f7611dEf408122793c358a3d11E5a5", // TWAP
    "0x412c36e5011cd2517016d243a2dfb37f73a242e7", // StopLoss
    "0xdaf33924925e03c9cc3a10d434016d6cfad0add5", // GoodAfterTime
    "0x519BA24e959E33b3B6220CA98bd353d8c2D89920", // PerpetualSwap
    "0x812308712a6d1367f437e1c1e4af85c854e1e9f6", // TradeAboveThreshold
  ].map(a => a.toLowerCase()));
  ```
  Addresses are identical across mainnet, Gnosis, Arbitrum.

## Implementation Notes

- Source file to promote: `tmp/m3-research/decode-signature.ts`
- Shared utility — used by Task 6 (trade event handler), Task 7 (polling), and Task 8 (block handler)

## Acceptance Criteria

- `src/application/decoders/erc1271Signature.ts` exists and exports the decoder
- Given the hex signature from `tmp/m3-research/example-order-erc1271.json`, decoder returns `handler = 0x6cF1e9cA41f7611dEf408122793c358a3d11E5a5` (TWAP)
- `COMPOSABLE_COW_HANDLER_ADDRESSES` added to `src/data.ts`
- `pnpm typecheck` passes

## Dependencies

None — can be done in parallel with Tasks 2, 3, 4.

## References

- Source: `thoughts/prompts/m3-linear-tasks-prompt.md` Task 1
- Macro plan: `thoughts/plans/2026-03-06-milestone-3-macro-plan.md` Phase A
- Working decoder: `tmp/m3-research/decode-signature.ts`
- Example signature: `tmp/m3-research/example-order-erc1271.json`
