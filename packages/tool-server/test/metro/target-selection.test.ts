import { describe, it, expect } from "vitest";
import { selectTarget } from "../../src/utils/debugger/target-selection";
import type { CDPTarget } from "../../src/utils/debugger/discovery";

function makeTarget(overrides: Partial<CDPTarget> = {}): CDPTarget {
  return {
    id: "page1",
    title: "React Native",
    description: "",
    webSocketDebuggerUrl: "ws://localhost:8081/inspector/debug?device=0&page=1",
    ...overrides,
  };
}

describe("selectTarget", () => {
  it("prefers Fusebox target", () => {
    const fusebox = makeTarget({
      id: "fusebox",
      reactNative: { capabilities: { prefersFuseboxFrontend: true } },
    });
    const legacy = makeTarget({ id: "legacy", title: "React Native Bridge (0)" });

    const result = selectTarget([legacy, fusebox], 8081);
    expect(result.target.id).toBe("fusebox");
    expect(result.isNewDebugger).toBe(true);
  });

  it("falls back to C++ connection", () => {
    const cpp = makeTarget({
      id: "cpp",
      description: "some [C++ connection]",
    });
    const legacy = makeTarget({ id: "legacy" });

    const result = selectTarget([legacy, cpp], 8081);
    expect(result.target.id).toBe("cpp");
    expect(result.isNewDebugger).toBe(true);
  });

  it("falls back to React Native Bridge", () => {
    const bridge = makeTarget({
      id: "bridge",
      title: "React Native Bridge (0)",
    });
    const other = makeTarget({ id: "other", title: "Other" });

    const result = selectTarget([other, bridge], 8081);
    expect(result.target.id).toBe("bridge");
    expect(result.isNewDebugger).toBe(false);
  });

  it("falls back to first target", () => {
    const t1 = makeTarget({ id: "first", title: "Unknown" });
    const t2 = makeTarget({ id: "second", title: "Unknown 2" });

    const result = selectTarget([t1, t2], 8081);
    expect(result.target.id).toBe("first");
  });

  it("normalizes WebSocket URL to localhost with correct port", () => {
    const target = makeTarget({
      webSocketDebuggerUrl: "ws://10.0.2.2:9999/inspector/debug?device=0&page=1",
    });

    const result = selectTarget([target], 8081);
    expect(result.webSocketUrl).toContain("localhost");
    expect(result.webSocketUrl).toContain("8081");
    expect(result.webSocketUrl).not.toContain("10.0.2.2");
    expect(result.webSocketUrl).not.toContain("9999");
  });

  it("filters by deviceName when specified", () => {
    const dev1 = makeTarget({ id: "dev1", deviceName: "iPhone 16" });
    const dev2 = makeTarget({ id: "dev2", deviceName: "Pixel 9" });

    const result = selectTarget([dev1, dev2], 8081, {
      deviceName: "Pixel 9",
    });
    expect(result.target.id).toBe("dev2");
  });

  it("filters by deviceId when specified", () => {
    const dev1 = makeTarget({
      id: "dev1",
      reactNative: { logicalDeviceId: "aaa" },
    });
    const dev2 = makeTarget({
      id: "dev2",
      reactNative: { logicalDeviceId: "bbb" },
    });

    const result = selectTarget([dev1, dev2], 8081, { deviceId: "bbb" });
    expect(result.target.id).toBe("dev2");
  });

  it("routes distinct deviceIds to distinct devices (no collapse)", () => {
    const dev1 = makeTarget({
      id: "dev1",
      reactNative: { logicalDeviceId: "aaa", capabilities: { prefersFuseboxFrontend: true } },
    });
    const dev2 = makeTarget({
      id: "dev2",
      reactNative: { logicalDeviceId: "bbb", capabilities: { prefersFuseboxFrontend: true } },
    });

    expect(selectTarget([dev1, dev2], 8081, { deviceId: "aaa" }).target.id).toBe("dev1");
    expect(selectTarget([dev1, dev2], 8081, { deviceId: "bbb" }).target.id).toBe("dev2");
  });

  it("throws instead of silently collapsing when an unmatched deviceId is ambiguous", () => {
    const dev1 = makeTarget({ id: "dev1", reactNative: { logicalDeviceId: "aaa" } });
    const dev2 = makeTarget({ id: "dev2", reactNative: { logicalDeviceId: "bbb" } });

    // An id that matches neither device must NOT resolve to the first target —
    // that is the "all debuggers resolve to the same device" bug.
    expect(() => selectTarget([dev1, dev2], 8081, { deviceId: "unmatched" })).toThrow(
      /No debugger target matches device_id "unmatched"/
    );
    // The error must surface the valid ids so the caller can re-target.
    expect(() => selectTarget([dev1, dev2], 8081, { deviceId: "unmatched" })).toThrow(/aaa.*bbb/);
  });

  it("surfaces deviceName alongside logicalDeviceId so the caller can map ids to devices", () => {
    const ipad = makeTarget({
      id: "dev1",
      deviceName: "iPad Pro",
      reactNative: { logicalDeviceId: "9e7844f7" },
    });
    const iphone = makeTarget({
      id: "dev2",
      deviceName: "iPhone 16",
      reactNative: { logicalDeviceId: "8a44101d" },
    });

    // Each listed device shows its human-readable name next to the hash.
    expect(() => selectTarget([ipad, iphone], 8081, { deviceId: "some-udid" })).toThrow(
      /iPad Pro \(9e7844f7\).*iPhone 16 \(8a44101d\)/
    );
  });

  it("falls back to the bare logicalDeviceId when a device has no deviceName", () => {
    const named = makeTarget({
      id: "dev1",
      deviceName: "iPhone 16",
      reactNative: { logicalDeviceId: "aaa" },
    });
    const unnamed = makeTarget({ id: "dev2", reactNative: { logicalDeviceId: "bbb" } });

    expect(() => selectTarget([named, unnamed], 8081, { deviceId: "unmatched" })).toThrow(
      /iPhone 16 \(aaa\).*bbb/
    );
  });

  it("still falls back to the only device when a single device is connected", () => {
    // Single-device convenience: callers may pass an id Metro never echoes (e.g.
    // an iOS simulator UDID, which is not the logicalDeviceId). With one device
    // there is no ambiguity, so selection must succeed via fallback.
    const fusebox = makeTarget({
      id: "only",
      reactNative: {
        logicalDeviceId: "real-logical-id",
        capabilities: { prefersFuseboxFrontend: true },
      },
    });
    const uiPage = makeTarget({
      id: "only-ui",
      reactNative: { logicalDeviceId: "real-logical-id" },
    });

    const result = selectTarget([fusebox, uiPage], 8081, { deviceId: "some-ios-udid" });
    expect(result.target.id).toBe("only");
  });

  it("falls back when no target exposes a logicalDeviceId at all", () => {
    // Old-arch / pre-Fusebox targets omit reactNative.logicalDeviceId entirely.
    const t1 = makeTarget({ id: "first" });
    const t2 = makeTarget({
      id: "second",
      reactNative: { capabilities: { prefersFuseboxFrontend: true } },
    });

    const result = selectTarget([t1, t2], 8081, { deviceId: "anything" });
    expect(result.target.id).toBe("second");
  });
});
