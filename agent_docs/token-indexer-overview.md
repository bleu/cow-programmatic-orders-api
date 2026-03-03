# Token Indexer — Architecture Patterns & Conventions

Reference document for building a Ponder-based protocol indexer modelled after this monorepo.
Protocol-specific details (contract addresses, discovery format, ABIs, business logic) are left as
placeholders. Use this as the structural blueprint.

**Root of the reference implementation:** `apps/token-indexer/`
**Path for agent access:** `agent_docs/token-indexer-overview.md`

---

## 1. High-level architecture

```
Blockchain
    ↓
eRPC (port 30000, RPC multiplexer/cache)
    ↓
Ponder Indexer (apps/token-indexer)
    ↓
PostgreSQL
    ↓
GraphQL / REST API (Hono)
```

Data discovery is a **separate offline step** that produces `discovery.json` — a static snapshot
of every contract address the indexer needs to watch. This file is committed to the repo and loaded
at startup; the indexer never discovers contracts at runtime.

---

## 2. Monorepo layout

```
apps/
  token-indexer/     ← main Ponder indexer (this document's reference)
  token-supervisor/  ← Docker Swarm orchestrator; manages indexer containers
  api-health-checks/ ← standalone health/monitoring service
lib/
  utils/             ← shared ABIs, chain configs, types (workspace package)
agent_docs/          ← documentation for agents and developers
thoughts/            ← analysis, plans, research notes (not shipped)
```

---

## 3. `apps/token-indexer/` — detailed structure

```
apps/token-indexer/
├── discovery.json          # Static contract discovery data (committed)
├── ponder.config.ts        # Ponder entry: chains, contracts, block handlers
├── ponder.schema.ts        # Re-exports schema (required by Ponder)
├── package.json
├── tsconfig.json
├── vite.config.ts          # Path alias support (vite-tsconfig-paths)
│
├── schema/                 # Database schema (3 files, not protocol logic)
│   ├── tables.ts           # onchainTable and onchainEnum definitions
│   ├── relations.ts        # Table relationship definitions
│   └── views.ts            # Optional PostgreSQL views
│
└── src/
    ├── data.ts             # Transforms discovery.json → ponder.config structures
    │
    ├── api/                # HTTP / GraphQL layer
    │   ├── index.ts        # Hono app; mounts GraphQL, SQL, and REST endpoints
    │   ├── endpoints/      # Custom REST endpoint handlers
    │   └── queries/        # Shared query helpers for API routes
    │
    ├── application/        # Event handlers (entry point for blockchain events)
    │   └── handlers/       # One file (or subdirectory) per contract / domain
    │
    ├── domain/             # Business logic
    │   ├── contracts/      # On-chain contract interaction helpers
    │   ├── services/       # Calculation, transformation, snapshot services
    │   └── types/          # TypeScript domain types
    │
    ├── infrastructure/     # Data access
    │   ├── repositories/   # One repository class per entity (CRUD + queries)
    │   └── readers/        # On-chain read helpers (not DB)
    │
    └── shared/             # Cross-cutting utilities
        ├── config/         # Runtime config (oracle addresses, etc.)
        └── utils/          # Math, ID generation, logger, contract read wrappers
```

---

## 4. Data flow in detail

```
OFFLINE DISCOVERY
  ↓
discovery.json
  (lists every contract address + creation block, grouped by chain)
  ↓
INDEXER STARTUP
  ↓
src/data.ts
  loadDiscoveryState()           ← reads discovery.json (path from env)
  buildXChainObjects(chains)     ← returns { [chainName]: { address[], startBlock, endBlock? } }
  buildBlockUpdates(chains)      ← periodic block handlers (~30 min interval)
  buildLatestBlockUpdates(chains)← "latest" block range handlers (expensive ops)
  buildDailyBlockUpdates(chains) ← once-per-day handlers (timeseries snapshots)
  ↓
ponder.config.ts
  createConfig({
    chains: ...,
    contracts: { ContractName: { abi, chain: buildXChainObjects(...) } },
    blocks:    { BlockUpdates: { chain: buildBlockUpdates(...) } },
  })
  ↓
Ponder framework
  - subscribes to chains via RPC
  - filters logs by contract address + event signature
  - calls ponder.on() handlers in order
  ↓
src/application/handlers/
  - receives { event, context }
  - parses event args, block, transaction, log
  - calls domain services for calculations
  - persists via repositories
  ↓
src/infrastructure/repositories/
  - context.db.insert / update / find / sql
  ↓
PostgreSQL
  ↓
src/api/
  - GraphQL (auto-generated from schema)
  - SQL passthrough endpoint
  - custom Hono REST endpoints
```

