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
    // One PollResultPoller entry per chain — fires every block to check due orders via
    // getTradeableOrderWithSignature. Replaces the old RemovalPoller (singleOrders check).
    // To add a new chain: copy this pattern and register a handler in blockHandler.ts.
    PollResultPollerMainnet: {
      chain: "mainnet",
      startBlock: COMPOSABLE_COW_DEPLOYMENTS.mainnet.startBlock,
      interval: 1,
    },
    PollResultPollerGnosis: {
      chain: "gnosis",
      startBlock: COMPOSABLE_COW_DEPLOYMENTS.gnosis.startBlock,
      interval: 1,
    },
  },
});
