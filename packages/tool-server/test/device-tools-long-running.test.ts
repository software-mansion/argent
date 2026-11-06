import { beforeEach, describe, expect, it, vi } from "vitest";

type ExecOptions = { timeout?: number; killSignal?: string } | undefined;
const calls: Array<{ cmd: string; args: readonly string[]; options: ExecOptions }> = [];
// simctl subcommand that fails, and whether it fails by timing out.
let failing: { sub: string; killed: boolean } | null = null;

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
      if (cmd === "xcrun" && failing && args.includes(failing.sub)) {
        callback(
          Object.assign(new Error(`simctl ${failing.sub} failed`), { killed: failing.killed }),
          {
            stdout: "",
            stderr: "",
          }
        );
        return;
      }
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

// The bundle check reads a real .app on disk; reinstall-app-validate.test.ts covers it.
vi.mock("../src/tools/reinstall-app/validate-app", async () => {
  const actual = await vi.importActual<typeof import("../src/tools/reinstall-app/validate-app")>(
    "../src/tools/reinstall-app/validate-app"
  );
  return { ...actual, assertIosAppBundle: vi.fn(async () => {}) };
});

vi.mock("../src/blueprints/native-devtools", async () => {
  const actual = await vi.importActual<typeof import("../src/blueprints/native-devtools")>(
    "../src/blueprints/native-devtools"
  );
  return { ...actual, precheckNativeDevtools: vi.fn(async () => null) };
});

import { getFailureSignal, Registry } from "@argent/registry";
import { createBootDeviceTool } from "../src/tools/devices/boot-device";
import { reinstallAppTool } from "../src/tools/reinstall-app/index";
import { createRestartAppTool } from "../src/tools/restart-app/index";
import { createDescribeTool } from "../src/tools/describe/index";
import { createLaunchAppTool } from "../src/tools/launch-app/index";
import { nativeProfilerStartTool } from "../src/tools/profiler/native-profiler/native-profiler-start";

const registry = new Registry();
const slowDeviceTools: { id: string; longRunning?: boolean }[] = [
  createBootDeviceTool(registry),
  reinstallAppTool,
  createRestartAppTool(registry),
  createDescribeTool(registry),
  createLaunchAppTool(registry),
  nativeProfilerStartTool,
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
    failing = null;
  });

  it.each([
    [
      "reinstall-app",
      () => reinstallAppTool.execute!({}, { udid: UDID, bundleId: "com.x", appPath: "/a.app" }),
      { uninstall: 30_000, install: 180_000 },
    ],
    [
      "launch-app",
      () =>
        createLaunchAppTool(fakeRegistry).execute!(
          {},
          { udid: UDID, bundleId: "com.x", launchArgs: ["-a"] }
        ),
      { terminate: 15_000, launch: 30_000 },
    ],
    [
      "restart-app",
      () => createRestartAppTool(fakeRegistry).execute!({}, { udid: UDID, bundleId: "com.x" }),
      { terminate: 15_000, launch: 30_000 },
    ],
  ])("%s", async (_id, run, limits) => {
    await run();
    const simctl = calls.filter((c) => c.cmd === "xcrun" && c.args.includes("simctl"));
    // The messages, descriptions and tools.mdx state these limits.
    for (const [sub, timeout] of Object.entries(limits)) {
      const call = simctl.find((c) => c.args.includes(sub));
      expect(call?.options).toMatchObject({ killSignal: "SIGKILL", timeout });
    }
    for (const c of simctl) {
      expect(c.options?.killSignal).toBe("SIGKILL");
      expect(c.options?.timeout).toBeGreaterThan(0);
    }
  });
});

