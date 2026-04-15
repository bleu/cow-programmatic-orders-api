# Deployment and Operations Guide

This guide covers everything needed to run the Composable CoW programmatic orders indexer in production. It assumes you have a fresh clone of the repository and want to get to a running instance.

## Environment Variables

All environment variables are configured through a `.env` file (for production) or `.env.local` (for local development). Copy `.env.example` as a starting point.

### RPC URLs

| Variable | Required | Description |
|----------|----------|-------------|
| `MAINNET_RPC_URL` | Yes | Ethereum mainnet RPC endpoint |
| `GNOSIS_RPC_URL` | Yes | Gnosis Chain RPC endpoint |

Both chains are actively indexed. The indexer hits the RPC hard during initial sync (historical backfill from the contract deployment block to chain tip). An archive node is not required, but a node with generous rate limits will make initial sync much faster. Free-tier public RPCs will work but expect sync to take significantly longer. Paid providers like Alchemy, QuickNode, or dRPC are recommended for production.

Arbitrum support is planned but not yet implemented. There is a commented-out `ARBITRUM_RPC_URL` in the example file.

### Database

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | For production | PostgreSQL connection string. If unset, Ponder falls back to SQLite (fine for local dev, not for production). |
| `DATABASE_SCHEMA` | For production | PostgreSQL schema name. The `pnpm start` script defaults to `public` if unset. In the production Docker setup, `manage.sh` sets this to `programmatic_orders`. |

Example: `DATABASE_URL=postgresql://cow_programmatic:secretpass@localhost:5433/cow_programmatic`

### Debug / Performance Flags

| Variable | Required | Description |
|----------|----------|-------------|
| `DISABLE_REMOVAL_POLL` | No | Set to any truthy value to skip the RemovalPoller block handler. This handler does multicall `singleOrders()` checks every 100 blocks to detect cancelled orders. Disabling it saves RPC calls during sync at the cost of not detecting removals until re-enabled. |
| `DISABLE_SETTLEMENT_FACTORY_CHECK` | No | Set to `"true"` to skip `getCode` + `FACTORY()` RPC calls in the GPv2Settlement handler. Useful for benchmarking base sync throughput. |
| `PINO_LOG_LEVEL` | No | Log verbosity: `debug`, `info`, `warn`, `error`. Defaults to Ponder's built-in default. |

### Production Docker Variables

These are used by `deployment/docker-compose.yml` and `deployment/manage.sh`:

| Variable | Required | Description |
|----------|----------|-------------|
| `PROJECT_PREFIX` | Yes | Docker Compose project name prefix (e.g. `cow-programmatic`) |
| `POSTGRES_USER` | Yes | PostgreSQL username |
| `POSTGRES_PASSWORD` | Yes | PostgreSQL password |
| `POSTGRES_DB` | Yes | PostgreSQL database name |
| `POSTGRES_PORT` | No | Host port mapped to PostgreSQL. Defaults to `5433`. |
| `POSTGRES_MEMORY_LIMIT` | No | Memory allocated to the PostgreSQL container. Defaults to `1G`. The `start-db.sh` script auto-tunes `shared_buffers`, `work_mem`, etc. based on this value. |
| `PONDER_EXPOSED_PORT` | No | Host port mapped to the Ponder API. Defaults to `40000`. Inside the container, Ponder always listens on port `3000`. |
| `PONDER_MEMORY_LIMIT` | No | Memory limit for the Ponder container. Defaults to `2G`. |


## Database Setup

### Local Development

For local dev, you can skip PostgreSQL entirely. If `DATABASE_URL` is not set, Ponder uses an embedded SQLite database with zero configuration. This is convenient but doesn't support the SQL client API endpoints.

To use PostgreSQL locally, the repo includes a `docker-compose.yml` at the project root:

```bash
docker compose up -d
```

This starts a PostgreSQL 16 instance on port 5432 with user `postgres`, password `postgres`, database `programmatic-orders`. Set your `.env.local` to match:

```
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/programmatic-orders
DATABASE_SCHEMA=programmatic_orders
```

### Production

Production uses a separate `deployment/docker-compose.yml` that runs both PostgreSQL and the Ponder indexer as containers. More on that in the Docker section below.

Ponder manages its own schema migrations automatically. You never run migrations manually. When Ponder starts, it creates or updates the tables it needs within the configured `DATABASE_SCHEMA`. If the schema definition changes between deployments, Ponder detects this and re-indexes from scratch (see the Redeployment Behavior section).


## Docker

### Production Stack

The production Docker setup lives in `deployment/`. The layout:

```
deployment/
  docker-compose.yml     # PostgreSQL + Ponder services
  manage.sh              # Orchestrates build & deploy
  deploy-remotely.sh     # Rsync + SSH deploy to a remote host
  static/start-db.sh     # PostgreSQL entrypoint that auto-tunes memory settings
```

The `Dockerfile` in the project root builds the Ponder image. It's a two-stage Node 22 Alpine build: the first stage installs dependencies, the second copies everything and runs `pnpm install --frozen-lockfile` for production. The container exposes port 3000 and runs `pnpm start`.

The image includes a health check that hits `http://localhost:3000/ready`, with a 24-hour start period to accommodate initial sync time.

### Deploying

The typical production deploy workflow:

