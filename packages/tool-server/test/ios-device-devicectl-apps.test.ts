import { beforeEach, describe, expect, it, vi } from "vitest";
import { writeFileSync } from "node:fs";
import { installedAppUrl } from "../src/utils/ios-device/devicectl";

const devicectl = vi.hoisted(() => ({ argv: [] as string[][], payload: {} as unknown }));

// devicectl promisifies execFile at module load, so the mock replaces the
// callback-style function. It writes `payload` to the --json-output file.
vi.mock("node:child_process", () => ({
  execFile: (_file: unknown, args: string[], _options: unknown, callback: unknown) => {
    devicectl.argv.push(args);
    writeFileSync(args[args.indexOf("--json-output") + 1]!, JSON.stringify(devicectl.payload));
    (callback as (error: null, result: { stdout: string; stderr: string }) => void)(null, {
      stdout: "",
      stderr: "",
    });
  },
}));

const UDID = "00008110-000978540290401E";
const URL = "file:///private/var/containers/Bundle/Application/X/App.app/";

beforeEach(() => {
  devicectl.argv = [];
});

describe("devicectl installedAppUrl", () => {
  it("returns the bundle URL of the installed app", async () => {
    devicectl.payload = {
      result: { apps: [{ bundleIdentifier: "com.example.app", name: "App", url: URL }] },
    };
    expect(await installedAppUrl(UDID, "com.example.app")).toBe(URL);
    expect(devicectl.argv[0]!.slice(0, 8)).toEqual([
      "devicectl",
      "device",
      "info",
      "apps",
      "--device",
      UDID,
      "--bundle-id",
      "com.example.app",
    ]);
  });

  it("returns null when the device lists no such app", async () => {
    devicectl.payload = { result: { apps: [] } };
    expect(await installedAppUrl(UDID, "com.example.app")).toBeNull();
  });

  it("does not read a missing app list as not installed", async () => {
    devicectl.payload = { info: {} };
    await expect(installedAppUrl(UDID, "com.example.app")).rejects.toThrow(
      "devicectl returned no app list for com.example.app."
    );
  });
});
