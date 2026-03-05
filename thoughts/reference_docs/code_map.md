# Code Map & Context for COW-709 Implementation

This document serves as a high-speed context loading reference for agents implementing the initial Ponder project. It maps the reference POC to the target structure and provides necessary configuration values.

## 1. Project Structure Mapping

| Target Path | Source/Reference (POC) | Notes |
| :--- | :--- | :--- |
| `package.json` | `package.json` | Use dependencies listed below. |
| `ponder.config.ts` | `ponder.config.ts` | Expand to multi-chain structure (see Config section). |
| `ponder.schema.ts` | `ponder.schema.ts` | Re-export from `schema/` directory. |
| `schema/tables.ts` | `ponder.schema.ts` | Extract tables here. |
| `schema/relations.ts` | `ponder.schema.ts` | Extract relations here. |
| `src/api/index.ts` | `src/api/index.ts` | Hono app setup. |
| `src/data.ts` | N/A (New) | Store constants/addresses here. |
| `abis/ComposableCowAbi.ts` | `abis/ComposableCowAbi.ts` | Copy exact file. |
| `docker-compose.yml` | N/A (New) | Standard Postgres setup. |

## 2. Configuration Values

### Chains

| Chain | ID | RPC Env Var | Status for M1 |
| :--- | :--- | :--- | :--- |
| **Mainnet** | `1` | `MAINNET_RPC_URL` | **Active** |
| Gnosis | `100` | `GNOSIS_RPC_URL` | Configured but empty contracts |
| Arbitrum | `42161` | `ARBITRUM_RPC_URL` | Configured but empty contracts |

### Contracts (ComposableCow)

**Mainnet**:
- **Address**: `0xfdaFc9d1902f4e0b84f65F49f244b32b31013b74`
- **Start Block**: `17883049`
- **ABI**: See `abis/ComposableCowAbi.ts`

**Gnosis / Arbitrum**:
- *Not in scope for M1 active indexing, but structure should exist.*

## 3. Schema Definition (Ready to Implement)

### `transaction` Table
```typescript
export const transaction = onchainTable("transaction", (t) => ({
  hash: t.hex().notNull(),
  chainId: t.integer().notNull(),
  blockNumber: t.bigint().notNull(),
  blockTimestamp: t.bigint().notNull(),
}), (table) => ({
  pk: primaryKey({ columns: [table.chainId, table.hash] }),
  blockIdx: index().on(table.blockNumber),
}));
```

### `conditionalOrderGenerator` Table
```typescript
export const conditionalOrderGenerator = onchainTable("conditional_order_generator", (t) => ({
  eventId: t.text().notNull(),
  chainId: t.integer().notNull(),
  owner: t.hex().notNull(),
  handler: t.hex().notNull(),
  salt: t.hex().notNull(),
  staticInput: t.hex().notNull(),
  hash: t.hex().notNull(),
  orderType: orderTypeEnum("order_type").notNull(),
  status: orderStatusEnum("order_status").notNull().default("Active"),
  decodedParams: t.json(),
  txHash: t.hex().notNull(),
}), (table) => ({
  pk: primaryKey({ columns: [table.chainId, table.eventId] }),
  ownerIdx: index().on(table.owner),
  handlerIdx: index().on(table.handler),
}));
```

### `discreteOrder` Table
```typescript
export const discreteOrder = onchainTable("discrete_order", (t) => ({
  orderUid: t.text().notNull(),
  chainId: t.integer().notNull(),
  conditionalOrderGeneratorId: t.text().notNull(),
}), (table) => ({
  pk: primaryKey({ columns: [table.chainId, table.orderUid] }),
  generatorIdx: index().on(table.conditionalOrderGeneratorId),
}));
```

### Relations
- `transaction` has many `conditionalOrderGenerators`
- `conditionalOrderGenerator` belongs to one `transaction`, has many `discreteOrders`
- `discreteOrder` belongs to one `conditionalOrderGenerator`

## 4. Dependencies (Exact Versions)

Use these versions to match the working POC:

```json
"dependencies": {
  "ponder": "^0.16.2",
  "viem": "^2.21.3",
  "hono": "^4.5.0",
  "@cowprotocol/cow-sdk": "^7.2.13",
  "@cowprotocol/sdk-viem-adapter": "^0.3.1"
}
```

## 5. Development Environment

- **Node Version**: `>=18.14`
- **Package Manager**: `pnpm`
- **Database**: PostgreSQL (via Docker Compose)
- **Local Dev Port**: `42069` (default Ponder)
