import { createConfig } from "ponder";
import { ACTIVE_CHAINS } from "./src/chains";
import { pollerInterval } from "./src/chains/types";
import { ComposableCowAbi } from "./abis/ComposableCowAbi";
import { CoWShedFactoryAbi } from "./abis/CoWShedFactoryAbi";
import { GPv2SettlementAbi } from "./abis/GPv2SettlementAbi";

// Build chain entries: { mainnet: { id: 1, rpc: "..." }, gnosis: { id: 100, rpc: "..." }, ... }
const chains = Object.fromEntries(
  ACTIVE_CHAINS.map((c) => [c.name, { id: c.chainId, rpc: process.env[c.rpcEnvVar]! }]),
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
    // C1: Contract Poller — RPC multicall for non-deterministic generators
    // Gnosis interval=4 (~20s) vs mainnet interval=1 (~12s).
    // The CoW watch-tower processes orders sequentially — with 1,461+ gnosis
    // generators, a full cycle takes many blocks. Polling every 5s gnosis block
    // wastes RPC calls since state rarely changes between blocks.
    ContractPoller: {
      chain: Object.fromEntries(
        ACTIVE_CHAINS.map((c) => [
          c.name,
          {
            startBlock: "latest" as const,
            ...(pollerInterval(c.blockTime) > 1 ? { interval: pollerInterval(c.blockTime) } : {}),
          },
        ]),
      ),
      interval: 1,
    },
    // C2: Candidate Confirmer — checks API for unconfirmed candidates
    CandidateConfirmer: {
      chain: Object.fromEntries(
        ACTIVE_CHAINS.map((c) => [c.name, { startBlock: "latest" as const }]),
      ),
      interval: 1,
    },
    // C3: Status Updater — polls API for open discrete order status
    StatusUpdater: {
      chain: Object.fromEntries(
        ACTIVE_CHAINS.map((c) => [c.name, { startBlock: "latest" as const }]),
      ),
      interval: 1,
    },
    // C4: Historical Bootstrap — one-time owner fetch for non-deterministic backfill orders
    HistoricalBootstrap: {
      chain: Object.fromEntries(
        ACTIVE_CHAINS.map((c) => [
          c.name,
          { startBlock: "latest" as const, endBlock: "latest" as const },
        ]),
      ),
      interval: 1,
    },
    // C5: Deterministic Cancellation Sweeper — singleOrders() mapping read for
    // generators C1 skips (allCandidatesKnown=true). Cadence per generator is
    // DETERMINISTIC_CANCEL_SWEEP_INTERVAL blocks; the handler itself is cheap
    // when nothing is due.
    DeterministicCancellationSweeper: {
      chain: Object.fromEntries(
        ACTIVE_CHAINS.map((c) => [c.name, { startBlock: "latest" as const }]),
      ),
      interval: 1,
    },
    // SettlementResolver — async Aave adapter discovery from queued Settlement events.
    // Only runs on chains that have a flash loan router (currently mainnet only).
    SettlementResolver: {
      chain: Object.fromEntries(
        settlementChains.map((c) => [c.name, { startBlock: "latest" as const }]),
      ),
      interval: 1,
    },
  },
});
