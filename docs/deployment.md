# Deployment and Operations

How to get the indexer running in production. Assumes a fresh clone.

## Environment Variables

All config goes in a `.env` file (production) or `.env.local` (local dev). Start from `.env.example`.

### RPC URLs

| Variable | Required | Description |
|----------|----------|-------------|
| `MAINNET_RPC_URL` | Yes | Ethereum mainnet RPC endpoint |
| `GNOSIS_RPC_URL` | Yes | Gnosis Chain RPC endpoint |
| `MAINNET_WS_RPC_URL` | No | Mainnet WebSocket endpoint — enables Ponder realtime subscriptions; falls back to HTTP polling when unset |
| `GNOSIS_WS_RPC_URL` | No | Gnosis WebSocket endpoint — enables Ponder realtime subscriptions; falls back to HTTP polling when unset |

The indexer is RPC-heavy during initial sync. Rate-limited endpoints will work but sync takes considerably longer. Use an endpoint with generous throughput for production.

> **Adding a new chain:** when a chain is added to `ACTIVE_CHAINS` in `src/chains/index.ts`, its RPC URL env var (defined as `rpcEnvVar` in the chain config file) must be added here and to the `ponder` service environment in `docker-compose.yml` under the `deploy` profile. The RPC used must be a dedicated/paid one, since the public endpoint rate limits is insuficient for the app. The optional WS RPC URL env var (`wsRpcEnvVar`) may be added the same way to enable realtime WS subscriptions.

### Database

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `DATABASE_SCHEMA` | Yes | PostgreSQL schema name. `manage.ts` defaults to `programmatic_orders`. |

Example: `DATABASE_URL=postgresql://cow_programmatic:secretpass@localhost:5433/cow_programmatic`

### Debug / Performance Flags

| Variable | Required | Description |
|----------|----------|-------------|
| `MAX_GENERATORS_PER_BLOCK_<chainId>` | No | Per-block cap on how many generators `OrderDiscoveryPoller` and `CancellationWatcher` will touch on the given chain (e.g. `MAX_GENERATORS_PER_BLOCK_1=200`, `MAX_GENERATORS_PER_BLOCK_100=400`). Default is 200. Excess generators defer to the next block, prioritized by oldest `lastCheckBlock` first. |
| `MAX_DISCRETE_ORDERS_PER_BLOCK_<chainId>` | No | Per-block cap on how many open discrete orders `OrderStatusTracker` will check on the given chain (e.g. `MAX_DISCRETE_ORDERS_PER_BLOCK_1=200`). Default is 200. Excess orders are deferred to the next block, prioritised by oldest `promotedAt` first. |
| `MAX_OWNERS_BACKFILL_PER_BLOCK_<chainId>` | No | Per-block cap on how many distinct owners `OwnerBackfillLive` drains on the given chain (e.g. `MAX_OWNERS_BACKFILL_PER_BLOCK_1=40`). Default is 20. Bounds the per-block orderbook request rate and transaction size while the owner-history drain spreads across live-sync blocks from the tip onward. Owner drains are resumable (progress persists in `cow_cache.owner_drain`), so a slow owner costs one bounded slice per firing, never a restart. |
| `MAX_OWNERS_BACKFILL_CONCURRENCY_<chainId>` | No | How many owner drains `OwnerBackfillLive` runs concurrently within one firing (e.g. `MAX_OWNERS_BACKFILL_CONCURRENCY_1=40`). Default is 20. Keep it equal to the cap so a firing's wall-clock stays around one per-owner slice (~30s). |
| `DISABLE_SETTLEMENT_FACTORY_CHECK` | No | Skips `getCode` + `FACTORY()` RPC calls in the GPv2Settlement handler. Useful for benchmarking base sync throughput. |
| `PINO_LOG_LEVEL` | No | Log verbosity: `debug`, `info`, `warn`, `error`. Defaults to Ponder's built-in default. |

### Production Docker Variables

Used by `docker-compose.yml` (deploy profile) and `deployment/manage.ts`:

