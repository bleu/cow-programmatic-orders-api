# Token Indexer — Ponder Setup Overview

Reference document for bootstrapping a Ponder-based token indexer from scratch. Use this as a blueprint for structure, config, and conventions. Protocol-specific details (contract addresses, discovery format, ABIs) are left as placeholders for you to fill in.

---

## 1. Project initialization and dependencies

### 1.1 Create the app and install Ponder

From the monorepo root (or a new package):

```bash
mkdir -p apps/token-indexer
cd apps/token-indexer
pnpm init
```

Add core dependencies:

```json
{
  "name": "@your-org/token-indexer",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "ponder dev",
    "start": "ponder start",
    "db": "ponder db",
    "codegen": "ponder codegen",
    "lint": "eslint .",
    "typecheck": "tsc"
  },
  "dependencies": {
    "ponder": "0.16.x",
    "viem": "^2.x",
    "hono": "^4.x"
  },
  "devDependencies": {
    "@types/node": "^20.x",
    "eslint": "^8.x",
    "typescript": "^5.x",
    "vite": "^6.x",
    "vite-tsconfig-paths": "^5.x"
  },
  "engines": { "node": ">=18.14" }
}
```

Then:

```bash
pnpm install
```

### 1.2 TypeScript and Vite

- **tsconfig.json**: `strict: true`, `module: "ESNext"`, `moduleResolution: "bundler"`, `noEmit: true`. Include path aliases if you have a shared `lib` (e.g. `@your-org/utils/*`).
- **vite.config.ts**: Use `vite-tsconfig-paths` so path aliases work with Ponder’s bundler.

---

## 2. Project structure (high level)

Keep the token indexer as a single Ponder app with a clear layout:

```
apps/token-indexer/
├── ponder.config.ts      # Chains, contracts, blocks
├── ponder.schema.ts      # Re-exports schema (tables + relations + views)
├── schema/
│   ├── tables.ts         # Table and enum definitions
│   ├── relations.ts      # Relations between tables
│   └── views.ts          # (Optional) Views
├── src/
│   ├── data.ts           # Build contract/chain config (addresses, startBlock, etc.)
│   ├── api/
│   │   ├── index.ts      # Hono app: GraphQL, optional REST
│   │   ├── endpoints/    # Custom HTTP endpoints
│   │   └── utils.ts      # Shared API helpers
│   └── application/
│       └── handlers/     # ponder.on(...) event and block handlers
├── .env.local            # Not committed; indexer env vars
├── package.json
├── tsconfig.json
└── vite.config.ts
```

- **Config**: `ponder.config.ts` imports chain and contract definitions (from `src/data.ts` or equivalent) so contract addresses and block ranges stay in one place.
- **Schema**: Single entry point `ponder.schema.ts` that re-exports `schema/tables`, `schema/relations`, and optionally `schema/views`.
- **Handlers**: One or more files under `src/application/handlers/` that register `ponder.on("ContractName:EventName", ...)` or `ponder.on("BlockUpdates:block", ...)`.

---

## 3. Ponder config (`ponder.config.ts`)

Config defines chains, contracts, and (optionally) block intervals.

### 3.1 Chains

Use viem chain definitions. You can centralize chain list and RPC in a shared util or env:

```ts
import { createConfig } from "ponder";

// Example: chains from a shared lib or env
// const chains = { mainnet: mainnet, arbitrum: arbitrum, ... };
const config = createConfig({
  chains: {
    // chainName: { ...chain, rpcUrl: process.env.MAINNET_RPC_URL }
  },
  contracts: { /* see below */ },
  blocks: { /* optional block handlers */ },
});
export default config;
```

Leave actual chain IDs and RPC URLs to your env or config (e.g. `process.env.ETHEREUM_RPC_URL`).

### 3.2 Contracts

Each key is a logical contract name used in handlers as `ContractName:EventName`. Value is `abi` + `chain` (per-chain address and block range):

