import { describe, it, expect } from "vitest";
import {
  SIGNING_SCHEME_EIP1271,
  TRY_NEXT_BLOCK_WARMUP_THRESHOLD,
  TRY_NEXT_BLOCK_COOLDOWN_THRESHOLD,
  TRY_NEXT_BLOCK_BACKOFF_WARMUP,
  TRY_NEXT_BLOCK_BACKOFF_MID,
  TRY_NEXT_BLOCK_BACKOFF_COLD,
  DETERMINISTIC_CANCEL_SWEEP_INTERVAL,
  ORDERBOOK_HTTP_TIMEOUT_MS,
  BLOCK_HANDLER_RPC_TIMEOUT_MS,
  BOOTSTRAP_OWNER_FETCH_TIMEOUT_MS,
  DEFAULT_MAX_GENERATORS_PER_BLOCK,
  DEFAULT_MAX_DISCRETE_ORDERS_PER_BLOCK,
} from "../src/constants";

describe("DEFAULT_MAX_DISCRETE_ORDERS_PER_BLOCK", () => {
  it("is 200", () => {
    expect(DEFAULT_MAX_DISCRETE_ORDERS_PER_BLOCK).toBe(200);
  });

  it("is a positive integer", () => {
    expect(Number.isInteger(DEFAULT_MAX_DISCRETE_ORDERS_PER_BLOCK)).toBe(true);
    expect(DEFAULT_MAX_DISCRETE_ORDERS_PER_BLOCK).toBeGreaterThan(0);
  });
});

describe("DEFAULT_MAX_GENERATORS_PER_BLOCK", () => {
  it("is 200", () => {
    expect(DEFAULT_MAX_GENERATORS_PER_BLOCK).toBe(200);
  });
});

describe("SIGNING_SCHEME_EIP1271", () => {
  it('is the string "eip1271"', () => {
    expect(SIGNING_SCHEME_EIP1271).toBe("eip1271");
  });

  it('is not "erc1271" — the API uses eip1271 spelling', () => {
    expect(SIGNING_SCHEME_EIP1271).not.toBe("erc1271");
  });
});

describe("TryNextBlock backoff thresholds", () => {
  it("WARMUP_THRESHOLD is 50", () => {
    expect(TRY_NEXT_BLOCK_WARMUP_THRESHOLD).toBe(50);
  });

  it("COOLDOWN_THRESHOLD is 200", () => {
    expect(TRY_NEXT_BLOCK_COOLDOWN_THRESHOLD).toBe(200);
  });

  it("WARMUP < COOLDOWN — thresholds are ordered correctly", () => {
    expect(TRY_NEXT_BLOCK_WARMUP_THRESHOLD).toBeLessThan(
      TRY_NEXT_BLOCK_COOLDOWN_THRESHOLD,
    );
  });
});

describe("TryNextBlock backoff block offsets", () => {
  it("WARMUP backoff is 1 block", () => {
    expect(TRY_NEXT_BLOCK_BACKOFF_WARMUP).toBe(1n);
  });

  it("MID backoff is 10 blocks", () => {
    expect(TRY_NEXT_BLOCK_BACKOFF_MID).toBe(10n);
  });

  it("COLD backoff is 50 blocks", () => {
    expect(TRY_NEXT_BLOCK_BACKOFF_COLD).toBe(50n);
  });

  it("backoff levels are strictly increasing", () => {
    expect(TRY_NEXT_BLOCK_BACKOFF_WARMUP).toBeLessThan(
      TRY_NEXT_BLOCK_BACKOFF_MID,
    );
    expect(TRY_NEXT_BLOCK_BACKOFF_MID).toBeLessThan(
      TRY_NEXT_BLOCK_BACKOFF_COLD,
    );
  });

  it("all backoff values are bigints", () => {
    expect(typeof TRY_NEXT_BLOCK_BACKOFF_WARMUP).toBe("bigint");
    expect(typeof TRY_NEXT_BLOCK_BACKOFF_MID).toBe("bigint");
    expect(typeof TRY_NEXT_BLOCK_BACKOFF_COLD).toBe("bigint");
  });
});

describe("DETERMINISTIC_CANCEL_SWEEP_INTERVAL", () => {
  it("is 100n", () => {
    expect(DETERMINISTIC_CANCEL_SWEEP_INTERVAL).toBe(100n);
  });

  it("is a bigint", () => {
    expect(typeof DETERMINISTIC_CANCEL_SWEEP_INTERVAL).toBe("bigint");
  });
});

describe("Timeout constants", () => {
  it("ORDERBOOK_HTTP_TIMEOUT_MS is 10_000", () => {
    expect(ORDERBOOK_HTTP_TIMEOUT_MS).toBe(10_000);
  });

  it("BLOCK_HANDLER_RPC_TIMEOUT_MS is 15_000", () => {
    expect(BLOCK_HANDLER_RPC_TIMEOUT_MS).toBe(15_000);
  });

  it("BOOTSTRAP_OWNER_FETCH_TIMEOUT_MS is 30_000", () => {
    expect(BOOTSTRAP_OWNER_FETCH_TIMEOUT_MS).toBe(30_000);
  });

  it("RPC timeout is shorter than bootstrap timeout — boot has more slack", () => {
    expect(BLOCK_HANDLER_RPC_TIMEOUT_MS).toBeLessThan(
      BOOTSTRAP_OWNER_FETCH_TIMEOUT_MS,
    );
  });

  it("HTTP timeout is shorter than RPC timeout", () => {
    expect(ORDERBOOK_HTTP_TIMEOUT_MS).toBeLessThan(
      BLOCK_HANDLER_RPC_TIMEOUT_MS,
    );
  });
});