---

## 5. `src/data.ts` — data layer pattern

This is the only file that knows about `discovery.json`'s shape. It exports:

- **`PROTOCOL_DISCOVERY_STATE`** — parsed discovery data, loaded once at startup
- **`buildXChainObjects(selectedChains)`** — one function per logical contract group,
  returns the `chain` field value for `ponder.config.ts` contracts
- **`buildBlockUpdates / buildLatestBlockUpdates / buildDailyBlockUpdates`** — return the `blocks`
  field values for periodic handlers

Key rule: `ponder.config.ts` **never** contains raw addresses or block numbers — those always come
from `data.ts`.

---

## 6. `ponder.config.ts` — config pattern

```ts
import { createConfig } from "ponder";
import { buildChainsObject, buildFactoryContracts } from "@your-org/utils";
import {
  buildMarketChainObjects,
  buildTokenChainObjects,
  buildBlockUpdates,
  buildDailyBlockUpdates,
} from "./src/data";

const selectedChains = ["mainnet", "arbitrum"] as const; // change per deployment

export default createConfig({
  chains: buildChainsObject(selectedChains), // from lib/utils
  contracts: {
    ...buildFactoryContracts(selectedChains), // factory contracts (auto-discover)
    Market: { abi: MarketAbi, chain: buildMarketChainObjects(selectedChains) },
    ERC20: { abi: erc20Abi, chain: buildTokenChainObjects(selectedChains) },
    // more contracts...
  },
  blocks: {
    ...buildBlockUpdates(selectedChains),
    ...buildDailyBlockUpdates(selectedChains),
  },
});
```

---

## 7. Schema patterns (`schema/`)

### Entry point (`ponder.schema.ts`)

```ts
export * from "./schema/tables";
export * from "./schema/relations";
export * from "./schema/views"; // optional
```

### Tables (`schema/tables.ts`)

```ts
import { onchainTable, onchainEnum, primaryKey, index } from "ponder";

// Enums for domain categorisation
export const statusEnum = onchainEnum("status", [
  "ACTIVE",
  "PAUSED",
  "DEPRECATED",
]);

// Entity table
export const market = onchainTable(
  "market",
  (t) => ({
    id: t.text().notNull(), // address (lowercase)
    chainId: t.integer().notNull(),
    name: t.text().notNull(),
    status: statusEnum().notNull(),
    // amounts stored as decimal strings (never raw BigInt in DB)
    totalSupply: t.text().notNull(),
    totalBorrow: t.text().notNull(),
    totalSupplyUsd: t.real(),
    // timestamps as bigint (block.timestamp in seconds)
    createdAt: t.bigint().notNull(),
    updatedAt: t.bigint().notNull(),
  }),
  (table) => ({
    pk: primaryKey({ columns: [table.chainId, table.id] }),
  }),
);

// Timeseries table (snapshot at each interval)
export const marketTimeseries = onchainTable(
  "market_timeseries",
  (t) => ({
    id: t.text().notNull(), // "{marketId}-{dayTimestamp}"
    chainId: t.integer().notNull(),
    marketId: t.text().notNull(),
    timestamp: t.bigint().notNull(),
    totalSupply: t.text().notNull(),
    totalSupplyUsd: t.real(),
    utilization: t.text().notNull(),
    borrowRate: t.text().notNull(),
    depositRate: t.text().notNull(),
  }),
  (table) => ({
    pk: primaryKey({ columns: [table.chainId, table.id] }),
    idx_timestamp: index("market_ts_timestamp").on(table.timestamp),
    idx_market: index("market_ts_market").on(table.marketId),
  }),
);
```

Key conventions:

- **Composite PK**: always `(chainId, id)` for multi-chain support
- **IDs**: `address` (lowercase hex) for entity tables; `"{entityId}-{qualifier}"` for
  timeseries / events
