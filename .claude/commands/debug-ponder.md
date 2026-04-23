# Debug Ponder Log

Analyze `ponder.log` to diagnose indexer issues. Run after `pnpm dev --disable-ui 2>&1 | tee ponder.log`.

## Critical Rule

**NEVER use the `Read` tool on `ponder.log`** — the file is too large and will crash context. Use only `Bash` with `grep`, `tail`, or `sed`.

---

## Investigation Steps

Run all steps before reporting. If a step returns nothing, note it explicitly — "No errors found" is useful signal.

### Step 1 — Fatal errors

```bash
grep -n "ERROR" ponder.log | head -40
```

If any errors found, grab context around the first one:

```bash
# Replace N with the line number from above
grep -n "ERROR" ponder.log | head -1
# Then run: sed -n 'N-2,N+20p' ponder.log
```

### Step 2 — Warnings

```bash
grep -n "WARN\|console.warn\|\[ComposableCow\].*failed\|\[ComposableCow\].*Unknown" ponder.log | head -40
```

### Step 3 — Handler events (success path)

```bash
grep -n "\[ComposableCow\]" ponder.log | tail -30
```

Healthy output looks like:
```
[ComposableCow] ConditionalOrderCreated event=... orderType=TWAP block=...
[ComposableCow] Decoded event=... orderType=TWAP decodedParams=ok
```

Red flags:
- `decodedParams=null` on a known orderType → decoder returned nothing
- `Decode failed` line → malformed staticInput, check `decodeError` column in DB
- `Unknown handler` line → address not in `HANDLER_MAP` in `src/utils/order-types.ts`

### Step 4 — Startup / DB / RPC health

```bash
grep -n "INFO\|WARN\|ERROR" ponder.log | head -20
```

Healthy startup sequence:
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

Deterministic types (TWAP, StopLoss) should have all UIDs precomputed at creation — they should NOT appear in C1 polling. If precompute fails, the generator falls into C1 and wastes RPC calls every block.

### Precompute failures — why generators fall into C1

```bash
grep -n "\[COW:PRECOMPUTE\] SKIP" ponder.log | head -20
```

Each line is a deterministic generator that FAILED precompute and will fall into C1 polling. The `reason=` field tells you why:

| reason | meaning | fix |
|--------|---------|-----|
| `decodedParams_null` | Decode of staticInput returned null | Check decoder for that order type; likely malformed on-chain data |
| `missing_params` | Required fields missing after decode (see `missing=` for which) | Decoder returned incomplete data |
| `invalid_math` | nParts <= 0 or tSeconds <= 0 | Invalid TWAP params on-chain |
| `too_many_parts` | nParts > 100,000 | Extremely large TWAP; raise limit if legitimate |

**If you see SKIP lines**: count them and cross-reference with C1's `due=` count. If they match, precompute failures are the sole cause of C1 polling for deterministic types.

```bash
grep -c "\[COW:PRECOMPUTE\] SKIP" ponder.log
```

### Verify deterministic types are NOT in C1

