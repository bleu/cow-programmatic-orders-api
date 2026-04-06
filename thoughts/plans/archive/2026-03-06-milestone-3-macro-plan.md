# M3 Macro Plan: Orderbook Integration

**Date:** 2026-03-06
**Status:** Draft — some items flagged as pending API research output (see `thoughts/prompts/m3-orderbook-api-research-prompt.md`)
**Grant scope:** Milestone 3 — Orderbook Integration (3 weeks / ½ S4 – S7)
**Prerequisite:** M2 must be complete (owner_mapping table needed for trade event owner resolution)
**Planning session log:** `thoughts/plans/2026-03-06-m3-planning-log.md`

---

## 1. Scope Summary

From the grant proposal and Slack discussions:

- **Order matching**: Link orderbook orders to their originating composable cow order (via ERC1271 signature decoding)
- **Execution tracking**: Track filled, partially filled, unfilled, and expired discrete parts (especially TWAP)
- **Block handler**: Detect unfilled/expired parts using watch-tower style PollResultErrors logic
- **Persistent off-chain cache**: Survive Ponder redeployments for orderbook API responses

M3 is significantly more complex than M2. It has four distinct sub-systems that interact, a known performance risk (block handler), and a dependency on external API access. The macro plan breaks it into independent phases that can be parallelized where possible.

**Chain scope:** Mainnet only (same as M1 and M2).

**References:**
- Grant scope: `thoughts/reference_docs/grant_proposal.md` §M3
- Technical decisions: `thoughts/reference_docs/grant_aligned_summary.md` §M3
- Slack decisions: `agent_docs/slack_decisions_summary.md` §1 (Orderbook, Block Handler, Cache sections)
- API research (to be completed): `thoughts/reference_docs/m3-orderbook-api-research.md`

---

## 2. Problem Context

After M1+M2, we have:
- All composable cow orders indexed with decoded params (`conditionalOrderGenerator`)
- Owner resolution for CoWShed proxies and flash loan helpers (`owner_mapping`)
- `discreteOrder` table stubbed but empty

**What's missing**: We know orders were *created*, but not whether they *executed*. For TWAP, we don't know which of the N parts ran, which were skipped, or when the order expires. M3 fills all of this.

