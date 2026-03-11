import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHttpApp, type HttpAppHandle } from "../src/http";
import type { Registry } from "@argent/registry";

function stubRegistry() {
  return {
    getSnapshot: vi.fn(() => ({ services: new Map(), namespaces: [], tools: [] })),
    getTool: vi.fn(() => undefined),
    invokeTool: vi.fn(),
  } as unknown as Registry;
}

describe("idle timeout", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires onIdle after configured timeout with no activity", () => {
    const onIdle = vi.fn();
    const handle = createHttpApp(stubRegistry(), {
      idleTimeoutMs: 5 * 60_000,
      onIdle,
    });

    vi.advanceTimersByTime(5 * 60_000);
    expect(onIdle).toHaveBeenCalledOnce();

    handle.dispose();
  });

  it("does NOT fire when activity keeps resetting the timer", async () => {
    const onIdle = vi.fn();
    const registry = stubRegistry();
    (registry.getTool as ReturnType<typeof vi.fn>).mockReturnValue({
      description: "test",
      inputSchema: {},
      services: () => ({}),
      execute: async () => ({ ok: true }),
    });
    (registry.invokeTool as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
    });

    const handle = createHttpApp(registry, {
      idleTimeoutMs: 5 * 60_000,
      onIdle,
    });

    const request = await import("supertest").then((m) => m.default);

    // Simulate activity every 3 minutes (well within the 5-min timeout)
    for (let i = 0; i < 4; i++) {
      vi.advanceTimersByTime(3 * 60_000);
      await request(handle.app)
        .post("/tools/test-tool")
        .send({})
        .expect(200);
    }

    expect(onIdle).not.toHaveBeenCalled();

    handle.dispose();
  });

  it("resets the timer on tool invocation", async () => {
    const onIdle = vi.fn();
    const registry = stubRegistry();
    (registry.getTool as ReturnType<typeof vi.fn>).mockReturnValue({
      description: "test",
      inputSchema: {},
      services: () => ({}),
      execute: async () => ({ ok: true }),
    });
    (registry.invokeTool as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
    });

    const handle = createHttpApp(registry, {
      idleTimeoutMs: 5 * 60_000,
      onIdle,
    });

    const request = await import("supertest").then((m) => m.default);

    // Advance 4 minutes (not enough to trigger)
    vi.advanceTimersByTime(4 * 60_000);
    expect(onIdle).not.toHaveBeenCalled();

    // Call a tool — resets the timer
    await request(handle.app).post("/tools/test-tool").send({}).expect(200);

    // Advance another 4 minutes — still not 5 from last activity
    vi.advanceTimersByTime(4 * 60_000);
    expect(onIdle).not.toHaveBeenCalled();

    // Advance 1 more minute — now 5 since last activity
    vi.advanceTimersByTime(1 * 60_000);
    expect(onIdle).toHaveBeenCalledOnce();

    handle.dispose();
  });

  it("does not start a timer when timeout is 0", () => {
    const onIdle = vi.fn();
    const handle = createHttpApp(stubRegistry(), {
      idleTimeoutMs: 0,
      onIdle,
    });

    vi.advanceTimersByTime(60 * 60_000);
    expect(onIdle).not.toHaveBeenCalled();

    handle.dispose();
  });

  it("does not start a timer when no onIdle callback", () => {
    const handle = createHttpApp(stubRegistry(), {
      idleTimeoutMs: 5 * 60_000,
    });

    // Should not throw or fire anything
    vi.advanceTimersByTime(10 * 60_000);

    handle.dispose();
  });

  it("clears the timer on dispose()", () => {
    const onIdle = vi.fn();
    const handle = createHttpApp(stubRegistry(), {
      idleTimeoutMs: 5 * 60_000,
      onIdle,
    });

    handle.dispose();

    vi.advanceTimersByTime(10 * 60_000);
    expect(onIdle).not.toHaveBeenCalled();
  });
});
