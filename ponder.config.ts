import { createConfig } from "ponder";
import {
  ComposableCowContract,
  COMPOSABLE_COW_DEPLOYMENTS,
  CoWShedFactoryContract,
  GPv2SettlementContract,
} from "./src/data";

export default createConfig({
  chains: {
    mainnet: {
      id: 1,
      rpc: process.env.MAINNET_RPC_URL!,
    },
  },
  contracts: {
    ComposableCow: ComposableCowContract,
    CoWShedFactory: CoWShedFactoryContract,
    GPv2Settlement: GPv2SettlementContract,
  },
  blocks: {
    RemovalPoller: {
      chain: "mainnet",
      startBlock: COMPOSABLE_COW_DEPLOYMENTS.mainnet.startBlock,
      interval: 100, // every ~20 min at 12s/block
    },
  },
});
