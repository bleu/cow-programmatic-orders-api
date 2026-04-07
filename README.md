# Programmatic Orders API

Ponder-based indexer and GraphQL API for [CoW Protocol](https://cow.fi) Composable CoW programmatic orders. Indexes on-chain events from the ComposableCoW contract, decodes order types, and exposes queryable data via GraphQL and SQL endpoints.

Built by [@bleu](https://github.com/bleu) for the [CoW Protocol](https://cow.fi) ecosystem.

## Tech Stack

- **[Ponder](https://ponder.sh)** 0.16.x — blockchain indexing framework
- **TypeScript** — type-safe handlers and API
- **[viem](https://viem.sh)** — Ethereum interaction and ABI encoding
- **[Hono](https://hono.dev)** — lightweight web framework for API routes
- **PostgreSQL** — production database (SQLite for local dev)

## Architecture

```
ComposableCoW contract (Ethereum mainnet)
  ↓ events
ponder.config.ts ← src/data.ts (contract addresses + start blocks)
  ↓
src/application/handlers/ (event handlers)
  ↓
schema/tables.ts (table definitions)
  ↓
src/api/index.ts (Hono: /graphql + /sql/*)
```

| Path                        | Purpose                                   |
| --------------------------- | ----------------------------------------- |
| `abis/`                     | Contract ABIs                             |
| `src/data.ts`               | Chain configs and contract addresses      |
| `schema/tables.ts`          | Table definitions                         |
| `schema/relations.ts`       | Drizzle relations                         |
| `src/application/handlers/` | Event handlers (one file per contract)    |
| `src/api/index.ts`          | API layer — GraphQL and Ponder SQL client |
| `ponder.config.ts`          | Ponder configuration (chains, contracts)  |

## Getting Started

### Prerequisites

- Node.js >= 18.14
- [pnpm](https://pnpm.io/)
- Docker (optional, for PostgreSQL)

### Installation

```bash
git clone https://github.com/bleu-fi/cow-programmatic-orders-api.git
cd cow-programmatic-orders-api
pnpm install
```

### Environment Setup

Copy the example env file and configure your RPC URL:

```bash
cp .env.example .env.local
```

Edit `.env.local` and set at minimum:

```env
MAINNET_RPC_URL=https://your-rpc-url
```

### Database

**SQLite (default for local dev):** No setup needed — Ponder uses SQLite by default.

**PostgreSQL:** Start the included Docker container:

```bash
docker compose up -d
```

This starts PostgreSQL on port 5432 with the connection string already configured in `.env.example`:

```
postgresql://postgres:postgres@localhost:5432/programmatic-orders
```

### Run the Indexer

```bash
pnpm dev
```

This starts the Ponder dev server, which will:

1. Sync historical blocks from the configured start block
2. Index `ConditionalOrderCreated` events from the ComposableCoW contract
3. Serve the GraphQL API at `http://localhost:42069`
4. Serve the SQL endpoint at `http://localhost:42069/sql`

### Production

```bash
pnpm start
```

### SQL

The Ponder SQL client is available at `/sql/*` for direct SQL-style queries against the indexed data.

## Development

```bash
pnpm dev         # Start the indexer in dev mode
pnpm codegen     # Regenerate types (run after config/schema changes)
pnpm typecheck   # TypeScript type checking
pnpm lint        # ESLint
```

## CI

GitHub Actions runs lint, typecheck, and codegen verification on every push to `main` and on pull requests.

## Project Scope

This project is developed across four milestones:

| #   | Milestone               | Scope                                                                                                |
| --- | ----------------------- | ---------------------------------------------------------------------------------------------------- |
| 1   | Composable CoW Tracking | Event indexing, historical backfill, order type decoders (TWAP, Stop Loss, Perpetual Swap, GAT, TAT) |
| 2   | Flash Loan & CoWShed    | Flash loan order-to-EOA mapping, CoWShed proxy ownership resolution                                  |
| 3   | Orderbook Integration   | Historical/real-time orderbook data, order matching, execution status, off-chain cache               |
| 4   | Review & Documentation  | Technical review, API docs, integration guides                                                       |

## Links

- [Composable CoW Repository](https://github.com/cowprotocol/composable-cow)
- [CoW Protocol Programmatic Orders Docs](https://docs.cow.fi/cow-protocol/concepts/order-types/programmatic-orders)
- [Ponder Documentation](https://ponder.sh/docs)

## License

Open source.
