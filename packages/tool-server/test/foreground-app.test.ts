import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Registry } from "@argent/registry";
import type { AXForegroundAppResponse } from "../src/blueprints/ax-service";
import type { GetHierarchyOptions } from "../src/blueprints/android-devtools";
import { createForegroundAppTool } from "../src/tools/foreground-app";
import { UnsupportedOperationError } from "../src/utils/capability";
import { cacheSimulatorRuntimeKind } from "../src/utils/ios-devices";
import { __primeDepCacheForTests, __resetDepCacheForTests } from "../src/utils/check-deps";

const IOS_UDID = "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA";
const TV_UDID = "BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB";
const SCREEN = { width: 1000, height: 2000, rotation: 0 };
// A helper at treeVersion 2 on a current API level, listing windows.
const V2 = { treeVersion: 2, sdkInt: 36, captureMode: "interactive-windows" };

function node(attrs: Record<string, string>): string {
  const raw = Object.entries(attrs)
    .map(([k, v]) => `${k}="${v}"`)
    .join(" ");
  return `<node ${raw} />`;
}

function dump(...windows: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?><hierarchy rotation="0">${windows.join("")}</hierarchy>`;
}

// A depth-0 window root, as the helper writes it.
const win = (type: string, pkg: string, bounds = "[0,0][1000,2000]") =>
  node({ "class": "android.widget.FrameLayout", "window-type": type, "package": pkg, bounds });

let capture: Record<string, unknown> = {};
let axAnswer: AXForegroundAppResponse = { alertVisible: false };
const hierarchyCalls: GetHierarchyOptions[] = [];
const resolved: string[] = [];

const registry = {
  resolveService: vi.fn(async (urn: string) => {
    resolved.push(urn);
    if (urn.startsWith("AXService:")) return { foregroundApp: async () => axAnswer };
    return {
      getHierarchy: async (opts: GetHierarchyOptions) => {
        hierarchyCalls.push(opts);
        return capture;
      },
      getScreenSize: async () => SCREEN,
    };
  }),
} as unknown as Registry;

const tool = createForegroundAppTool(registry);
const run = (udid: string) => tool.execute!({}, { udid });

function android(xml: string, helper: Record<string, unknown> = V2) {
  // The helper reports depth 0 as truncated; the tool knows no window was cut.
  capture = { xml, truncated: true, ...helper };
  return run("emulator-5554");
}

beforeEach(() => {
  hierarchyCalls.length = 0;
  resolved.length = 0;
  __resetDepCacheForTests();
  __primeDepCacheForTests(["xcrun", "sim-remote", "adb"]);
  cacheSimulatorRuntimeKind(IOS_UDID, "mobile");
  cacheSimulatorRuntimeKind(TV_UDID, "tv");
});

describe("foreground-app", () => {
  it("is hidden from MCP", () => {
    expect(tool.hideFromMcp).toBe(true);
  });

  describe("Android", () => {
    it("reads window roots only, with the default settle", async () => {
      await android(dump(win("1", "com.google.android.apps.nexuslauncher")));
      expect(hierarchyCalls).toEqual([{ maxDepth: 0, clearCache: true }]);
    });

    it("answers the launcher on the home screen", async () => {
      await expect(
        android(
          dump(win("3", "com.android.systemui"), win("1", "com.google.android.apps.nexuslauncher"))
        )
      ).resolves.toEqual({
        bundleId: "com.google.android.apps.nexuslauncher",
        alertVisible: false,
      });
    });

    it("answers the topmost app window past the keyboard and system bars", async () => {
      await expect(
        android(
          dump(
            win("2", "com.google.android.inputmethod.latin", "[0,1200][1000,2000]"),
            win("3", "com.android.systemui"),
            win("1", "com.example")
          )
        )
      ).resolves.toEqual({ bundleId: "com.example", alertVisible: false });
    });

    it("answers the app under a permission dialog when its window is listed", async () => {
      await expect(
        android(
          dump(
            win("1", "com.android.packageinstaller", "[28,700][972,1300]"),
            win("1", "com.example")
          ),
          { ...V2, sdkInt: 28 }
        )
      ).resolves.toEqual({ bundleId: "com.example", alertVisible: true });
    });

    it("leaves bundleId unset when the dialog hides the app's window", async () => {
      const result = await android(
        dump(win("1", "com.google.android.permissioncontroller", "[28,700][972,1300]"))
      );
      expect(result).toEqual({ alertVisible: true });
      expect(result.bundleId).toBeUndefined();
    });

    it("reports a system crash dialog over the app", async () => {
      await expect(
        android(dump(win("3", "android", "[28,907][972,1446]"), win("1", "com.example")))
      ).resolves.toEqual({ bundleId: "com.example", alertVisible: true });
    });

    it("answers no app and no alert on the lock screen, though depth 0 reports truncated", async () => {
      capture = { xml: dump(win("3", "com.android.systemui")), truncated: true, ...V2 };
      const result = await run("emulator-5558");
      expect(result).toEqual({ alertVisible: false });
      expect(result.bundleId).toBeUndefined();
    });

    it("answers nothing for a helper that predates window types", async () => {
      const result = await android(dump(win("1", "com.example")), { treeVersion: 1 });
      expect(result.bundleId).toBeUndefined();
      expect(result.alertVisible).toBeUndefined();
    });
  });

  describe("iOS", () => {
    it("passes the ax-service answer through", async () => {
      axAnswer = { alertVisible: true, bundleId: "com.apple.Maps", name: "Maps" };
      await expect(run(IOS_UDID)).resolves.toEqual(axAnswer);
      expect(resolved).toEqual([`AXService:${IOS_UDID}`]);
    });

    it("rejects a tvOS simulator without starting the ax-service", async () => {
      await expect(run(TV_UDID)).rejects.toBeInstanceOf(UnsupportedOperationError);
      expect(resolved).toEqual([]);
    });
  });

  it.each([
    ["a physical iPhone", "00008110-000000000000001E"],
    ["a Chromium app", "chromium-cdp-9222"],
  ])("rejects %s as unsupported", async (_name, udid) => {
    await expect(run(udid)).rejects.toBeInstanceOf(UnsupportedOperationError);
    expect(resolved).toEqual([]);
  });
});