- **Amounts**: stored as `t.text()` decimal strings, not BigInt
- **Prices/rates**: stored as `t.real()` (floating-point is fine for display)
- **Timestamps**: `t.bigint()` (block.timestamp in seconds)
- **Indexes**: add for any column used in `WHERE` or `ORDER BY` in hot queries

### Relations (`schema/relations.ts`)

```ts
import { relations } from "ponder";
import { market, marketTimeseries, position } from "./tables";

export const marketRelations = relations(market, ({ many }) => ({
  timeseries: many(marketTimeseries),
  positions: many(position),
}));

export const marketTimeseriesRelations = relations(
  marketTimeseries,
  ({ one }) => ({
    market: one(market, {
      fields: [marketTimeseries.chainId, marketTimeseries.marketId],
      references: [market.chainId, market.id],
    }),
  }),
);
```

---

## 8. Handler patterns (`src/application/handlers/`)

Handlers are pure Ponder event registrations. They **orchestrate** but do not contain business logic.

```
handlers/
  ProtocolFactory.ts      ← factory events (protocol & market creation)
  market/
    market.ts             ← core market events (deposit, withdraw, borrow, repay)
    AccruedInterestHandler.ts
    FlashLoanHandler.ts
  vault/
    vault.ts
    VaultConfigHandler.ts
  incentives/
    incentives.ts
  block/
    MarketBlockUpdates.ts ← periodic/daily block handlers
```

Handler shape:

```ts
import { ponder } from "ponder:registry";
import { MarketRepository } from "../../infrastructure/repositories/MarketRepository";
import { PositionRepository } from "../../infrastructure/repositories/PositionRepository";
import { MarketService } from "../../domain/services/MarketService";
import { getEventId } from "../../shared/utils/idUtils";

ponder.on("Market:Deposit", async ({ event, context }) => {
  const { args, block, transaction, log } = event;

  // 1. Instantiate repositories (pass context, not global state)
  const marketRepo = new MarketRepository(context);
  const positionRepo = new PositionRepository(context);
  const marketSvc = new MarketService(context, marketRepo);

  // 2. Load existing state
  const mkt = await marketRepo.findByIdOrThrow(log.address);

  // 3. Calculate new state via service
  const updated = await marketSvc.applyDeposit(
    mkt,
    args.assets,
    block.timestamp,
  );

  // 4. Persist
  await marketRepo.update(log.address, updated);
  await positionRepo.upsert(
    args.owner,
    log.address,
    args.shares,
    block.timestamp,
  );

  // 5. Store event record
  await context.db.insert(depositEvent).values({
    id: getEventId(transaction.hash, log.logIndex),
    chainId: context.chain.id,
    marketId: log.address.toLowerCase(),
    accountId: args.owner.toLowerCase(),
    assets: args.assets.toString(),
    timestamp: block.timestamp,
  });
});
```

Block handler shape:

```ts
ponder.on("BlockUpdates:block", async ({ event, context }) => {
  // Sync on-chain state to DB periodically (~30 min interval)
  const marketRepo = new MarketRepository(context);
  const markets = await marketRepo.findAll();
  for (const mkt of markets) {
    const onchainState = await readMarketFromChain(context, mkt.id);
    await marketRepo.update(mkt.id, onchainState);
  }
});

ponder.on("DailyBlockUpdates:block", async ({ event, context }) => {
  // Create daily timeseries snapshots
  const marketRepo = new MarketRepository(context);
  const markets = await marketRepo.findAll();
  for (const mkt of markets) {
    await marketRepo.insertTimeseries(mkt, event.block.timestamp);
  }
});
```

---

## 9. Repository patterns (`src/infrastructure/repositories/`)

One file per entity. Each repository wraps `context.db` and always scopes queries to
`context.chain.id`.

