# Debug Ponder Log

Analyze `ponder.log` to diagnose indexer issues. Run after `pnpm dev --disable-ui 2>&1 | tee ponder.log`.

## Critical Rule

**NEVER use the `Read` tool on `ponder.log`** — the file is too large and will crash context. Use only `Bash` with `grep`, `tail`, or `sed`.

## Log Format

Handler code uses a structured JSON logger (`src/application/helpers/logger.ts`). Each `log(level, msg, fields)` call emits exactly one JSON line:

```json
{"time":1700000000000,"level":"info","msg":"OrderDiscoveryPoller:DONE","block":"12345678","chainId":1,"due":12,"success":2,"never":0,"backedOff":0}
```

Practical consequences for grep:
- The `msg` token is the stable search key. Grep it directly: `grep OrderDiscoveryPoller:DONE ponder.log` (or `grep '"OrderDiscoveryPoller:DONE"'` to avoid substring collisions).
- Fields like `block`, `chainId`, `owner`, `due` are JSON keys, not `key=value` text. Filter on them with `grep '"chainId":100'`, not `grep 'chain=100'`.
- Severity is the JSON `"level"` key (`info` / `warn` / `error`), not a bare `INFO` / `WARN` / `ERROR` word — though Ponder's own framework lines still use the bare-word format, so both appear in the file.
- Pretty-print a matched line with `jq`: `grep OrderDiscoveryPoller:DONE ponder.log | tail -1 | jq`.

The block handlers split work across five Ponder block entries. The canonical handler names are:

| Handler | Role |
|---------|------|
| `OrderDiscoveryPoller` | RPC multicall for non-deterministic generators, every block |
| `CandidateConfirmer`   | API batch check for unconfirmed candidates, every block |
| `OrderStatusTracker`   | API batch check for open discrete orders + expiry, every block |
| `OwnerBackfill`         | One-shot owner fetch for non-deterministic backfill orders |
| `CancellationWatcher`  | `singleOrders()` mapping read for deterministic generators OrderDiscoveryPoller skips |

---

## Investigation Steps

Run all steps before reporting. If a step returns nothing, note it explicitly — "No errors found" is useful signal.

### Step 1 — Fatal errors

```bash
# Framework errors (bare-word) plus structured error lines
grep -n "ERROR\|\"level\":\"error\"" ponder.log | head -40
```

If any errors found, grab context around the first one:

```bash
# Replace N with the line number from above
grep -n "ERROR\|\"level\":\"error\"" ponder.log | head -1
# Then run: sed -n 'N-2,N+20p' ponder.log
```

### Step 2 — Warnings

```bash
grep -n "WARN\|\"level\":\"warn\"" ponder.log | head -40
```

The structured warn lines worth scanning include `composableCow:decodeFailed`, `composableCow:unknownHandler`, the `ob:*` fetch failures/timeouts, and the `*:multicall_timeout` handler lines.

### Step 3 — Handler events (success path)

```bash
grep -n "composableCow:" ponder.log | tail -30
```

Healthy output looks like:
```json
{"level":"info","msg":"composableCow:created","event":"...","chainId":1,"orderType":"TWAP","block":"..."}
{"level":"info","msg":"composableCow:decoded","event":"...","orderType":"TWAP","decodedParams":"ok"}
```

Red flags:
- `composableCow:decoded` with `"decodedParams":"null"` on a known orderType -> decoder returned nothing
- `composableCow:decodeFailed` line -> malformed staticInput; the `err` field has the message
- `composableCow:unknownHandler` line -> address not in `HANDLER_MAP` in `src/utils/order-types.ts`

### Step 4 — Startup / DB / RPC health

```bash
grep -n "INFO\|WARN\|ERROR" ponder.log | head -20
```

These are Ponder's own framework lines (bare-word format). Healthy startup sequence:
```
INFO  Connected to database
INFO  Connected to JSON-RPC
INFO  Dropped existing database tables   ← only on first run / schema change
INFO  Created database tables
INFO  Started backfill indexing
INFO  Started fetching backfill JSON-RPC data
```

### Step 5 — Last known state

```bash
tail -50 ponder.log
```

If the process is stuck or crashed, this shows the last state before it stopped.

---

## Report Format

