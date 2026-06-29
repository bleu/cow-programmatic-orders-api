# CLAUDE.md

## What This Project Is

Ponder-based indexer and GraphQL API for Composable CoW programmatic orders. Indexes on-chain events from the ComposableCoW contract, decodes all supported order types (see `docs/supported-order-types.md`), and exposes queryable data via GraphQL.

**Tech**: Ponder 0.16.x · TypeScript · viem · Hono · PostgreSQL · pnpm

## Architecture

```
ComposableCoW contract (mainnet + gnosis; more chains planned)
       ↓  events
  ponder.config.ts  ←  src/chains/  (contract addresses + start blocks per chain)
       ↓
  src/application/handlers/  (one file per contract)
       ↓
  schema/tables.ts  (transaction, conditionalOrderGenerator, discreteOrder, …)
       ↓
  src/api/index.ts  (Hono: /graphql  /  /sql/*)
```

**Key paths**:
- `abis/` — Contract ABIs
- `src/chains/` — Chain configs and contract addresses (add a chain file, then register it in `src/chains/index.ts`)
- `schema/tables.ts` — Table definitions; `schema/relations.ts` — Drizzle relations
- `src/application/handlers/` — Event handlers (add new handlers here)
- `src/api/index.ts` — Hono API exposing GraphQL and Ponder SQL client

## How to Verify Changes

```bash
pnpm codegen      # Regenerate ponder-env.d.ts (required after config/schema changes)
pnpm typecheck    # TypeScript
pnpm lint         # ESLint
pnpm dev          # Start indexer locally (requires .env.local with MAINNET_RPC_URL)
```

Copy `.env.example` -> `.env.local` and set `MAINNET_RPC_URL` before `pnpm dev`.
Start PostgreSQL with `docker compose up -d` to use it instead of the default SQLite.

## Reference Documentation

| File | When to read |
|------|--------------|
| `agent_docs/project-structure.md` | Current file map, schema tables, env vars, key commands |
| `agent_docs/code-patterns.md` | Schema/naming conventions (snake_case, composite PK, eventId) — **check before schema or handler changes** |
| `agent_docs/token-indexer-overview.md` | Full Ponder patterns (handlers, repos, services) — **read before writing any implementation plan** |
| `docs/supported-order-types.md` | All 8 order type ABI structs, handler addresses, decoded fields, edge cases — **read before any decoder or block-handler work** |

## Working Conventions

- Run `pnpm codegen` after any change to `ponder.config.ts` or `ponder.schema.ts`
- New event handlers go in `src/application/handlers/` (one file per contract)
- Adding a chain: create a chain file in `src/chains/` and register it in `src/chains/index.ts`; set its `rpcEnvVar` and optionally `wsRpcEnvVar` (the optional `<CHAIN>_WS_RPC_URL` enables Ponder realtime WS subscriptions)
- External HTTP / RPC calls in block handlers must use `withTimeout(...)` and be partial-failure tolerant — see `agent_docs/code-patterns.md` § External I/O in block handlers
- Current scope: mainnet + gnosis; Arbitrum planned
