import { createConfig } from "ponder";
import {
  ComposableCowContract,
  COMPOSABLE_COW_DEPLOYMENTS,
  CoWShedFactoryContract,
  FLASH_LOAN_ROUTER_ADDRESSES,
  GPv2SettlementContract,
  GPv2SettlementTradeContract,
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
    // Separate entry for Trade events — starts at "latest" (live sync only).
    // Historical fulfillment status comes from the Orderbook API.
    // The handler gates on owner membership to skip non-composable trades.
    GPv2SettlementTrade: {
      ...GPv2SettlementTradeContract,
      filter: { event: "Trade", args: {} },
    },
  },
  blocks: {
    RemovalPoller: {
      chain: "mainnet",
      startBlock: COMPOSABLE_COW_DEPLOYMENTS.mainnet.startBlock,
      // Ponder uses a single interval for both sync (backfill) and live — no separate "sync interval" vs "live interval".
      // 1000 blocks ≈ ~3.3 hours at 12s/block on mainnet.
      interval: 1000,
    },
  },
});
