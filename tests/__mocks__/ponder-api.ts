import { vi } from "vitest";

// Chainable select stub — each .select() call gets its own independent chain so
// tests can use mockReturnValueOnce to return different rows per query.
function makeSelectChain(rows: unknown[] = []) {
  const where = vi.fn().mockResolvedValue(rows);
  const from = vi.fn().mockReturnValue({ where });
  return { from };
}

export const db = {
  execute: vi.fn().mockResolvedValue({ rows: [] }),
  select: vi.fn().mockReturnValue(makeSelectChain()),
  /** Helper used by tests to program per-call return values. */
  __makeSelectChain: makeSelectChain,
};