| Variable | Required | Description |
|----------|----------|-------------|
| `PROJECT_PREFIX` | Yes | Docker Compose project name prefix (e.g. `cow-programmatic`) |
| `POSTGRES_USER` | Yes | PostgreSQL username |
| `POSTGRES_PASSWORD` | Yes | PostgreSQL password |
| `POSTGRES_DB` | Yes | PostgreSQL database name |
| `POSTGRES_PORT` | No | Host port mapped to PostgreSQL. Default: `5433`. |
| `POSTGRES_MEMORY_LIMIT` | No | Unused. Memory flags are now hardcoded inline in `docker-compose.yml` (tuned for 1G). Adjust the `command:` block proportionally if you allocate more RAM. |
| `PONDER_EXPOSED_PORT` | No | Host port mapped to the Ponder API. Default: `40000`. Inside the container, Ponder listens on `3000`. |

If you're using the `deploy-remotely.ts` workflow, these variables also need to be set as GitHub Actions secrets (or equivalent) in your CI environment.

## Database Setup

### Local Development

The repo includes a `docker-compose.yml` at the root that starts PostgreSQL 16:

```bash
docker compose up -d
```

Copy the matching `DATABASE_URL` and `DATABASE_SCHEMA` into `.env.local` from `.env.example`. Ponder manages schema migrations automatically — it creates or updates the tables within the configured schema on startup; you never run migrations manually.

### Production

Production uses the `deploy` profile in the root `docker-compose.yml`, which runs PostgreSQL and the indexer together. See the Docker section below.


## Docker

### Production Stack

```
docker-compose.yml         # root compose file — dev postgres (default) + deploy profile
deployment/
  manage.ts                # Build image, bring up/down the stack
  deploy-remotely.ts       # Rsync + SSH deploy to a remote host
```

The deploy services (`postgres-deploy` and `ponder`) live in the root `docker-compose.yml` under the `deploy` profile. Start them with:

```bash
docker compose --profile deploy up -d
```

The `Dockerfile` in the project root builds the Ponder image: two-stage Node 22 Alpine, installs dependencies with `--frozen-lockfile`, exposes port 3000, runs `pnpm start`. The health check hits `/readyz` with a 24-hour start period (initial sync takes hours).

### Kubernetes Probes

The indexer exposes two health endpoints with distinct semantics:

| Endpoint | Semantic | Returns 200 when |
|----------|----------|-----------------|
| `/health` | **Liveness** — is the process alive? | Always, once the server starts |
| `/ready` | Ponder sync — has it reached the chain tip? | Only when historical sync is complete |
| `/readyz` | **Readiness** — synced, keeping up, **and** owner backfill complete | Ponder synced AND every active chain within its staleness budget AND no non-deterministic historical generator still pending |

Use **`/readyz`** as the readiness/promotion probe. Ponder's built-in `/ready` flips as soon as historical sync reaches the tip, and `OwnerBackfillLive` then drains historical discrete orders across the following live-sync blocks. `/readyz` waits for all three conditions: Ponder synced, no chain lagging the tip, and `COUNT(historyBackfilled = false) = 0` (it internally checks `/ready` first, so it also can't false-positive on an empty fresh DB). Expect it to report pending during the drain, which begins after `/ready` flips. Ponder reserves the `/ready` path, so `/readyz` is a distinct endpoint served by the app.

The staleness check reads `ponder_sync_block_timestamp` per chain from `/metrics` and compares it against wall-clock time. Anything older than `READINESS_MAX_LAG_SECONDS` (default 300, overridable per chain with a numeric chain-id suffix) makes `/readyz` return 503 naming the chain, its newest block, and the measured lag. It deliberately does not call the RPC for the current head: a probe that depends on the RPC turns an RPC outage into a restart loop, and the block timestamp already carries enough to spot a stalled sync. The trade-off is that a genuine chain halt reads as staleness.

Map these to different K8s probe types. The specific timing values (`periodSeconds`, `failureThreshold`, `initialDelaySeconds`) depend on your cluster's SLOs; what matters is which path and port to use:

```yaml
livenessProbe:
  httpGet:
    path: /health
    port: 3000
  initialDelaySeconds: 30
  periodSeconds: 30
  failureThreshold: 3
readinessProbe:
  httpGet:
    path: /readyz     # synced AND owner backfill complete
    port: 3000
  initialDelaySeconds: 30
  periodSeconds: 10
  failureThreshold: 18   # 3-minute window before marking unready
```

