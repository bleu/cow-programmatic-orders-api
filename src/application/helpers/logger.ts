// Structured JSON logger for handler code — always emits one JSON line per call regardless of Ponder's --log-format setting.

type LogLevel = "info" | "warn" | "error";

export function log(
  level: LogLevel,
  msg: string,
  fields: Record<string, unknown> = {},
): void {
  const line = JSON.stringify({ time: Date.now(), level, msg, ...fields });
  if (level === "warn" || level === "error") {
    console.error(line);
  } else {
    console.log(line);
  }
}
