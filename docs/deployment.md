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
| `DISABLE_POLL_RESULT_CHECK` | No | Disables the `OrderDiscoveryPoller` block handler. Skips RPC multicalls for non-deterministic generators. Saves RPC calls during initial sync at the cost of not detecting poll results until re-enabled. |
| `DISABLE_DETERMINISTIC_CANCEL_SWEEP` | No | Disables the `CancellationWatcher`. Skips periodic `singleOrders()` reads on deterministic generators. While disabled, on-chain `ComposableCoW.remove()` calls on TWAP/StopLoss/CirclesBackingOrder generators will not be detected and those generators stay `Active`. |
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

This gives you Postgres on port 5432 (user `postgres`, password `postgres`, database `programmatic-orders`). Add to `.env.local`:

```
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/programmatic-orders
DATABASE_SCHEMA=programmatic_orders
```

Ponder manages schema migrations automatically. When it starts, it creates or updates the tables within the configured schema. You never run migrations manually.

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

