import { createConfig } from "ponder";
import {
  ComposableCowContract,
  CoWShedFactoryContract,
  FLASH_LOAN_ROUTER_ADDRESSES,
  GPv2SettlementContract,
  GPv2SettlementTradeContract,
  ORDERBOOK_POLL_INTERVAL,
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
    // Fires every ORDERBOOK_POLL_INTERVAL blocks on each chain to check due orders
    // via getTradeableOrderWithSignature. Starts at "latest" because the block handler
    // only runs at live sync (backfill is skipped via LIVE_LAG_THRESHOLD_SECONDS).
    // To add a new chain: add it here and in src/data.ts.
    PollResultPoller: {
      chain: {
        mainnet: { startBlock: "latest" },
        gnosis: { startBlock: "latest" },
      },
      interval: ORDERBOOK_POLL_INTERVAL,
    },
  },
});
