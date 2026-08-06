// Prometheus text-format parser for a single gauge metric.
// Matches lines like: metric_name{label="value"} 123
const GAUGE_RE = /^(\w+)\{([^}]*)\}\s+([\d.]+)/;

/** Parse one gauge from Ponder's /metrics output into a map keyed by chain label. */
export function parsePrometheusGauge(
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
    const chainMatch = /chain="([^"]+)"/.exec(labels);
    if (chainMatch) result.set(chainMatch[1] as string, value);
  }
  return result;
}

/** Fetch Ponder's /metrics on the same origin and split it into lines. */
export async function fetchMetricLines(origin: string): Promise<string[]> {
  const text = await fetch(`${origin}/metrics`)
    .then((r) => r.text())
    .catch(() => "");
  return text.split("\n");
}
