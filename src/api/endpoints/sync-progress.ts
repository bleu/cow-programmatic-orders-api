import type { RouteHandler } from "@hono/zod-openapi";
import type { syncProgressRoute } from "../routes";

// Prometheus text-format parser for a single gauge metric.
// Matches lines like: metric_name{label="value"} 123
const GAUGE_RE = /^(\w+)\{([^}]*)\}\s+([\d.]+)/;

function parsePrometheusGauge(
  lines: string[],
  metricName: string,
): Map<string, number> {
  const result = new Map<string, number>();
  for (const line of lines) {
    if (!line.startsWith(metricName + "{")) continue;
    const m = GAUGE_RE.exec(line);
    if (!m) continue;
    const labels = m[2] as string;
    const value = Number(m[3]);
    // Extract chain label value
    const chainMatch = /chain="([^"]+)"/.exec(labels);
    if (chainMatch) result.set(chainMatch[1] as string, value);
  }
  return result;
}

export const syncProgressHandler: RouteHandler<typeof syncProgressRoute> =
  async (c) => {
    // Resolve /metrics relative to the current request so this works on any port.
    const origin = new URL(c.req.url).origin;
    const metricsText = await fetch(`${origin}/metrics`)
      .then((r) => r.text())
      .catch(() => "");

    const lines = metricsText.split("\n");

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
        isComplete: (isComplete.get(chain) ?? 0) === 1,
      };
    }

    return c.json(result, 200);
  };
