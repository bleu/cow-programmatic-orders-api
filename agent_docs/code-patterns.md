# Code Patterns — Programmatic Orders API

Quick reference for schema, naming, and structure. Full Ponder patterns (repositories, services, handlers) are in **`agent_docs/token-indexer-overview.md`** — read that before writing implementation plans.

---

## Schema (Ponder)

| Convention | Rule |
|------------|------|
| **Table name (SQL)** | `snake_case` (e.g. `conditional_order_generator`, `discrete_order`) |
| **TypeScript export** | `camelCase` (e.g. `conditionalOrderGenerator`, `discreteOrder`) |
| **Primary key** | Composite `(chainId, id)` for multi-chain tables; use `primaryKey({ columns: [table.chainId, table.id] })` |
| **Event / log rows** | Prefer `eventId` for the Ponder event id (not `id`) so it’s clear it’s from the event |
| **Addresses** | Store as `t.hex()`, normalize with `.toLowerCase()` before insert |
| **Timestamps** | `t.bigint()` (block timestamp in seconds) |

## File layout

| What | Where |
|------|--------|
| Table definitions | `schema/tables.ts` |
| Relations | `schema/relations.ts` |
| Event handlers | `src/application/handlers/` (one file per contract, e.g. `composableCow.ts`) |
| Chain/contract config | `src/data.ts` → `ponder.config.ts` |
| API | `src/api/index.ts` (Hono + GraphQL + SQL) |

## Commands after changes

- Schema or config change → run `pnpm codegen`
- Always run `pnpm typecheck` and `pnpm lint` before considering a task done

---

## Extending this doc

When you add patterns (e.g. from the token-indexer or from PR review), add them here so the next task has a single place to look. You can also ask the agent in the token-indexer project to list conventions and copy the relevant ones here.
