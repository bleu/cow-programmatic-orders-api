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
      // Many RPC providers cap eth_getLogs at 1000–2000 blocks; set conservatively to avoid
      // InvalidInputRpcError retry storms during backfill. Override if your provider allows more.
      ethGetLogsBlockRange: 1000,
    },
    gnosis: {
      id: 100,
      rpc: process.env.GNOSIS_RPC_URL!,
      ethGetLogsBlockRange: 1000,
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
    // composableCow.OrderDiscoveryPoller — RPC multicall for non-deterministic generators.
    // Gnosis interval=4 (~20s) vs mainnet interval=1 (~12s).
    // The CoW watch-tower processes orders sequentially — with 1,461+ gnosis
    // generators, a full cycle takes many blocks. Polling every 5s gnosis block
    // wastes RPC calls since state rarely changes between blocks.
    "composableCow.OrderDiscoveryPoller": {
      chain: {
        mainnet: { startBlock: "latest" },
        gnosis: { startBlock: "latest", interval: 4 },
      },
      interval: 1,
    },
    // composableCow.CandidateConfirmer — checks API for unconfirmed candidates.
    "composableCow.CandidateConfirmer": {
      chain: {
        mainnet: { startBlock: "latest" },
        gnosis: { startBlock: "latest" },
      },
      interval: 1,
    },
    // composableCow.OrderStatusTracker — polls API for open discrete order status.
    "composableCow.OrderStatusTracker": {
      chain: {
        mainnet: { startBlock: "latest" },
        gnosis: { startBlock: "latest" },
      },
      interval: 1,
    },
    // composableCow.OwnerBackfill — one-time owner fetch for non-deterministic backfill orders.
    "composableCow.OwnerBackfill": {
      chain: {
        mainnet: { startBlock: "latest", endBlock: "latest" },
        gnosis: { startBlock: "latest", endBlock: "latest" },
      },
      interval: 1,
    },
    // composableCow.CancellationWatcher — singleOrders() mapping read for deterministic
    // generators (allCandidatesKnown=true). Cadence per generator is
    // DETERMINISTIC_CANCEL_SWEEP_INTERVAL blocks; the handler itself is cheap when nothing is due.
    "composableCow.CancellationWatcher": {
      chain: {
        mainnet: { startBlock: "latest" },
        gnosis: { startBlock: "latest" },
      },
      interval: 1,
    },
  },
});
