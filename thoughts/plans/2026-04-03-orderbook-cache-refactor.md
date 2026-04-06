# Orderbook Cache Refactor — Implementation Plan

## Overview

Replace the periodic orderbook API polling architecture with event-driven order discovery and a persistent cross-deploy cache. Orders are fetched once when a `ConditionalOrderCreated` event fires (live only), status transitions are resolved entirely from on-chain signals (Trade events, block handler `getTradeableOrderWithSignature`, PollResultErrors), and the API response cache survives Ponder resyncs by living in a separate PostgreSQL schema (`cow_cache`).

**Research document:** `thoughts/plan-orderbook-cache-refactor.md` (Parts A–F)
**Current flow documentation:** `thoughts/current-orderbook-flow.md`

## Current State Analysis

The M3 orderbook integration has 6 open cascade PRs (#20–#25), each building on the previous:

```
main
 └─ PR #20  cow-732  schema: discreteOrder, orderPollState, orderbook_cache
     └─ PR #21  cow-731  ERC1271 signature decoder
         └─ PR #22  cow-737  orderbook poller (periodic)
             └─ PR #23  cow-736  trade event handler
                 └─ PR #24  cow-738  block handler (PollResultErrors)
                     └─ PR #25  cow-739  GraphQL API + perf fixes
```

The periodic poller (`orderbookPoller.ts`) fires every 20 blocks per chain, fetches all orders for each active owner from the CoW API, decodes EIP-1271 signatures, and upserts discrete orders. The `orderbook_cache` table (raw DDL) caches terminal-status owners but has a **known production bug**: Ponder's `ponder start` creates a new schema per deployment, orphaning the raw DDL table in the old schema.

### Key Discoveries

- **Ponder's `search_path` behavior is pool-specific:**
  - The **`user` pool** (used by `context.db.sql.execute()` in event handlers) does **NOT** set `search_path` — it uses PostgreSQL's default `("$user", public)`. This means unqualified DDL like `CREATE TABLE orderbook_cache` lands in `public`, and cross-schema queries work natively. (`node_modules/ponder/dist/esm/utils/pg.js:47-108`)
  - The **`readonly` pool** (used by the API/GraphQL layer via `readonlyQB`) **does** set `search_path` to the Ponder namespace. Any raw SQL in API endpoints that needs to read from `cow_cache` must use fully qualified table names. (`node_modules/ponder/dist/esm/utils/pg.js:116`)
  - The pglite-only migration code sets `search_path` (`database/index.js:376`), but this does NOT apply to real PostgreSQL deployments.
- The current `orderbook_cache` table already lives in the `public` schema (not the Ponder namespace), which is why it survives `ponder dev` restarts. The production bug is specifically about `ponder start` creating a fresh namespace — but since the table is in `public`, the real issue may be that the readonly pool can't find it. **Moving to `cow_cache` schema with fully qualified names everywhere solves both the handler and API access patterns.**
- `getTradeableOrderWithSignature` returns `(GPv2Order.Data, bytes signature)` on success — all 12 order fields including `validTo`, `sellAmount`, `buyAmount`, `feeAmount` are available. The block handler currently discards this data at `blockHandler.ts:136`.
- `orderUid` = `encodePacked(orderDigest, owner, validTo)` where `orderDigest` is the EIP-712 typed hash. Domain: `{name: "Gnosis Protocol", version: "v2", chainId, verifyingContract: GPV2_SETTLEMENT_ADDRESS}`. Implementable with viem's `hashTypedData` + `encodePacked` — no new dependencies needed.
- `partIndex` formula has an off-by-one bug at `orderbookPoller.ts:290` and `tradeEvent.ts:206`. Current: `(validTo - t0) / t - 1n`. Correct: `(validTo + 1n - t0) / t - 1n`.

## Desired End State

After all phases are complete:

1. **No periodic polling** — `orderbookPoller.ts` is deleted, `OrderbookPollerMainnet`/`OrderbookPollerGnosis` removed from `ponder.config.ts`
2. **Fetch-on-creation** — when `ConditionalOrderCreated` fires (live only), all orders for that owner are fetched once from the API and cached
3. **Block handler creates discrete orders** — on `getTradeableOrderWithSignature` success, the returned `GPv2Order.Data` is used to compute `orderUid` and upsert a `discreteOrder` row
4. **Block handler detects expiry** — open discrete orders with `validTo < block.timestamp` are marked `expired`
5. **Persistent cache** — `cow_cache.orderbook_cache` lives in a separate schema and survives all Ponder resyncs/redeployments
6. **Trade events remain authoritative** for fulfillment (unchanged)

### Verification

```bash
pnpm codegen    # Schema changes compile
pnpm typecheck  # All types resolve
pnpm lint       # No lint errors
pnpm dev        # Indexer starts, processes live blocks, discovers orders without polling
```

Manual: confirm discrete orders appear in the GraphQL API for a known composable cow owner.

## What We're NOT Doing

- **No external cache service** (Redis, separate DB) — the same PostgreSQL instance is used via a separate schema
- **No TWAP-specific orderUID optimization** (D2 in research doc) — deferred; owner-level fetch works for all types
- **No `ConditionalOrderCancelled` event handler** — not yet implemented; `PollNever` covers cancellation
- **No sync recovery burst fetch** — deferred (Phase 6 is optional); post-resync data gap is acceptable short-term
- **No `@cowprotocol/sdk-order-signing` dependency** — `computeOrderUid` is implemented with pure viem
- **No off-chain cancellation detection** — API-only cancellations (DELETE endpoint) are not detected; documented as known limitation in code

## Implementation Approach

Changes land on the existing cascade PRs. The implementing agent works one phase at a time, rebases all downstream branches after each phase, and pauses for human review. Each phase maps to exactly one PR.

---

## Phase 1: Schema & Cache Infrastructure

**PR:** #20 `jefferson/cow-732-schema-fill-in-discreteorder-table`
**Branch:** `jefferson/cow-732-schema-fill-in-discreteorder-table`

### Overview

Add `validTo` column to `discreteOrder`, fix the `partIndex` off-by-one bug, and move the `orderbook_cache` table to a separate PostgreSQL schema (`cow_cache`) that survives Ponder redeployments.

### Changes Required

#### 1. Schema: add `validTo` to discreteOrder

**File:** `schema/tables.ts`
**Change:** Add `validTo` column to the `discreteOrder` table definition, after `filledAtBlock`.

```typescript
// In the discreteOrder onchainTable definition, add:
validTo: t.integer(),  // uint32 Unix timestamp — from API or getTradeableOrderWithSignature
```

#### 2. Fix `partIndex` off-by-one

**File:** `schema/tables.ts` or wherever the formula appears in this branch.
**Change:** If the `partIndex` derivation formula exists on this branch (it may only exist in later branches — check), fix:

- Old: `partIndex = (validTo - t0) / t - 1n`
- New: `partIndex = (validTo + 1n - t0) / t - 1n`

The contract sets `validTo = t0 + (part+1)*t - 1`, so inverting requires adding 1 before dividing.

**Note:** This formula appears at `orderbookPoller.ts:290` and `tradeEvent.ts:206` on later branches. If those files don't exist on this branch yet, the fix will be applied in the phases where they do. Add a note in the commit message about the bug so downstream phases know to apply the fix.

#### 3. Move `orderbook_cache` to `cow_cache` schema

**File:** `src/application/handlers/setup.ts`
**Change:** Replace the current DDL with schema-qualified table creation:

```typescript
ponder.on("ComposableCow:setup", async ({ context }) => {
  // Create a separate schema that Ponder's per-deployment schema management won't touch.
  // Ponder sets search_path to its own schema on each connection, but fully qualified
  // table names (cow_cache.orderbook_cache) bypass search_path and work correctly.
  await context.db.sql.execute(sql`CREATE SCHEMA IF NOT EXISTS cow_cache`);

  await context.db.sql.execute(sql`
    CREATE TABLE IF NOT EXISTS cow_cache.orderbook_cache (
      cache_key     TEXT PRIMARY KEY,
      response_json TEXT NOT NULL,
      fetched_at    BIGINT NOT NULL
    )
  `);

  // Log surviving cache entries
  const result = await context.db.sql.execute(
    sql`SELECT COUNT(*)::int AS count FROM cow_cache.orderbook_cache`,
  ) as { count: number }[];
  const count = result[0]?.count ?? 0;

  console.log(
    `[COW:SETUP] cow_cache.orderbook_cache ready — ${count} entr${count === 1 ? "y" : "ies"} from previous run`,
  );
});
```

**Cross-schema access is confirmed safe** from event handlers — Ponder's `user` pool does not restrict `search_path`. For the API layer (`src/api/index.ts`), the `readonly` pool has `search_path` restricted to the Ponder namespace, so any API endpoint that reads from `cow_cache` must also use `cow_cache.orderbook_cache` (fully qualified) in raw SQL. Ponder's `db.execute(sql\`...\`)` in the API layer passes raw SQL through, so this works.

**No fallback needed.** Cross-schema access works natively in both pools when using fully qualified names.

#### 4. Run codegen

After schema changes, run `pnpm codegen` to regenerate `ponder-env.d.ts`.

### Success Criteria

#### Automated Verification

- [ ] `pnpm codegen` succeeds
- [ ] `pnpm typecheck` passes
- [ ] `pnpm lint` passes
- [ ] `schema/tables.ts` has `validTo: t.integer()` in `discreteOrder`
- [ ] `setup.ts` references `cow_cache.orderbook_cache` (not unqualified `orderbook_cache`)

#### Manual Verification

- [ ] Start `pnpm dev`, verify `[COW:SETUP] cow_cache.orderbook_cache ready` appears in logs
- [ ] In psql: `\dn` shows `cow_cache` schema exists; `\dt cow_cache.*` shows the table
- [ ] Stop and restart `pnpm dev` — cache count should be preserved (not reset to 0)

### Post-Phase: Rebase Downstream

```bash
git checkout jefferson/cow-731-add-erc1271-signature-decoder-for-m3-order-matching
git rebase jefferson/cow-732-schema-fill-in-discreteorder-table
# Likely conflict in: schema/tables.ts — resolve by keeping the new validTo column
# Continue for each downstream branch in order: cow-737, cow-736, cow-738, cow-739
```

**STOP for review before proceeding to Phase 2.**

---

## Phase 2: `computeOrderUid` Utility

**PR:** #21 `jefferson/cow-731-add-erc1271-signature-decoder-for-m3-order-matching`
**Branch:** `jefferson/cow-731-add-erc1271-signature-decoder-for-m3-order-matching`

### Overview

Implement a pure-viem utility to compute GPv2 order UIDs from order data. This unblocks the block handler (Phase 5) to create discrete order rows from multicall results.

### Changes Required

#### 1. Create `computeOrderUid` helper

**File:** `src/application/helpers/orderUid.ts` (new file)

```typescript
import { encodePacked, hashTypedData, type Hex } from "viem";
import { GPV2_SETTLEMENT_ADDRESS } from "../../data";

// GPv2Order EIP-712 type definition — must match GPv2Order.sol exactly
const GPV2_ORDER_TYPES = {
  Order: [
    { name: "sellToken", type: "address" },
    { name: "buyToken", type: "address" },
    { name: "receiver", type: "address" },
    { name: "sellAmount", type: "uint256" },
    { name: "buyAmount", type: "uint256" },
    { name: "validTo", type: "uint32" },
    { name: "appData", type: "bytes32" },
    { name: "feeAmount", type: "uint256" },
    { name: "kind", type: "string" },
    { name: "partiallyFillable", type: "bool" },
    { name: "sellTokenBalance", type: "string" },
    { name: "buyTokenBalance", type: "string" },
  ],
} as const;

/** GPv2Order.Data fields as returned by getTradeableOrderWithSignature */
export interface GPv2OrderData {
  sellToken: Hex;
  buyToken: Hex;
  receiver: Hex;
  sellAmount: bigint;
  buyAmount: bigint;
  validTo: number;
  appData: Hex;
  feeAmount: bigint;
  kind: Hex;               // bytes32 — must be converted to "sell" or "buy" string
  partiallyFillable: boolean;
  sellTokenBalance: Hex;   // bytes32 — must be converted to "erc20" / "external" / "internal"
  buyTokenBalance: Hex;    // bytes32 — must be converted to "erc20" / "internal"
}

// GPv2Order.sol constant hashes
const KIND_SELL = "0x6ed88e868af0a1983e3886d5f3e95a2fafbd6c3450bc229e27342283dc429ccc";
const KIND_BUY  = "0x68d080d2d76b2b66b0362ccf78225f93b4e09a3d39c1e5bbd3e9750eafec7e1b";
const BALANCE_ERC20    = "0x5a28e9363bb942b639270062aa6bb295f434bcdfc42c97267bf003f272060dc9";
const BALANCE_EXTERNAL = "0xabee3b73373acd583a130924aad6dc38cfdc44ba0555ba94ce2ff63980ea0632";
const BALANCE_INTERNAL = "0x4ac99ace14ee0a5ef932dc609df0943ab7ac16b7583b3f8de0d74ae99a9e79b5";

function decodeKind(kindHash: Hex): string {
  if (kindHash.toLowerCase() === KIND_SELL.toLowerCase()) return "sell";
  if (kindHash.toLowerCase() === KIND_BUY.toLowerCase()) return "buy";
  return "sell"; // fallback
}

function decodeBalance(balanceHash: Hex): string {
  const h = balanceHash.toLowerCase();
  if (h === BALANCE_ERC20.toLowerCase()) return "erc20";
  if (h === BALANCE_EXTERNAL.toLowerCase()) return "external";
  if (h === BALANCE_INTERNAL.toLowerCase()) return "internal";
  return "erc20"; // fallback
}

/**
 * Compute the 56-byte order UID for a GPv2 order.
 *
 * UID = abi.encodePacked(orderDigest, owner, uint32(validTo))
 * where orderDigest = EIP-712 typed hash of the order struct.
 *
 * Reference: tmp/contracts/gpv2-contracts/src/contracts/libraries/GPv2Order.sol
 */
export function computeOrderUid(
  chainId: number,
  order: GPv2OrderData,
  owner: Hex,
): Hex {
  const domain = {
    name: "Gnosis Protocol",
    version: "v2",
    chainId,
    verifyingContract: GPV2_SETTLEMENT_ADDRESS as Hex,
  };

  // Convert bytes32 enum hashes to their string representations for EIP-712 hashing
  const message = {
    sellToken: order.sellToken,
    buyToken: order.buyToken,
    receiver: order.receiver,
    sellAmount: order.sellAmount,
    buyAmount: order.buyAmount,
    validTo: order.validTo,
    appData: order.appData,
    feeAmount: order.feeAmount,
    kind: decodeKind(order.kind),
    partiallyFillable: order.partiallyFillable,
    sellTokenBalance: decodeBalance(order.sellTokenBalance),
    buyTokenBalance: decodeBalance(order.buyTokenBalance),
  };

  const orderDigest = hashTypedData({
    domain,
    types: GPV2_ORDER_TYPES,
    primaryType: "Order",
    message,
  });

  return encodePacked(
    ["bytes32", "address", "uint32"],
    [orderDigest, owner, order.validTo],
  );
}
```

**Important implementation notes:**
- The `kind`, `sellTokenBalance`, `buyTokenBalance` fields come from `getTradeableOrderWithSignature` as `bytes32` hashes (e.g., `keccak256("sell")`). They must be converted back to strings for EIP-712 hashing because the type definition uses `string`, not `bytes32`. The constant hashes are from `GPv2Order.sol`.
- The `GPV2_SETTLEMENT_ADDRESS` is already exported from `src/data.ts` (line 9).
- `encodePacked` with `["bytes32", "address", "uint32"]` produces a 56-byte hex string, matching `GPv2Order.UID_LENGTH`.

#### 2. Validate against known order

After implementing, validate by computing the UID for the TWAP order in `tmp/m3-research/example-order-erc1271.json` and comparing against the API's `uid` field. This can be done in a throwaway test script or inline during dev.

### Success Criteria

#### Automated Verification

- [ ] `pnpm typecheck` passes
- [ ] `pnpm lint` passes
- [ ] File `src/application/helpers/orderUid.ts` exists and exports `computeOrderUid` and `GPv2OrderData`

#### Manual Verification

- [ ] `computeOrderUid` produces the correct UID for the example TWAP order (compare against `tmp/m3-research/example-order-erc1271.json` → `uid` field)
- [ ] The function handles both `kind: "sell"` and `kind: "buy"` correctly

### Post-Phase: Rebase Downstream

Rebase `cow-737` through `cow-739` onto this branch. New file should merge cleanly (no conflicts expected).

**STOP for review before proceeding to Phase 3.**

---

## Phase 3: Fetch-on-Creation + Remove Poller

**PR:** #22 `jefferson/cow-737-orderbook-polling-discover-open-and-expired-discrete-orders`
**Branch:** `jefferson/cow-737-orderbook-polling-discover-open-and-expired-discrete-orders`

### Overview

Replace the periodic orderbook poller with a one-time fetch triggered by `ConditionalOrderCreated`. Extract the fetch-and-match logic into a shared utility. Delete the poller and its block handler registrations.

### Changes Required

#### 1. Extract shared fetch utility

**File:** `src/application/helpers/orderbookFetch.ts` (new file)

Extract from `orderbookPoller.ts`:
- `processOwner()` logic → `fetchAndMatchOwnerOrders(context, chainId, apiBaseUrl, owner, blockTimestamp)`
- `processOrder()` logic → `matchOrderToGenerator(context, chainId, order)`
- Cache read/write helpers → update to use `cow_cache.orderbook_cache` (fully qualified)

The shared utility should:
- Check cache first (`cow_cache.orderbook_cache` by key `{chainId}:{owner}`)
- On cache miss: fetch `GET /api/v1/account/{owner}/orders` from the API
- Filter for `signingScheme === "eip1271"`, decode signatures, match to generators
- Upsert discrete orders with `validTo` from the API response
- Cache the response (terminal-only owners: permanent; owners with open orders: store but with short expiry so they're re-fetched next time)
- Fix the `partIndex` formula: `(validTo + 1n - t0) / t - 1n`

#### 2. Add fetch-on-creation to `composableCow.ts`

**File:** `src/application/handlers/composableCow.ts`

After the existing generator insert (around line 111), add:

```typescript
// Fetch owner orders from API (live only — skip during backfill)
const nowSeconds = Math.floor(Date.now() / 1000);
const lagSeconds = nowSeconds - Number(event.block.timestamp);
if (lagSeconds <= LIVE_LAG_THRESHOLD_SECONDS) {
  const apiBaseUrl = ORDERBOOK_API_URLS[chainId];
  if (apiBaseUrl) {
    await fetchAndMatchOwnerOrders(
      context,
      chainId,
      apiBaseUrl,
      ownerAddress,
      Number(event.block.timestamp),
    );
  }
}
```

Import `LIVE_LAG_THRESHOLD_SECONDS` from `../../constants` and `ORDERBOOK_API_URLS` from `../../data`.

The known limitation (off-chain cancellation gap) is already documented in the file header comment added earlier.

#### 3. Delete the periodic poller

- **Delete:** `src/application/handlers/orderbookPoller.ts`
- **Edit `ponder.config.ts`:** Remove `OrderbookPollerMainnet` and `OrderbookPollerGnosis` from the `blocks` section
- **Edit `src/constants.ts`:** Remove any constants that were only used by the poller (check if `MAX_ORDER_LIFETIME_SECONDS` is still needed — it's used by the fetch utility's cutoff window, so likely keep it)
- **Remove `DISABLE_ORDERBOOK_POLL` env var** handling if it exists

#### 4. Update cache helpers to use `cow_cache` schema

All SQL in cache helpers must use `cow_cache.orderbook_cache` instead of `orderbook_cache`:

```sql
SELECT response_json FROM cow_cache.orderbook_cache WHERE cache_key = ...
INSERT INTO cow_cache.orderbook_cache (...) VALUES (...) ON CONFLICT ...
```

### Success Criteria

#### Automated Verification

- [ ] `pnpm typecheck` passes
- [ ] `pnpm lint` passes
- [ ] `orderbookPoller.ts` does not exist
- [ ] `ponder.config.ts` has no `OrderbookPoller*` entries in `blocks`
- [ ] `src/application/helpers/orderbookFetch.ts` exists
- [ ] `composableCow.ts` imports and calls `fetchAndMatchOwnerOrders`

#### Manual Verification

- [ ] `pnpm dev` starts without errors (no missing handler registrations)
- [ ] Create or find a live `ConditionalOrderCreated` event — discrete orders appear in the DB after the event is processed
- [ ] Check `cow_cache.orderbook_cache` in psql — entries exist for fetched owners
- [ ] Restart `pnpm dev` — cache entries persist (count > 0 in setup log)

### Post-Phase: Rebase Downstream

This is the most conflict-heavy rebase. Expected conflicts:
- `ponder.config.ts` — poller registrations removed (cow-738 also touches this file)
- `src/constants.ts` — may have conflicting changes
- Any file that imported from `orderbookPoller.ts`

**STOP for review before proceeding to Phase 4.**

---

## Phase 4: Trade Handler Adjustments

**PR:** #23 `jefferson/cow-736-trade-event-handler-discrete-order-matching-and-status`
**Branch:** `jefferson/cow-736-trade-event-handler-discrete-order-matching-and-status`

### Overview

Update the trade event handler to store `validTo` on discrete order upserts and use the shared fetch utility for Gate 3 (API fallback).

### Changes Required

#### 1. Store `validTo` on upserts

**File:** `src/application/handlers/tradeEvent.ts`

- In Gate 3 (API fetch path, around line 218–238): add `validTo: order.validTo` to the `.values()` call
- In the `.onConflictDoUpdate` set clause: add `validTo: order.validTo` (in case the poller previously inserted without it)

#### 2. Fix `partIndex` formula

If the formula appears in this file (around line 206), fix:
- Old: `partIndex = (validTo - t0) / t - 1n`
- New: `partIndex = (BigInt(order.validTo) + 1n - t0) / t - 1n`

#### 3. Optionally use shared fetch utility for Gate 3

Gate 3 currently fetches a single order by UID (`GET /api/v1/orders/{orderUid}`). This is already efficient and doesn't need the owner-level fetch utility. **Keep it as-is** unless there's a reason to change. The shared utility is for owner-level fetches only.

### Success Criteria

#### Automated Verification

- [ ] `pnpm typecheck` passes
- [ ] `pnpm lint` passes
- [ ] `tradeEvent.ts` includes `validTo` in discrete order upsert values

#### Manual Verification

- [ ] Process a Trade event for a known composable cow order — `discrete_order.valid_to` column is populated

### Post-Phase: Rebase Downstream

Minimal conflicts expected — trade handler is self-contained.

**STOP for review before proceeding to Phase 5.**

---

## Phase 5: Block Handler — Discrete Order Creation + Expiry Detection

**PR:** #24 `jefferson/cow-738-block-handler-unfilledexpired-detection-via-pollresulterrors`
**Branch:** `jefferson/cow-738-block-handler-unfilledexpired-detection-via-pollresulterrors`

### Overview

Extend the block handler to (a) create discrete order rows from `getTradeableOrderWithSignature` success results, and (b) mark open discrete orders as expired when `validTo < block.timestamp`.

### Changes Required

#### 1. Read order data from multicall success

**File:** `src/application/handlers/blockHandler.ts`

In the success branch (around line 136), access the returned order data:

```typescript
if (result.status === "success") {
  const [orderData, _signature] = result.result as [GPv2OrderData, Hex];
  
  // Compute orderUid for this order
  const orderUid = computeOrderUid(chainId, orderData, order.owner);
  
  // Derive partIndex for TWAP
  let partIndex: bigint | null = null;
  // (look up generator's orderType and decodedParams — already available in the dueOrders query)
  // If TWAP with known t0 and t: partIndex = (BigInt(orderData.validTo) + 1n - t0) / t - 1n

  // Upsert discrete order — only if status would be "open" (don't overwrite fulfilled/expired)
  await context.db.sql
    .insert(discreteOrder)
    .values({
      orderUid: orderUid.toLowerCase(),
      chainId,
      conditionalOrderGeneratorId: order.generatorId,
      status: "open",
      partIndex,
      sellAmount: orderData.sellAmount.toString(),
      buyAmount: orderData.buyAmount.toString(),
      feeAmount: orderData.feeAmount.toString(),
      validTo: orderData.validTo,
      filledAtBlock: null,
      detectedBy: "block_handler" as const,
      creationDate: BigInt(Number(event.block.timestamp)),
    })
    .onConflictDoNothing();  // Don't overwrite if already exists (e.g., from API fetch or trade event)

  // Schedule recheck (existing behavior)
  await updatePollState(context, chainId, order.generatorId, currentBlock, {
    nextCheckBlock: currentBlock + RECHECK_INTERVAL,
    lastPollResult: "success",
  });
  successCount++;
}
```

**Note:** The dueOrders query (line 75) needs to be extended to also select `orderType` and `decodedParams` from `conditionalOrderGenerator` for the TWAP `partIndex` derivation. These fields are already joined but not selected — add them.

Import `computeOrderUid` and `GPv2OrderData` from `../helpers/orderUid`, and `discreteOrder` from `ponder:schema`.

#### 2. Add expiry detection

After the multicall processing loop, add a bulk update for expired orders:

```typescript
// Mark open discrete orders as expired if their validTo has passed
await context.db.sql
  .update(discreteOrder)
  .set({ status: "expired" })
  .where(
    and(
      eq(discreteOrder.chainId, chainId),
      eq(discreteOrder.status, "open"),
      lte(discreteOrder.validTo, Number(currentTimestamp)),
    ),
  );
```

Import `lte` from `ponder` (already imported: `lte` is used for `orderPollState` query).

#### 3. Update PollNever handling

In the `PollNever` case (around line 178), also expire any open discrete orders for this generator:

```typescript
case "never":
  // Deactivate poll state and mark generator Invalid (existing)
  // ... existing code ...

  // Also expire any open discrete orders for this generator
  await context.db.sql
    .update(discreteOrder)
    .set({ status: "expired" })
    .where(
      and(
        eq(discreteOrder.chainId, chainId),
        eq(discreteOrder.conditionalOrderGeneratorId, order.generatorId),
        eq(discreteOrder.status, "open"),
      ),
    );
  break;
```

### Success Criteria

#### Automated Verification

- [ ] `pnpm typecheck` passes
- [ ] `pnpm lint` passes
- [ ] `blockHandler.ts` imports `computeOrderUid` and `discreteOrder`
- [ ] `blockHandler.ts` upserts a `discreteOrder` on multicall success
- [ ] `blockHandler.ts` has an expiry check query after the multicall loop

#### Manual Verification

- [ ] Run `pnpm dev` and observe block handler logs — discrete orders appear for active generators
- [ ] Verify `discrete_order` rows with `detected_by = 'block_handler'` exist in the DB
- [ ] Verify `valid_to` is populated on block-handler-created orders
- [ ] If a TWAP part's `validTo` has passed, it should be marked `expired`

### Post-Phase: Rebase Downstream

Rebase `cow-739` onto this branch. Should be clean — different files.

**STOP for review before proceeding to Phase 6.**

---

## Phase 6: GraphQL + Optional Sync Recovery (Deferrable)

**PR:** #25 `jefferson/cow-739-graphql-api-expose-discrete-order-status-and-execution`
**Branch:** `jefferson/cow-739-graphql-api-expose-discrete-order-status-and-execution`

### Overview

Minor adjustments to the GraphQL layer for the new `validTo` field. Optional: implement one-time burst fetch on live transition for sync recovery.

### Changes Required

#### 1. GraphQL adjustments

**File:** `src/api/index.ts`

The auto-generated GraphQL schema (via Ponder's `graphql()` middleware) will automatically expose `validTo` on `discreteOrder` since it's an `onchainTable` column. No code changes needed for auto-generated queries.

For the custom `/api/orders/by-owner/:owner` endpoint: add `validTo` to the select clause (around line 118):

```typescript
validTo: schema.discreteOrder.validTo,
```

For the `/api/generator/:eventId/execution-summary` endpoint: no changes needed (it aggregates by status, not by `validTo`).

#### 2. Review performance fixes

The existing performance fixes on this branch (backfill skip, interval tuning) should be reviewed for compatibility:
- `LIVE_LAG_THRESHOLD_SECONDS` is still used by `composableCow.ts` (fetch-on-creation guard) and `blockHandler.ts` — keep it
- `ORDERBOOK_POLL_INTERVAL` is still used for `PollResultPoller` interval and `RECHECK_INTERVAL` — keep it
- Any references to `OrderbookPoller*` should have been removed during rebase from Phase 3

#### 3. Sync recovery (OPTIONAL — can defer)

If implementing:

**File:** `src/application/handlers/blockHandler.ts` or a new `syncRecovery.ts`

Detect transition from backfill to live:
```typescript
// Track whether we've done the initial sync fetch
let syncFetchDone = false;

// At the top of runPollResultCheck, after the backfill skip:
if (!syncFetchDone && lagSeconds <= LIVE_LAG_THRESHOLD_SECONDS) {
  syncFetchDone = true;
  // Trigger one-time burst fetch for all active owners not in cache
  // Throttle: 20 owners per invocation, track progress in cow_cache.sync_state
}
```

**Recommendation:** Defer this to a follow-up task. The fetch-on-creation + block handler already cover the steady-state. The only gap is historical orders after a full resync, which is acceptable short-term.

### Success Criteria

#### Automated Verification

- [ ] `pnpm typecheck` passes
- [ ] `pnpm lint` passes
- [ ] `pnpm codegen` passes (final check after all rebases)

#### Manual Verification

- [ ] `pnpm dev` runs clean — no errors, no references to deleted poller
- [ ] Query `/api/orders/by-owner/{address}` — results include `validTo` field
- [ ] Query `/graphql` — `discreteOrders` query includes `validTo`
- [ ] Full flow works: create a conditional order → discrete orders appear → trade event marks fulfilled → expired orders are detected by block handler

---

## Testing Strategy

### Integration Tests (Manual — `pnpm dev`)

1. **Fetch-on-creation:** Monitor logs for `[COW:OB:FETCH]` (or equivalent) after a `ConditionalOrderCreated` event
2. **Cache persistence:** Stop `pnpm dev`, check `SELECT COUNT(*) FROM cow_cache.orderbook_cache`, restart, verify count is preserved
3. **Block handler discrete orders:** Check `SELECT * FROM discrete_order WHERE detected_by = 'block_handler'`
4. **Expiry detection:** Find an order with past `validTo`, verify `status = 'expired'`
5. **Trade fulfillment:** Process a Trade event, verify `status = 'fulfilled'` and `filled_at_block` is set

### Edge Cases to Verify Manually

- Owner with zero orders in the API → no crash, no discrete orders created
- Owner with all terminal orders → cached permanently, not re-fetched on next generator creation
- TWAP with `t0 = 0` → `partIndex` is null (cannot derive without first fill)
- Block handler multicall failure → PollResultError handling unchanged

## Performance Considerations

- **Fetch-on-creation adds latency to event processing:** The API call happens synchronously during the `ConditionalOrderCreated` handler. For most owners this is <500ms. If it becomes a bottleneck, the fetch can be moved to a background mechanism.
- **Block handler now does DB writes on success:** One `INSERT ... ON CONFLICT DO NOTHING` per tradeable order per recheck cycle. This is bounded by the number of active generators (typically tens, not thousands).
- **Expiry check runs every 20 blocks:** `UPDATE ... WHERE status = 'open' AND valid_to < ?` is a cheap indexed query.

## Migration Notes

- The `orderbook_cache` table moves from the Ponder-managed schema to `cow_cache` schema. Existing cache entries in the old schema are effectively abandoned (they were in the per-deployment schema anyway). No data migration needed.
- The `validTo` column is added as nullable (`t.integer()` without `.notNull()`). Existing discrete orders from before this change will have `validTo = null`. These will NOT be picked up by the expiry check (which filters `validTo < block.timestamp`), which is correct — they'll eventually be updated by the trade event handler or re-discovered by the fetch utility.

## Git Workflow — Per-Phase Execution

### Recommended Workflow

A **separate implementing agent** works each phase. A **reviewing agent** (with full context from the planning session) reviews each PR before the next phase begins.

### Branch Names (Full)

```
BRANCHES=(
  "jefferson/cow-732-schema-fill-in-discreteorder-table"
  "jefferson/cow-731-add-erc1271-signature-decoder-for-m3-order-matching"
  "jefferson/cow-737-orderbook-polling-discover-open-and-expired-discrete-orders"
  "jefferson/cow-736-trade-event-handler-discrete-order-matching-and-status"
  "jefferson/cow-738-block-handler-unfilledexpired-detection-via-pollresulterrors"
  "jefferson/cow-739-graphql-api-expose-discrete-order-status-and-execution"
)
```

### Per-Phase Git Procedure

The implementing agent MUST follow this procedure after completing each phase:

#### 1. Verify changes on the target branch

```bash
# Switch to the phase's branch
git checkout jefferson/cow-<task>-<description>

# Check what changed
git diff --stat
git diff  # review full diff
```

#### 2. Run automated checks

```bash
pnpm codegen      # if schema/config changed
pnpm typecheck
pnpm lint
```

#### 3. Commit changes

```bash
# Stage only the files changed by this phase (never git add -A)
git add <specific files>

# Commit with descriptive message referencing the refactor
git commit -m "refactor(<task>): <description>

Part of orderbook cache refactor (thoughts/plans/2026-04-03-orderbook-cache-refactor.md)
Phase N: <phase name>

Co-Authored-By: Claude <noreply@anthropic.com>"
```

#### 4. Rebase all downstream branches

This is critical — every branch below the current one must be rebased to pick up changes:

```bash
# After committing on the current branch, rebase each downstream branch in order.
# Example: after Phase 1 (cow-732), rebase cow-731 through cow-739:

git checkout jefferson/cow-731-add-erc1271-signature-decoder-for-m3-order-matching
git rebase jefferson/cow-732-schema-fill-in-discreteorder-table
# Resolve conflicts if any → git add <files> && git rebase --continue

git checkout jefferson/cow-737-orderbook-polling-discover-open-and-expired-discrete-orders
git rebase jefferson/cow-731-add-erc1271-signature-decoder-for-m3-order-matching

git checkout jefferson/cow-736-trade-event-handler-discrete-order-matching-and-status
git rebase jefferson/cow-737-orderbook-polling-discover-open-and-expired-discrete-orders

git checkout jefferson/cow-738-block-handler-unfilledexpired-detection-via-pollresulterrors
git rebase jefferson/cow-736-trade-event-handler-discrete-order-matching-and-status

git checkout jefferson/cow-739-graphql-api-expose-discrete-order-status-and-execution
git rebase jefferson/cow-738-block-handler-unfilledexpired-detection-via-pollresulterrors
```

**Common conflict zones by phase:**
- Phase 1: `schema/tables.ts` (validTo column), `setup.ts` (cache DDL)
- Phase 3: `ponder.config.ts` (poller removed), `src/constants.ts`, imports from deleted `orderbookPoller.ts`
- Phase 5: `blockHandler.ts` (new imports, expanded success branch)

#### 5. Push all branches

After all rebases are clean, push everything:

```bash
for branch in \
  jefferson/cow-732-schema-fill-in-discreteorder-table \
  jefferson/cow-731-add-erc1271-signature-decoder-for-m3-order-matching \
  jefferson/cow-737-orderbook-polling-discover-open-and-expired-discrete-orders \
  jefferson/cow-736-trade-event-handler-discrete-order-matching-and-status \
  jefferson/cow-738-block-handler-unfilledexpired-detection-via-pollresulterrors \
  jefferson/cow-739-graphql-api-expose-discrete-order-status-and-execution
do
  git push origin "$branch" --force-with-lease
done
```

**`--force-with-lease`** is required because rebasing rewrites history. It's safe here because these are feature branches with a single author.

#### 6. STOP — Wait for review

After pushing, the implementing agent must **stop and report what was done**. The reviewing agent (or human) then:

1. Opens the PR on GitHub (PRs #20–#25)
2. Reviews the diff against this plan's phase requirements
3. Runs the manual verification steps
4. Approves or requests changes

**Only proceed to the next phase after explicit approval.**

### Quick Reference: Phase → Branch → PR

| Phase | Branch Suffix | PR # | Key Files Changed |
|-------|--------------|------|-------------------|
| 1 | `cow-732-schema-*` | #20 | `schema/tables.ts`, `setup.ts` |
| 2 | `cow-731-add-erc1271-*` | #21 | `src/application/helpers/orderUid.ts` (new) |
| 3 | `cow-737-orderbook-polling-*` | #22 | `composableCow.ts`, `orderbookPoller.ts` (delete), `ponder.config.ts`, `orderbookFetch.ts` (new) |
| 4 | `cow-736-trade-event-*` | #23 | `tradeEvent.ts` |
| 5 | `cow-738-block-handler-*` | #24 | `blockHandler.ts` |
| 6 | `cow-739-graphql-api-*` | #25 | `src/api/index.ts` |

## References

- Research document: `thoughts/plan-orderbook-cache-refactor.md` (Parts A–F)
- Current flow documentation: `thoughts/current-orderbook-flow.md`
- GPv2Order.sol: `tmp/contracts/gpv2-contracts/src/contracts/libraries/GPv2Order.sol`
- ComposableCoW.sol: `tmp/contracts/composable-cow/src/ComposableCoW.sol:221` (getTradeableOrderWithSignature)
- PollResultErrors ABI: `abis/PollResultErrorsAbi.ts:38-58`
- Example TWAP order: `tmp/m3-research/example-order-erc1271.json`
- Ponder search_path (user pool, no restriction): `node_modules/ponder/dist/esm/utils/pg.js:47-108`
- Ponder search_path (readonly pool, restricted): `node_modules/ponder/dist/esm/utils/pg.js:116`
