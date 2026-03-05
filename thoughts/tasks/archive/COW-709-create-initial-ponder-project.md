---
linear_id: COW-709
linear_url: https://linear.app/bleu-builders/issue/COW-709/create-initial-ponder-propject
status: Todo
priority: High
assignee: jefferson@bleu.studio
estimate: 2 Points
milestone: Composable CoW Tracking
sprint: S1
created: 2026-02-27
updated: 2026-02-27
linear_synced: true
git_branch: jefferson/cow-709-create-initial-ponder-propject
---

# Create Initial Ponder Project — Bootstrap & Infrastructure

## Problem

Before we can index Composable CoW events, we need a working Ponder project with proper structure, multi-chain configuration, and development environment. This foundational work unblocks all subsequent indexing tasks.

The PoC exists but is single-chain (mainnet only), has hardcoded block ranges, and lacks proper project structure for production use.

## Scope

- [ ] Initialize Ponder project with proper dependencies
- [ ] Set up project structure following token-indexer conventions
- [ ] Configure multi-chain support (Ethereum Mainnet, Gnosis Chain, Arbitrum)
- [ ] Set up Docker Compose for local PostgreSQL
- [ ] Create `.env.local.example` with documented env vars
- [ ] Basic CI/CD pipeline (linting, typecheck)

## Technical Details

### Project Structure (following token-indexer pattern)

```
apps/programmatic-orders-api/
├── ponder.config.ts      # Chains, contracts, blocks
├── ponder.schema.ts      # Re-exports schema
├── schema/
│   ├── tables.ts         # Table and enum definitions
│   ├── relations.ts      # Relations between tables
│   └── views.ts          # (Optional) Views
├── src/
│   ├── data.ts           # Contract addresses, ABIs, start blocks per chain
│   ├── api/
│   │   └── index.ts      # Hono app: GraphQL endpoints
│   └── application/
│       └── handlers/     # Event handlers
├── abis/                 # ABI files (can be .ts or .json)
├── docker-compose.yml    # PostgreSQL for local dev
├── .env.local.example
├── package.json
├── tsconfig.json
└── vite.config.ts
```

### Dependencies (from PoC + token-indexer reference)

```json
{
  "dependencies": {
    "ponder": "^0.16.2",
    "viem": "^2.21.3",
    "hono": "^4.5.0",
    "@cowprotocol/cow-sdk": "^7.2.13"
  },
  "devDependencies": {
    "@types/node": "^20.x",
    "typescript": "^5.x",
    "eslint": "^8.x",
    "vite": "^6.x"
  }
}
```

### Chain Configuration

```typescript
// ponder.config.ts
chains: {
  mainnet: {
    id: 1,
    rpc: process.env.ETHEREUM_RPC_URL!,
  },
  gnosis: {
    id: 100,
    rpc: process.env.GNOSIS_RPC_URL!,
  },
  arbitrum: {
    id: 42161,
    rpc: process.env.ARBITRUM_RPC_URL!,
  },
}
```

### Key Files to Create

| File | Purpose | Reference |
|------|---------|-----------|
| `ponder.config.ts` | Chain + contract config | PoC: `ponder.config.ts` |
| `ponder.schema.ts` | Schema entry point | Token-indexer pattern |
| `src/data.ts` | Contract addresses per chain | To be populated by research task |
| `src/api/index.ts` | Hono + GraphQL setup | PoC: `src/api/index.ts` |
| `docker-compose.yml` | Local PostgreSQL | Standard pattern |
| `.env.local.example` | Env var documentation | — |

### What to Reuse from PoC

- `src/api/index.ts` — Hono app pattern with graphql/client middleware
- `abis/ComposableCowAbi.ts` — ComposableCoW ABI
- Basic `ponder.config.ts` structure (but expand to multi-chain)

### What to Build Fresh

- Multi-chain configuration
- Proper project structure (`schema/`, `src/application/handlers/`)
- Docker Compose for PostgreSQL
- CI/CD pipeline
- `src/data.ts` for contract configs (addresses come from research task)

## Acceptance Criteria

- [ ] `pnpm dev` starts Ponder and connects to all 3 chains
- [ ] `pnpm typecheck` passes
- [ ] `pnpm lint` passes
- [ ] Docker Compose starts PostgreSQL successfully
- [ ] GraphQL endpoint accessible at `http://localhost:42069/graphql`
- [ ] `.env.local.example` documents all required env vars
- [ ] Project structure matches the layout above

## Open Questions

- [ ] Should we use a monorepo structure (`apps/`) or single package?
- [ ] Which Ponder version — stick with 0.16.x or upgrade?

## References

- PoC: `/Users/jefferson/Projects/Bleu/cow/reference_repos/cow-programmatic-orders-indexer/`
- Token Indexer Overview: `thoughts/reference_docs/token-indexer-overview.md`
- Sprint Plan S1.1: `thoughts/plans/sprint_plan.md`
- Grant: `thoughts/reference_docs/grant_proposal.md` (Milestone 1)
- Linear: https://linear.app/bleu-builders/issue/COW-709/create-initial-ponder-propject
