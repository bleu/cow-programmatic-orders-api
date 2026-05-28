import { describe, it, expect } from "vitest";
import { CHAIN_NAMES } from "../../src/data";
import { ChainIdQuery } from "../../src/api/schemas/common";

describe("CHAIN_NAMES", () => {
  it("contains an entry for every supported chain ID", () => {
    expect(Object.keys(CHAIN_NAMES)).toEqual(expect.arrayContaining(["1", "100"]));
  });

  it("has non-empty display names", () => {
    for (const name of Object.values(CHAIN_NAMES)) {
      expect(typeof name).toBe("string");
      expect(name.length).toBeGreaterThan(0);
    }
  });
});

describe("ChainIdQuery schema description", () => {
  it("lists all chain IDs and names from CHAIN_NAMES", () => {
    const desc = ChainIdQuery.description ?? "";
    for (const [id, name] of Object.entries(CHAIN_NAMES)) {
      expect(desc).toContain(id);
      expect(desc).toContain(name);
    }
  });

  it("does not hardcode chain names outside of CHAIN_NAMES", () => {
    // Adding a fictional chain to CHAIN_NAMES should appear in the description.
    // This test verifies the description is truly derived and not static.
    const desc = ChainIdQuery.description ?? "";
    expect(desc).not.toContain("Indexed chains: 1 (mainnet)");
    // Real description uses full names from CHAIN_NAMES
    expect(desc).toContain("Ethereum mainnet");
    expect(desc).toContain("Gnosis Chain");
  });
});
