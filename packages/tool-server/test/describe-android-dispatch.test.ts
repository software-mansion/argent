import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Registry } from "@argent/registry";

const execFileMock = vi.fn();
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    execFile: (
      cmd: string,
      args: readonly string[],
      opts: unknown,
      cb?: (err: Error | null, out: { stdout: string | Buffer; stderr: string }) => void
    ) => {
      const callback = typeof opts === "function" ? opts : cb!;
      const options = typeof opts === "function" ? undefined : opts;
      const result = execFileMock(cmd, args, options);
      if (result instanceof Error) callback(result, { stdout: "", stderr: "" });
      else callback(null, result ?? { stdout: "", stderr: "" });
    },
  };
});

import { createDescribeTool } from "../src/tools/interactions/describe";
import { __resetClassifyCacheForTests, warmDeviceCache } from "../src/utils/platform-detect";

const fakeRegistry: Registry = {
  resolveService: vi.fn(),
} as unknown as Registry;

// Each test gets a unique serial because `getAndroidScreenSize` caches the
// `wm size` output for 5 s per serial. Reusing a serial across tests leaks the
// first test's mocked screen size into the second.
let nextSerial = 7000;
const mkSerial = () => {
  const s = `emulator-${nextSerial++}`;
  // Warm the classify cache so describe's platform check is O(1) and doesn't
  // shell out to xcrun / adb list lookups.
  warmDeviceCache([{ udid: s, platform: "android" }]);
  return s;
};

beforeEach(() => {
  execFileMock.mockReset();
  __resetClassifyCacheForTests();
});

function sampleDump(): string {
  return `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" text="Login" resource-id="com.x:id/btn" class="android.widget.Button" package="com.x" content-desc="" bounds="[0,0][1080,200]" />
</hierarchy>`;
}

describe("describe — Android branch dispatch on adb serial", () => {
  it("calls `adb exec-out uiautomator dump ... && cat ...` and normalizes bounds using wm size", async () => {
    // Sequence of adb calls this branch makes:
    //   1. adb -s <serial> shell wm size            -> screen size for normalization
    //   2. adb -s <serial> exec-out uiautomator...  -> the XML dump
    const calls: string[][] = [];
    execFileMock.mockImplementation((cmd: string, args: string[]) => {
      calls.push([cmd, ...args]);
      const joined = args.join(" ");
      if (joined.includes("wm size")) {
        return { stdout: "Physical size: 1080x1920\n", stderr: "" };
      }
      if (joined.includes("uiautomator dump")) {
        // Buffer is what exec-out returns for binary-safe payloads; we return
        // a Buffer here to mirror production.
        return { stdout: Buffer.from(sampleDump(), "utf-8"), stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });

    const tool = createDescribeTool(fakeRegistry);
    const serial = mkSerial();
    const result = await tool.execute({}, { udid: serial });

    expect(result.source).toBe("native-devtools");
    expect(result.tree.role).toBe("Screen");
    expect(result.tree.children).toHaveLength(1);

    // Registry.resolveService must not be touched on Android — the AX-service
    // and native-devtools blueprints are iOS-only.
    expect(fakeRegistry.resolveService).not.toHaveBeenCalled();

    // Both adb calls must target -s <serial>. Any missing -s means commands
    // could leak onto a second attached device.
    const adbCalls = calls.filter((c) => c[0] === "adb");
    expect(adbCalls.length).toBeGreaterThanOrEqual(2);
    for (const c of adbCalls) {
      expect(c).toContain("-s");
      expect(c).toContain(serial);
    }
  });

  it("prefers the `Override size` line when both Physical and Override are present", async () => {
    // Emulators commonly set an override — the tool must read it, not the
    // physical size, otherwise tap coordinates render at the wrong fraction.
    // Use a dump with small bounds so the numerator stays well below both
    // denominators; the resulting fraction is only correct when the override
    // wins (physical would produce a *different* fraction).
    const dump = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" text="Tiny" resource-id="com.x:id/tiny" class="android.widget.Button" package="com.x" content-desc="" bounds="[108,96][216,192]" />
</hierarchy>`;
    execFileMock.mockImplementation((cmd: string, args: string[]) => {
      if (args.join(" ").includes("wm size")) {
        return {
          stdout: "Physical size: 1080x1920\nOverride size: 540x960\n",
          stderr: "",
        };
      }
      if (args.join(" ").includes("uiautomator dump")) {
        return { stdout: Buffer.from(dump, "utf-8"), stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });

    const tool = createDescribeTool(fakeRegistry);
    const serial = mkSerial();
    const result = await tool.execute({}, { udid: serial });
    const node = result.tree.children[0]!;
    // bounds [108,96][216,192] against override 540x960 → (0.2, 0.1, 0.2, 0.1).
    // Against physical 1080x1920 → (0.1, 0.05, 0.1, 0.05).
    // The values below prove the code picked the override, not the physical.
    expect(node.frame.x).toBeCloseTo(108 / 540, 3);
    expect(node.frame.y).toBeCloseTo(96 / 960, 3);
    expect(node.frame.width).toBeCloseTo(108 / 540, 3);
    expect(node.frame.height).toBeCloseTo(96 / 960, 3);
  });

  it("surfaces a helpful error when the dump fails with a keyguard/secure overlay", async () => {
    // Repro of the specific failure mode we saw on a locked emulator — the
    // error message must mention the common causes so an agent can recover.
    execFileMock.mockImplementation((cmd: string, args: string[]) => {
      if (args.join(" ").includes("wm size")) {
        return { stdout: "Physical size: 1080x1920\n", stderr: "" };
      }
      return {
        stdout: Buffer.from("ERROR: could not get idle state.\n", "utf-8"),
        stderr: "",
      };
    });

    const tool = createDescribeTool(fakeRegistry);
    await expect(tool.execute({}, { udid: mkSerial() })).rejects.toThrow(
      /uiautomator could not capture/
    );
  });

  it("ignores a bundleId arg on Android (iOS-only hint)", async () => {
    execFileMock.mockImplementation((cmd: string, args: string[]) => {
      if (args.join(" ").includes("wm size")) {
        return { stdout: "Physical size: 1080x1920\n", stderr: "" };
      }
      return { stdout: Buffer.from(sampleDump(), "utf-8"), stderr: "" };
    });
    const tool = createDescribeTool(fakeRegistry);
    const result = await tool.execute({}, { udid: mkSerial(), bundleId: "com.example.app" });
    expect(result.source).toBe("native-devtools");
    // bundleId must not have caused any extra adb or xcrun calls beyond
    // wm-size + uiautomator-dump.
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });
});
