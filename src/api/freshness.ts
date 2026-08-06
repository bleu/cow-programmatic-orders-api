import { ACTIVE_CHAINS } from "../chains";
import type { ChainConfig } from "../chains/types";

/**
 * How far the newest synced block may fall behind wall-clock before a chain is
 * considered stalled. Generous by default: the live block handlers
 * (OrderDiscoveryPoller, CandidateConfirmer, …) each add seconds of latency per
 * firing, so normal operation already lags tens of seconds behind the tip.
 */
export const DEFAULT_MAX_LAG_SECONDS = 300;

/** Resolve the staleness budget for a chain: per-chain env, then global env, then default. */
export function maxLagSecondsFor(chainId: number): number {
  for (const raw of [
    process.env[`READINESS_MAX_LAG_SECONDS_${chainId}`],
    process.env.READINESS_MAX_LAG_SECONDS,
  ]) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_MAX_LAG_SECONDS;
}

export type StaleChain = {
  chain: string;
  /** Newest synced block number, or null when the chain reports no block at all. */
  blockNumber: number | null;
  /** Seconds between that block's timestamp and now, or null when unknown. */
  lagSeconds: number | null;
  maxLagSeconds: number;
};

/**
 * Compare each active chain's newest synced block against wall-clock time.
 *
 * Wall-clock rather than a fresh `eth_blockNumber` call on purpose: a readiness
 * probe that depends on the RPC turns an RPC outage into a restart loop, and the
 * block timestamp already carries everything needed to spot a stalled sync.
 * The trade-off is that a genuine chain halt reads as staleness here.
 *
 * A chain missing from the metrics counts as stale — absent data is not evidence
 * of freshness.
 */
export function findStaleChains(
  blockTimestamps: Map<string, number>,
  blockNumbers: Map<string, number>,
  nowSeconds: number,
  chains: ChainConfig[] = ACTIVE_CHAINS,
): StaleChain[] {
  const stale: StaleChain[] = [];

  for (const chain of chains) {
    const maxLagSeconds = maxLagSecondsFor(chain.chainId);
    const blockNumber = blockNumbers.get(chain.name) ?? null;
    const timestamp = blockTimestamps.get(chain.name);

    if (timestamp === undefined || timestamp <= 0) {
      stale.push({ chain: chain.name, blockNumber, lagSeconds: null, maxLagSeconds });
      continue;
    }

    const lagSeconds = Math.round(nowSeconds - timestamp);
    if (lagSeconds > maxLagSeconds) {
      stale.push({ chain: chain.name, blockNumber, lagSeconds, maxLagSeconds });
    }
  }

  return stale;
}

/** One-line, operator-readable summary of why the probe failed. */
export function describeStaleChains(stale: StaleChain[]): string {
  const parts = stale.map((s) =>
    s.lagSeconds === null
      ? `${s.chain}: no synced block reported`
      : `${s.chain}: block ${s.blockNumber ?? "?"} is ${s.lagSeconds}s old (max ${s.maxLagSeconds}s)`,
  );
  return `Chain sync is stalled — ${parts.join("; ")}.`;
}
