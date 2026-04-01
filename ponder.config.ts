import { createConfig } from "ponder";
import {
  ComposableCowContract,
  COMPOSABLE_COW_DEPLOYMENTS,
  CoWShedFactoryContract,
  FLASH_LOAN_ROUTER_ADDRESSES,
  GPv2SettlementContract,
} from "./src/data";

// Orderbook polling interval in blocks.
// ~20 blocks ≈ 4 min on mainnet (12s/block), ~2 min on Gnosis (5s/block).
// Add a matching entry here whenever a new chain is added to the indexer.
const ORDERBOOK_POLL_INTERVAL = 20;

export default createConfig({
  chains: {
    mainnet: {
      id: 1,
      rpc: process.env.MAINNET_RPC_URL!,
    },
    gnosis: {
      id: 100,
      rpc: process.env.GNOSIS_RPC_URL!,
    },
  },
  contracts: {
    ComposableCow: ComposableCowContract,
    CoWShedFactory: CoWShedFactoryContract,
    GPv2Settlement: {
      ...GPv2SettlementContract,
      filter: {
        event: "Settlement",
        args: { solver: FLASH_LOAN_ROUTER_ADDRESSES.mainnet },
      },
    },
  },
  blocks: {
    RemovalPoller: {
      chain: "mainnet",
      startBlock: COMPOSABLE_COW_DEPLOYMENTS.mainnet.startBlock,
      // Ponder uses a single interval for both sync (backfill) and live — no separate "sync interval" vs "live interval".
      // 100 blocks ≈ ~20 min at 12s/block on mainnet. Use 500 for faster sync and ~10 min live if preferred.
      // interval: 1000,
      interval: 1000,
    },
    // One OrderbookPoller entry per chain. Each fires the same handler function.
    // To add a new chain: copy this pattern and set startBlock to the ComposableCoW
    // deployment block for that chain (so we don't poll before any orders exist).
    OrderbookPollerMainnet: {
      chain: "mainnet",
      startBlock: COMPOSABLE_COW_DEPLOYMENTS.mainnet.startBlock,
      interval: ORDERBOOK_POLL_INTERVAL,
    },
    OrderbookPollerGnosis: {
      chain: "gnosis",
      startBlock: COMPOSABLE_COW_DEPLOYMENTS.gnosis.startBlock,
      interval: ORDERBOOK_POLL_INTERVAL,
    },
  },
});
