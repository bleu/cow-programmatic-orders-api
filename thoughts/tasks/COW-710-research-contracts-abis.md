---
linear_id: COW-710
linear_url: https://linear.app/bleu-builders/issue/COW-710/research-protocol-contracts-abis-start-blocks
status: Todo
linear_synced: true
created: 2026-02-27
milestone: M1
sprint: S1
priority: 2
estimate: 1
depends_on: []
---

# Research: Protocol Contracts, ABIs & Start Blocks

## Problem

To index Composable CoW events across all supported chains, we need accurate contract addresses, ABIs, and start blocks. This information is scattered across repositories and chains. Without this research, we cannot configure the indexer correctly.

The PoC only has mainnet addresses. We need Gnosis Chain and Arbitrum, plus all handler contracts.

## Scope

- [ ] Research and document ComposableCoW contract addresses per chain
- [ ] Research all handler contract addresses (TWAP, Stop Loss, Perpetual Swap, Good After Time, Trade Above Threshold)
- [ ] Research CoWShed / CoWShedForComposableCow factory addresses per chain (needed for M2)
- [ ] Research GPv2Settlement addresses per chain (needed for trade events)
- [ ] Collect and organize all required ABIs
- [ ] Document start blocks for each contract on each chain
- [ ] Create `src/data.ts` with all contract configurations

## Technical Details

### Known Addresses (from PoC)

| Contract | Chain | Address | Start Block |
|----------|-------|---------|-------------|
| ComposableCoW | Mainnet | `0xfdaFc9d1902f4e0b84f65F49f244b32b31013b74` | 17883049 |
| Perpetual Swap Handler | Mainnet | `0x519ba24e959e33b3b6220ca98bd353d8c2d89920` | TBD |

### Contracts to Research

1. **ComposableCoW** — Main contract emitting `ConditionalOrderCreated` events
2. **Handler contracts** — One per order type:
   - TWAP Handler
   - Stop Loss Handler
   - Perpetual Swap Handler
   - Good After Time Handler
   - Trade Above Threshold Handler
3. **GPv2Settlement** — For `Trade` events (M3, but good to document now)
4. **CoWShed Factory** — For `COWShedBuilt` events (M2)
5. **AaveV3AdapterFactory** — For flash loan tracking (M2)

### Chains to Cover

| Chain | Chain ID | RPC Env Var |
|-------|----------|-------------|
| Ethereum Mainnet | 1 | `ETHEREUM_RPC_URL` |
| Gnosis Chain | 100 | `GNOSIS_RPC_URL` |
| Arbitrum One | 42161 | `ARBITRUM_RPC_URL` |

### Output Format (`src/data.ts`)

```typescript
export const contracts = {
  composableCow: {
    abi: ComposableCowAbi,
    chains: {
      mainnet: { address: "0x...", startBlock: 17883049 },
      gnosis: { address: "0x...", startBlock: TBD },
      arbitrum: { address: "0x...", startBlock: TBD },
    },
  },
  handlers: {
    twap: { /* ... */ },
    stopLoss: { /* ... */ },
    perpetualSwap: { /* ... */ },
    goodAfterTime: { /* ... */ },
    tradeAboveThreshold: { /* ... */ },
  },
  // M2 contracts (document but don't configure yet)
  cowShedFactory: { /* ... */ },
  gpv2Settlement: { /* ... */ },
};
```

### Research Sources

1. [composable-cow repo](https://github.com/cowprotocol/composable-cow) — Contract addresses in README or deployments
2. [cow-sdk](https://github.com/cowprotocol/cow-sdk) — May have addresses in config
3. Block explorers (Etherscan, Gnosisscan, Arbiscan) — Verify addresses and find deployment blocks
4. CoW Protocol docs — Official deployment addresses

## Acceptance Criteria

- [ ] All ComposableCoW addresses documented for 3 chains
- [ ] All 5 handler addresses documented (at least for mainnet)
- [ ] Start blocks verified via block explorer
- [ ] ABIs collected and added to `abis/` directory
- [ ] `src/data.ts` created with typed exports
- [ ] Research documented in a markdown file for reference

## Open Questions

- [ ] Are all handlers deployed on all chains?
- [ ] Are there multiple versions of ComposableCoW?
- [ ] What are the official deployment blocks (first event vs contract creation)?

## References

- PoC: `/Users/jefferson/Projects/Bleu/cow/reference_repos/cow-programmatic-orders-indexer/ponder.config.ts`
- composable-cow repo: https://github.com/cowprotocol/composable-cow
- Project References: `thoughts/reference_docs/project_references.md`
- Sprint Plan S1.2: `thoughts/plans/sprint_plan.md`
