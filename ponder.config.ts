import { createConfig } from "ponder";
import { ComposableCowContract } from "./src/data";

export default createConfig({
  chains: {
    mainnet: {
      id: 1,
      rpc: process.env.MAINNET_RPC_URL!,
    },
  },
  contracts: {
    ComposableCow: ComposableCowContract,
  },
});