describe("iOS app tools fail when the step before launch or install times out", () => {
  const UDID = "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA";
  const fakeRegistry = { resolveService: vi.fn(async () => ({})) } as never;
  const cases = [
    {
      id: "reinstall-app",
      run: () =>
        reinstallAppTool.execute!({}, { udid: UDID, bundleId: "com.x", appPath: "/a.app" }),
      sub: "uninstall",
      next: "install",
      ok: { reinstalled: true, bundleId: "com.x" },
      message: /Uninstalling com\.x .* did not finish within 30s/,
      code: "IOS_REINSTALL_UNINSTALL_FAILED",
      stage: "ios_reinstall_app_simctl_uninstall",
    },
    {
      id: "launch-app",
      run: () =>
        createLaunchAppTool(fakeRegistry).execute!(
          {},
          { udid: UDID, bundleId: "com.x", launchArgs: ["-a"] }
        ),
      sub: "terminate",
      next: "launch",
      ok: { launched: true, bundleId: "com.x" },
      message: /Terminating iOS app com\.x .* did not finish within 15s/,
      code: "IOS_LAUNCH_SIMCTL_FAILED",
      stage: "ios_launch_app_simctl_terminate",
    },
    {
      id: "restart-app",
      run: () => createRestartAppTool(fakeRegistry).execute!({}, { udid: UDID, bundleId: "com.x" }),
      sub: "terminate",
      next: "launch",
      ok: { restarted: true, bundleId: "com.x" },
      message: /Terminating iOS app com\.x .* did not finish within 15s/,
      code: "IOS_RESTART_TERMINATE_FAILED",
      stage: "ios_restart_app_simctl_terminate",
    },
  ];

  beforeEach(() => {
    calls.length = 0;
  });

  it.each(cases)(
    "$id fails on a timed-out $sub and never runs $next",
    async ({ run, sub, next, message, code, stage }) => {
      failing = { sub, killed: true };
      const err = await run().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toMatch(message);
      expect(getFailureSignal(err)).toMatchObject({
        error_code: code,
        failure_stage: stage,
        error_kind: "timeout",
      });
      const simctl = calls.filter((c) => c.cmd === "xcrun" && c.args.includes("simctl"));
      expect(simctl.some((c) => c.args.includes(next))).toBe(false);
    }
  );

  it.each(cases)(
    "$id still succeeds when $sub fails without timing out",
    async ({ run, sub, ok }) => {
      failing = { sub, killed: false };
      await expect(run()).resolves.toMatchObject(ok);
    }
  );
});

describe("iOS app tools report a timed-out launch or install as a timeout", () => {
  const UDID = "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA";
  const fakeRegistry = { resolveService: vi.fn(async () => ({})) } as never;

  beforeEach(() => {
    calls.length = 0;
  });

  it.each([
    {
      id: "reinstall-app",
      run: () =>
        reinstallAppTool.execute!({}, { udid: UDID, bundleId: "com.x", appPath: "/a.app" }),
      sub: "install",
      message: `Installing the iOS app bundle on ${UDID} did not finish within 180s.`,
      code: "IOS_REINSTALL_INSTALL_FAILED",
      stage: "ios_reinstall_app_simctl_install",
    },
    {
      id: "launch-app",
      run: () => createLaunchAppTool(fakeRegistry).execute!({}, { udid: UDID, bundleId: "com.x" }),
      sub: "launch",
      message: `Launching iOS app com.x on ${UDID} did not finish within 30s.`,
      code: "IOS_LAUNCH_SIMCTL_FAILED",
      stage: "ios_launch_app_simctl_launch",
    },
    {
      id: "restart-app",
      run: () => createRestartAppTool(fakeRegistry).execute!({}, { udid: UDID, bundleId: "com.x" }),
      sub: "launch",
      message: `Relaunching iOS app com.x on ${UDID} did not finish within 30s.`,
      code: "IOS_RESTART_LAUNCH_FAILED",
      stage: "ios_restart_app_simctl_launch",
    },
  ])("$id: a timed-out $sub", async ({ run, sub, message, code, stage }) => {
    failing = { sub, killed: true };
    const err = await run().catch((e: unknown) => e);
    expect((err as Error).message).toBe(message);
    expect(getFailureSignal(err)).toMatchObject({
      error_code: code,
      failure_stage: stage,
      error_kind: "timeout",
    });

    failing = { sub, killed: false };
    expect(getFailureSignal(await run().catch((e: unknown) => e))).toMatchObject({
      error_code: code,
      failure_stage: stage,
      error_kind: "subprocess",
    });
  });
});