```ts
import type { Context } from "ponder:registry";
import { and, eq, inArray } from "ponder";
import { market } from "../../../schema/tables";

export class MarketRepository {
  private chainId: number;

  constructor(private context: Context) {
    this.chainId = context.chain.id;
  }

  // --- reads ---

  async findById(id: string) {
    return this.context.db.find(market, {
      id: id.toLowerCase(),
      chainId: this.chainId,
    });
  }

  async findByIdOrThrow(id: string) {
    const found = await this.findById(id);
    if (!found)
      throw new Error(`Market not found: ${id} (chain ${this.chainId})`);
    return found;
  }

  async findAll() {
    return this.context.db.sql
      .select()
      .from(market)
      .where(eq(market.chainId, this.chainId));
  }

  // --- writes ---

  async create(params: typeof market.$inferInsert) {
    return this.context.db.insert(market).values({
      ...params,
      chainId: this.chainId,
      id: params.id.toLowerCase(),
    });
  }

  async update(id: string, updates: Partial<typeof market.$inferInsert>) {
    return this.context.db
      .update(market)
      .set(updates)
      .where(
        and(eq(market.id, id.toLowerCase()), eq(market.chainId, this.chainId)),
      );
  }
}
```

---

## 10. Service patterns (`src/domain/services/`)

Services hold **all calculation logic**. They receive repositories via constructor (dependency
injection) so they can be unit-tested without a real DB.

```ts
import { formatUnits } from "viem";
import type { MarketRepository } from "../../infrastructure/repositories/MarketRepository";

export class MarketService {
  constructor(
    private marketRepo: MarketRepository,
    private priceRepo: PriceRepository,
  ) {}

  async applyDeposit(
    market: typeof marketTable.$inferSelect,
    assets: bigint,
    timestamp: bigint,
  ) {
    const assetsNorm = formatUnits(assets, market.inputTokenDecimals);
    const price = await this.priceRepo.getLatest(market.inputTokenId);
    const assetsUsd = price ? parseFloat(assetsNorm) * price : null;

    return {
      totalSupply: (
        parseFloat(market.totalSupply) + parseFloat(assetsNorm)
      ).toString(),
      totalSupplyUsd:
        market.totalSupplyUsd != null && assetsUsd != null
          ? market.totalSupplyUsd + assetsUsd
          : null,
      updatedAt: timestamp,
    };
  }

  async createTimeseries(
    market: typeof marketTable.$inferSelect,
    timestamp: bigint,
  ) {
    const dayTs = getDayTimestamp(timestamp);
    return {
      id: `${market.id}-${dayTs}`,
      chainId: market.chainId,
      marketId: market.id,
      timestamp: dayTs,
      totalSupply: market.totalSupply,
      totalSupplyUsd: market.totalSupplyUsd,
      // ... rates, utilization, etc.
    };
  }
}
```

Typical services per domain:

- `MarketService` — state transitions, interest accrual, utilization
- `PositionService` — position asset/debt calculations, health snapshots
- `HealthService` — LTV, health factor, liquidation threshold
- `VaultService` — vault allocation, yield
- `PriceService` — oracle price fetching and caching
- `IncentivesService` — incentive amount calculations

---

## 11. Shared utilities (`src/shared/utils/`)

| File                | Purpose                                                          |
| ------------------- | ---------------------------------------------------------------- |
| `idUtils.ts`        | ID generation (`getEventId`, `getPositionId`, `getTimeseriesId`) |
| `mathUtils.ts`      | Safe division, rounding, percent calculations                    |
| `logger.ts`         | Thin wrapper around pino (`logger.debug/info/warn/error`)        |
| `contractReads.ts`  | viem `readContract` helpers scoped to context chain              |
| `timestampUtils.ts` | `getDayTimestamp`, `getHourTimestamp`, `secondsToDate`           |

ID generation conventions:

```ts
// Entity IDs
getMarketId(address)         → address.toLowerCase()
getPositionId(market, acct)  → `${market}-${acct}`   (both lowercase)
getProtocolId(chainId, addr) → `${chainId}-${addr}`

// Event IDs (unique per log)
getEventId(txHash, logIndex) → `${txHash}-${logIndex}`

// Timeseries IDs
getTimeseriesId(entityId, dayTs) → `${entityId}-${dayTs}`
```

---

## 12. `lib/utils/` — shared library

Path alias: `@your-org/utils/*` → `lib/utils/src/*`

