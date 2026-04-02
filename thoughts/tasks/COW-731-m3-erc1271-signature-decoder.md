---
status: todo
linear_synced: true
created: 2026-03-06
milestone: M3
estimate: 1
labels: [decoder, feature]
linear_url: https://linear.app/bleu-builders/issue/COW-731/add-erc1271-signature-decoder-for-m3-order-matching
git_branch: jefferson/cow-731-add-erc1271-signature-decoder-for-m3-order-matching
---

# Add ERC1271 signature decoder for M3 order matching

## Problem

M3 requires linking filled orderbook orders back to their originating `conditionalOrderGenerator` record. The matching key lives inside the ERC1271 `signature` field of every filled composable cow order — but that bytes field must be decoded to extract `handler`, `salt`, `staticInput`, and compute the `hash`. Without this decoder, M3 cannot match trade events or API responses to on-chain orders.

## Details

- Working implementation already exists at `tmp/m3-research/decode-signature.ts` (produced by API research agent)
- Move to `src/application/decoders/erc1271Signature.ts`
- Export `decodeEip1271Signature(signature: Hex): { handler, salt, staticInput, proof } | null`
  - Returns `null` on any decode failure (never throws)
- Two signature formats to handle (see "CoWShed decoder concern" below for important context):
  - `0x5fd7e97d` prefix → ISafeSignatureVerifier (Safe + ExtensibleFallbackHandler, most common)
  - CoWShedForComposableCoW → format is different from the above; must be investigated and implemented (see note below)
- The POC at `tmp/m3-research/decode-signature.ts` only implements Format 1 — **do not treat the POC as complete**; it was built as a reference and knowingly skips the CoWShed path
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
- Handles both the ISafeSignatureVerifier format (`0x5fd7e97d` prefix) and the CoWShedForComposableCoW format (to be determined before implementing)
- Given the hex signature from `tmp/m3-research/example-order-erc1271.json`, decoder returns `handler = 0x6cF1e9cA41f7611dEf408122793c358a3d11E5a5` (TWAP)
- A CoWShedForComposableCoW order signature is correctly decoded to its handler and params
- Unrecognized formats return `null` (never throws)
- `COMPOSABLE_COW_HANDLER_ADDRESSES` added to `src/data.ts`
- `pnpm typecheck` passes

## CoWShed decoder concern (validated ✓)

**Pedro Yves Fracari (call + Linear comment, 2026-03-30):**
> "The decoder for ComposableCoW and CoWShedForComposableCow will be different. At the POC just have 1 type."

**Validated — this is a real concern.** Here is what the codebase evidence shows:

The POC at `tmp/m3-research/decode-signature.ts` was built as a reference implementation and knowingly handles only one format:
- Format 1 (`0x5fd7e97d` prefix): ISafeSignatureVerifier — used by Safe wallets with ExtensibleFallbackHandler

CoWShedForComposableCoW is a distinct contract variant (Gnosis-only currently, deployed at `0x6773d5aa31a1ead34127d564d6e258e66254ebdb`) that implements its own `isValidSignature`. Pedro confirmed its signature format is different from Format 1.

**The POC was a shortcut. This task must implement both decoders.**

Pedro's point is a warning: don't blindly promote the POC and assume it's done. The implementing agent must:
1. Investigate what signature format `CoWShedForComposableCoW` actually produces — read the contract source or ask @anxolin / @mfw
2. Implement that format as a second decoder path alongside Format 1
3. Return `null` only for truly unrecognized formats (safe fallback for unknown future variants)

## Dependencies

None — can be done in parallel with Tasks 2, 3, 4.

## References

- Source: `thoughts/prompts/m3-linear-tasks-prompt.md` Task 1
- Macro plan: `thoughts/plans/2026-03-06-milestone-3-macro-plan.md` Phase A
- Working decoder: `tmp/m3-research/decode-signature.ts`
- Example signature: `tmp/m3-research/example-order-erc1271.json`
