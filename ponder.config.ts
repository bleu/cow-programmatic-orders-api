import { createConfig } from "ponder";
import {
  ComposableCowContract,
  COMPOSABLE_COW_DEPLOYMENTS,
  CoWShedFactoryContract,
  FLASH_LOAN_ROUTER_ADDRESSES,
  GPv2SettlementContract,
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
    // C1: Contract Poller — RPC multicall for non-deterministic generators
    ContractPoller: {
      chain: {
        mainnet: { startBlock: "latest" },
        gnosis: { startBlock: "latest" },
      },
      interval: 1,
    },
    // C2: Candidate Confirmer — checks API for unconfirmed candidates
    CandidateConfirmer: {
      chain: {
        mainnet: { startBlock: "latest" },
        gnosis: { startBlock: "latest" },
      },
      interval: 1,
    },
    // C3: Status Updater — polls API for open discrete order status
    StatusUpdater: {
      chain: {
        mainnet: { startBlock: "latest" },
        gnosis: { startBlock: "latest" },
      },
      interval: 1,
    },
    // C4: Historical Bootstrap — one-time owner fetch for non-deterministic backfill orders
    HistoricalBootstrap: {
      chain: {
        mainnet: { startBlock: "latest", endBlock: "latest" },
        gnosis: { startBlock: "latest", endBlock: "latest" },
      },
      interval: 1,
    },
  },
});
