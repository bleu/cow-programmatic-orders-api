import { createConfig } from "ponder";
import { ACTIVE_CHAINS } from "./src/chains";
import { pollerInterval } from "./src/chains/types";
import { ComposableCowAbi } from "./abis/ComposableCowAbi";
import { CoWShedFactoryAbi } from "./abis/CoWShedFactoryAbi";
import { GPv2SettlementAbi } from "./abis/GPv2SettlementAbi";

// Build chain entries: { mainnet: { id: 1, rpc: "..." }, gnosis: { id: 100, rpc: "..." }, ... }
const chains = Object.fromEntries(
  ACTIVE_CHAINS.map((c) => [
    c.name,
    {
      id: c.chainId,
      rpc: process.env[c.rpcEnvVar]!,
      // Many RPC providers cap eth_getLogs at 1000–2000 blocks; set conservatively to avoid
      // InvalidInputRpcError retry storms during backfill. Override via ETH_GET_LOGS_BLOCK_RANGE_<chainId>.
      ethGetLogsBlockRange: Number(process.env[`ETH_GET_LOGS_BLOCK_RANGE_${c.chainId}`] ?? 1000),
    },
  ]),
);

const cowShedChains = ACTIVE_CHAINS.filter((c) => c.cowShedFactory !== null);
const settlementChains = ACTIVE_CHAINS.filter(
  (c) => c.gpv2Settlement !== null && c.flashLoanRouter !== null,
);

export default createConfig({
  chains,
  contracts: {
    ComposableCow: {
      abi: ComposableCowAbi,
      chain: Object.fromEntries(
        ACTIVE_CHAINS.map((c) => [
          c.name,
          { address: c.composableCow.address, startBlock: c.composableCow.startBlock },
        ]),
      ),
    },
    ComposableCowLive: {
      abi: ComposableCowAbi,
      chain: Object.fromEntries(
        ACTIVE_CHAINS.map((c) => [
          c.name,
          { address: c.composableCowLive.address, startBlock: "latest" as const },
        ]),
      ),
    },
    CoWShedFactory: {
      abi: CoWShedFactoryAbi,
      chain: Object.fromEntries(
        cowShedChains.map((c) => [
          c.name,
          { address: c.cowShedFactory!.address, startBlock: c.cowShedFactory!.startBlock },
        ]),
      ),
    },
    GPv2Settlement: {
      abi: GPv2SettlementAbi,
      chain: Object.fromEntries(
        settlementChains.map((c) => [
          c.name,
          {
            address: c.gpv2Settlement!.address,
            startBlock: c.gpv2Settlement!.startBlock,
            filter: {
              event: "Settlement" as const,
              args: { solver: c.flashLoanRouter! },
            },
          },
        ]),
      ),
    },
  },
  blocks: {
    // Block handler intervals use coprime prime numbers per chain so handlers
    // naturally spread across different blocks and rarely all fire together.
    // On gnosis (5s blocks) stacking all handlers on the same block causes
    // ~35s combined execution — longer than the 5s block time, making the
    // indexer drift behind the chain tip. With coprime intervals the four
    // handlers all coincide only every LCM(3,5,7,11)=1155 blocks (~96 min).
    //
    // Gnosis intervals: OrderDiscoveryPoller=7, CandidateConfirmer=6,
    //   OrderStatusTracker=5, CancellationWatcher=11.
    // Mainnet (12s blocks): all interval=1 — handlers comfortably fit within 12s.

    // OrderDiscoveryPoller — RPC multicall for non-deterministic generators.
    OrderDiscoveryPoller: {
      chain: Object.fromEntries(
        ACTIVE_CHAINS.map((c) => [
          c.name,
          {
            startBlock: "latest" as const,
            ...(c.blockTime < 8 ? { interval: 7 } : {}),
          },
        ]),
      ),
      interval: 1,
    },
    // CandidateConfirmer — checks API for unconfirmed candidates.
    CandidateConfirmer: {
      chain: Object.fromEntries(
        ACTIVE_CHAINS.map((c) => [
          c.name,
          {
            startBlock: "latest" as const,
            ...(c.blockTime < 8 ? { interval: 6 } : {}),
          },
        ]),
      ),
      interval: 1,
    },
    // OrderStatusTracker — polls API for open discrete order status.
    OrderStatusTracker: {
      chain: Object.fromEntries(
        ACTIVE_CHAINS.map((c) => [
          c.name,
          {
            startBlock: "latest" as const,
            ...(c.blockTime < 8 ? { interval: 5 } : {}),
          },
        ]),
      ),
      interval: 1,
    },
    // OwnerBackfill — one-time owner fetch for non-deterministic backfill orders.
    OwnerBackfill: {
      chain: Object.fromEntries(
        ACTIVE_CHAINS.map((c) => [
          c.name,
          { startBlock: "latest" as const, endBlock: "latest" as const },
        ]),
      ),
      interval: 1,
    },
    // CancellationWatcher — singleOrders() mapping read for deterministic generators
    // (allCandidatesKnown=true). Cadence per generator is DETERMINISTIC_CANCEL_SWEEP_INTERVAL
    // blocks; the handler itself is cheap when nothing is due.
    CancellationWatcher: {
      chain: Object.fromEntries(
        ACTIVE_CHAINS.map((c) => [
          c.name,
          {
            startBlock: "latest" as const,
            ...(c.blockTime < 8 ? { interval: 11 } : {}),
          },
        ]),
      ),
      interval: 1,
    },
  },
});
