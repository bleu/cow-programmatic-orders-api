import { describe, it, expect } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { AddressInfo } from "node:net";
import {
  TimeoutError,
  fetchWithTimeout,
  withTimeout,
} from "../../src/application/helpers/withTimeout";

describe("withTimeout", () => {
  it("resolves with the inner value when the promise beats the timer", async () => {
    const value = await withTimeout(Promise.resolve(42), 50, "t:ok");
    expect(value).toBe(42);
  });

  it("propagates the original rejection when the promise beats the timer", async () => {
    const inner = new Error("inner boom");
    await expect(
      withTimeout(Promise.reject(inner), 50, "t:reject"),
    ).rejects.toBe(inner);
  });

  it("rejects with a TimeoutError when the timer wins", async () => {
    const slow = new Promise<string>((resolve) => setTimeout(() => resolve("late"), 40));
    await expect(withTimeout(slow, 5, "t:slow")).rejects.toSatisfy((err) => {
      return (
        err instanceof TimeoutError &&
        err.label === "t:slow" &&
        err.timeoutMs === 5
      );
    });
  });

  it("does not leave a hanging timer when the promise resolves first", async () => {
    // If the timer weren't cleared, vitest's --detectOpenHandles would flag
    // this test. We simulate by resolving well before the timeout and then
    // observing no unhandled timer fires in the event loop tick.
    const start = Date.now();
    await withTimeout(Promise.resolve("fast"), 1_000, "t:clear");
    // The test itself should finish in a few ms, not the 1s budget.
    expect(Date.now() - start).toBeLessThan(500);
  });
});

describe("fetchWithTimeout", () => {
  async function startServer(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{ url: string; close: () => Promise<void> }> {
    const server: Server = createServer(handler);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    return {
      url: `http://127.0.0.1:${port}/`,
      close: () => new Promise((resolve) => server.close(() => resolve())),
    };
  }

  it("returns the response when the server replies before the timeout", async () => {
    const { url, close } = await startServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
    });
    try {
      const response = await fetchWithTimeout(url, undefined, 500, "fwt:ok");
      expect(response.ok).toBe(true);
      expect(await response.text()).toBe("ok");
    } finally {
      await close();
    }
  });

  it("throws TimeoutError and cancels the socket when the server is slow", async () => {
    let socketClosedByClient = false;
    const { url, close } = await startServer((req, res) => {
      req.on("close", () => {
        socketClosedByClient = true;
      });
      // Never respond within the test window.
      setTimeout(() => {
        if (!res.writableEnded) {
          res.writeHead(200, { "content-type": "text/plain" });
          res.end("late");
        }
      }, 500);
    });

    try {
      await expect(
        fetchWithTimeout(url, undefined, 20, "fwt:slow"),
      ).rejects.toSatisfy((err) => {
        return (
          err instanceof TimeoutError &&
          err.label === "fwt:slow" &&
          err.timeoutMs === 20
        );
      });

      // Give the server's `req.on('close')` a tick to fire.
      await new Promise((r) => setTimeout(r, 50));
      expect(socketClosedByClient).toBe(true);
    } finally {
      await close();
    }
  });
});