After running all steps, output:

```markdown
## Ponder Debug Report

### Errors
[List each unique error with line number, or "None found"]

### Warnings
[List each unique warning type and count, or "None found"]

### Handler Events
- Total ConditionalOrderCreated seen: N
- Breakdown by orderType: TWAP=N, StopLoss=N, PerpetualSwap=N, GoodAfterTime=N, TradeAboveThreshold=N, Unknown=N
- decodedParams=ok: N | decodedParams=null: N

### Verdict
[Healthy | Degraded (warnings only) | Broken (errors present)]

### Root Cause
[What's wrong and why, based on evidence]

### Next Step
[Specific fix or command to run]
```

---

## Precompute Diagnostics

Deterministic types (TWAP, StopLoss) should have all UIDs precomputed at creation — they should NOT appear in `OrderDiscoveryPoller` polling. If precompute fails, the generator falls into OrderDiscoveryPoller and wastes RPC calls every block.

### Precompute failures — why generators fall into OrderDiscoveryPoller

```bash
grep -n "precompute:skip" ponder.log | head -20
```

Each line is a deterministic generator that FAILED precompute and will fall into OrderDiscoveryPoller polling. The JSON `reason` field tells you why:

| reason | meaning | fix |
|--------|---------|-----|
| `decodedParams_null` | Decode of staticInput returned null | Check decoder for that order type; likely malformed on-chain data |
| `missing_params` | Required fields missing after decode (see the `missing` field for which) | Decoder returned incomplete data |
| `invalid_math` | nParts <= 0 or tSeconds <= 0 | Invalid TWAP params on-chain |
| `too_many_parts` | nParts > 100,000 | Extremely large TWAP; raise limit if legitimate |

**If you see skip lines**: count them and cross-reference with OrderDiscoveryPoller's `due` count. If they match, precompute failures are the sole cause of OrderDiscoveryPoller polling for deterministic types.

```bash
grep -c "precompute:skip" ponder.log
```

The counterpart success log is `precompute:allTerminal` (all UIDs for a generator precomputed up front):

```bash
grep -c "precompute:allTerminal" ponder.log
```

### Verify deterministic types are NOT in OrderDiscoveryPoller

After precompute fixes, OrderDiscoveryPoller should only poll non-deterministic types. Inspect recent OrderDiscoveryPoller DONE lines on gnosis:

```bash
grep '"OrderDiscoveryPoller:DONE"' ponder.log | grep '"chainId":100' | tail -5
```

A healthy `due` count should be much smaller than total generators — only non-deterministic types should remain.

---

## Orderbook Cache

The `orderbook_cache` table persists across Ponder resyncs (it is NOT an `onchainTable`). These steps verify the cache is alive and working.

### Cache startup — verify persistence across restarts

Look for the setup log emitted once at startup (`setup:cacheReady`):

```bash
grep -n "setup:cacheReady" ponder.log | head -5
```

Healthy output (the `count` field is the row count loaded from the previous run):
```json
{"level":"info","msg":"setup:cacheReady","count":42,"entries":"42 entries from previous run"}
```

If you see `"count":0` on a restart (not a first run), the cache table was dropped — this indicates a schema migration or Docker volume wipe, not a bug.

### Orderbook fetches — what is served from cache vs. the API

Each orderbook fetch emits an `ob:fetch` entry on start and an `ob:fetchResult` on completion. The result line carries the cache breakdown:

```bash
grep -n "ob:fetchResult" ponder.log | tail -20
```

Healthy output:
```json
{"level":"info","msg":"ob:fetchResult","owner":"0x1234...","chainId":1,"apiTotal":12,"composable":5,"cached":3,"refreshed":2}
```

- `cached` = composable orders served from the cache (no per-UID status refresh needed).
- `refreshed` = composable orders whose status was re-fetched this cycle.

High `cached` relative to `composable` means the cache is working. If `cached` stays near zero after a warm restart, the cache was not populated in the previous run (all owners were non-terminal) or the table was reset.

Fetch-side failures and timeouts are warn lines worth scanning when fetches look wrong:

```bash
grep -nE "ob:(noApiUrl|accountError|accountFetchFailed|accountTimeout|batchFetchError|batchFetchFailed|batchFetchTimeout|statusByUidsTimeout)" ponder.log | tail -20
```

