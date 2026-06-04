import { describe, it, expect, beforeEach, vi } from "vitest";
import { OpenAPIHono } from "@hono/zod-openapi";
import { z } from "zod";

// Mock virtual modules before any ponder-importing source files are loaded.
vi.mock("ponder:api", () => ({ db: { execute: vi.fn() } }));
vi.mock("ponder", () => ({
  sql: Object.assign(
    (_s: TemplateStringsArray, ..._v: unknown[]) => ({}),
    { raw: (_s: string) => ({}) },
  ),
}));

import { db } from "ponder:api";
import { executionSummaryRoute } from "../../src/api/routes";
import { executionSummaryHandler } from "../../src/api/endpoints/execution-summary";
import { DiscreteOrderStatusQuery } from "../../src/api/schemas/common";

type StatusRow = { status: z.infer<typeof DiscreteOrderStatusQuery>; count: string };

function buildApp() {
  const app = new OpenAPIHono();
  app.openapi(executionSummaryRoute, executionSummaryHandler);
  return app;
}

const EVENT_ID = "177991282000000000000001000000000046395020000000000000001750000000000000054";

function makeUrl(eventId = EVENT_ID, chainId = 1) {
  return `http://localhost/generator/${eventId}/execution-summary?chainId=${chainId}`;
}

beforeEach(() => {
  vi.mocked(db.execute).mockReset();
});

describe("GET /api/generator/:eventId/execution-summary", () => {
  it("returns all-zero counts when no discrete orders exist", async () => {
    vi.mocked(db.execute).mockResolvedValue({ rows: [] } as never);

    const res = await buildApp().request(makeUrl());
    expect(res.status).toBe(200);

    const body = await res.json() as Record<string, unknown>;
    expect(body["totalParts"]).toBe(0);
    expect(body["filledParts"]).toBe(0);
    expect(body["openParts"]).toBe(0);
    expect(body["unfilledParts"]).toBe(0);
    expect(body["expiredParts"]).toBe(0);
    expect(body["cancelledParts"]).toBe(0);
  });

  it("maps fulfilled, expired, open, unfilled, cancelled to the right fields", async () => {
    const rows: StatusRow[] = [
      { status: "fulfilled", count: "3" },
      { status: "expired",   count: "7" },
      { status: "open",      count: "2" },
    ];
    vi.mocked(db.execute).mockResolvedValue({ rows } as never);

    const body = await (await buildApp().request(makeUrl())).json() as Record<string, unknown>;

    expect(body["filledParts"]).toBe(3);
    expect(body["expiredParts"]).toBe(7);
    expect(body["openParts"]).toBe(2);
    expect(body["unfilledParts"]).toBe(0);
    expect(body["cancelledParts"]).toBe(0);
    expect(body["totalParts"]).toBe(12);
  });

  it("totalParts is the sum of all status counts", async () => {
    const rows: StatusRow[] = [
      { status: "fulfilled",  count: "10" },
      { status: "cancelled",  count: "5" },
      { status: "unfilled",   count: "3" },
    ];
    vi.mocked(db.execute).mockResolvedValue({ rows } as never);

    const body = await (await buildApp().request(makeUrl())).json() as Record<string, unknown>;
    expect(body["totalParts"]).toBe(18);
  });

  it("echoes back the generatorId and chainId", async () => {
    vi.mocked(db.execute).mockResolvedValue({ rows: [] } as never);

    const body = await (await buildApp().request(makeUrl(EVENT_ID, 100))).json() as Record<string, unknown>;
    expect(body["generatorId"]).toBe(EVENT_ID);
    expect(body["chainId"]).toBe(100);
  });

  it("returns 400 when chainId query param is missing", async () => {
    const app = buildApp();
    const res = await app.request(
      `http://localhost/generator/${EVENT_ID}/execution-summary`,
    );
    expect(res.status).toBe(400);
  });

  it("returns 500 when the DB throws", async () => {
    vi.mocked(db.execute).mockRejectedValueOnce(new Error("db error"));

    const res = await buildApp().request(makeUrl());
    expect(res.status).toBe(500);
  });
});
