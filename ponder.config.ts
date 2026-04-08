import { createConfig } from "ponder";
import {
  ComposableCowContract,
  COMPOSABLE_COW_DEPLOYMENTS,
  CoWShedFactoryContract,
  FLASH_LOAN_ROUTER_ADDRESSES,
  GPv2SettlementContract,
  ORDERBOOK_POLL_INTERVAL,
} from "./src/data";
import { ComposableCowAbi } from "./abis/ComposableCowAbi";

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
    ComposableCowLive: {
      abi: ComposableCowAbi,
      chain: {
        mainnet: { ...COMPOSABLE_COW_DEPLOYMENTS.mainnet, startBlock: "latest" },
        gnosis: { ...COMPOSABLE_COW_DEPLOYMENTS.gnosis, startBlock: "latest" },
      },
    },
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
    // Fires every ORDERBOOK_POLL_INTERVAL blocks on each chain to check due orders
    // via getTradeableOrderWithSignature. Starts at "latest" — only runs at live sync.
    PollResultPoller: {
      chain: {
        mainnet: { startBlock: "latest" },
        gnosis: { startBlock: "latest" },
      },
      interval: ORDERBOOK_POLL_INTERVAL,
    },
  },
});
