---
status: draft
linear_synced: false
created: 2026-03-06
milestone: M3
estimate: 3
labels: [service, feature]
---

# Implement orderbook API client service with caching

## Problem

Multiple M3 components need to query the CoW orderbook API: trade event handler (to decode order signatures), polling handler (to find open/expired orders), and perpetual swap matching (to find non-deterministic UIDs). Without a centralized service with caching, each component would independently make redundant API calls and there would be no protection against rate limits or Ponder resync storms.

## Details

**File location:** `src/application/services/orderbookApi.ts`

**Key behaviors:**
- Fetch all orders for an owner: `GET /api/v1/account/{owner}/orders` with offset-based pagination (max 1000 per page)
- Bulk fetch by UIDs: `POST /api/v1/orders/by_uids` (max 128 UIDs per request)
- Fetch single order: `GET /api/v1/orders/{uid}`
- All responses cached in `orderbook_cache` table (Task 4)
- Before any API call: check cache, return cached if not expired
- Error handling: exponential backoff on 5xx; return null on 404; no auth required

**API base URL:**
- Mainnet: `https://api.cow.fi/mainnet/api/v1`
- Read from env var `COW_API_BASE_URL` (default to mainnet URL)

**Filtering composable cow orders** (after fetching):
1. `order.signingScheme === "eip1271"` — **exact string, NOT "erc1271"**
2. `decodeEip1271Signature(order.signature)` returns non-null
3. Decoded `handler` is in `COMPOSABLE_COW_HANDLER_ADDRESSES`

## Implementation Notes

- Depends on Task 1 (decoder) and Task 4 (cache table)
- The `eip1271` vs `erc1271` distinction is a known source of bugs — use the exact string `"eip1271"`

## Acceptance Criteria

- Service fetches all pages for an owner with 35+ orders (pagination works)
- Cache hit is returned on second call without a network request
- EIP1271 filtering correctly excludes non-composable-cow orders
- `pnpm typecheck` and `pnpm lint` pass

## Dependencies

- Task 1 (ERC1271 decoder)
- Task 4 (orderbook_cache table)

## References

- Source: `thoughts/prompts/m3-linear-tasks-prompt.md` Task 5
- Macro plan: `thoughts/plans/2026-03-06-milestone-3-macro-plan.md` Phase D
- API research: `thoughts/reference_docs/m3-orderbook-api-research.md`
