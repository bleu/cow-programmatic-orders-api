import { createConfig } from "ponder";
import {
  ComposableCowContract,
  COMPOSABLE_COW_DEPLOYMENTS,
  CoWShedFactoryContract,
  FLASH_LOAN_ROUTER_ADDRESSES,
  GPv2SettlementContract,
} from "./src/data";

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
  },
});