### OwnerBackfill — one-shot (`endBlock: "latest"`)

`OwnerBackfill` in `ponder.config.ts` uses `startBlock: "latest"` and `endBlock: "latest"` so it should run **once per chain** when the indexer reaches live (not every block). Use logs to confirm.

```bash
grep -nE "OwnerBackfill:(START|bootstrap_start|no_bootstrap_needed|DONE)" ponder.log
```

Healthy output (per chain, after live sync starts):
```json
{"level":"info","msg":"OwnerBackfill:START","block":"...","chainId":1,"pendingRetry":0}
{"level":"info","msg":"OwnerBackfill:bootstrap_start","block":"...","chainId":1,"generators":7,"freshOwners":7}
{"level":"info","msg":"OwnerBackfill:DONE","block":"...","chainId":1,"discovered":3}
```

When nothing needs bootstrapping you get `OwnerBackfill:no_bootstrap_needed` instead of `bootstrap_start`/`DONE`. Either way you should see this sequence run roughly once per chain after live, not every block. Owner-fetch timeouts during bootstrap surface as `OwnerBackfill:owner_timeout` (and `OwnerBackfill:owner_retry_timeout` on the retry queue) — both carry the offending `owner` and `timeoutMs`. A **full resync** resets the process and you will see the START/DONE pair fire again on the next run (expected).

---

## OrderDiscoveryPoller tryNextBlock backoff

Generators that keep returning `PollResult.tryNextBlock` are progressively rate-limited. After 50 consecutive tryNextBlock responses the recheck interval jumps from +1 to +10 blocks; after 200, to +50.

### DONE log — backoff count per cycle

```bash
grep -n '"OrderDiscoveryPoller:DONE"' ponder.log | tail -20
```

Healthy output (mainnet, few stuck generators):
```json
{"level":"info","msg":"OrderDiscoveryPoller:DONE","block":"12345678","chainId":1,"due":12,"success":2,"never":0,"backedOff":0,"capped":false}
```

Gnosis after warm-up — expect non-zero `backedOff` as chronic offenders climb past the 50-threshold:
```json
{"level":"info","msg":"OrderDiscoveryPoller:DONE","block":"45678901","chainId":100,"due":180,"success":3,"never":0,"backedOff":150,"capped":false}
```

`backedOff` counts generators whose counter exceeded the warmup threshold on *this* block — i.e., they received a backoff longer than +1. A `"NEVER"` entry (`OrderDiscoveryPoller:NEVER`) records a generator that returned `PollResult.dontTryNextBlock` with its `reason`.

### Counter distribution — verify the mechanism is climbing

Run against the indexer Postgres (see `docker compose up -d`):

```sql
SELECT chain_id,
       CASE
         WHEN consecutive_try_next_block <= 50 THEN '0-50 (warmup)'
         WHEN consecutive_try_next_block <= 200 THEN '51-200 (mid)'
         ELSE '201+ (cold)'
       END AS tier,
       COUNT(*) AS generators,
       MAX(consecutive_try_next_block) AS max_count
FROM conditional_order_generator
WHERE status = 'Active' AND all_candidates_known = false
GROUP BY 1, 2
ORDER BY 1, 2;
```

On a healthy gnosis run post-sync you should see a non-trivial bucket in `51-200` and/or `201+`. If everything sits at `0-50` after >300 gnosis blocks, either there genuinely are no chronic tryNextBlock generators (precompute eliminated them — success) *or* the counter is not incrementing (bug).

### Red flag — counter stuck high but `due` still huge

If `consecutive_try_next_block` is large for many generators *and* the OrderDiscoveryPoller `due` count is still massive every block, the backoff is not actually deferring those generators — check that the OrderDiscoveryPoller SELECT filters by `nextCheckBlock <= currentBlock` and that the handler updated `nextCheckBlock = currentBlock + <backoff>` correctly on tryNextBlock.

---

## CancellationWatcher — singleOrders() mapping sweep

