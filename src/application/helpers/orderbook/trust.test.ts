import { describe, it, expect } from "vitest";
import { classifyCachedRow } from "./trust";
import { CACHE_VERSION } from "../../../constants";

const NOW = 1_800_000_000; // arbitrary wall-clock seconds
const W = 1200; // 20-minute reorg safety window

describe("classifyCachedRow", () => {
  it("trusts a terminal row whose validTo passed more than the window ago", () => {
    // The backfill case: an order that expired/filled ages ago. No fill can
    // happen after validTo, so the terminal status is final — no re-fetching.
    const trust = classifyCachedRow(
      {
        status: "fulfilled",
        validTo: NOW - 10 * W,
        terminalSince: NOW, // just cached — must not matter on the fast path
        fetchedAt: NOW,
        cacheVersion: CACHE_VERSION,
      },
      NOW,
      W,
    );
    expect(trust).toBe("trusted");
  });

  it("trusts a far-future-validTo row once a fetch re-confirmed it more than W after first seen", () => {
    // A long-dated order that filled recently: validTo can't prove anything,
    // but the status was still "fulfilled" when fetched > W after we first saw
    // it — the settlement survived a full reorg window of real time.
    const trust = classifyCachedRow(
      {
        status: "fulfilled",
        validTo: NOW + 365 * 24 * 3600,
        terminalSince: NOW - 2 * W,
        fetchedAt: NOW - 2 * W + (W + 1),
        cacheVersion: CACHE_VERSION,
      },
      NOW,
      W,
    );
    expect(trust).toBe("trusted");
  });

  it("keeps a freshly-terminal row soft until the cooling-off fetch happens", () => {
    // Just saw it go terminal, and the only fetch is the one that discovered
    // it. A reorg could still take the settlement back — keep re-fetching.
    const trust = classifyCachedRow(
      {
        status: "fulfilled",
        validTo: NOW + 3600,
        terminalSince: NOW - 60,
        fetchedAt: NOW - 60,
        cacheVersion: CACHE_VERSION,
      },
      NOW,
      W,
    );
    expect(trust).toBe("soft");
  });

  it("treats a stale-version row as soft even when it is otherwise final", () => {
    // Healing (COW-1183 gap 1): rows cached before a column existed must be
    // re-fetched once, no matter how old the order is.
    const trust = classifyCachedRow(
      {
        status: "fulfilled",
        validTo: NOW - 10 * W,
        terminalSince: NOW - 10 * W,
        fetchedAt: NOW - 5 * W,
        cacheVersion: CACHE_VERSION - 1,
      },
      NOW,
      W,
    );
    expect(trust).toBe("soft");
  });

  it("classifies a non-terminal status as not-terminal (plain miss)", () => {
    const trust = classifyCachedRow(
      { status: "open", validTo: NOW - 10 * W, terminalSince: null, fetchedAt: NOW, cacheVersion: CACHE_VERSION },
      NOW,
      W,
    );
    expect(trust).toBe("not-terminal");
  });

  it("keeps a row soft when terminal_since is missing and validTo can't prove finality", () => {
    // Rows written by paths that never observed the transition (or migrated
    // rows) have no cooling-off anchor — they stay soft until validTo ages out
    // or a re-fetch stamps terminal_since and the window passes.
    const trust = classifyCachedRow(
      { status: "cancelled", validTo: NOW + 3600, terminalSince: null, fetchedAt: NOW, cacheVersion: CACHE_VERSION },
      NOW,
      W,
    );
    expect(trust).toBe("soft");
  });

  it("is strict at the window boundary — exactly W is not enough", () => {
    expect(
      classifyCachedRow(
        { status: "fulfilled", validTo: NOW - W, terminalSince: null, fetchedAt: NOW, cacheVersion: CACHE_VERSION },
        NOW,
        W,
      ),
    ).toBe("soft");
    expect(
      classifyCachedRow(
        { status: "fulfilled", validTo: NOW + 3600, terminalSince: NOW - 2 * W, fetchedAt: NOW - W, cacheVersion: CACHE_VERSION },
        NOW,
        W,
      ),
    ).toBe("soft");
  });
});
