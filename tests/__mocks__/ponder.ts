// Stub for the `ponder` module — satisfies imports from orderbookClient.ts in vitest.
// The exported sql tag and helpers are no-ops; tests mock context.db.sql.execute directly.
export const and = (..._args: unknown[]) => ({});
export const eq = (..._args: unknown[]) => ({});
export const sql = Object.assign(
  (_strings: TemplateStringsArray, ..._values: unknown[]) => ({}),
  { raw: (_str: string) => ({}) },
);