```
lib/utils/src/
  abis/               # One file per ABI, exported as `const` (e.g. ERC20Abi)
  chains.ts           # CHAINS object: { [chainName]: { id, rpc, secondsPerBlock, indexing } }
  chainObjects.ts     # Chain name → viem chain object mapping
  factoryContracts.ts # buildFactoryContracts(selectedChains) — for ponder.config.ts
  rpcUtils.ts         # getRpcTransport(envVarName) — returns viem transport
  types/
    chain.ts          # ChainName union type, Chains interface
    protocol.ts       # Protocol-specific discovery types
```

`CHAINS` shape:

```ts
export const CHAINS: Chains = {
  mainnet: {
    id: 1,
    rpc: getRpcTransport("MAINNET_RPC_URL"),
    secondsPerBlock: 12,
    indexing: {
      startBlock: 20_000_000,
      factoryAddress: "0x...",
      // ... other factories
    },
  },
  // arbitrum, optimism, avalanche, sonic, ...
};
```

---

## 13. Clean architecture summary

```
┌─────────────────────────────────────────────────────────────┐
│  Ponder Framework  (event filtering, block subscription)    │
└────────────────────────────┬────────────────────────────────┘
                             │ { event, context }
                ┌────────────▼────────────┐
                │  Handlers (application) │  ← orchestrate only
                │  src/application/       │
                └──┬──────────────────────┘
                   │
        ┌──────────┼────────────┐
        │          │            │
┌───────▼──────┐  │  ┌─────────▼───────┐
│   Services   │  │  │  Repositories   │
│   (domain)   │  │  │ (infrastructure)│
│  calculations│  │  │  CRUD / queries │
└───────┬──────┘  │  └────────┬────────┘
        │         │           │
        └─────────┘           │
                    ┌─────────▼────────┐
                    │   PostgreSQL     │
                    └──────────────────┘
                             │
                    ┌────────▼─────────┐
                    │  API (src/api/)  │
                    │  GraphQL + REST  │
                    └──────────────────┘
```

Rules:

- Handlers do not contain calculations — delegate to services
- Services do not touch `context.db` directly — use repositories
- Repositories are always scoped to `context.chain.id`
- No business logic in schema, config, or data layers

---

## 14. Key conventions summary

| Convention     | Rule                                                                                          |
| -------------- | --------------------------------------------------------------------------------------------- |
| Addresses      | Always `.toLowerCase()` before storing or comparing                                           |
| Amounts        | `formatUnits(bigint, decimals)` → store as `string`                                           |
| USD values     | `parseFloat(normalizedAmount) * priceUSD` → store as `real`                                   |
| Timestamps     | `block.timestamp` (bigint, seconds since epoch)                                               |
| Primary keys   | `(chainId, id)` composite for all multi-chain tables                                          |
| Table names    | `snake_case`                                                                                  |
| TypeScript     | `PascalCase` for classes, `camelCase` for functions/vars                                      |
| File names     | Handlers: `PascalCase.ts`, Repos: `PascalCaseRepository.ts`, Services: `PascalCaseService.ts` |
| Error handling | Throw from `findByIdOrThrow`, not from handlers                                               |
| Logging        | Use `logger.{level}` from `shared/utils/logger.ts`                                            |

---

## 15. Checklist for a new protocol indexer

- [ ] `discovery.json` — contract addresses + creation blocks per chain
- [ ] `lib/utils/` — chain configs, ABIs, `buildFactoryContracts`
- [ ] `src/data.ts` — `buildXChainObjects` functions from discovery data
- [ ] `ponder.config.ts` — chains, contracts, blocks using data.ts builders
- [ ] `schema/tables.ts` — entity tables with composite PKs + timeseries tables
- [ ] `schema/relations.ts` — one-to-many / one-to-one relations
- [ ] `ponder.schema.ts` — re-export tables + relations
- [ ] `src/infrastructure/repositories/` — one class per entity
- [ ] `src/domain/services/` — calculation logic (no DB access)
- [ ] `src/application/handlers/` — one file (or subdir) per contract/domain
- [ ] `src/api/index.ts` — Hono app with GraphQL + optional REST endpoints
- [ ] `.env.local` — `DISCOVERY_JSON_PATH`, `DATABASE_URL`, RPC URLs
- [ ] `pnpm dev` works end-to-end
