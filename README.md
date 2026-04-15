# Programmatic Orders API

Indexes on-chain events from [CoW Protocol](https://cow.fi)'s ComposableCoW contract, decodes programmatic order types (TWAP, Stop Loss, Perpetual Swap, Good After Time, Trade Above Threshold), and serves the data through a GraphQL API. Built with [Ponder](https://ponder.sh) by [@bleu](https://github.com/bleu) for CoW Protocol.

## Tech stack

- [Ponder](https://ponder.sh) 0.16.x -- blockchain indexing framework
- TypeScript
- [viem](https://viem.sh) -- Ethereum interactions and ABI encoding
- [Hono](https://hono.dev) -- API routing
- PostgreSQL (SQLite works for local dev)

## Quick start

```bash
git clone https://github.com/bleu/cow-programmatic-orders-api.git
cd cow-programmatic-orders-api
pnpm install
```

Copy the env file and set your RPC URL:

```bash
cp .env.example .env.local
```

Open `.env.local` and set `MAINNET_RPC_URL` to a working Ethereum RPC endpoint.

Start PostgreSQL (optional -- Ponder defaults to SQLite for local dev):

```bash
docker compose up -d
```

Run the indexer:

```bash
pnpm dev
```

The GraphQL API is at `http://localhost:42069` once the dev server starts.

## Commands

| Command | What it does |
|---------|-------------|
| `pnpm dev` | Start the indexer in dev mode |
| `pnpm start` | Start in production mode |
| `pnpm codegen` | Regenerate types after config or schema changes |
| `pnpm typecheck` | Run TypeScript type checking |
| `pnpm lint` | Run ESLint |
| `pnpm test` | Run tests |

## Documentation

- [docs/api-reference.md](docs/api-reference.md) -- GraphQL schema and query examples
- [docs/integration-guide.md](docs/integration-guide.md) -- Common query patterns for integrators
- [docs/architecture.md](docs/architecture.md) -- System internals, data flow, schema design
- [docs/deployment.md](docs/deployment.md) -- Production setup and configuration
- [docs/supported-order-types.md](docs/supported-order-types.md) -- Decoded order types and their parameters

## Links

- [CoW Protocol programmatic orders docs](https://docs.cow.fi/cow-protocol/concepts/order-types/programmatic-orders)
- [Composable CoW repository](https://github.com/cowprotocol/composable-cow)
- [Ponder documentation](https://ponder.sh/docs)

## License

Open source.