**Do not** use `/readyz` (or `/ready`) as the liveness probe. A pod that is still indexing (which takes hours on a cold start) returns 200 on `/health` but not on `/readyz`. Using it for liveness would kill the pod before it ever finishes syncing.

A pod in `NotReady` state is not killed — it is simply removed from load-balancer rotation. On a cold start (no existing database), the pod will be `NotReady` for the duration of the historical backfill (hours). That is expected: the old pod (if any) keeps serving traffic during this window, and once the new pod catches up, K8s starts routing to it.

The container health check (declared in the `Dockerfile`) uses `/readyz` with a 24-hour start period as a pragmatic fallback for single-container deployments, not as a K8s-style probe. Two things about it are easy to get wrong:

Docker never restarts a container because its health check fails — `restart: unless-stopped` only reacts to the process exiting. A wedged-but-alive indexer stays up, marked unhealthy, indefinitely. The `autoheal: "true"` label on the ponder service is what closes that loop: the host's `willfarrell/autoheal` daemon (started with `AUTOHEAL_CONTAINER_LABEL=autoheal`) polls for unhealthy labelled containers and restarts them. If that daemon is not running on the host, the label does nothing and the health check only reports.

The 24-hour start period exists because a cold start legitimately fails `/readyz` for hours. During the start period a failing check does not mark the container unhealthy; the first success ends it. The owner-backfill gate cannot flap afterwards — generators created during live sync are written with `historyBackfilled = true`, so the pending count never climbs back above zero once the initial drain finishes.

### Structured Logging

`pnpm start` runs with `--log-format json`, which makes both Ponder's internal log lines and the handler log lines emit newline-delimited JSON. Each handler log line includes structured fields (e.g. `chainId`, `block`) enabling log aggregators (Datadog, CloudWatch, Loki) to filter and alert by chain.

`pnpm dev` uses Ponder's default pretty format for readability during local development.

**Convention:** application and API code uses `log()` from `src/application/helpers/logger.ts` instead of `console.log/warn/error` directly, so every line is structured JSON. (Hono still handles its own request-level logging.) Example:

```ts
import { log } from "../helpers/logger";

log("info", "CandidateConfirmer:confirmed", { chainId, orderUid, block: String(event.block.number) });
log("warn", "CandidateConfirmer:timeout",   { chainId, block: String(event.block.number) });
```

`warn` and `error` level messages go to `stderr`; `info` goes to `stdout`. The `level` field in the JSON payload is what log aggregators use to route and alert.


### PostgreSQL Memory Flags

Memory settings are hardcoded in the `command:` block of `docker-compose.yml`, tuned for 1G RAM (see the inline comments there). Adjust them proportionally if you change the host's available memory.


## Deploying

### How it works in practice

`deploy-remotely.ts` handles the full flow:

```bash
# Local deploy (builds and starts on this machine)
npx tsx deployment/deploy-remotely.ts - /path/to/.env

# Remote deploy via SSH
npx tsx deployment/deploy-remotely.ts user@host:/opt/cow-indexer /path/to/.env
```

What it does:
1. Rsyncs the repo to the target (excluding `.git`, `node_modules`, `.env`, logs)
2. Copies the `.env` file to `deployment/.env` on the remote
3. Runs `manage.ts up`, which builds a Docker image tagged with the current git SHA and brings up the stack

On the target machine, you need Docker and DNS configured to point at the container's exposed port (`PONDER_EXPOSED_PORT`, default 40000).

To tear down: `npx tsx deployment/manage.ts down --env-file deployment/.env`

## Cold-Start and Backfill Behavior

### Timeline

A fresh deployment (no prior `ponder_sync` cache) reindexes from the configured start blocks. Expected durations:

| Phase | Typical duration | Notes |
|-------|-----------------|-------|
| Event backfill | 4–10 hours | Fetches `eth_getLogs` from start block to tip. Bottleneck is RPC throughput; a generous RPC endpoint shortens this. The owner-history drain runs in the next phase (live-sync catch-up), keeping orderbook I/O off the critical path to the tip. |
| Live-sync catch-up | 5–15 minutes | Block handlers (OrderDiscoveryPoller, CandidateConfirmer, OrderStatusTracker, OwnerBackfillLive, CancellationWatcher) run at "latest". Stale TWAP candidates drain at 500/block; OwnerBackfillLive drains every non-deterministic owner's history from the tip onward. |
| Full data completeness | Gated by `/readyz` | All generators have candidates or discrete orders; every non-deterministic owner's history is drained (`historyBackfilled` complete). `/readyz` turns 200 only here — use it as the promotion probe. |

