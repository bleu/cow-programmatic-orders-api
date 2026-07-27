import { describe, it, expect } from "vitest";
import { ACTIVE_CHAINS } from "../src/chains";
import { REORG_SAFETY_WINDOW_SECONDS } from "../src/data";

describe("REORG_SAFETY_WINDOW_SECONDS", () => {
  it("has a window for every active chain", () => {
    for (const chain of ACTIVE_CHAINS) {
      expect(
        REORG_SAFETY_WINDOW_SECONDS[chain.chainId],
        `missing reorg safety window for ${chain.name}`,
      ).toBeDefined();
    }
  });

  it("windows are at least 60 seconds — anything shorter is inside normal reorg depth", () => {
    for (const chain of ACTIVE_CHAINS) {
      expect(
        REORG_SAFETY_WINDOW_SECONDS[chain.chainId]!,
        `window too small for ${chain.name}`,
      ).toBeGreaterThanOrEqual(60);
    }
  });

  it("mainnet window comfortably covers ~13min finality", () => {
    expect(REORG_SAFETY_WINDOW_SECONDS[1]!).toBeGreaterThanOrEqual(1200);
  });
});
