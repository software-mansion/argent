import * as fs from "node:fs";
import { describe, expect, it } from "vitest";
import { scopeHome, snapshotEnv } from "./helpers.js";
import { emitDebugPayload, isDebugEnabled } from "../src/debug.js";
import { debugLogPath } from "../src/paths.js";

describe("debug", () => {
  scopeHome();

  it("isDebugEnabled honours ARGENT_TELEMETRY_DEBUG=1", () => {
    const restore = snapshotEnv(["ARGENT_TELEMETRY_DEBUG"]);
    try {
      delete process.env.ARGENT_TELEMETRY_DEBUG;
      expect(isDebugEnabled()).toBe(false);
      process.env.ARGENT_TELEMETRY_DEBUG = "1";
      expect(isDebugEnabled()).toBe(true);
      process.env.ARGENT_TELEMETRY_DEBUG = "true";
      expect(isDebugEnabled()).toBe(true);
      process.env.ARGENT_TELEMETRY_DEBUG = "0";
      expect(isDebugEnabled()).toBe(false);
    } finally {
      restore();
    }
  });

  it("emitDebugPayload appends to ~/.argent/telemetry-debug.log when debug is on", () => {
    const restore = snapshotEnv(["ARGENT_TELEMETRY_DEBUG"]);
    try {
      process.env.ARGENT_TELEMETRY_DEBUG = "1";
      emitDebugPayload({
        event: "test:event",
        distinctId: "00000000-0000-0000-0000-000000000000",
        properties: { foo: "bar" },
        ts: "2026-05-25T00:00:00.000Z",
      });
      const contents = fs.readFileSync(debugLogPath(), "utf8");
      expect(contents).toContain("test:event");
      expect(contents).toContain('"foo":"bar"');
    } finally {
      restore();
    }
  });

  it("emitDebugPayload is a no-op when debug is off (file is not created)", () => {
    const restore = snapshotEnv(["ARGENT_TELEMETRY_DEBUG"]);
    try {
      delete process.env.ARGENT_TELEMETRY_DEBUG;
      emitDebugPayload({
        event: "test:event",
        distinctId: "00000000-0000-0000-0000-000000000000",
        properties: {},
        ts: "2026-05-25T00:00:00.000Z",
      });
      expect(fs.existsSync(debugLogPath())).toBe(false);
    } finally {
      restore();
    }
  });

  it("emitDebugPayload does not throw when properties contain circular values", () => {
    const restore = snapshotEnv(["ARGENT_TELEMETRY_DEBUG"]);
    try {
      process.env.ARGENT_TELEMETRY_DEBUG = "1";
      const circular: Record<string, unknown> = {};
      circular.self = circular;
      expect(() =>
        emitDebugPayload({
          event: "test:event",
          distinctId: "00000000-0000-0000-0000-000000000000",
          properties: circular,
          ts: "2026-05-25T00:00:00.000Z",
        })
      ).not.toThrow();
      const contents = fs.readFileSync(debugLogPath(), "utf8");
      expect(contents).toContain("debug_payload_serialization_error");
    } finally {
      restore();
    }
  });

  it("emitDebugPayload does not throw when properties contain BigInt", () => {
    const restore = snapshotEnv(["ARGENT_TELEMETRY_DEBUG"]);
    try {
      process.env.ARGENT_TELEMETRY_DEBUG = "1";
      expect(() =>
        emitDebugPayload({
          event: "test:event",
          distinctId: "00000000-0000-0000-0000-000000000000",
          properties: { value: 1n },
          ts: "2026-05-25T00:00:00.000Z",
        })
      ).not.toThrow();
      const contents = fs.readFileSync(debugLogPath(), "utf8");
      expect(contents).toContain("debug_payload_serialization_error");
    } finally {
      restore();
    }
  });
});
