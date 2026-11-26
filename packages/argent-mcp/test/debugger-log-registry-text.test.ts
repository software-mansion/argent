import { describe, it, expect } from "vitest";
import { debuggerLogRegistryText } from "../src/debugger-log-registry-text.js";

describe("debuggerLogRegistryText", () => {
  it("renders summary, file path, clusters, and recent entries compactly", () => {
    const text = debuggerLogRegistryText({
      status: "connected",
      file: "/Users/me/.argent/tmp/argent-logs-8081-1700.log",
      totalEntries: 15,
      byLevel: { error: 2, warning: 3, log: 10 },
      fileSizeBytes: 2048,
      appName: "MyApp",
      deviceName: "iPhone 17",
      logicalDeviceId: "ios-sim-1",
      clusters: [
        {
          message: "Rendered screen",
          count: 10,
          level: "log",
          firstId: 1,
          lastId: 14,
          sourceFile: "App.tsx",
          sourceLine: 42,
        },
        {
          message: "Unhandled rejection\n  at fetchUser (api.ts:18)",
          count: 1,
          level: "error",
          firstId: 15,
          lastId: 15,
        },
      ],
      entries: [
        {
          id: 14,
          timestamp: "2026-11-25T08:00:00.000Z",
          level: "log",
          message: "Rendered screen",
        },
        {
          id: 15,
          timestamp: "2026-11-25T08:00:01.000Z",
          level: "error",
          message: "Unhandled rejection\nline 2",
        },
      ],
    });

    expect(text).toBe(
      [
        'JS console logs (connected): 15 entries (error=2, warning=3, log=10) | app=MyApp device="iPhone 17" id=ios-sim-1',
        "File: /Users/me/.argent/tmp/argent-logs-8081-1700.log (2.0 KB)",
        "",
        "Clusters (2):",
        "[x10] log #1..#14 App.tsx:42 | Rendered screen",
        "[x1] error #15 | Unhandled rejection\n    at fetchUser (api.ts:18)",
        "",
        "Recent entries (2, oldest first):",
        "[L:14] 2026-11-25T08:00:00.000Z log | Rendered screen",
        "[L:15] 2026-11-25T08:00:01.000Z error | Unhandled rejection\n  line 2",
      ].join("\n")
    );
  });

  it("includes note and omits empty sections when no entries were captured", () => {
    const text = debuggerLogRegistryText({
      status: "connected",
      file: "/tmp/argent-logs.log",
      totalEntries: 0,
      byLevel: {},
      fileSizeBytes: 0,
      appName: "MyApp",
      deviceName: "",
      logicalDeviceId: undefined,
      note: "Previous JS-runtime debugger session ended when the app crashed.",
      clusters: [],
      entries: [],
    });

    expect(text).toBe(
      [
        "JS console logs (connected): 0 entries | app=MyApp",
        "File: /tmp/argent-logs.log (0 B)",
        "Note: Previous JS-runtime debugger session ended when the app crashed.",
      ].join("\n")
    );
  });

  it("notes when totalEntries > 0 but level filter returned no recent entries", () => {
    const text = debuggerLogRegistryText({
      status: "connected",
      file: "/tmp/argent-logs.log",
      totalEntries: 5,
      byLevel: { log: 5 },
      fileSizeBytes: 512,
      appName: "MyApp",
      deviceName: "Pixel",
      clusters: [{ message: "hi", count: 5, level: "log", firstId: 1, lastId: 5 }],
      entries: [],
    });

    expect(text).toContain("Recent entries: none");
  });

  it("returns undefined for not_connected and unknown shapes", () => {
    expect(
      debuggerLogRegistryText({
        status: "not_connected",
        reason: "metro_unreachable",
        detail: "connection refused",
        guidance: "Start Metro first.",
      })
    ).toBeUndefined();
    expect(debuggerLogRegistryText(null)).toBeUndefined();
    expect(debuggerLogRegistryText({ status: "connected" })).toBeUndefined();
  });
});