**The fundamental insight** (from Anxo's "aha moment" in Slack): composable cow order matching doesn't require scanning all orderbook orders. A filled orderbook order with `signingScheme=eip1271` carries its entire composable cow lineage inside its `signature` field — decode it and you have the handler, salt, and staticInput that identify the originating order. This makes matching O(trade events) rather than O(all orders × all composable orders).

> **Note:** The API uses `"eip1271"` — NOT `"erc1271"`. This is confirmed by the API research and is a common source of bugs. All code filtering on this field must use the correct string.

---

## 3. The Four Sub-Systems

Before defining phases, it helps to understand the four sub-systems and their roles:

| Sub-system | Trigger | Purpose |
|------------|---------|---------|
| **Signature decoder** | orderbook API response or trade event | Decode ERC1271 signature → extract handler, salt, staticInput → match to `conditionalOrderGenerator` |
| **Trade event handler** | `GPv2Settlement:Trade` on-chain event | Primary signal for "this discrete part was filled" |
| **Block handler** | every block (with PollResultErrors scheduling) | Detect unfilled/expired parts; generate expected UIDs for open parts |
| **Orderbook API + cache** | called from block handler and trade handler | Confirm order status, partial fill amounts, and find non-deterministic UIDs (perpetual swaps) |

The **signature decoder** is a shared utility used by both the trade event handler and the orderbook API integration. It's the most important piece to get right.

---

## 4. Phases

### Phase A — Signature Decoding (foundational, no external dependencies)

**Goal:** Implement and test the ERC1271 signature decoder that links an orderbook order to a `conditionalOrderGenerator` record.

**The decode chain:**
```
signature bytes
  └─ detect format by first 4 bytes
       ├─ 0x5fd7e97d → ISafeSignatureVerifier (most common — Safe + ExtensibleFallbackHandler)
       │    └─ skip selector(4) + domainSeparator(32) + typeHash(32) + offsets(64) + encodeData(384)
       │         └─ abi.decode PayloadStruct from remaining bytes
       └─ other → ERC1271Forwarder (rare — non-Safe ERC1271 contracts)
            └─ skip first 384 bytes (GPv2Order.Data), abi.decode PayloadStruct
  └─ PayloadStruct → { proof[], ConditionalOrderParams, offchainInput }
       └─ ConditionalOrderParams → { handler, salt, staticInput }
            └─ keccak256(abi.encode(handler, salt, staticInput)) = hash
                 └─ match against conditionalOrderGenerator.hash
```

**Working implementation** is available at `tmp/m3-research/decode-signature.ts` (produced by the API research agent). Move to `src/application/decoders/erc1271Signature.ts`.

**Known handler addresses** (from API research — use to verify decoded `handler` is a composable cow order):

| Order Type | Handler Address |
|------------|----------------|
| TWAP | `0x6cF1e9cA41f7611dEf408122793c358a3d11E5a5` |
| StopLoss | `0x412c36e5011cd2517016d243a2dfb37f73a242e7` |
| GoodAfterTime | `0xdaf33924925e03c9cc3a10d434016d6cfad0add5` |
| PerpetualSwap | `0x519BA24e959E33b3B6220CA98bd353d8c2D89920` |
| TradeAboveThreshold | `0x812308712a6d1367f437e1c1e4af85c854e1e9f6` |

These addresses are identical across all chains. Add to `src/data.ts` as `COMPOSABLE_COW_HANDLER_ADDRESSES`.

**Codebase additions:**
- `src/application/decoders/erc1271Signature.ts` (or similar) — the decoder utility, used by both Phase B and Phase D
- Unit tests with real captured signatures from the API research output

**Done when:** Given a raw ERC1271 signature bytes, the decoder correctly returns the handler, salt, staticInput, and the computed hash — confirmed against at least one real TWAP and one Stop Loss order.

---

### Phase B — Trade Event Handler (primary fill detection)

**Goal:** Index `GPv2Settlement:Trade` events and use them as the primary signal that a discrete part was filled. Update `discreteOrder` records accordingly.

**Trade events are the primary source of truth for fills.** The block handler (Phase C) handles the unfilled/expired case; Phase B handles the filled case.

**Processing flow per `GPv2Settlement:Trade` event:**
1. Extract `orderUid`, `owner`, `sellToken`, `buyToken`, `sellAmount`, `buyAmount`, `feeAmount`
2. Check if `owner` is a known composable cow owner (direct from `conditionalOrderGenerator`, or via `owner_mapping` → M2 dependency)
3. If yes: look up `orderUid` in `discreteOrder`
   - If found: update status to `filled` with amounts
   - If not found: decode ERC1271 signature (Phase A decoder) → find `conditionalOrderGenerator` → create `discreteOrder` record with status `filled`
4. If `owner` is not known: skip (not a composable cow order)

**Note on M2 dependency:** Step 2 requires the `owner_mapping` table from M2. This is the only direct M2 dependency in M3. Since M3 starts after M2 is complete, this is not a blocker.

**Codebase additions:**
- `src/data.ts` — GPv2Settlement address + start block (may already exist from M2 Phase B)
- `ponder.config.ts` — add or extend GPv2Settlement contract (if not already added for M2)
- `src/application/handlers/settlement.ts` — extend with trade event handler (M2 may have created this file for owner mapping; M3 adds order-fill logic to it)
- `schema/tables.ts` — fill in `discreteOrder` table with status, amounts, timestamps

**Done when:** A TWAP order that has executed on mainnet shows its filled parts correctly in `discreteOrder` with accurate amounts.

---

### Phase C — Block Handler + PollResultErrors (unfilled/expired detection)

**Goal:** Detect discrete parts that were not filled (unfilled window passed, or order expired entirely). This is what makes M3 more than "just trade event indexing."

**Why we need this:** Trade events only fire when an order executes. TWAP part #3 of 10 can silently expire with no on-chain event. Without the block handler, it simply disappears. The grant requires tracking unfilled/expired parts as a must-have.

**Design decisions:**

**1. Block handler does NOT run during historical backfilling.**

Running `getTradableOrder` on every historical block is prohibitively expensive (millions of unique `eth_call` requests with no cache benefit). Historical fills are captured by the trade event handler (Phase B). The block handler only runs from the current block onward — i.e., from the time of deployment.

Implication: for historical TWAP orders, we may not have complete unfilled/expired part data before the deployment date. This is an acceptable trade-off, documented as a known limitation.

**2. PollResultErrors scheduling (not fixed intervals).**

Each active composable cow order stores a "next check at block N" value. The block handler only processes orders where `nextCheckBlock <= currentBlock`. After checking, the order's `nextCheckBlock` is updated based on the PollResultErrors revert reason:

- `TRY_NEXT_BLOCK` → nextCheckBlock = currentBlock + 1
- `TRY_AT_EPOCH(t)` → nextCheckBlock = block where timestamp ≥ t
- `DONT_TRY` → order is inactive; stop checking
- `DONT_TRY_WITH_REASON(reason)` → log reason; mark order as expired/cancelled

This is strictly better than a fixed interval: each order self-schedules at the minimum necessary frequency.

**3. Block handler is lightweight per order.**

If 50 orders are active but only 3 are "due" on a given block, only 3 `getTradableOrder` calls are made. The overhead scales with `dueOrders`, not `allOrders`.

**New schema concept: `orderPollState`**

```
order_poll_state
  conditionalOrderGeneratorId   text     (FK to conditionalOrderGenerator)
  chainId                       integer
  nextCheckBlock                bigint   — skip this order until this block
  lastCheckBlock                bigint   — last block we actually checked
  lastPollResult                text     — last PollResultErrors reason (for debugging)
  isActive                      boolean  — false = DONT_TRY received, stop checking
```

**Processing flow per block:**
1. Fetch all `order_poll_state` records where `nextCheckBlock <= currentBlock AND isActive = true`
2. For each: call `handler.getTradableOrder(owner, [], staticInput, offchainInput, currentBlock)` (via viem multicall where possible)
3. If returns order: expected discrete part is "open" — upsert into `discreteOrder` with status `open`
4. If reverts with PollResultErrors: parse reason, update `nextCheckBlock`, mark order as done if `DONT_TRY`
5. If `discreteOrder` for this part exists and has no trade event: it's unfilled for this window

**Codebase additions:**
- Block handler in `ponder.config.ts` (Ponder block handler registration)
- `schema/tables.ts` — `order_poll_state` table
- `src/application/handlers/blockHandler.ts` — the block handler logic
- `src/application/helpers/pollResultErrors.ts` — parse PollResultErrors revert reasons (reference: cow-sdk Twap.ts#L354)

> **Reference:** [cow-sdk Twap.ts#L354](https://github.com/cowprotocol/cow-sdk/blob/main/packages/composable/src/orderTypes/Twap.ts#L354) and [cow-sdk types.ts#L183](https://github.com/cowprotocol/cow-sdk/blob/main/packages/composable/src/types.ts#L183)

**Done when:** A TWAP order with N parts shows: filled parts (from Phase B), open/current part (from block handler), and unfilled/expired past parts (marked by block handler when window passed without a trade event).

---

### Phase D — Orderbook API + Persistent Cache

**Goal:** Fetch order details from the orderbook API for cases we cannot determine purely from on-chain data. Persist responses so they survive Ponder redeployments.

**When we need the orderbook API:**
1. **Perpetual swaps** — non-deterministic UIDs; we can't predict the UID without calling `getTradableOrder` on-chain. But the orderbook API can tell us all open orders for an owner at a point in time.
2. **Partial fill amounts** — trade events give us the amounts per fill, but the orderbook API gives the accumulated state across multiple partial fills.
3. **Cancellations** — composable cow orders can be cancelled via the `OrderCancelled` event (on-chain) or via presign/soft cancel on the orderbook. The on-chain cancellation is the authoritative one; the orderbook API cancellation is a soft signal.

**What we do NOT need the API for (covered by on-chain):**
- Whether a TWAP part was filled (trade event)
- Whether a part window passed without fill (block handler + timestamp comparison)
- Order creation and decoded params (M1)

**Persistent cache design:**

A PostgreSQL table outside Ponder's sync-managed schema (does not get dropped on Ponder resync). Stores orderbook API responses keyed by request identity.

```
orderbook_cache
  cacheKey        text     — hash of (endpoint, params) — PK
  responseJson    json     — full API response
  fetchedAt       bigint   — unix timestamp of fetch
```

> This table must be created outside Ponder's `onchainTable` mechanism so it is NOT wiped on a full Ponder resync. Use a separate Drizzle migration or an `onApplicationStart` hook to ensure it exists.

**Cache usage pattern:**
1. Before calling the orderbook API: check `orderbook_cache` for a fresh entry (fetchedAt + TTL > now)
2. Cache hit → use cached response
3. Cache miss → fetch API → write to cache → use response

**Cache TTL guidance:** Order lists for an owner can be cached for a few minutes (they change only when new orders are created or filled). A specific order UID status can be cached until it reaches a terminal state (filled, expired, cancelled) — then cached indefinitely.

> **API research dependency:** Phase D cannot be fully designed until the API research confirms endpoint structure, rate limits, and pagination. The cache key design and TTL values depend on the API's response format and rate limit headroom. See `thoughts/reference_docs/m3-orderbook-api-research.md`.

**Codebase additions:**
- `schema/tables.ts` — `orderbook_cache` table (managed separately from Ponder sync)
- `src/application/services/orderbookApi.ts` — API client with cache integration
- Migration or startup hook to create the cache table

---

### Phase E — GraphQL API Layer

**Goal:** Expose the full M3 data set via the GraphQL API.

**New queries / fields:**
- `conditionalOrderGenerator` → add `discreteOrders`, `executionStatus`, `totalParts`, `filledParts`
- `discreteOrder` → status (open | filled | unfilled | expired), fill amounts, orderbook UID
- Top-level `discreteOrders(owner: "0x...", status: filled)` query
- `conditionalOrderGenerators(owner: "0x...", status: active)` — filter by execution state

**Owner resolution in queries:** All queries that accept an `owner` parameter should resolve through `owner_mapping` (from M2) so that querying by EOA returns orders placed via CoWShed proxy or flash loan helper.

**No new indexing** in this phase — it's purely the API/query layer.

---

## 5. Updated Schema Concepts

### `discreteOrder` (fill in the M1 stub)

```
discrete_order
  orderUid                        text        — PK part
  chainId                         integer     — PK part
  conditionalOrderGeneratorId     text        — FK
  status                          enum        — open | filled | unfilled | expired
  partIndex                       integer     — for TWAP: which part (0-indexed); null for others
  sellAmount                      numeric     — actual sell amount (from trade event or API)
  buyAmount                       numeric     — actual buy amount
  feeAmount                       numeric
  filledAt                        bigint      — block number of fill (from trade event)
  detectedBy                      enum        — trade_event | block_handler | orderbook_api
```

### `order_poll_state` (new in Phase C)

As described in Phase C above.

### `orderbook_cache` (new in Phase D, managed outside Ponder sync)

As described in Phase D above.

---

## 6. Key Decisions

| Decision | Choice | Notes |
|----------|--------|-------|
| Primary fill signal | Trade events | Block handler handles unfilled/expired only |
| Block handler frequency | PollResultErrors per order | Adaptive scheduling; not fixed interval |
| Block handler history | Skip historical blocks | Only run from deployment block onward; historical fills from trade events |
| Persistent cache | PostgreSQL table, outside Ponder managed schema | Not dropped on Ponder resync; separate migration |
| M3 start | After M2 complete | Hard dependency on `owner_mapping` for trade event owner resolution |
| Perpetual swap matching | Orderbook API + cache | Non-deterministic UIDs; can't predict without API |

---

## 7. Risks & Open Points

### Block Handler Historical Gap (design limitation, not a bug)
Orders created before the M3 deployment date will not have complete unfilled/expired part history. Trade events cover historical fills. But TWAP parts that expired before deployment with no trade event are not detectable retroactively without replaying all blocks (which is too expensive). **This is an accepted limitation** — document it clearly in M4 API docs.

### Perpetual Swap Edge Case (⚠ open point)
For perpetual swaps, the UID is non-deterministic. The block handler calls `getTradableOrder` and gets the UID for the current period. But what about UIDs from past periods that we missed before deployment? We'd need to query the orderbook API for all historical orders by owner. The cache helps on re-syncs, but the first run after deployment still needs to fetch all history. Rate limits may constrain this.

> **To confirm with API research:** Can we efficiently fetch all historical orders for an owner in a single paginated request? What's the maximum history?

### Signature Decode for Safe-Owned Orders
Some composable cow orders are owned by a Safe multisig (not a CoWShed proxy). Safe signatures have an outer wrapper (`checkNSignatures` with selector `0x5aab22b1`). The Phase A decoder must handle this layer before the inner ERC1271 decode. Confirm the exact Safe signature structure in the API research output.

### `getTradableOrder` Revert Behavior Across Order Types
PollResultErrors parsing is well-documented for TWAP (cow-sdk reference). Other order types (Stop Loss, Perpetual Swap, etc.) may use different revert reasons or no standard revert at all. The block handler must handle unexpected reverts gracefully (treat as TRY_NEXT_BLOCK rather than crashing).

> **To verify:** Does every order type handler implement PollResultErrors consistently? Check against the composable-cow repo handlers.

### Orderbook API Rate Limits (⚠ pending research)
If rate limits are tight and we have many composable cow owners, the initial fetch-all-history for perpetual swaps could be throttled. Need to know limits before designing the cache refresh strategy.

### Cancellation Detection
On-chain cancellations via `OrderCancelled` event on ComposableCoW must be wired. M1 may have stubs for this; if not, it should be added as part of M3. Soft cancellations via the orderbook API are a secondary signal.

---

## 8. M3 "Done" Criteria

- TWAP order shows all N discrete parts with correct status: filled parts (with amounts), unfilled parts (window passed with no fill), and expired parts
- Non-deterministic order types (Perpetual Swap) show matched fills from trade events
- Block handler correctly schedules per order using PollResultErrors; no redundant `eth_call` spam
- Orderbook API responses are cached in PostgreSQL and survive a Ponder resync (validate by re-syncing with cache populated and confirming API calls are not repeated)
- GraphQL: query `conditionalOrders(owner: "0xEOA")` returns all orders across direct ownership, CoWShed proxies, and flash loan helpers with their execution status and discrete parts
- Historical limitation documented: unfilled/expired parts before deployment date are not available

---

## 9. What Needs API Research Before Proceeding

These decisions are blocked until `thoughts/reference_docs/m3-orderbook-api-research.md` is complete:

1. **Signature field format** — raw hex? Base64? Does it include a Safe outer wrapper for all ERC1271 orders?
2. **Pagination strategy** — how to efficiently fetch all historical orders for a perpetual swap owner
3. **Rate limits** — affects how aggressively we can populate the cache on first run
4. **Partial fill fields** — exact field names in the API response for accumulated fill amounts
5. **Cancellation endpoint** — does the API expose soft cancellations? Are they reliable?

---

## 10. References

| Topic | Source |
|-------|--------|
| M3 grant scope | `thoughts/reference_docs/grant_proposal.md` §M3 |
| M3 technical decisions | `thoughts/reference_docs/grant_aligned_summary.md` §M3 |
| Slack decisions | `agent_docs/slack_decisions_summary.md` §1 |
| Architecture | `agent_docs/architecture.md` |
| ERC1271Forwarder signature | https://github.com/cowprotocol/composable-cow/blob/main/src/ERC1271Forwarder.sol#L30 |
| PollResultErrors (TWAP) | https://github.com/cowprotocol/cow-sdk/blob/main/packages/composable/src/orderTypes/Twap.ts#L354 |
| PollResultErrors (types) | https://github.com/cowprotocol/cow-sdk/blob/main/packages/composable/src/types.ts#L183 |
| API research prompt | `thoughts/prompts/m3-orderbook-api-research-prompt.md` |
| API research output | `thoughts/reference_docs/m3-orderbook-api-research.md` (to be created by agent) |
| Planning log | `thoughts/plans/2026-03-06-m3-planning-log.md` |
| Sprint plan | `thoughts/plans/sprint_plan.md` §Sprint 4–7 |