`CancellationWatcher` in `ponder.config.ts` runs every block but only does work when at least one deterministic generator (`allCandidatesKnown = true AND status = "Active"`) has `nextCheckBlock <= currentBlock`. Per-generator cadence is `DETERMINISTIC_CANCEL_SWEEP_INTERVAL` blocks (see `src/constants.ts`, default 100). The handler reads `ComposableCoW.singleOrders(owner, hash)` — `false` means the owner called `remove()` on-chain.

### ENTER / DONE — per-sweep summary

```bash
grep -nE "CancellationWatcher:(ENTER|DONE)" ponder.log | tail -40
```

Healthy output (one ENTER + one DONE per block where work happens):
```json
{"level":"info","msg":"CancellationWatcher:ENTER","block":"...","chainId":1,"due":12}
{"level":"info","msg":"CancellationWatcher:DONE","block":"...","chainId":1,"due":12,"cancelled":0,"stillActive":12,"errors":0}
```

If `due` is 0 on every block for a long time, either there are no Active deterministic generators on that chain yet, or the kill-switch is on (see below). When the multicall itself times out you get `CancellationWatcher:multicall_timeout` instead of a DONE line.

### Cancellations detected

```bash
grep -n "CancellationWatcher:CANCELLED" ponder.log
```

Each line is a deterministic generator whose on-chain `singleOrders(owner, hash)` returned `false`:
```json
{"level":"info","msg":"CancellationWatcher:CANCELLED","block":"...","chainId":1,"generatorId":"...","orderType":"StopLoss"}
```

After any `CANCELLED` line the candidate-cancellation cascade fires on the next CandidateConfirmer block tick — candidates are drained to `discrete_order`:
```json
{"level":"info","msg":"CandidateConfirmer:parent_cancelled","block":"...","chainId":1,"parentCancelled":3,"preflightKnown":0}
```

The OrderStatusTracker parent-cancelled sweep has no dedicated log line — verify via SQL:
```sql
SELECT count(*) FROM discrete_order
WHERE status='cancelled' AND conditional_order_generator_id = '<eventId>';
```

### Multicall errors

`errors > 0` on a DONE line is not fatal: CancellationWatcher leaves `nextCheckBlock` untouched for errored entries so they retry on the next sweep. Sustained nonzero `errors` across many blocks means the RPC provider is flaky — consider swapping provider.

### lastPollResult audit

SQL spot-check for what CancellationWatcher has touched:
```sql
SELECT chain_id, order_type, status, last_poll_result, count(*)
FROM conditional_order_generator
WHERE last_poll_result IN ('cancelled:removeMapping', 'sweep:stillAuthorized')
GROUP BY 1,2,3,4
ORDER BY 1,2,3,4;
```

`cancelled:removeMapping` rows are the on-chain-detected cancellations. `sweep:stillAuthorized` rows are healthy generators last confirmed still-authorized — cross-check that their `next_check_block - last_check_block == 100` (or whatever `DETERMINISTIC_CANCEL_SWEEP_INTERVAL` is set to).

---

## Known Error Patterns

| Error message | Cause | Fix |
|---------------|-------|-----|
| `BigIntSerializationError: Do not know how to serialize a BigInt` | Decoded params contain raw `bigint` — not wrapped with `replaceBigInts` | Wrap decode result: `replaceBigInts(decoded, String)` in handler |
| `Cannot use a pool after calling end on the pool` | Secondary — always follows a fatal handler error that caused Ponder to shut down the DB pool | Fix the primary error first |
| `Unknown handler ... saving as Unknown` | Handler address not in `HANDLER_MAP` in `src/utils/order-types.ts` | Add address to map; expected for new/unsupported contracts |
| `Decode failed ... orderType=...` | `staticInput` does not match expected ABI for that order type | Check ABI tuple in `src/decoders/<type>.ts`; compare with `agent_docs/decoder-reference.md` |
| `Fetching backfill JSON-RPC data is taking longer than expected` | RPC rate limit or slow provider | Transient — monitor; switch RPC if persistent |
| `[COW:timeout] <label> exceeded <ms>ms` | A wrapped async op blew its `withTimeout` budget (`src/application/helpers/withTimeout.ts`) — the `<label>` names the call site (e.g. `CandidateConfirmer:stale:accountFallback`) | Usually surfaces as a handler `*:multicall_timeout` / `ob:*Timeout` warn line too; check RPC/API latency for that call site |
