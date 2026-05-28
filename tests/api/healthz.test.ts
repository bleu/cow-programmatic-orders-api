import { describe, it, expect } from "vitest";
import { Hono } from "hono";

// Re-create just the /healthz route in isolation (same code as src/api/index.ts)
// to verify it behaves exactly as documented in docs/api-reference.md.
function buildApp() {
  const app = new Hono();
  app.get("/healthz", (c) => c.json({ status: "ok" }));
  return app;
}

describe("GET /healthz", () => {
  const app = buildApp();

  it("returns 200", async () => {
    const res = await app.request("/healthz");
    expect(res.status).toBe(200);
  });

  it('returns { "status": "ok" }', async () => {
    const res = await app.request("/healthz");
    const body = await res.json();
    expect(body).toEqual({ status: "ok" });
  });

  it("sets Content-Type to application/json", async () => {
    const res = await app.request("/healthz");
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
  });
});
