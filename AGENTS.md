# CLAUDE.md

## What This Project Is

Ponder-based indexer and GraphQL API for Composable CoW programmatic orders. Indexes on-chain events from the ComposableCoW contract, decodes all order types (TWAP, Stop Loss, Perpetual Swap, Good After Time, Trade Above Threshold), and exposes queryable data via GraphQL. CoW Protocol grant project — infrastructure to be handed off to the CoW Protocol team after grant completion.

**Tech**: Ponder 0.16.x · TypeScript · viem · Hono · PostgreSQL · pnpm

## Architecture

```
ComposableCoW contract (mainnet; gnosis/arbitrum in future sprints)
       ↓  events
  ponder.config.ts  ←  src/data.ts  (contract addresses + start blocks per chain)
       ↓
  src/application/handlers/  (one file per contract)
       ↓
  schema/tables.ts  (transaction, conditionalOrderGenerator, discreteOrder)
       ↓
  src/api/index.ts  (Hono: /graphql  /  /sql/*)
```

**Key paths**:
- `abis/` — Contract ABIs
- `src/data.ts` — Chain configs and contract addresses (extend here to add a chain)
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

Copy `.env.local.example` → `.env.local` and set `MAINNET_RPC_URL` before `pnpm dev`.
Start PostgreSQL with `docker compose up -d` to use it instead of the default SQLite.

## Reference Documentation

| File | When to read |
|------|--------------|
| `agent_docs/architecture.md` | Full data-flow, file responsibilities, schema details |
| `agent_docs/project-structure.md` | Current file map, schema tables, env vars, key commands |
| `agent_docs/code-patterns.md` | Schema/naming conventions (snake_case, composite PK, eventId) — **check before schema or handler changes** |
| `agent_docs/token-indexer-overview.md` | Full Ponder patterns (handlers, repos, services) — **read before writing any implementation plan** |
| `agent_docs/decoder-reference.md` | All 5 order type ABI structs, handler addresses, PollResultErrors — **read before any decoder or M3 block-handler work** |
| `agent_docs/slack_decisions_summary.md` | Technical decisions from CoW Protocol team (flash loans, CoWShed, orderbook, scope) — **read before planning M2/M3** |
| `thoughts/tasks/` | Linear ticket context for each sprint task |
| `thoughts/reference_docs/grant_proposal.md` | Full project scope across all milestones |

## Working Conventions

- Run `pnpm codegen` after any change to `ponder.config.ts` or `ponder.schema.ts`
- New event handlers go in `src/application/handlers/` (one file per contract)
- Adding a chain: update `src/data.ts` first, then `ponder.config.ts`
- M1 scope is mainnet + `ConditionalOrderCreated` only — do not carry forward PoC order-matching logic until S2.x