```ts
contracts: {
  YourContract: {
    abi: YourContractAbi,
    chain: {
      mainnet: {
        address: "0x...",  // or [ "0x...", "0x..." ] for multiple
        startBlock: 12345678,
        // endBlock: 99999999,  // optional
      },
      // other chains...
    },
  },
  Erc20Token: {
    abi: erc20Abi,
    chain: buildTokenChainObjects("mainnet"),  // from src/data.ts
  },
},
```

Contract addresses and `startBlock`/`endBlock` should come from your discovery or config (see **Data layer** below), not hardcoded in this file.

### 3.3 Block handlers (optional)

For periodic block-based updates (e.g. snapshots, storage sync):

```ts
blocks: {
  BlockUpdates: {
    chain: {
      mainnet: {
        interval: 100,
        startBlock: 12000000,
        // endBlock: optional
      },
    },
  },
},
```

Handlers are registered with `ponder.on("BlockUpdates:block", async ({ event, context }) => { ... })`.

---

## 4. Data layer (`src/data.ts`)

Use this module to build the `chains` and `contracts` (and optionally `blocks`) input for `ponder.config.ts`. Keep protocol-specific addresses and discovery format out of the config file.

- **Input**: Environment (e.g. `DISCOVERY_JSON_PATH`) or config that lists contract addresses and creation blocks per chain.
- **Output**: Structures like:
  - `buildXChainObjects(selectedChains)` → `Record<ChainName, { address: Address | Address[], startBlock: number, endBlock?: number }>` for a given contract type.
- **Usage in config**: `ponder.config.ts` imports these builders and passes selected chains, e.g. `chain: buildMarketChainObjects(["mainnet", "arbitrum"])`.

Leave the exact shape of “discovery” (e.g. silos, vaults, tokens) and contract names as placeholders; the important part is having one place that turns your protocol data into Ponder’s `chain` format.

---

## 5. Schema

### 5.1 Entry point (`ponder.schema.ts`)

```ts
export * from "./schema/tables";
export * from "./schema/relations";
export * from "./schema/views";   // if you use views
```

### 5.2 Tables (`schema/tables.ts`)

Define tables and enums with Ponder’s helpers:

```ts
import { onchainTable, onchainEnum, primaryKey } from "ponder";

export const myEnum = onchainEnum("my_enum", ["A", "B", "C"]);

export const myTable = onchainTable(
  "my_table",
  (t) => ({
    id: t.text().notNull(),
    chainId: t.integer().notNull(),
    name: t.text(),
    amount: t.bigint().notNull(),
  }),
  (table) => ({
    pk: primaryKey({ columns: [table.chainId, table.id] }),
  })
);
```

Use enums and table names that match your domain; avoid protocol-specific naming in this overview.

### 5.3 Relations (`schema/relations.ts`)

Define relations so the GraphQL API can resolve nested entities:

```ts
import { relations } from "ponder";
import { myTable, otherTable } from "./tables";

export const myTableRelations = relations(myTable, ({ one, many }) => ({
  other: one(otherTable, {
    fields: [myTable.otherId],
    references: [otherTable.id],
  }),
}));
```

---

## 6. Event and block handlers

Handlers are registered with `ponder.on`. The first argument is `"ContractName:EventName"` for contract events or `"BlockUpdates:block"` for block updates.

### 6.1 Contract events

```ts
import { ponder } from "ponder:registry";
import type { Context } from "ponder:registry";

ponder.on("YourContract:Transfer", async ({ event, context }) => {
  const { args, block, transaction, log } = event;
  // Use context.db to insert/update tables
  await context.db.insert(myTable).values({
    id: `${context.chain.id}-${log.address}-${args.from}-${args.to}`,
    chainId: context.chain.id,
    amount: args.value,
    blockNumber: block.number,
  });
});
```

Contract and event names must match `ponder.config.ts`. Use `context.db` for writes and `context.chain` for chain id/name.

### 6.2 Block handler

```ts
ponder.on("BlockUpdates:block", async ({ event, context }) => {
  const { block } = event;
  // e.g. snapshot or storage sync
});
```

### 6.3 Organizing handlers

