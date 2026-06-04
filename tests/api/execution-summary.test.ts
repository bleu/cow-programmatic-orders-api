import { describe, it, expect, beforeEach, vi } from "vitest";
import { OpenAPIHono } from "@hono/zod-openapi";
import { z } from "zod";

// Mock virtual modules before any ponder-importing source files are loaded.
vi.mock("ponder:api", () => ({ db: { select: vi.fn() } }));
vi.mock("ponder", () => ({
  and: (..._args: unknown[]) => ({}),
  eq: (..._args: unknown[]) => ({}),
  count: () => ({}),
}));
vi.mock("ponder:schema", () => ({
  discreteOrder: { status: "status", conditionalOrderGeneratorId: "conditionalOrderGeneratorId", chainId: "chainId" },
}));

import { db } from "ponder:api";
import { executionSummaryRoute } from "../../src/api/routes";
import { executionSummaryHandler } from "../../src/api/endpoints/execution-summary";
import { DiscreteOrderStatusQuery } from "../../src/api/schemas/common";

const Status = DiscreteOrderStatusQuery.enum;
type StatusRow = { status: z.infer<typeof DiscreteOrderStatusQuery>; count: number };

function buildApp() {
  const app = new OpenAPIHono();
  app.openapi(executionSummaryRoute, executionSummaryHandler);
  return app;
}

const EVENT_ID = "177991282000000000000001000000000046395020000000000000001750000000000000054";

function makeUrl(eventId = EVENT_ID, chainId = 1) {
  return `http://localhost/generator/${eventId}/execution-summary?chainId=${chainId}`;
}

function makeSelectChain(rows: unknown[] = []) {
  const groupBy = vi.fn().mockResolvedValue(rows);
  const where = vi.fn().mockReturnValue({ groupBy });
  const from = vi.fn().mockReturnValue({ where });
  return { from };
}

beforeEach(() => {
  vi.mocked(db.select).mockReset();
});

describe("GET /api/generator/:eventId/execution-summary", () => {
  it("returns all-zero counts when no discrete orders exist", async () => {
    vi.mocked(db.select).mockReturnValueOnce(makeSelectChain([]) as never);

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
      { status: Status.fulfilled, count: 3 },
      { status: Status.expired,   count: 7 },
      { status: Status.open,      count: 2 },
    ];
    vi.mocked(db.select).mockReturnValueOnce(makeSelectChain(rows) as never);

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
      { status: Status.fulfilled, count: 10 },
      { status: Status.cancelled, count: 5 },
      { status: Status.unfilled,  count: 3 },
    ];
    vi.mocked(db.select).mockReturnValueOnce(makeSelectChain(rows) as never);

    const body = await (await buildApp().request(makeUrl())).json() as Record<string, unknown>;
    expect(body["totalParts"]).toBe(18);
  });

  it("echoes back the generatorId and chainId", async () => {
    vi.mocked(db.select).mockReturnValueOnce(makeSelectChain([]) as never);

    const body = await (await buildApp().request(makeUrl(EVENT_ID, 100))).json() as Record<string, unknown>;
    expect(body["generatorId"]).toBe(EVENT_ID);
    expect(body["chainId"]).toBe(100);
  });

  it("returns 400 when chainId query param is missing", async () => {
    const res = await buildApp().request(
      `http://localhost/generator/${EVENT_ID}/execution-summary`,
    );
    expect(res.status).toBe(400);
  });

  it("returns 500 when the DB throws", async () => {
    const groupBy = vi.fn().mockRejectedValueOnce(new Error("db error"));
    const where = vi.fn().mockReturnValue({ groupBy });
    const from = vi.fn().mockReturnValue({ where });
    vi.mocked(db.select).mockReturnValueOnce({ from } as never);

    const res = await buildApp().request(makeUrl());
    expect(res.status).toBe(500);
  });
});
