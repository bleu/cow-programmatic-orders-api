---
status: todo
linear_synced: true
created: 2026-03-06
milestone: M3
estimate: 2
labels: [schema, feature]
linear_url: https://linear.app/bleu-builders/issue/COW-734/schema-add-orderbook-cache-table-persistent-across-ponder-resyncs
git_branch: jefferson/cow-734-schema-add-orderbook_cache-table-persistent-across-ponder
---

# Schema: add orderbook_cache table (persistent across Ponder resyncs)

## Problem

Ponder drops all `onchainTable`-managed tables on a full resync. The orderbook API is an external dependency that we cannot re-query for all historical data on every resync — especially for perpetual swaps whose UIDs are non-deterministic. We need a persistent cache table that survives resyncs, so repeated Ponder redeployments don't hammer the CoW orderbook API.

## Details

```typescript
// orderbook_cache — persists orderbook API responses across Ponder redeployments
//   cacheKey      text     — PK: hash or composite of (endpoint + owner + orderUid)
//   responseJson  json     — full API response object
//   fetchedAt     bigint   — unix timestamp of last fetch
//   expiresAt     bigint   — unix timestamp after which to re-fetch (TTL)
```

**Critical:** This table must NOT be an `onchainTable`. It must survive Ponder resyncs.

- Create as a plain Drizzle/PostgreSQL table outside of Ponder's sync-managed schema
- Use a Ponder `onApplicationStart` hook (or similar startup mechanism) to ensure the table exists before handlers run
- Intentionally excluded from Ponder's resync lifecycle — persists until DB is fully dropped

**TTL guidance:**
- Orders in terminal states (`fulfilled`, `expired`, `cancelled`): cache indefinitely
- Open orders: short TTL (e.g., 60–300 seconds)

## Implementation Notes

- File additions: `schema/tables.ts` (or separate migration file)
- Startup hook to ensure table exists before handlers run
- Validate by: run `pnpm dev`, populate cache, simulate resync, confirm table not wiped

## Acceptance Criteria

- Table exists and persists after `pnpm dev` restart
- Table is NOT dropped during a Ponder full resync simulation
- `pnpm typecheck` passes

## Dependencies

None — can be done in parallel with Tasks 1, 2, 3.

## References

- Source: `thoughts/prompts/m3-linear-tasks-prompt.md` Task 4
- Macro plan: `thoughts/plans/2026-03-06-milestone-3-macro-plan.md` Phase D

---

## Notes (planning / validation)

- **Logs para confirmar uso do cache na reindexação:** Adicionar logs que deixem explícito quando uma resposta da orderbook API vem do cache (cache hit) vs. quando é fetch novo (cache miss). Em reindexação, após popular a cache e reiniciar/resync, os logs devem mostrar cache hit para as mesmas chaves — confirmando que a reindexação está usando o cache e não batendo na API de novo.
- **Como testar localmente:** (1) Subir o indexer com Postgres; (2) disparar fluxos que chamem a orderbook API (ex.: block handler ou trade handler que consulte a API); (3) verificar nos logs que há cache miss na primeira vez e cache hit na segunda para a mesma chave; (4) simular resync (ex.: truncar tabelas on-chain gerenciadas pelo Ponder e re-rodar sync, ou reiniciar com flag de resync se houver); (5) confirmar que a tabela `orderbook_cache` não foi truncada e que os logs mostram cache hit para requisições que já estavam em cache — validando que a reindexação está de fato usando o cache persistente. Opcional: usar um segundo Postgres só para a cache (schema separado) para isolar e garantir que apenas a cache persiste.
