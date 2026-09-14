import { beforeEach, describe, expect, it, vi } from "vitest";
import { launchApp } from "../src/utils/ios-device/devicectl";

const spawned = vi.hoisted(() => ({ argv: [] as string[][] }));

// devicectl promisifies execFile at module load, so the mock must replace the
// callback-style function itself (same idiom as ios-device-devicectl-ready).
// Every call succeeds and records its argv for the assertions below.
vi.mock("node:child_process", () => ({
  execFile: (_file: unknown, args: unknown, _options: unknown, callback: unknown) => {
    spawned.argv.push(args as string[]);
    (callback as (error: null, result: { stdout: string; stderr: string }) => void)(null, {
      stdout: "",
      stderr: "",
    });
  },
}));

const UDID = "00008110-000978540290401E";

beforeEach(() => {
  spawned.argv = [];
});

describe("devicectl launchApp argv", () => {
  it("appends --payload-url before the bundle id when a payload URL is given", async () => {
    await launchApp(UDID, "com.apple.mobilesafari", { payloadUrl: "https://example.com/x" });

    expect(spawned.argv).toEqual([
      [
        "devicectl",
        "device",
        "process",
        "launch",
        "--device",
        UDID,
        "--payload-url",
        "https://example.com/x",
        "com.apple.mobilesafari",
      ],
    ]);
  });

  it("omits the flag for a plain launch", async () => {
    await launchApp(UDID, "com.example.app");

    expect(spawned.argv).toEqual([
      ["devicectl", "device", "process", "launch", "--device", UDID, "com.example.app"],
    ]);
  });
});
