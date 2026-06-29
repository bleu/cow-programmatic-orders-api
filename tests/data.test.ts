import { describe, it, expect } from "vitest";
import { SupportedChainId } from "@cowprotocol/cow-sdk";
import { RECHECK_INTERVAL_BLOCKS_BY_CHAIN_ID } from "../src/data";
import { ALL_DEFINED_CHAINS } from "../src/chains";

describe("RECHECK_INTERVAL_BLOCKS_BY_CHAIN_ID", () => {
  it("has a bigint entry for every defined chain", () => {
    for (const c of ALL_DEFINED_CHAINS) {
      const blocks = RECHECK_INTERVAL_BLOCKS_BY_CHAIN_ID[c.chainId];
      expect(typeof blocks).toBe("bigint");
      expect(blocks!).toBeGreaterThan(0n);
    }
  });

  it("preserves the prior 20-block cadence on every defined chain", () => {
    // Each chain's orderbookPollInterval is set to 20 * blockTime seconds, so the
    // derived per-chain block cadence must round-trip back to the former global of 20.
    for (const c of ALL_DEFINED_CHAINS) {
      expect(RECHECK_INTERVAL_BLOCKS_BY_CHAIN_ID[c.chainId]).toBe(20n);
    }
  });

  it("derives blocks as round(orderbookPollInterval / blockTime)", () => {
    for (const c of ALL_DEFINED_CHAINS) {
      const expected = BigInt(Math.max(1, Math.round(c.orderbookPollInterval / c.blockTime)));
      expect(RECHECK_INTERVAL_BLOCKS_BY_CHAIN_ID[c.chainId]).toBe(expected);
    }
  });

  it("omits chains skipped in the registry (null entries)", () => {
    expect(RECHECK_INTERVAL_BLOCKS_BY_CHAIN_ID[SupportedChainId.SEPOLIA]).toBeUndefined();
    expect(RECHECK_INTERVAL_BLOCKS_BY_CHAIN_ID[SupportedChainId.INK]).toBeUndefined();
    expect(RECHECK_INTERVAL_BLOCKS_BY_CHAIN_ID[SupportedChainId.LENS]).toBeUndefined();
  });
});
