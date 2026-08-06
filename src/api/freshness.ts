import { ACTIVE_CHAINS } from "../chains";
import type { ChainConfig } from "../chains/types";

/**
 * How far the newest indexed block may fall behind wall-clock before a chain is
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

/** Ponder's /status payload, keyed by chain name. */
export type ChainStatus = Record<
  string,
  { id?: number; block?: { number?: number; timestamp?: number } | null } | null
>;

/**
 * Read the newest indexed block per chain from Ponder's /status.
 *
 * /status decodes the `_ponder_checkpoint` table, so it reflects committed
 * database state rather than the indexing process's memory. That matters for
 * two reasons: it stays correct if the API is ever run separately from the
 * indexer (`ponder serve`), and it avoids parsing the Prometheus text format.
 */
export async function fetchChainStatus(origin: string): Promise<ChainStatus> {
  try {
    const res = await fetch(`${origin}/status`);
    if (!res.ok) return {};
    return (await res.json()) as ChainStatus;
  } catch {
    return {};
  }
}

export type StaleChain = {
  chain: string;
  /** Newest indexed block number, or null when the chain reports no block at all. */
  blockNumber: number | null;
  /** Seconds between that block's timestamp and now, or null when unknown. */
  lagSeconds: number | null;
  maxLagSeconds: number;
};

/**
 * Compare each active chain's newest indexed block against wall-clock time.
 *
 * Wall-clock rather than a fresh `eth_blockNumber` call on purpose: a readiness
 * probe that depends on the RPC turns an RPC outage into a restart loop, and the
 * block timestamp already carries everything needed to spot a stalled sync.
 * The trade-off is that a genuine chain halt reads as staleness.
 *
 * A chain missing from the payload counts as stale — absent data is not evidence
 * of freshness.
 */
export function findStaleChains(
  status: ChainStatus,
  nowSeconds: number,
  chains: ChainConfig[] = ACTIVE_CHAINS,
): StaleChain[] {
  const stale: StaleChain[] = [];

  for (const chain of chains) {
    const maxLagSeconds = maxLagSecondsFor(chain.chainId);
    const block = status[chain.name]?.block;
    const blockNumber = typeof block?.number === "number" ? block.number : null;
    const timestamp = block?.timestamp;

    if (typeof timestamp !== "number" || timestamp <= 0) {
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
      ? `${s.chain}: no indexed block reported`
      : `${s.chain}: block ${s.blockNumber ?? "?"} is ${s.lagSeconds}s old (max ${s.maxLagSeconds}s)`,
  );
  return `Chain sync is stalled — ${parts.join("; ")}.`;
}
