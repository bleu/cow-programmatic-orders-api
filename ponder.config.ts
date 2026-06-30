import { createConfig } from "ponder";
import { ACTIVE_CHAINS } from "./src/chains";
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
      // Optional WS endpoint for realtime eth_subscribe newHeads (more efficient than HTTP
      // polling). Built only when declared AND set; otherwise omitted → HTTP-only, no error.
      ...(c.wsRpcEnvVar && process.env[c.wsRpcEnvVar]
        ? { ws: process.env[c.wsRpcEnvVar] }
        : {}),
      // Many RPC providers cap eth_getLogs at 1000–2000 blocks; set conservatively to avoid
      // InvalidInputRpcError retry storms during backfill. Override via ETH_GET_LOGS_BLOCK_RANGE_<chainId>.
      ethGetLogsBlockRange: Number(process.env[`ETH_GET_LOGS_BLOCK_RANGE_${c.chainId}`] ?? 1000),
    },
  ]),
);

const cowShedChains = ACTIVE_CHAINS.filter((c) => c.cowShedFactory !== null);
const settlementChains = ACTIVE_CHAINS.filter(
  (c) => c.gpv2Settlement !== null && c.flashLoan !== null,
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
              args: { solver: c.flashLoan!.router },
            },
          },
        ]),
      ),
    },
  },
  blocks: {
    // Block handler intervals are tuned per chain to keep total handler time
    // well within the available window while reducing unnecessary invocations.
    //
    // Gnosis  (5s blocks, interval=10): 10×5s=50s window, ~33s combined → 66% utilization
    // Mainnet (12s blocks, interval=4):  4×12s=48s window, ~22s combined → 46% utilization
    //
    // All handlers fire together on the same block every interval blocks.
    // Simpler and more efficient than coprime staggering.

    // OrderDiscoveryPoller — RPC multicall for non-deterministic generators.
    OrderDiscoveryPoller: {
      chain: Object.fromEntries(
        ACTIVE_CHAINS.map((c) => [
          c.name,
          { startBlock: "latest" as const, interval: c.blockTime < 8 ? 10 : 4 },
        ]),
      ),
      interval: 1,
    },
    // CandidateConfirmer — checks API for unconfirmed candidates.
    CandidateConfirmer: {
      chain: Object.fromEntries(
        ACTIVE_CHAINS.map((c) => [
          c.name,
          { startBlock: "latest" as const, interval: c.blockTime < 8 ? 10 : 4 },
        ]),
      ),
      interval: 1,
    },
    // OrderStatusTracker — polls API for open discrete order status.
    OrderStatusTracker: {
      chain: Object.fromEntries(
        ACTIVE_CHAINS.map((c) => [
          c.name,
          { startBlock: "latest" as const, interval: c.blockTime < 8 ? 10 : 4 },
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
            interval: c.blockTime < 8 ? 10 : 4,
          },
        ]),
      ),
      interval: 1,
    },
  },
});