```bash
# Local deploy (builds and starts on this machine)
./deployment/deploy-remotely.sh - /path/to/.env

# Remote deploy via SSH
./deployment/deploy-remotely.sh user@host:/opt/cow-indexer /path/to/.env
```

`deploy-remotely.sh` does the following:
1. Rsyncs the repo to the target (excluding `.git`, `node_modules`, `.env` files, logs)
2. Copies the `.env` file separately to `deployment/.env` on the remote
3. Runs `manage.sh up` on the target

`manage.sh up` builds the Docker image (tagged with the current git short SHA), then brings up the stack via `docker compose up -d`.

To tear down:

```bash
./deployment/manage.sh down --env-file deployment/.env
```

This stops containers and removes volumes.

### PostgreSQL Auto-Tuning

The `start-db.sh` script tunes PostgreSQL memory settings based on `POSTGRES_MEMORY_LIMIT`. With the default 1G limit, you get roughly:

- `shared_buffers`: 200MB
- `work_mem`: 2MB per connection
- `effective_cache_size`: 512MB
- `maintenance_work_mem`: 51MB


## Running the Indexer

### Development

```bash
cp .env.example .env.local    # edit with your RPC URLs
docker compose up -d           # start local PostgreSQL (optional, SQLite works too)
pnpm install
pnpm codegen                   # generate ponder-env.d.ts
pnpm dev                       # starts indexer with hot reload
```

The dev server runs on port 42069 by default. GraphQL playground is at `http://localhost:42069/graphql`.

### Production

```bash
pnpm install --frozen-lockfile
pnpm start                     # runs: ponder start -p 3000 --schema ${DATABASE_SCHEMA:-public}
```

Or, more commonly, use the Docker deployment described above.

### Available npm Scripts

| Script | What it does |
|--------|-------------|
| `pnpm dev` | Ponder dev mode with hot reload |
| `pnpm start` | Production mode, port 3000, uses `DATABASE_SCHEMA` |
| `pnpm codegen` | Regenerates `ponder-env.d.ts`. Run this after changing `ponder.config.ts` or `ponder.schema.ts`. |
| `pnpm typecheck` | TypeScript type checking |
| `pnpm lint` | ESLint |
| `pnpm test` | Vitest |
| `pnpm db` | Ponder DB CLI utilities |

### API Endpoints

Once running, the indexer exposes:

- `GET /` and `POST /graphql` -- GraphQL API
- `/sql/*` -- Ponder SQL client (direct Drizzle-based queries)
- `GET /healthz` -- returns `{"status":"ok"}`
- `GET /ready` -- Ponder's built-in readiness check (used by the Docker health check)


## Ponder Redeployment Behavior

This section is important for operators. Ponder's behavior on restart depends on what changed:

**No schema/config changes**: Ponder resumes indexing from where it left off. It stores progress in the database and picks up from the last indexed block. This is the common case for code-only changes to event handlers.

**Schema changes** (tables added/removed/modified in `schema/tables.ts`): Ponder detects the mismatch and drops its existing data, then re-indexes from scratch. There's no manual migration step. This means a schema change in production triggers a full re-sync. Plan accordingly.

**Config changes** (new chain, new contract, changed start block): Similar to schema changes. If the indexing config changes in a way that affects what data is fetched, Ponder will re-index.

**Database schema isolation**: The `DATABASE_SCHEMA` variable controls which PostgreSQL schema Ponder uses. The production setup sets this to `programmatic_orders`. If you need to run two versions side by side (e.g., testing a new schema before cutting over), you can deploy with a different `DATABASE_SCHEMA` value and both instances will coexist in the same database without interference.

The cache that tracks sync progress lives in the same PostgreSQL schema as the indexed data. If you delete the schema, all progress is lost and you'll need a full re-sync.


## Initial Sync

Initial sync starts from the contract deployment blocks:

- Mainnet ComposableCoW: block 17,883,049 (Aug 2023)
- Gnosis ComposableCoW: block 29,389,123
- GPv2Settlement (flash loan filtering): block 23,812,751 on mainnet

Sync time depends heavily on RPC throughput. With a good paid RPC provider, expect initial sync to take several hours. With rate-limited public RPCs, it could take a day or more.

You can tell sync is working by watching the logs. Ponder logs the current block number as it progresses. The handlers also log activity:

- `[COW:REMOVE:POLL]` lines from the RemovalPoller
- `[SETTLEMENT:STATS]` lines from the GPv2Settlement handler (logged every 30s)

If you want faster initial sync, set `DISABLE_REMOVAL_POLL=true` and `DISABLE_SETTLEMENT_FACTORY_CHECK=true` during the backfill, then restart with them unset once you're near chain tip.

The Docker health check has a 24-hour start period specifically because initial sync takes a while. During this window, the container won't be marked unhealthy even though `/ready` might return a non-200 status.


## What's Not Implemented

- **Monitoring and alerting**: There are no Prometheus metrics, Grafana dashboards, or alerting rules. You'll need to set these up yourself or monitor via container logs and the `/healthz` endpoint.
- **Backup and restore**: No automated database backup. Standard PostgreSQL backup tools (`pg_dump`, WAL archiving) apply, but nothing is preconfigured.
- **Multi-region or HA deployment**: The setup assumes a single instance. There's no clustering, failover, or load balancing built in.
- **Arbitrum chain**: Planned but not yet configured. The code has placeholder comments.