- One file per contract or domain (e.g. `market.ts`, `vault-events.ts`).
- Import these files from a central entry (e.g. `handlers/index.ts`) or let the bundler pick them up so all `ponder.on` registrations run.

---

## 7. API (`src/api/index.ts`)

Ponder exposes the schema via GraphQL. You can add a Hono app to serve GraphQL and custom REST endpoints.

```ts
import { db } from "ponder:api";
import schema from "ponder:schema";
import { Hono } from "hono";
import { client, graphql } from "ponder";

const app = new Hono();

// Optional: global middleware (e.g. headers)
app.use("*", async (c, next) => {
  await next();
  c.res.headers.set("X-Indexer", "token-indexer");
});

// Ponder’s SQL/GraphQL
app.use("/sql/*", client({ db, schema }));
app.use("/", graphql({ db, schema }));
app.use("/graphql", graphql({ db, schema }));

// Custom REST endpoints
// app.get("/custom/:id", withTry(customEndpoint));

export default app;
```

Custom endpoints can use `db` and `schema` to run queries; keep heavy logic in services/repositories if you need reuse or tests.

---

## 8. Environment variables

Use a local env file (e.g. `.env.local`, not committed). Document required and optional variables.

| Variable | Required | Description |
|----------|----------|-------------|
| `DISCOVERY_JSON_PATH` (or similar) | Yes | Path to discovery/config file that lists contracts and blocks. |
| `DATABASE_URL` | No | PostgreSQL URL. Default is Ponder’s default (e.g. `postgresql://localhost:5432/ponder`). |
| `DATABASE_SCHEMA` | No | Schema name for this deployment (e.g. for multi-version rollback). |
| `PINO_LOG_LEVEL` | No | Log level: `debug`, `info`, `warn`, `error`. |

RPC URLs can be in the same file or in a shared `secrets.env`; reference them in your chain config (e.g. in a shared `lib` that builds `chains`).

---

## 9. Development commands

From `apps/token-indexer/`:

| Command | Description |
|---------|-------------|
| `pnpm dev` | Run indexer in watch mode (auto-reindex on changes). |
| `pnpm start` | Production run. |
| `pnpm db` | Open Ponder DB CLI. |
| `pnpm codegen` | Regenerate types from schema. |
| `pnpm typecheck` | TypeScript check. |
| `pnpm lint` | Lint. |

Quick start:

```bash
pnpm install          # from monorepo root
# Create .env.local with DISCOVERY_JSON_PATH (or your config path)
cd apps/token-indexer
pnpm dev
```

---

## 10. Optional: Docker

If you run the indexer in Docker:

- Build from monorepo root so `lib/` (if used) is available.
- Mount config, schema, and `src` so you can iterate without rebuilding.
- Set `DATABASE_URL` to the DB service (e.g. `postgresql://user:pass@token-indexer-pg:5432/dbname`).
- Load env from `.env.local` or `secrets.env` via `env_file`.

No need to document protocol-specific images or networks; keep the overview generic.

---

## 11. Summary checklist

- [ ] New package with `ponder`, `viem`, `hono`; TypeScript + Vite with path aliases.
- [ ] `ponder.config.ts`: chains (from env/config), contracts (from data layer), optional blocks.
- [ ] `ponder.schema.ts`: re-export tables, relations, views.
- [ ] `src/data.ts`: build contract/chain config from discovery or config; leave addresses/config format open.
- [ ] Handlers in `src/application/handlers/` using `ponder.on("ContractName:EventName", ...)` and optional block handlers.
- [ ] API: Hono app with Ponder’s `graphql` and `client`, plus any custom REST routes.
- [ ] `.env.local` with at least discovery/config path and optional `DATABASE_URL`, `PINO_LOG_LEVEL`.
- [ ] Commands: `pnpm dev`, `pnpm start`, `pnpm db`, `pnpm codegen`, `pnpm typecheck`, `pnpm lint`.

Contract addresses, discovery shape, ABIs, and chain list are protocol-specific and should be defined in your repo (env, discovery files, shared `lib`) rather than in this overview.
