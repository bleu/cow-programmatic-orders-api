import type { RouteHandler } from "@hono/zod-openapi";
import type { syncProgressRoute } from "../routes";
import { fetchMetricLines, parsePrometheusGauge } from "../prometheus";

export const syncProgressHandler: RouteHandler<typeof syncProgressRoute> =
  async (c) => {
    // Resolve /metrics relative to the current request so this works on any port.
    const lines = await fetchMetricLines(new URL(c.req.url).origin);

    const total = parsePrometheusGauge(lines, "ponder_historical_total_blocks");
    const completed = parsePrometheusGauge(
      lines,
      "ponder_historical_completed_blocks",
    );
    const cached = parsePrometheusGauge(
      lines,
      "ponder_historical_cached_blocks",
    );
    const isRealtime = parsePrometheusGauge(lines, "ponder_sync_is_realtime");
    const isComplete = parsePrometheusGauge(lines, "ponder_sync_is_complete");

    const chains = new Set([
      ...total.keys(),
      ...completed.keys(),
      ...cached.keys(),
    ]);

    const result: Record<
      string,
      {
        totalBlocks: number;
        processedBlocks: number;
        historicalBlocksFetchedPct: number;
        isRealtime: boolean;
        isComplete: boolean;
      }
    > = {};

    for (const chain of chains) {
      const t = total.get(chain) ?? 0;
      const c_ = completed.get(chain) ?? 0;
      const ca = cached.get(chain) ?? 0;
      const processed = c_ + ca;
      const pct = t > 0 ? Math.round((processed / t) * 1000) / 10 : 100;

      result[chain] = {
        totalBlocks: t,
        processedBlocks: processed,
        historicalBlocksFetchedPct: pct,
        isRealtime: (isRealtime.get(chain) ?? 0) === 1,
        // ponder_sync_is_complete never reaches 1 for chains with live block handlers
        // (OrderDiscoveryPoller, CandidateConfirmer, OrderStatusTracker, OwnerBackfill, CancellationWatcher run indefinitely). Derive locally: synced means realtime + all blocks processed.
        isComplete: (isRealtime.get(chain) ?? 0) === 1 && pct >= 100,
      };
    }

    return c.json(result, 200);
  };
