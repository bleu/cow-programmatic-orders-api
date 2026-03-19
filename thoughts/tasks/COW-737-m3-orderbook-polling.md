---
status: draft
linear_synced: false
created: 2026-03-06
milestone: M3
estimate: 3
labels: [handler, feature]
---

# Orderbook polling: discover open and expired discrete orders

## Problem

Trade events only fire when an order is settled on-chain. TWAP parts that are currently open (submitted to the orderbook but not yet matched) or that expired silently produce no on-chain event. The only way to detect these states is to poll the CoW orderbook API. Without polling, open and expired orders remain invisible in the database.

## Details

**Polling approach:**
- Use a Ponder block handler or periodic job (every 10–30 blocks, ~2–6 minutes)
- Configurable constant for polling interval — do NOT poll every block
- On trigger: fetch orders for all owners with at least one active `conditionalOrderGenerator`

**Per API order:**
- `status === "open"` → upsert `discrete_order` with `status: "open"`, `detectedBy: "orderbook_api"`
- `status === "fulfilled"` → upsert with `status: "fulfilled"` (Trade event handler may already have this)
- `status === "expired"` → upsert with `status: "expired"`
- `status === "cancelled"` → upsert with `status: "cancelled"`

**Stop-early strategy:** API returns orders sorted by `creationDate` descending (newest first). Stop paginating once orders are older than `(current_timestamp - max_order_lifetime)`. Avoids fetching all history on every poll cycle.

**Cache aggressively:** Only re-fetch when TTL has expired.

**File location:** Extend `src/application/handlers/settlement.ts` or create `src/application/handlers/pollingHandler.ts`

## Acceptance Criteria

- An open TWAP order (submitted to orderbook but not yet matched) appears in `discrete_order` with `status: "open"`
- An expired order that never executed appears with `status: "expired"`
- Polling does not re-fetch cached orders unnecessarily
- `pnpm typecheck` and `pnpm lint` pass

## Dependencies

- Task 2 (discreteOrder schema)
- Task 5 (orderbook API client)

## References

- Source: `thoughts/prompts/m3-linear-tasks-prompt.md` Task 7
- Macro plan: `thoughts/plans/2026-03-06-milestone-3-macro-plan.md` Phase C/D
- API research: `thoughts/reference_docs/m3-orderbook-api-research.md`
