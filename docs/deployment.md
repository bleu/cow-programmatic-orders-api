# Deployment and Operations

How to get the indexer running in production. Assumes a fresh clone.

## Environment Variables

All config goes in a `.env` file (production) or `.env.local` (local dev). Start from `.env.example`.

### RPC URLs

| Variable | Required | Description |
|----------|----------|-------------|
| `MAINNET_RPC_URL` | Yes | Ethereum mainnet RPC endpoint |
| `GNOSIS_RPC_URL` | Yes | Gnosis Chain RPC endpoint |

The indexer is RPC-heavy during initial sync. Rate-limited endpoints will work but sync takes considerably longer. Use an endpoint with generous throughput for production.

> **Adding a new chain:** when a chain is added to `ACTIVE_CHAINS` in `src/chains/index.ts`, its RPC URL env var (defined as `rpcEnvVar` in the chain config file) must be added here and to the `ponder` service environment in `docker-compose.yml` under the `deploy` profile.

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

The `Dockerfile` in the project root builds the Ponder image: two-stage Node 22 Alpine, installs dependencies with `--frozen-lockfile`, exposes port 3000, runs `pnpm start`. The health check hits `/ready` with a 24-hour start period (initial sync takes hours).

### Kubernetes Probes

The indexer exposes two health endpoints with distinct semantics:

| Endpoint | Semantic | Returns 200 when |
|----------|----------|-----------------|
| `/health` | **Liveness** — is the process alive? | Always, once the server starts |
| `/ready` | **Readiness** — is the index fully synced? | Only when fully synced |

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
    path: /ready
    port: 3000
  initialDelaySeconds: 30
  periodSeconds: 10
  failureThreshold: 18   # 3-minute window before marking unready
```

**Do not** use `/ready` as the liveness probe. A pod that is still indexing (which takes hours on a cold start) returns 200 on `/health` but not on `/ready`. Using `/ready` for liveness would kill the pod before it ever finishes syncing.

A pod in `NotReady` state is not killed — it is simply removed from load-balancer rotation. On a cold start (no existing database), the pod will be `NotReady` for the duration of the historical backfill (hours). That is expected: the old pod (if any) keeps serving traffic during this window, and once the new pod catches up, K8s starts routing to it.

The Docker Compose health check uses `/ready` with a 24-hour start period as a pragmatic fallback for single-container deployments, not as a K8s-style probe.

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
| Event backfill | 4–10 hours | Fetches `eth_getLogs` from start block to tip. Bottleneck is RPC throughput; a generous RPC endpoint shortens this. |
| Live-sync catch-up | 5–15 minutes | Block handlers (OrderDiscoveryPoller, CandidateConfirmer, OrderStatusTracker, OwnerBackfill, CancellationWatcher) run at "latest" only. Stale TWAP candidates drain at 500/block. |
| Full data completeness | After live-sync catch-up | All generators have candidates or discrete orders; historical TWAP parts resolved via account fallback. |

A reindex that reuses an existing `ponder_sync` cache (same chain, same start blocks) skips the event backfill and completes in minutes.

### `/ready` Semantics

`GET /ready` returns `200` when Ponder has processed all historical blocks up to the tip and the live indexer is running. It does **not** guarantee that all historical discrete-order data is complete — that depends on the live-sync catch-up phase completing (see above).

During backfill, `GET /ready` returns `503`. GraphQL queries are still available but data is incomplete (generators and transactions accumulate; discrete orders are absent until live sync starts).

### Historical Discrete Order Gap

Block handlers only run during live sync. TWAP parts computed during backfill land in `candidate_discrete_order` with past `validTo` dates. When live sync starts, CandidateConfirmer promotes these via the stale sweep path:

1. Tries `/orders/by_uids` — aged-out UIDs return empty
2. Falls back to `/account/{owner}/orders` for each owner with missed UIDs
3. Promotes with the actual API status (fulfilled/expired/cancelled) instead of defaulting to `expired`

**Residual gap**: Orders that no longer appear in `/account/{owner}/orders` (beyond the CoW API's retention window) will be recorded as `expired` regardless of their actual fill status. This affects only very old orders for users with a large order history.

Non-deterministic generators (PerpetualSwap, GoodAfterTime, TradeAboveThreshold, Unknown) are handled by OwnerBackfill, which calls `/account/{owner}/orders` once at live-sync start and upserts discovered orders directly into `discrete_order`.


