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

## External I/O in block handlers

Every `fetch`, `context.client.multicall`, `context.client.readContract`, or other network call inside a `ponder.on("…:block", …)` handler must:

1. Be wrapped in `withTimeout(..., msBudget, label)` or `fetchWithTimeout(...)` from `src/application/helpers/withTimeout.ts`.
2. Catch `TimeoutError` at the handler boundary, log `[COW:Cx] <label> timeout …`, and `return` without further DB writes.
3. Be partial-failure tolerant — writes for affected items are skipped; the next block retries naturally.

Rationale: Ponder 0.16 wraps every block in a single DB transaction (`node_modules/.../ponder/src/runtime/multichain.ts:363,639`) and offers no API to leave/re-enter. An unbounded external call in a handler holds the TX across the network round-trip; on a slow peer, Postgres terminates the connection and Ponder retries the full block 9× before shutting the process down (see `ponder-final-23-04.log`, 2026-04-23). Tuning knobs live in `src/constants.ts` (`ORDERBOOK_HTTP_TIMEOUT_MS`, `BLOCK_HANDLER_RPC_TIMEOUT_MS`, `BOOTSTRAP_OWNER_FETCH_TIMEOUT_MS`).

---

## Extending this doc

When you add patterns (e.g. from the token-indexer or from PR review), add them here so the next task has a single place to look. You can also ask the agent in the token-indexer project to list conventions and copy the relevant ones here.
