# COW-971 — Candidate Lifecycle Investigation

**Date**: 2026-05-27  
**Investigator**: Luiz Hatem  
**Source**: QA feedback from Pedro (2026-05-19)

---

## Known QA Order

**UID**: `0xf67f30204d58309213b9f37728d6404fa6664bd2da04a002f1c9731252f4fcba1d2ee08106f12960dc89ecf574778d9528904c616a022b12`

### CoW Protocol Orderbook API (`api.cow.fi/mainnet`)

| Field | Value |
|-------|-------|
| `status` | `expired` |
| `class` | `limit` (appData orderClass: `twap`) |
| `signingScheme` | `eip1271` |
| `creationDate` | 2026-05-11T18:16:41.918162Z |
| `validTo` | 1778526994 (~2026-05-11 19:17 UTC, ≈1 hour after creation) |
| `owner` | `0x1d2ee08106f12960dc89ecf574778d9528904c61` |
| `executedSellAmount` | `0` |
| `executedBuyAmount` | `0` |
| `invalidated` | `false` |

**Classification**: This is one part of a TWAP order. It was submitted to the CoW orderbook, expired without being filled.

### Indexer state — deployed endpoint

The deployed endpoint (`https://cow-programmatic-order.bleu.blue/`) returned **HTTP 502** during investigation. Live database queries could not be performed. The analysis below is based on code paths only.

### Expected indexer path for this order

Since this is a TWAP part (`signingScheme: eip1271`, appData orderClass `twap`), the TWAP generator was a deterministic type. At `ConditionalOrderCreated` time, `uidPrecompute.ts` would have computed this UID and called `fetchOrderStatusByUids`.

Two sub-cases:

**Case A — UID was on the API at creation time**  
The UID would have been inserted directly into `discreteOrder` (either as `open` or `expired` depending on when indexing happened). This is the happy path — no candidate involved.

**Case B — UID was NOT on the API at creation time**  
The UID would have gone into `candidateDiscreteOrder`. C2 would check every block (~12 s on mainnet). With ~300 blocks of window (1 hour), C2 had many chances to find it.

Two sub-sub-cases within Case B:

- **B1**: C2 found the order on the API before `validTo` passed → promoted to `discreteOrder` as `open`, then C3 updated it to `expired`. Expected row in `discreteOrder` with `status: "expired"`. **This is the correct path.**

- **B2**: C2 never found it before `validTo` passed → C2's stale cleanup (`lte(validTo, currentTimestamp)`) deleted the candidate row. No `discreteOrder` row was ever created. **This is the silent data loss.**

The fact that the order is on the CoW API means it WAS submitted — the watch-tower did its job. The concern is whether Case B2 occurred due to:
- API propagation delay (watch-tower submitted near the deadline)
- Indexer downtime during the validity window
- An API response timeout during C2's `fetchOrderStatusByUids`

---

## Code Analysis: Dominant Lifecycle Issues

### Issue 1 — Stale cleanup deletes without API check (PRIMARY)

**Location**: `blockHandler.ts:483-491` (C2 handler, end of run)

```typescript
await context.db.sql
  .delete(candidateDiscreteOrder)
  .where(
    and(
      eq(candidateDiscreteOrder.chainId, chainId),
      lte(candidateDiscreteOrder.validTo, Number(event.block.timestamp)),
    ),
  );
```

This runs regardless of whether the API was checked in the same run. If the API batch call (`fetchOrderStatusByUids`) happened to not include an order that already expired — or if a candidate was sitting in the table while the indexer was down — it gets silently deleted.

**Why this matters**: The CoW API retains `expired` orders. C2 could do a final API check before deleting and promote stale candidates as "expired" rather than dropping them. The current behavior treats "watch-tower never submitted" and "submitted but expired before we confirmed" identically — both disappear.

### Issue 2 — Expired candidates are undebuggable (SECONDARY)

There is no way to distinguish between:
- An order that was submitted, expired, and C2 confirmed it as `expired`
- An order that was submitted, expired, and C2 silently pruned it as stale
- An order that was never submitted and got pruned as stale

All three leave different amounts of evidence, but case 2 and 3 are indistinguishable in the current schema.

### Issue 3 — No `promotedAt` timestamp

When C2 promotes a candidate to `discreteOrder`, there's no timestamp recording when that promotion happened. You can infer it from `creationDate` (block timestamp on candidate insert) but you cannot tell when the API confirmed it.

### Non-issue: TWAP `possibleValidAfterTimestamp`

The `possibleValidAfterTimestamp` filter in C2 is correctly skipping checks for TWAP parts whose validity window hasn't started. This is not a source of missed orders — it's a correct optimization.

---

## Sampling — Deployed Endpoint

**Blocked by 502**. The deployed endpoint was unavailable during investigation.

The following queries were intended but could not be executed:

```graphql
# Recent candidates
{ candidateDiscreteOrders(limit: 10, orderBy: "creationDate", orderDirection: "desc") {
    items { orderUid chainId validTo creationDate possibleValidAfterTimestamp }
} }

# The known QA order
{ discreteOrder(id: "0xf67f...", chainId: 1) { orderUid status validTo creationDate } }
```

---

## Recommended Task Split for COW-972

Based on code analysis, COW-972 should be a **single PR** covering:

### 1. Fix stale cleanup — promote instead of delete

Before deleting stale candidates, do a final API check. If the API has the order (even as `expired`), promote it to `discreteOrder`. If the API doesn't have it (never submitted), promote it anyway with `status: "expired"` as a "watch-tower skip" sentinel. **No candidate row should ever be silently deleted.**

This is the core behavior fix.

### 2. Add `promotedAt` to `discreteOrder`

Nullable `bigint`. Set by C2 when a candidate is promoted. Null for rows inserted directly by UID precomputation or C4 (they never went through the candidate stage). This field makes the promotion moment debuggable without a separate lifecycle log.

### 3. GQL documentation

Update `discreteOrder` field docs to explain:
- `promotedAt: null` = created directly (precomputation at creation time or C4 historical fetch)
- `promotedAt: N` = was a candidate until block N, then confirmed via C2
- `status: "expired"` with `executedSellAmount: null` = confirmed expired by API or pruned without API confirmation (both land in `discreteOrder` now)

### Explicitly out of scope for COW-972

- Changing how C1 schedules checks — not a lifecycle fix
- Adding a `candidateExpiredWithoutSubmission` status — the `promotedAt` + `status: "expired"` combination is sufficient
- Separate PRs for timestamp fields — all of these serve the same debugging story and belong together

---

## Summary

| Area | Finding |
|------|---------|
| Known QA order | On the CoW API as `expired`, `executedSellAmount: 0`. Should be in `discreteOrder` if C2 confirmed it in time; may be silently missing if stale cleanup ran first. |
| Dominant issue | C2 stale cleanup deletes expired candidates without a final API check, leaving no trace |
| Secondary issue | No `promotedAt` field makes it impossible to know when a candidate was confirmed |
| COW-972 shape | Single PR: fix stale cleanup semantics + add `promotedAt` + GQL docs |
| Live data sample | Could not execute — deployed endpoint returned 502 |