A reindex that reuses an existing `ponder_sync` cache (same chain, same start blocks) skips the event backfill and completes in minutes.

### `/ready` vs `/readyz` Semantics

`GET /ready` (Ponder built-in) returns `200` when Ponder has processed all historical blocks up to the tip and the live indexer is running. It does **not** guarantee historical discrete-order data is complete — `OwnerBackfillLive` drains that across live blocks after the tip.

`GET /readyz` (app) returns `200` only when Ponder is synced, no active chain has fallen behind the tip, **and** the owner backfill has finished (no non-deterministic historical generator with `historyBackfilled = false`). This is the promotion gate: it guarantees a newly-promoted pod has the full historical discrete-order set, so blue-green promotion never drops a complete pod for one that's still filling. It returns `503` (with the pending count) while the drain is in progress.

The staleness condition also makes `/readyz` useful after startup, which `/ready` is not. `/ready` latches at 200 once historical sync completes and never goes back, so an indexer whose realtime subscription dies keeps advertising itself as ready while its data silently ages. That happened in production: a dRPC WebSocket stopped delivering `newHeads` without closing the connection, Ponder logged one "No new block received within expected time" warning and then sat idle, and `/ready` plus the container health check both stayed green for a week.

During backfill both return `503`. GraphQL queries are still available but data is incomplete (generators and transactions accumulate; discrete orders fill in as live sync progresses).

### Historical Discrete Order Gap

Block handlers only run during live sync. TWAP parts computed during backfill land in `candidate_discrete_order` with past `validTo` dates. When live sync starts, CandidateConfirmer promotes these via the stale sweep path:

1. Tries `/orders/by_uids` — aged-out UIDs return empty
2. Falls back to `/account/{owner}/orders` for each owner with missed UIDs
3. Promotes with the actual API status (fulfilled/expired/cancelled) instead of defaulting to `expired`

**Residual gap**: Orders that no longer appear in `/account/{owner}/orders` (beyond the CoW API's retention window) will be recorded as `expired` regardless of their actual fill status. This affects only very old orders for users with a large order history.

Non-deterministic generators (PerpetualSwap, GoodAfterTime, TradeAboveThreshold, fee-burners) are handled by OwnerBackfillLive, which drains each owner's full `/account/{owner}/orders` history and upserts discovered orders directly into `discrete_order`. `Unknown` and `CowAmmConstantProduct` generators are stored but excluded from the backfill (`OWNER_BACKFILL_EXCLUDED` in `src/utils/order-types.ts`): unknown handlers are unsupported by definition, and CoW AMM migrated out of ComposableCoW. It runs as a repeating live-sync handler from the tip onward, draining a bounded batch of owners per block (`MAX_OWNERS_BACKFILL_PER_BLOCK_<chainId>`, default 20), so a large owner population spreads across blocks instead of one burst; `/readyz` gates promotion until it's done. Owner drains are resumable: progress (pagination offset, completion flag, delta cursor) persists per owner in `cow_cache.owner_drain`, each attempt runs under a hard ~30s deadline that cancels the in-flight request, and owners are picked least-recently-attempted first — so a whale owner advances a few pages per firing instead of restarting from scratch, and can never starve the rest of the queue.

**Redeploy cost**: Ponder rebuilds onchain tables from scratch on every schema-hash deploy, so OwnerBackfillLive re-runs each time. To avoid re-fetching an owner's entire history per deploy, the full composable-order rows are kept in the durable `cow_cache.composable_order` table (external schema, survives reindex), and `cow_cache.owner_drain` records which owners have ever completed a full drain. On redeploy those owners fetch only the delta newer than their `delta_cursor`; the rest is rebuilt from the cache. The cursor only ever advances after a *complete* pass, so an interrupted fetch can cause overlap but never a gap. The first-ever deploy (empty cache) does the full drain, which is the dominant cost and the main thing `/readyz` waits on.


