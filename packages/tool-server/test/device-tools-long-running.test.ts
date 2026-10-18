import { beforeEach, describe, expect, it, vi } from "vitest";

type ExecOptions = { timeout?: number; killSignal?: string } | undefined;
const calls: Array<{ cmd: string; args: readonly string[]; options: ExecOptions }> = [];

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    execFile: (
      cmd: string,
      args: readonly string[],
      opts: unknown,
      cb?: (err: Error | null, out: { stdout: string; stderr: string }) => void
    ) => {
      const callback = typeof opts === "function" ? opts : cb!;
      calls.push({ cmd, args, options: (typeof opts === "function" ? undefined : opts) as never });
      const isProbe = cmd === "/bin/sh" || cmd === "where";
      const isListJson = args.includes("list") && args.includes("--json");
      callback(null, {
        stdout: isProbe ? "/usr/bin/probe\n" : isListJson ? '{"devices":{}}' : "",
        stderr: "",
      });
    },
  };
});

vi.mock("../src/utils/ios-devices", async () => {
  const actual = await vi.importActual<typeof import("../src/utils/ios-devices")>(
    "../src/utils/ios-devices"
  );
  return { ...actual, isTvOsSimulator: vi.fn(async () => false) };
});

vi.mock("../src/blueprints/native-devtools", async () => {
  const actual = await vi.importActual<typeof import("../src/blueprints/native-devtools")>(
    "../src/blueprints/native-devtools"
  );
  return { ...actual, precheckNativeDevtools: vi.fn(async () => null) };
});

import { Registry } from "@argent/registry";
import { createBootDeviceTool } from "../src/tools/devices/boot-device";
import { reinstallAppTool } from "../src/tools/reinstall-app/index";
import { createRestartAppTool } from "../src/tools/restart-app/index";
import { createDescribeTool } from "../src/tools/describe/index";
import { createLaunchAppTool } from "../src/tools/launch-app/index";

const registry = new Registry();
const slowDeviceTools: { id: string; longRunning?: boolean }[] = [
  createBootDeviceTool(registry),
  reinstallAppTool,
  createRestartAppTool(registry),
  createDescribeTool(registry),
  createLaunchAppTool(registry),
];

describe("device tools that can outlive the MCP fetch timeout", () => {
  it.each(slowDeviceTools)("$id is declared longRunning", (tool) => {
    expect(tool.longRunning).toBe(true);
  });
});

// No client timeout backs these, and a wedged simctl ignores SIGTERM.
describe("iOS simctl calls of longRunning app tools are SIGKILL-bounded", () => {
  const UDID = "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA";
  const fakeRegistry = { resolveService: vi.fn(async () => ({})) } as never;

  beforeEach(() => {
    calls.length = 0;
  });

  it.each([
    [
      "reinstall-app",
      () => reinstallAppTool.execute!({}, { udid: UDID, bundleId: "com.x", appPath: "/a.app" }),
      ["uninstall", "install"],
    ],
    [
      "launch-app",
      () =>
        createLaunchAppTool(fakeRegistry).execute!(
          {},
          { udid: UDID, bundleId: "com.x", launchArgs: ["-a"] }
        ),
      ["terminate", "launch"],
    ],
    [
      "restart-app",
      () => createRestartAppTool(fakeRegistry).execute!({}, { udid: UDID, bundleId: "com.x" }),
      ["terminate", "launch"],
    ],
  ])("%s", async (_id, run, subcommands) => {
    await run();
    const simctl = calls.filter((c) => c.cmd === "xcrun" && c.args.includes("simctl"));
    for (const sub of subcommands) {
      expect(simctl.some((c) => c.args.includes(sub))).toBe(true);
    }
    for (const c of simctl) {
      expect(c.options?.killSignal).toBe("SIGKILL");
      expect(c.options?.timeout).toBeGreaterThan(0);
    }
  });
});
