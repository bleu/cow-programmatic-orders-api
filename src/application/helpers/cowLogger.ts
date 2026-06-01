/**
 * Structured JSON logger for handler code. Outputs one JSON line per call so
 * log aggregators (Datadog, CloudWatch, etc.) can filter by chainId, handler,
 * block number, or any other field without regex parsing.
 *
 * Ponder's own log lines are controlled by --log-format (pretty|json) on the
 * CLI. These handler lines are always JSON so they remain parseable regardless
 * of Ponder's format setting.
 */

type LogLevel = "info" | "warn" | "error";

export function cowLog(
  level: LogLevel,
  msg: string,
  fields: Record<string, unknown> = {},
): void {
  console.log(JSON.stringify({ time: Date.now(), level, msg, ...fields }));
}
