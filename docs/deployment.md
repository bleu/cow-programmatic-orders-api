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

### Database

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `DATABASE_SCHEMA` | Yes | PostgreSQL schema name. `manage.sh` defaults to `programmatic_orders`. For zero-downtime deploys, use a per-revision schema name (see Redeployment below). |

Example: `DATABASE_URL=postgresql://cow_programmatic:secretpass@localhost:5433/cow_programmatic`

### Debug / Performance Flags

| Variable | Required | Description |
|----------|----------|-------------|
| `DISABLE_POLL_RESULT_CHECK` | No | Disables the C1 ContractPoller block handler. Skips RPC multicalls for non-deterministic generators. Saves RPC calls during initial sync at the cost of not detecting poll results until re-enabled. |
| `DISABLE_SETTLEMENT_FACTORY_CHECK` | No | Skips `getCode` + `FACTORY()` RPC calls in the GPv2Settlement handler. Useful for benchmarking base sync throughput. |
| `PINO_LOG_LEVEL` | No | Log verbosity: `debug`, `info`, `warn`, `error`. Defaults to Ponder's built-in default. |

### Production Docker Variables

Used by `deployment/docker-compose.yml` and `deployment/manage.sh`:

| Variable | Required | Description |
|----------|----------|-------------|
| `PROJECT_PREFIX` | Yes | Docker Compose project name prefix (e.g. `cow-programmatic`) |
| `POSTGRES_USER` | Yes | PostgreSQL username |
| `POSTGRES_PASSWORD` | Yes | PostgreSQL password |
| `POSTGRES_DB` | Yes | PostgreSQL database name |
| `POSTGRES_PORT` | No | Host port mapped to PostgreSQL. Default: `5433`. |
| `POSTGRES_MEMORY_LIMIT` | No | Memory allocated to PostgreSQL. Default: `1G`. The `start-db.sh` entrypoint auto-tunes `shared_buffers`, `work_mem`, etc. based on this. |
| `PONDER_EXPOSED_PORT` | No | Host port mapped to the Ponder API. Default: `40000`. Inside the container, Ponder listens on `3000`. |

If you're using the `deploy-remotely.sh` workflow, these variables also need to be set as GitHub Actions secrets (or equivalent) in your CI environment.

## Database Setup

### Local Development

The repo includes a `docker-compose.yml` at the root that starts PostgreSQL 16:

```bash
docker compose up -d
```

This gives you Postgres on port 5432 (user `postgres`, password `postgres`, database `programmatic-orders`). Add to `.env.local`:

```
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/programmatic-orders
DATABASE_SCHEMA=programmatic_orders
```

Ponder manages schema migrations automatically. When it starts, it creates or updates the tables within the configured schema. You never run migrations manually.

### Production

Production uses a separate stack in `deployment/` that runs PostgreSQL and the indexer together. See the Docker section below.


## Docker

### Production Stack

```
deployment/
  docker-compose.yml     # PostgreSQL + Ponder services
  manage.sh              # Build image, bring up/down the stack
  deploy-remotely.sh     # Rsync + SSH deploy to a remote host
  static/start-db.sh     # PostgreSQL entrypoint with memory auto-tuning
```

The `Dockerfile` in the project root builds the Ponder image: two-stage Node 22 Alpine, installs dependencies with `--frozen-lockfile`, exposes port 3000, runs `pnpm start`. The health check hits `/ready` with a 24-hour start period (initial sync takes hours).

### PostgreSQL Auto-Tuning

`start-db.sh` tunes memory settings from `POSTGRES_MEMORY_LIMIT`. With the default 1G:

- `shared_buffers`: ~204MB
- `work_mem`: 2MB per connection
- `effective_cache_size`: 512MB
- `maintenance_work_mem`: 51MB


## Deploying

### How it works in practice

`deploy-remotely.sh` handles the full flow:

```bash
# Local deploy (builds and starts on this machine)
./deployment/deploy-remotely.sh - /path/to/.env

# Remote deploy via SSH
./deployment/deploy-remotely.sh user@host:/opt/cow-indexer /path/to/.env
```

What it does:
1. Rsyncs the repo to the target (excluding `.git`, `node_modules`, `.env`, logs)
2. Copies the `.env` file to `deployment/.env` on the remote
3. Runs `manage.sh up`, which builds a Docker image tagged with the current git SHA and brings up the stack

On the target machine, you need Docker and DNS configured to point at the container's exposed port (`PONDER_EXPOSED_PORT`, default 40000).

To tear down: `./deployment/manage.sh down --env-file deployment/.env`

### Production architecture

For a production setup, run at least two containers: one dedicated to indexing and one (or more) serving the API. This way if a user overloads the API with queries, the indexer keeps working. And if the indexer crashes or restarts, the API stays up with the last-synced data.

The current `deployment/docker-compose.yml` runs a single container doing both. Splitting indexer and API is a straightforward change: run two instances of the same image, one with indexing enabled and one configured as API-only (Ponder supports this via its `--api-only` flag or by disabling indexing).

### API Endpoints

Once running, the indexer exposes:

- `GET /graphql` and `POST /graphql` -- GraphQL API
- `/sql/*` -- Ponder SQL client (direct Drizzle-based queries)
- `GET /healthz` -- returns `{"status":"ok"}`
- `GET /ready` -- readiness check (used by the Docker health check)


## Redeployment

Ponder's restart behavior depends on what changed:

**Code-only changes** (handler logic): Ponder resumes from where it left off. Sync progress is stored in the database and it picks up from the last indexed block.

**Schema changes** (tables in `schema/tables.ts`): Ponder detects the mismatch, drops its data, and re-indexes from scratch. No manual migration.

**Config changes** (new chain, new contract, changed start block): Same as schema changes -- triggers a full re-sync.

### Zero-downtime deploys

A re-sync means the new version has no data until it catches up. To avoid downtime, deploy with a unique `DATABASE_SCHEMA` per revision (e.g. `programmatic_orders_<commit-sha>`). The old container keeps serving from the old schema while the new one syncs in parallel. Once the new container is synced, point traffic to it and remove the old one.

`manage.sh` currently hardcodes `DATABASE_SCHEMA=programmatic_orders`. For zero-downtime, override it in your `.env`:

```
DATABASE_SCHEMA=programmatic_orders_abc1234
```

The cache tracking sync progress lives in the same schema as the data. Dropping the schema means a full re-sync.


## Initial Sync

Sync starts from the contract deployment blocks and works forward to chain tip. With a good RPC endpoint, expect several hours. With rate-limited endpoints, a day or more.

Watch the logs to track progress. Ponder logs the current block number as it processes. The `[SETTLEMENT:STATS]` lines from the GPv2Settlement handler log every ~30 seconds and are a good heartbeat indicator.

Setting `DISABLE_POLL_RESULT_CHECK=true` and `DISABLE_SETTLEMENT_FACTORY_CHECK=true` during initial backfill reduces RPC load. Restart without them once you're near chain tip.

The Docker health check gives a 24-hour window before marking the container unhealthy, specifically to accommodate sync time.


## What's Not Implemented

- No monitoring or alerting. Watch container logs and the `/healthz` endpoint. Standard observability tooling (Prometheus, Grafana) can be wired up but nothing is preconfigured.
- No automated backups. Use standard PostgreSQL tools (`pg_dump`, WAL archiving).
- Single-instance deployment by default. See the production architecture section above for multi-container guidance.
