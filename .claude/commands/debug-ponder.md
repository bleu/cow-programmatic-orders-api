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

## Known Error Patterns

| Error message | Cause | Fix |
|---------------|-------|-----|
| `BigIntSerializationError: Do not know how to serialize a BigInt` | Decoded params contain raw `bigint` — not wrapped with `replaceBigInts` | Wrap decode result: `replaceBigInts(decoded, String)` in handler |
| `Cannot use a pool after calling end on the pool` | Secondary — always follows a fatal handler error that caused Ponder to shut down the DB pool | Fix the primary error first |
| `Unknown handler ... saving as Unknown` | Handler address not in `HANDLER_MAP` in `src/utils/order-types.ts` | Add address to map; expected for new/unsupported contracts |
| `Decode failed ... orderType=...` | `staticInput` does not match expected ABI for that order type | Check ABI tuple in `src/decoders/<type>.ts`; compare with `agent_docs/decoder-reference.md` |
| `Fetching backfill JSON-RPC data is taking longer than expected` | RPC rate limit or slow provider | Transient — monitor; switch RPC if persistent |
