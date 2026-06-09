import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { Registry } from "@argent/registry";
import { attachRegistryTelemetry } from "../src/registry-listener.js";
import { scopeHome } from "./helpers.js";
import * as telemetry from "../src/index.js";

const INVOCATION_ID_1 = "11111111-1111-4111-8111-111111111111";
const INVOCATION_ID_2 = "22222222-2222-4222-8222-222222222222";

describe("attachRegistryTelemetry", () => {
  scopeHome();

  beforeEach(() => {
    telemetry.init("tool_server");
    // Reset the in-memory consent cache so each test starts fresh.
    telemetry.markEnabled();
    (globalThis as Record<string, unknown>).__ARGENT_POSTHOG_KEY_TEST = "";
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("emits tool:invoke + tool:complete on a successful invocation", () => {
    const trackSpy = vi.spyOn(telemetry, "track");
    const registry = new Registry();

    const handle = attachRegistryTelemetry(registry);
    handle.recordInvocation(INVOCATION_ID_1, { platform: "ios" });

    registry.events.emit("toolInvoked", "gesture-tap", INVOCATION_ID_1);
    registry.events.emit("toolCompleted", "gesture-tap", INVOCATION_ID_1, 42.5);

    expect(trackSpy).toHaveBeenCalledTimes(2);
    expect(trackSpy.mock.calls[0]![0]).toBe("tool:invoke");
    expect(trackSpy.mock.calls[0]![1]).toMatchObject({
      tool: "gesture-tap",
      tool_invocation_id: INVOCATION_ID_1,
      platform: "ios",
    });
    expect(trackSpy.mock.calls[0]![1]).not.toHaveProperty("device_id_hash");

    expect(trackSpy.mock.calls[1]![0]).toBe("tool:complete");
    expect(trackSpy.mock.calls[1]![1]).toMatchObject({
      tool: "gesture-tap",
      tool_invocation_id: INVOCATION_ID_1,
      duration_ms: 42.5,
    });

    handle.detach();
  });

  it("emits tool:fail with tool metadata and real duration", () => {
    const trackSpy = vi.spyOn(telemetry, "track");
    const registry = new Registry();
    const handle = attachRegistryTelemetry(registry);

    handle.recordInvocation(INVOCATION_ID_1, { platform: "android" });

    registry.events.emit("toolInvoked", "screenshot", INVOCATION_ID_1);

    class TimeoutError extends Error {}
    emitToolFailed(
      registry,
      "screenshot",
      INVOCATION_ID_1,
      new TimeoutError("ETIMEDOUT 1.2.3.4"),
      17.25
    );

    expect(trackSpy).toHaveBeenCalledTimes(2);
    expect(trackSpy.mock.calls[1]![0]).toBe("tool:fail");
    expect(trackSpy.mock.calls[1]![1]).toMatchObject({
      tool: "screenshot",
      tool_invocation_id: INVOCATION_ID_1,
      platform: "android",
      duration_ms: 17.25,
    });
    // The error MESSAGE must never reach the payload.
    expect(JSON.stringify(trackSpy.mock.calls[1]![1])).not.toContain("ETIMEDOUT");
    expect(JSON.stringify(trackSpy.mock.calls[1]![1])).not.toContain("1.2.3.4");

    handle.detach();
  });

  it("totalToolCalls counter increments per invocation", () => {
    const registry = new Registry();
    const handle = attachRegistryTelemetry(registry);

    expect(handle.getTotalToolCalls()).toBe(0);
    registry.events.emit("toolInvoked", "x", INVOCATION_ID_1);
    registry.events.emit("toolInvoked", "y", INVOCATION_ID_2);
    expect(handle.getTotalToolCalls()).toBe(2);
    handle.detach();
  });

  it("detach unsubscribes — no further events emitted", () => {
    const trackSpy = vi.spyOn(telemetry, "track");
    const registry = new Registry();
    const handle = attachRegistryTelemetry(registry);
    handle.detach();
    registry.events.emit("toolInvoked", "x", INVOCATION_ID_1);
    expect(trackSpy).not.toHaveBeenCalled();
  });

  it("omits platform when no device metadata was recorded", () => {
    const trackSpy = vi.spyOn(telemetry, "track");
    const registry = new Registry();
    const handle = attachRegistryTelemetry(registry);
    registry.events.emit("toolInvoked", "screenshot", INVOCATION_ID_1);
    expect(trackSpy.mock.calls[0]![1]).toEqual({
      tool: "screenshot",
      tool_invocation_id: INVOCATION_ID_1,
    });
    handle.detach();
  });

  it("release function drops pending metadata before invocation", () => {
    const trackSpy = vi.spyOn(telemetry, "track");
    const registry = new Registry();
    const handle = attachRegistryTelemetry(registry);
    const release = handle.recordInvocation(INVOCATION_ID_1, { platform: "android" });

    release();
    registry.events.emit("toolInvoked", "screenshot", INVOCATION_ID_1);

    expect(trackSpy.mock.calls[0]![1]).toEqual({
      tool: "screenshot",
      tool_invocation_id: INVOCATION_ID_1,
    });
    handle.detach();
  });

  it("keeps same-tool invocation metadata separate by caller-provided invocation id", () => {
    const trackSpy = vi.spyOn(telemetry, "track");
    const registry = new Registry();
    const handle = attachRegistryTelemetry(registry);

    handle.recordInvocation(INVOCATION_ID_2, { platform: "android" });
    handle.recordInvocation(INVOCATION_ID_1, { platform: "ios" });

    registry.events.emit("toolInvoked", "screenshot", INVOCATION_ID_1);
    registry.events.emit("toolInvoked", "screenshot", INVOCATION_ID_2);
    registry.events.emit("toolCompleted", "screenshot", INVOCATION_ID_2, 20);
    registry.events.emit("toolCompleted", "screenshot", INVOCATION_ID_1, 10);

    expect(trackSpy.mock.calls.map((call) => call[1])).toEqual([
      expect.objectContaining({
        tool_invocation_id: INVOCATION_ID_1,
        platform: "ios",
      }),
      expect.objectContaining({
        tool_invocation_id: INVOCATION_ID_2,
        platform: "android",
      }),
      expect.objectContaining({
        tool_invocation_id: INVOCATION_ID_2,
        platform: "android",
        duration_ms: 20,
      }),
      expect.objectContaining({
        tool_invocation_id: INVOCATION_ID_1,
        platform: "ios",
        duration_ms: 10,
      }),
    ]);

    handle.detach();
  });
});

function emitToolFailed(
  registry: Registry,
  toolId: string,
  toolInvocationId: string,
  error: Error,
  durationMs: number
): void {
  const emit = registry.events.emit.bind(registry.events) as (
    event: "toolFailed",
    toolId: string,
    toolInvocationId: string,
    error: Error,
    durationMs: number
  ) => void;
  emit("toolFailed", toolId, toolInvocationId, error, durationMs);
}