After precompute fixes, C1 should only poll non-deterministic types. Check if C1 success lines show TWAP/StopLoss (they shouldn't):

```bash
grep "\[COW:C1\] DONE" ponder.log | grep 'chain=100' | tail -5
```

A healthy `due=` count should be much smaller than total generators — only non-deterministic types should remain.

---

## Orderbook Cache (M3)

The `orderbook_cache` table persists across Ponder resyncs (it is NOT an `onchainTable`). These steps verify the cache is alive and working.

### Cache startup — verify persistence across restarts

Look for the setup log emitted once at startup:

```bash
grep -n "\[COW:SETUP\]" ponder.log | head -5
```

Healthy output:
```
[COW:SETUP] orderbook_cache ready — 42 entries from previous run
```

If you see `0 entries from previous run` on a restart (not a first run), the cache table was dropped — this indicates a schema migration or Docker volume wipe, not a bug.

### Cache hits — verify terminal owners are served from cache

```bash
grep -n "\[COW:OB:CACHE\] HIT" ponder.log | tail -20
```

Each line confirms a terminal owner was served from cache instead of hitting the API:
```
[COW:OB:CACHE] HIT owner=0x1234... chain=1 orders=5
```

If you see zero hits after a warm restart, the cache was not populated in the previous run (all owners were non-terminal) or the table was reset.

### Cache saves — verify terminal owners are being cached

```bash
grep -n "\[COW:OB:CACHE\] SAVED" ponder.log | tail -20
```

Healthy output:
```
[COW:OB:CACHE] SAVED owner=0x1234... chain=1 orders=3 (all terminal, cached permanently)
```

Active owners (with any `open` order) are intentionally NOT saved — they must be re-fetched on every poll cycle.

### Orderbook poll cycle metrics

```bash
grep -n "\[COW:OB:POLL\] DONE" ponder.log | tail -10
```

Healthy output includes cache hit ratio and active owner count:
```
[COW:OB:POLL] DONE block=12345678 chain=1 owners=20 discovered=3 cacheHits=15 apiFetches=5 activeOwners=2 totalOrders=47
```

High `cacheHits` relative to `owners` means the cache is working. High `apiFetches` with low `activeOwners` may indicate many owners are not yet cached.

### C4 HistoricalBootstrap — one-shot (`endBlock: "latest"`) — PR #29 entrada 9

`HistoricalBootstrap` in `ponder.config.ts` uses `startBlock: "latest"` and `endBlock: "latest"` so it should run **once per chain** when the indexer reaches live (not every block). Use logs to confirm.

**Invocation counter (expect `#1` only per chain per process):**

```bash
grep -n "\[COW:C4\] HistoricalBootstrap invocation" ponder.log
```

Healthy output (one line per chain after live starts):

```
... [COW:C4] HistoricalBootstrap invocation=#1 chain=1 block=... (one-shot bootstrap; see .claude/commands/debug-ponder.md — C4 section)
```

If you see **`invocation=#2`** or a **`WARN`** line saying *invocation #2* / *repeats every block*, `endBlock: "latest"` is not behaving as a one-shot in your Ponder version — escalate or check Ponder release notes. A **full resync** resets the process: you will see `#1` again on the next run (expected).

**Full C4 trace (bootstrap work or empty):**

```bash
grep -n "\[COW:C4\]" ponder.log
```

You should see `invocation=#1`, then either `no generators need bootstrap` or `generators=...` + `DONE`, then **no further `[COW:C4]` lines** for that chain until restart.

### Backfill skip — verify poller is not running during historical sync

During backfill, the orderbook poller is silently skipped (no log line). To confirm live-only behavior, check that poll DONE lines only appear near the tip:

```bash
grep -n "\[COW:OB:POLL\] DONE" ponder.log | head -5
```

The `block=` values should be close to the current chain head. If you see poll DONE lines during historical blocks, the `PollResultPoller` start block may not be set to `"latest"`.

---

## C1 tryNextBlock backoff

Generators that keep returning `PollResult.tryNextBlock` are progressively rate-limited. After 50 consecutive tryNextBlock responses the recheck interval jumps from +1 to +10 blocks; after 200, to +50.

### DONE log — backoff count per cycle

```bash
grep -n "\[COW:C1\] DONE" ponder.log | tail -20
```

Healthy output (mainnet, few stuck generators):
```
[COW:C1] DONE block=12345678 chain=1 due=12 success=2 never=0 backedOff=0
```

Gnosis after warm-up — expect non-zero `backedOff=` as chronic offenders climb past the 50-threshold:
```
[COW:C1] DONE block=45678901 chain=100 due=180 success=3 never=0 backedOff=150
```

`backedOff=` counts generators whose counter exceeded the warmup threshold on *this* block — i.e., they received a backoff longer than +1.

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

On a healthy gnosis run post-sync you should see a non-trivial bucket in `51-200` and/or `201+`. If everything sits at `0-50` after >300 gnosis blocks, either COW-904 eliminated all such generators (success) *or* the counter is not incrementing (bug).

### Red flag — counter stuck high but `due=` still huge

If `consecutive_try_next_block` is large for many generators *and* the C1 `due=` count is still massive every block, the backoff is not actually deferring those generators — check that the C1 SELECT filters by `nextCheckBlock <= currentBlock` and that the handler updated `nextCheckBlock = currentBlock + <backoff>` correctly on tryNextBlock.

---

## C5 DeterministicCancellationSweeper — singleOrders() mapping sweep

`DeterministicCancellationSweeper` in `ponder.config.ts` runs every block but only does work when at least one deterministic generator (`allCandidatesKnown = true AND status = "Active"`) has `nextCheckBlock <= currentBlock`. Per-generator cadence is `DETERMINISTIC_CANCEL_SWEEP_INTERVAL` blocks (see `src/constants.ts`, default 100). The handler reads `ComposableCoW.singleOrders(owner, hash)` — `false` means the owner called `remove()` on-chain.

### ENTER / DONE — per-sweep summary

```bash
grep -n "\[COW:C5\]" ponder.log | tail -40
```

Healthy output (one ENTER + one DONE per block where work happens):
```
... [COW:C5] ENTER block=... chain=1 due=12
... [COW:C5] DONE block=... chain=1 due=12 cancelled=0 stillActive=12 errors=0
```

If `due=0` on every block for a long time, either there are no Active deterministic generators on that chain yet, or the kill-switch is on (see below).

### Cancellations detected — the interesting signal

```bash
grep -n "\[COW:C5\] CANCELLED" ponder.log
```

Each line is a deterministic generator whose on-chain `singleOrders(owner, hash)` returned `false`:
```
[COW:C5] CANCELLED generatorId=... orderType=StopLoss block=... chain=1
```

After any `CANCELLED` line you should see COW-918's cascade fire on the next C2 block tick:
```
[COW:C2] block=... chain=1 parent-cancelled=N   ← candidates drained to discrete_order
```

C3's parent-cancelled sweep has no dedicated log line — verify via SQL:
```sql
SELECT count(*) FROM discrete_order
WHERE status='cancelled' AND conditional_order_generator_id = '<eventId>';
```

### Multicall errors — non-fatal, will self-heal

`errors > 0` on a DONE line is not fatal: C5 leaves `nextCheckBlock` untouched for errored entries so they retry on the next sweep. Sustained nonzero `errors` across many blocks means the RPC provider is flaky — consider swapping provider (see COW-887 on DRPC flakiness).

### Sweep disabled (kill-switch)

If operators see no `[COW:C5]` lines at all and expect them:
```bash
grep -n "DISABLE_DETERMINISTIC_CANCEL_SWEEP" .env.local env.prod 2>/dev/null
```

Non-empty means the sweeper is intentionally disabled via env var — same pattern as `DISABLE_POLL_RESULT_CHECK` for C1.

### lastPollResult audit

SQL spot-check for what C5 has touched:
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
