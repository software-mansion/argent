import { execFileSync, spawn, type SpawnOptions } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// The macOS artifacts are stand-ins: a helper that runs a Node "app" speaking
// the library protocol (test/fixtures/macos-fake-library). The real helper and
// library are proven by the end-to-end run against a built app.
const native = vi.hoisted(() => ({ dir: "", missing: false }));
vi.mock("@argent/native-devtools-ios", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@argent/native-devtools-ios")>()),
  macosArtifacts: () => {
    if (native.missing) throw new Error(`macOS app artifact not found: ${native.dir}`);
    return {
      bootstrap: path.join(native.dir, "libArgentInjectionBootstrap.dylib"),
      library: path.join(native.dir, "libNativeDevtoolsMacos.dylib"),
      helper: path.join(native.dir, "argent-macos-helper"),
    };
  },
}));

// Records what the blueprint hands the helper: its arguments and environment.
const spawned = vi.hoisted(
  () => [] as { command: string; args: string[]; env: NodeJS.ProcessEnv; cwd?: unknown }[]
);
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (command: string, args: string[], options: SpawnOptions) => {
      spawned.push({ command, args, env: { ...(options?.env ?? {}) }, cwd: options?.cwd });
      return actual.spawn(command, args, options);
    },
  };
});

// Pids that the process search reports besides the real ones: a pid that
// another program has by the time argent signals it.
const searched = vi.hoisted(() => ({ extraPids: [] as number[] }));
vi.mock("../src/utils/macos-apps", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/utils/macos-apps")>();
  return {
    ...actual,
    findRunningCopies: async (...args: Parameters<typeof actual.findRunningCopies>) => {
      const found = await actual.findRunningCopies(...args);
      return { ...found, same: [...found.same, ...searched.extraPids] };
    },
  };
});

// list-devices: only the Mac branch is under test, so the other platforms'
// discovery returns nothing instead of running simctl, adb or the Vega CLI.
vi.mock("../src/utils/ios-devices", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/ios-devices")>()),
  listIosSimulators: vi.fn(async () => []),
}));
vi.mock("../src/utils/ios-device/devicectl", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/ios-device/devicectl")>()),
  listIosPhysicalDevices: vi.fn(async () => []),
}));
vi.mock("../src/utils/sim-remote", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/sim-remote")>()),
  simctlListDevices: vi.fn(async () => {
    throw new Error("no sim-remote here");
  }),
}));
vi.mock("../src/utils/adb", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/adb")>()),
  listAndroidDevices: vi.fn(async () => []),
  listAvds: vi.fn(async () => []),
}));
vi.mock("../src/utils/chromium-discovery", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/chromium-discovery")>()),
  discoverChromiumDevices: vi.fn(async () => []),
}));
vi.mock("../src/utils/vega-devices", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/vega-devices")>()),
  listVegaDevices: vi.fn(async () => []),
}));
vi.mock("../src/utils/external-devices", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/external-devices")>()),
  listExternalDevices: vi.fn(async () => []),
}));

import { setFlag } from "@argent/configuration-core";
import { FAILURE_CODES, getFailureSignal, Registry, type ToolDefinition } from "@argent/registry";
import { macosAppBlueprint, macosAppRef } from "../src/blueprints/macos-app";
import type { MacosAppApi } from "../src/blueprints/macos-app";
import { listDevicesTool } from "../src/tools/devices/list-devices";
import { createBootDeviceTool } from "../src/tools/devices/boot-device";
import { createLaunchAppTool } from "../src/tools/launch-app";
import { createRestartAppTool } from "../src/tools/restart-app";
import { openUrlTool } from "../src/tools/open-url";
import { createNativeNetworkLogsTool } from "../src/tools/native-devtools/native-network-logs";
import { createNetworkCaptureStartTool } from "../src/tools/network/network-capture-start";
import { createNetworkCaptureStopTool } from "../src/tools/network/network-capture-stop";
import { networkRequestTool } from "../src/tools/network/network-request";
import { createStopSimulatorServerTool } from "../src/tools/simulator/stop-simulator-server";
import { resolveDevice } from "../src/utils/device-info";
import { NOT_RECONNECTED, PROCESS_ENDED } from "../src/utils/native-network-record";
import { MACOS_NO_BODIES } from "../src/blueprints/ios-network-records";
import {
  chromiumRefusal,
  findRunningCopies,
  getTrackedMacosApp,
  hardenedRuntimeRefusal,
  inspectMacosApp,
  macosVersionRefusal,
  otherWorktreeOfBuild,
  parseCodesignDisplay,
  processRunsExecutable,
  recordTrackedMacosApp,
  removeUnusedLibraries,
  runningTrackedApp,
  stageLibraryFor,
  stageMacosLibraries,
  type MacosAppInfo,
} from "../src/utils/macos-apps";

const BUNDLE_ID = `com.argent.fake${process.pid}`;
const STAGED_BOOTSTRAP =
  /\/\.argent\/macos\/lib\/[0-9a-f]{16}\/libArgentInjectionBootstrap\.dylib$/;
const DEVICE_ID = `macos-app-${BUNDLE_ID}`;
const FIXTURES = path.join(__dirname, "fixtures", "macos-fake-library");

let root = "";
let appPath = "";
let executable = "";
let registry: Registry;
let tools: Record<string, ToolDefinition<any, any>>;

function writeBundle(dir: string, bundleId: string, extraPlist = ""): string {
  const app = path.join(dir, "Fake.app");
  fs.mkdirSync(path.join(app, "Contents", "MacOS"), { recursive: true });
  fs.writeFileSync(
    path.join(app, "Contents", "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${bundleId}</string>
<key>CFBundleExecutable</key><string>FakeApp</string>
<key>CFBundleName</key><string>Fake</string>
<key>CFBundlePackageType</key><string>APPL</string>${extraPlist}
</dict></plist>
`
  );
  // Never executed: the fake helper runs Node with this path as argv[0].
  fs.writeFileSync(path.join(app, "Contents", "MacOS", "FakeApp"), "#!/bin/sh\nexit 0\n", {
    mode: 0o755,
  });
  return fs.realpathSync(app);
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Every process that runs the fake executable, found the way argent finds them. */
function fakeAppPids(of: string = executable): number[] {
  const out = execFileSync("ps", ["-axo", "pid=,comm="], { encoding: "utf8" });
  return out
    .split("\n")
    .map((line) => /^\s*(\d+)\s+(.*)$/.exec(line))
    .filter((m): m is RegExpExecArray => m !== null && m[2] === of)
    .map((m) => Number(m[1]));
}

/**
 * Every process that runs an executable under the suite's directory: the fake
 * app of any bundle there, also one that runs as a launcher's `<executable>.sh`.
 */
function suitePids(): number[] {
  const out = execFileSync("ps", ["-ww", "-axo", "pid=,comm="], { encoding: "utf8" });
  return out
    .split("\n")
    .map((line) => /^\s*(\d+)\s+(.*)$/.exec(line))
    .filter((m): m is RegExpExecArray => m !== null && m[2]!.startsWith(`${root}/`))
    .map((m) => Number(m[1]));
}

async function waitUntil(check: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** The user quits the app outside argent. */
async function quit(pid: number): Promise<void> {
  process.kill(pid, "SIGTERM");
  await waitUntil(() => !pidAlive(pid));
}

function macosApp(reg: Registry = registry, deviceId = DEVICE_ID): Promise<MacosAppApi> {
  const ref = macosAppRef(resolveDevice(deviceId));
  return reg.resolveService<MacosAppApi>(ref.urn, ref.options);
}

async function run(tool: string, params: Record<string, unknown>): Promise<any> {
  return registry.invokeTool(tool, params);
}

async function macosEntries(): Promise<any[]> {
  const { devices } = await run("list-devices", {});
  return devices.filter((d: { platform: string }) => d.platform === "macos");
}

function codeOf(err: unknown): string | undefined {
  return getFailureSignal(err)?.error_code;
}

describe.skipIf(process.platform !== "darwin")("Mac app lifecycle (fake library)", () => {
  beforeAll(() => {
    // A short HOME: the listening socket lives under it, and sun_path holds 103 bytes.
    root = fs.realpathSync(fs.mkdtempSync("/tmp/amf-"));
    native.dir = path.join(root, "native");
    fs.mkdirSync(native.dir);
    for (const lib of ["libArgentInjectionBootstrap.dylib", "libNativeDevtoolsMacos.dylib"]) {
      fs.writeFileSync(path.join(native.dir, lib), `stand-in ${lib}`);
    }
    // Node directly, no shell: a shell (SIP-protected) would drop a
    // DYLD_INSERT_LIBRARIES that wrongly reached the helper and hide the bug.
    fs.writeFileSync(
      path.join(native.dir, "argent-macos-helper"),
      `#!${process.execPath}\nrequire(${JSON.stringify(path.join(FIXTURES, "fake-helper.cjs"))});\n`,
      { mode: 0o755 }
    );
    appPath = writeBundle(path.join(root, "apps"), BUNDLE_ID);
    executable = path.join(appPath, "Contents", "MacOS", "FakeApp");
  });

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  beforeEach(() => {
    vi.stubEnv("HOME", path.join(root, `home-${Math.random().toString(36).slice(2, 8)}`));
    fs.mkdirSync(process.env.HOME!);
    setFlag("macos-apps", true, "global");
    native.missing = false;
    spawned.length = 0;
    searched.extraPids = [];
    registry = new Registry();
    registry.registerBlueprint(macosAppBlueprint);
    tools = {
      "list-devices": listDevicesTool,
      "boot-device": createBootDeviceTool(registry),
      "launch-app": createLaunchAppTool(registry),
      "restart-app": createRestartAppTool(registry),
      "open-url": openUrlTool,
      "native-network-logs": createNativeNetworkLogsTool(registry),
      "network-capture-start": createNetworkCaptureStartTool(registry),
      "network-capture-stop": createNetworkCaptureStopTool(registry),
      "view-network-request-details": networkRequestTool,
      "stop-simulator-server": createStopSimulatorServerTool(registry),
    };
    for (const tool of Object.values(tools)) registry.registerTool(tool);
  });

  afterEach(async () => {
    await registry.dispose();
    // Also a copy that the code under test failed to stop, of another bundle or
    // under another name. An outside copy's process group holds its
    // `/bin/sleep`, also when the test failed before it learned that pid.
    const tracked = await runningTrackedApp(BUNDLE_ID);
    if (tracked) leftovers.push(tracked.pid);
    for (const pid of [...suitePids(), ...leftovers.splice(0)]) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // already gone
        }
      }
    }
    vi.unstubAllEnvs();
  });

  /** Processes a test started outside the fake app: argent must leave them alone. */
  const leftovers: number[] = [];

  /**
   * A copy of the app that argent did not start (outside-copy.cjs), as when
   * the user opens the app or Xcode Run starts it: the bundle executable is
   * its `argv[0]`. `child` runs `/bin/sleep` in the copy's process group.
   */
  async function startOutsideCopy(
    ...flags: string[]
  ): Promise<{ pid: number; child: number; signals: () => string[] }> {
    return startOutsideCopyOf(executable, ...flags);
  }

  async function startOutsideCopyOf(
    bundleExecutable: string,
    ...flags: string[]
  ): Promise<{ pid: number; child: number; signals: () => string[] }> {
    const report = path.join(root, `outside-${Math.random().toString(36).slice(2, 8)}.json`);
    const copy = spawn(
      process.execPath,
      [path.join(FIXTURES, "outside-copy.cjs"), report, ...flags],
      { argv0: bundleExecutable, detached: true, stdio: "ignore" }
    );
    const pid = copy.pid!;
    leftovers.push(pid);
    let child = 0;
    await waitUntil(() => {
      try {
        child = (JSON.parse(fs.readFileSync(report, "utf8")) as { child: number }).child;
      } catch {
        return false;
      }
      return fakeAppPids(bundleExecutable).includes(pid);
    });
    leftovers.push(child);
    const signals = () => {
      try {
        return fs.readFileSync(`${report}.signals`, "utf8").trim().split("\n");
      } catch {
        return [];
      }
    };
    return { pid, child, signals };
  }

  const helperRuns = () =>
    spawned.filter((s) => s.command === path.join(native.dir, "argent-macos-helper")).length;

  it("boot-device starts the app through the helper with the library variables, and list-devices shows it", async () => {
    const booted = await run("boot-device", { macosAppPath: appPath });
    expect(booted).toMatchObject({
      platform: "macos",
      id: DEVICE_ID,
      bundleId: BUNDLE_ID,
      appPath,
      sandboxed: false,
      args: [],
      booted: true,
    });
    expect(booted.alreadyRunning).toBeUndefined();
    expect(fakeAppPids()).toEqual([booted.pid]);

    const app = await macosApp();
    expect(app.isConnected()).toBe(true);
    expect(app.handshake()).toEqual({
      bundleId: BUNDLE_ID,
      pid: booted.pid,
      platform: "macos",
      protocol: 1,
      libraryVersion: "fake",
    });
    await expect(app.call("Echo", { a: 1 })).resolves.toMatchObject({
      params: { a: 1 },
      pid: booted.pid,
    });

    expect(await macosEntries()).toEqual([
      {
        platform: "macos",
        kind: "app",
        id: DEVICE_ID,
        name: "Fake",
        bundleId: BUNDLE_ID,
        appPath,
        pid: booted.pid,
        state: "Running",
      },
    ]);
    expect(getTrackedMacosApp(BUNDLE_ID)).toMatchObject({
      bundleId: BUNDLE_ID,
      appPath,
      executable,
      pid: booted.pid,
      sandboxed: false,
      userSelectedReadOnly: false,
      listenSocket: path.join(process.env.HOME!, ".argent", "macos", `${BUNDLE_ID}.sock`),
      args: [],
    });
    expect(fs.statSync(path.join(process.env.HOME!, ".argent", "macos")).mode & 0o777).toBe(0o700);
    expect(fs.readFileSync(booted.logPath, "utf8")).toContain(`fake app ${BUNDLE_ID}`);

    // A second boot hands back the running app instead of a second copy.
    const again = await run("boot-device", { macosAppPath: appPath });
    expect(again).toMatchObject({ pid: booted.pid, alreadyRunning: true });
    expect(fakeAppPids()).toEqual([booted.pid]);
  });

  it("hands the helper the staged bootstrap as --insert-library, from /, with a Finder launch's environment only", async () => {
    // A DYLD_* or NATIVE_DEVTOOLS_* would redirect the injection or the channel;
    // argent's own token and port would let the app drive the tool-server.
    for (const [name, value] of Object.entries({
      DYLD_INSERT_LIBRARIES: "/inherited/elsewhere.dylib",
      DYLD_LIBRARY_PATH: "/somewhere",
      NATIVE_DEVTOOLS_LISTEN_SOCKET: "/stale.sock",
      ARGENT_AUTH_TOKEN: "secret-xyz",
      ARGENT_PORT: "4517",
      ARGENT_SECRET_APP_PASSWORD: "hunter2",
      argent_secret_lower: "hunter3",
      DB_PASSWORD: "hunter4",
    })) {
      vi.stubEnv(name, value);
    }
    await run("boot-device", { macosAppPath: appPath });
    const helper = spawned.filter(
      (s) => s.command === path.join(native.dir, "argent-macos-helper")
    );
    expect(helper).toHaveLength(1);
    const { args, env, cwd } = helper[0]!;
    expect(cwd).toBe("/");
    expect(env.DB_PASSWORD).toBeUndefined();
    const flag = args.indexOf("--insert-library");
    expect(flag).toBeGreaterThan(0);
    expect(flag).toBeLessThan(args.indexOf("--"));
    // The copy in ~/.argent, never the shipped file, which may sit in a
    // privacy-protected folder such as ~/Desktop.
    expect(
      args[flag + 1]!.startsWith(path.join(process.env.HOME!, ".argent", "macos", "lib"))
    ).toBe(true);
    expect(args[flag + 1]).toMatch(STAGED_BOOTSTRAP);
    expect(Object.keys(env).filter((k) => /^(dyld_|argent_)/i.test(k))).toEqual([
      "ARGENT_INJECT_BUNDLE_ID",
    ]);
    expect(env).toMatchObject({
      ARGENT_INJECT_BUNDLE_ID: BUNDLE_ID,
      NATIVE_DEVTOOLS_FD: "3",
      NATIVE_DEVTOOLS_LISTEN_SOCKET: path.join(
        process.env.HOME!,
        ".argent",
        "macos",
        `${BUNDLE_ID}.sock`
      ),
      PATH: process.env.PATH,
    });
  });

  it("returns from a launch only once the app shows a window", async () => {
    // The fake's window comes 200 ms after its handshake.
    await run("boot-device", { macosAppPath: appPath });
    const app = await macosApp();
    const { windows } = await app.call<{ windows: unknown[] }>("Window.list");
    expect(windows).toEqual([expect.objectContaining({ isVisible: true, isMiniaturized: false })]);
  });

  it.each(["windowless", "minimized"])(
    "a %s app still starts, with a note instead of a failure",
    async (mode) => {
      const app = await macosApp();
      const started = Date.now();
      const result = await app.launch({ appPath, args: [`--mode=${mode}`], windowTimeoutMs: 500 });
      expect(Date.now() - started).toBeGreaterThanOrEqual(400);
      expect(result.note).toMatch(/showed no window within 1 s/);
      expect(result.pid).toBe(getTrackedMacosApp(BUNDLE_ID)!.pid);
      expect(pidAlive(result.pid)).toBe(true);
      expect(app.isConnected()).toBe(true);
      // A restart would lose the state of an app that closed its last window.
      const again = await run("launch-app", { udid: DEVICE_ID, bundleId: BUNDLE_ID });
      expect(again.note).toMatch(
        mode === "windowless" ? /no open window.*menu-bar/ : /restart-app/
      );
    }
  );

  it.each([
    ["shows only a panel", "panel-only", ""],
    ["has no menu bar and no window", "windowless", "<key>LSUIElement</key><true/>"],
  ])("refuses an app that %s, and quits it", async (_name, mode, extraPlist) => {
    const bundle = writeBundle(path.join(root, `apps-${mode}`), BUNDLE_ID, extraPlist);
    const app = await macosApp();
    const failed = await app
      .launch({ appPath: bundle, args: [`--mode=${mode}`], windowTimeoutMs: 500 })
      .catch((e: unknown) => e);
    expect((failed as Error).message).toMatch(/shows no window that argent can drive/);
    expect(codeOf(failed)).toBe(FAILURE_CODES.MACOS_APP_BUNDLE_INVALID);
    expect(fakeAppPids(path.join(bundle, "Contents", "MacOS", "FakeApp"))).toEqual([]);
  });

  it("call() surfaces the library's errors and times out a request that gets no answer", async () => {
    await run("boot-device", { macosAppPath: appPath });
    const app = await macosApp();
    const failed = await app.call("Fail").catch((e: unknown) => e);
    expect((failed as Error).message).toBe("boom from the library");
    expect(codeOf(failed)).toBe(FAILURE_CODES.MACOS_APP_RPC_ERROR);
    await expect(app.call("Fail", { message: "No window" })).rejects.toThrow(
      /File > New.*menu-bar/
    );
    await expect(app.call("No.such")).rejects.toThrow("Unsupported method: No.such");

    const hung = await app.call("Hang", {}, { timeoutMs: 200 }).catch((e: unknown) => e);
    expect(codeOf(hung)).toBe(FAILURE_CODES.MACOS_APP_RPC_TIMEOUT);
    // The channel survives a timed-out request.
    await expect(app.call("Echo")).resolves.toMatchObject({ params: {} });

    // The library never runs a request after argent stopped waiting, unless told to.
    const sent = Date.now();
    const { deadline } = await app.call<{ deadline?: number }>("Echo", {}, { timeoutMs: 5_000 });
    expect(deadline).toBeGreaterThanOrEqual(sent + 5_000);
    expect(deadline).toBeLessThanOrEqual(Date.now() + 5_000);
    await expect(app.call("Echo", {}, { runLate: true })).resolves.not.toHaveProperty("deadline");
  });

  it("tells a call cut off by argent's own close apart from an app that quit", async () => {
    const { pid } = await run("boot-device", { macosAppPath: appPath });
    const urn = macosAppRef(resolveDevice(DEVICE_ID)).urn;

    // Another agent's stop-simulator-server while this call waits, and before the next
    // request of the same tool call (a drag, typing).
    const stopped = await macosApp();
    const pending = stopped.call("Hang", {}, { timeoutMs: 10_000 }).catch((e) => e);
    await new Promise((r) => setTimeout(r, 100));
    await registry.disposeService(urn);
    for (const closed of [await pending, await stopped.call("Echo").catch((e) => e)]) {
      expect(codeOf(closed)).toBe(FAILURE_CODES.MACOS_APP_CONNECTION_CLOSED);
      // Typing may have reached the app already: a blind retry would type it twice.
      expect((closed as Error).message).toMatch(
        /argent closed its connection.*check the app's state with describe before you retry/
      );
      expect((closed as Error).message).not.toMatch(/quit or crashed/);
    }
    // A read is safe to send again.
    const read = await stopped.call("Window.list").catch((e) => e);
    expect(codeOf(read)).toBe(FAILURE_CODES.MACOS_APP_CONNECTION_CLOSED);
    expect((read as Error).message).toMatch(/Retry the call: argent connects again/);
    await expect((await macosApp()).call("Echo")).resolves.toMatchObject({ pid });

    // The app itself going away is still reported as such.
    const lost = (await macosApp()).call("Hang", {}, { timeoutMs: 10_000 }).catch((e) => e);
    await new Promise((r) => setTimeout(r, 100));
    process.kill(pid, "SIGKILL");
    const quit = await lost;
    expect(codeOf(quit)).toBe(FAILURE_CODES.MACOS_APP_CONNECTION_LOST);
    expect((quit as Error).message).toMatch(/the app quit or crashed/);
  });

  it("reconnects through the listening socket when the channel is dropped or the tool-server restarts", async () => {
    const { pid } = await run("boot-device", { macosAppPath: appPath });
    await registry.disposeService(macosAppRef(resolveDevice(DEVICE_ID)).urn);

    const fresh = await macosApp();
    expect(fresh.isConnected()).toBe(false);
    await expect(fresh.call("Echo")).resolves.toMatchObject({ pid });
    expect(fresh.isConnected()).toBe(true);

    // Once the first tool-server is gone, a new one knows the app from
    // ~/.argent/macos-apps.json alone.
    await registry.disposeService(macosAppRef(resolveDevice(DEVICE_ID)).urn);
    const other = new Registry();
    other.registerBlueprint(macosAppBlueprint);
    await expect((await macosApp(other)).call("Echo")).resolves.toMatchObject({ pid });
    await other.dispose();
  });

  it("says when an app has no listening socket, and a restart after the connection is gone quits and starts it again", async () => {
    // No socket path under so long a HOME fits sun_path.
    vi.stubEnv("HOME", path.join(root, "h".repeat(90)));
    fs.mkdirSync(process.env.HOME!);
    setFlag("macos-apps", true, "global");
    const booted = await run("boot-device", { macosAppPath: appPath });
    expect(booted.note).toContain("too long for a listening socket");
    expect((await macosEntries())[0].note).toContain("too long for a listening socket");

    // This tool-server after a restart.
    await registry.disposeService(macosAppRef(resolveDevice(DEVICE_ID)).urn);
    const restarted = await run("restart-app", { udid: DEVICE_ID, bundleId: BUNDLE_ID });
    expect(restarted.note).toContain("force-quit");
    expect(pidAlive(booted.pid)).toBe(false);
    expect(fakeAppPids()).toHaveLength(1);
  });

  it("refuses an Electron app, which argent drives as a Chromium device", async () => {
    const electron = writeBundle(path.join(root, `electron-${Date.now()}`), BUNDLE_ID);
    fs.mkdirSync(path.join(electron, "Contents", "Frameworks", "Electron Framework.framework"), {
      recursive: true,
    });
    await expect(run("boot-device", { macosAppPath: electron })).rejects.toThrow(
      /is an Electron app/
    );
    expect(helperRuns()).toBe(0);
  });

  it("refuses a Mac Catalyst app, also as one slice of a universal binary", async () => {
    const catalyst = writeBundle(path.join(root, `catalyst-${Date.now()}`), BUNDLE_ID);
    // A 64-bit Mach-O header and one LC_BUILD_VERSION load command for platform 6, Mac Catalyst.
    const thin = Buffer.alloc(56);
    [0xfeedfacf, 0x0100000c, 0, 2, 1, 24].forEach((v, i) => thin.writeUInt32LE(v, i * 4));
    [0x32, 24, 6].forEach((v, i) => thin.writeUInt32LE(v, 32 + i * 4));
    const fat = Buffer.alloc(4096 + thin.length);
    [0xcafebabe, 1, 0x0100000c, 0, 4096, thin.length].forEach((v, i) =>
      fat.writeUInt32BE(v, i * 4)
    );
    thin.copy(fat, 4096);
    for (const executable of [thin, fat]) {
      fs.writeFileSync(path.join(catalyst, "Contents", "MacOS", "FakeApp"), executable);
      await expect(run("boot-device", { macosAppPath: catalyst })).rejects.toThrow(
        /is a Mac Catalyst \(UIKit\) app/
      );
    }
    expect(helperRuns()).toBe(0);
  });

  it("restart-app starts a new process under the same device id", async () => {
    const { pid } = await run("boot-device", { macosAppPath: appPath });
    const restarted = await run("restart-app", { udid: DEVICE_ID, bundleId: BUNDLE_ID });
    expect(restarted).toEqual({
      restarted: true,
      bundleId: BUNDLE_ID,
      appPath: fs.realpathSync(appPath),
      args: [],
    });
    const next = getTrackedMacosApp(BUNDLE_ID)!.pid;
    expect(next).not.toBe(pid);
    expect(pidAlive(pid)).toBe(false);
    expect(fakeAppPids()).toEqual([next]);
    expect((await macosEntries()).map((d) => [d.id, d.pid])).toEqual([[DEVICE_ID, next]]);
    await expect((await macosApp()).call("Echo")).resolves.toMatchObject({ pid: next });
  });

  describe("native network capture", () => {
    interface Listing {
      status: string;
      header: string;
      armed: boolean;
      started?: false;
      stopped?: true;
      count: number;
      total: number;
      requests: { id: string; url: string; state: string; status?: number; errorText?: string }[];
    }
    interface Capture {
      status: string;
      layers: Record<string, unknown>[];
    }
    const readLog = (extra: Record<string, unknown> = {}): Promise<Listing> =>
      run("native-network-logs", { udid: DEVICE_ID, bundleId: BUNDLE_ID, ...extra });
    const start = (): Promise<Capture> =>
      run("network-capture-start", { udid: DEVICE_ID, bundleId: BUNDLE_ID });
    const stop = (): Promise<Capture> =>
      run("network-capture-stop", { udid: DEVICE_ID, bundleId: BUNDLE_ID });
    const details = (requestId: string): Promise<any> =>
      run("view-network-request-details", { device_id: DEVICE_ID, requestId });
    const request = async (url: string, extra: Record<string, unknown> = {}) =>
      (
        await (
          await macosApp()
        ).call<{ network: { active: boolean; activations: number } }>("Net.request", {
          url,
          method: "GET",
          ...extra,
        })
      ).network;
    const urls = (log: Listing) => log.requests.map((r) => r.url);
    /** Reads the listing until `check` holds. */
    const readUntil = async (check: (log: Listing) => boolean): Promise<Listing> => {
      const deadline = Date.now() + 3_000;
      let log = await readLog();
      while (!check(log) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
        log = await readLog();
      }
      return log;
    };
    const GAP =
      "capture started while the app was already running, so the requests before that were not recorded";

    it("starts nothing on a read, and lists records with ids once network-capture-start armed the app", async () => {
      const { pid } = await run("boot-device", { macosAppPath: appPath });
      // A read only reads: before a start it reaches nothing in the app.
      expect(await readLog()).toMatchObject({ started: false, armed: false, count: 0, total: 0 });
      expect(await request("https://example.com/before")).toEqual({
        active: false,
        activations: 0,
      });

      expect(await start()).toEqual({
        status: "ok",
        layers: [{ layer: "macos-native", armed: true }],
      });
      expect(await request("https://example.com/a")).toEqual({ active: true, activations: 1 });
      const log = await readLog();
      expect(log.header).toBe(`macos-native: armed, 1 request (pid ${pid}; ${GAP})`);
      expect(log).toMatchObject({ armed: true, count: 1, total: 1 });
      expect(log.requests).toEqual([
        expect.objectContaining({
          id: expect.stringMatching(/^macos-[0-9a-f]{4}-\d+$/),
          method: "GET",
          url: "https://example.com/a",
          state: "complete",
          status: 200,
        }),
      ]);
      // The gap is said once.
      expect((await readLog()).header).toBe(`macos-native: armed, 1 request (pid ${pid})`);

      // Metro's own requests on `port` are left out; `limit` keeps the most
      // recent and 0 keeps none; `clear` hides what was listed.
      await request("http://localhost:8081/status");
      await request("https://example.com/b");
      expect(urls(await readLog())).toEqual(["https://example.com/a", "https://example.com/b"]);
      expect(urls(await readLog({ port: 8095 }))).toContain("http://localhost:8081/status");
      expect(urls(await readLog({ limit: 1 }))).toEqual(["https://example.com/b"]);
      expect(await readLog({ limit: 0 })).toMatchObject({ count: 0, total: 2, requests: [] });
      expect((await readLog({ clear: true })).count).toBe(2);
      expect((await readLog()).total).toBe(0);

      // A second start keeps capture as it is.
      expect((await start()).layers).toEqual([{ layer: "macos-native", armed: true }]);
      expect(await request("https://example.com/c")).toEqual({ active: true, activations: 1 });
      expect(urls(await readLog())).toEqual(["https://example.com/c"]);
    });

    it("gives a record's details with its secret headers redacted", async () => {
      await run("boot-device", { macosAppPath: appPath });
      await start();
      await request("https://example.com/secret", {
        headers: { Authorization: "Bearer fake-token", Accept: "application/json" },
      });
      const [line] = (await readLog()).requests;
      const found = await details(line!.id);
      expect(found).toMatchObject({
        requestId: line!.id,
        state: "complete",
        request: {
          url: "https://example.com/secret",
          method: "GET",
          headers: { Authorization: "[REDACTED]", Accept: "application/json" },
        },
        response: { status: 200, headers: { "Set-Cookie": "[REDACTED]" } },
      });
      // The fake keeps no bodies, as the Mac library does.
      expect(found.response.body).toBe(`[unavailable: ${MACOS_NO_BODIES}]`);
      expect(JSON.stringify(found)).not.toContain("fake-token");
      expect(JSON.stringify(found)).not.toContain("fake-secret");

      expect(await details("macos-0000-999999")).toBe(
        "Request macos-0000-999999 not found. Use native-network-logs to list the requests the Mac app native layer recorded."
      );
      // A Mac app has only native ids.
      expect(await details("rn-net-1")).toBe(
        "Request rn-net-1 not found. Use native-network-logs to list the requests the Mac app native layer recorded."
      );
    });

    it("arms the new process at restart-app, keeps the history and fails the old process's open request", async () => {
      // The fake app sends a request 150 ms after each start.
      await run("boot-device", { macosAppPath: appPath, macosAppArgs: ["--launch-request"] });
      await new Promise((r) => setTimeout(r, 300));
      await start();
      await request("https://example.com/held", { hold: true });
      expect((await readLog()).requests.map((r) => r.state)).toEqual(["pending"]);

      await run("restart-app", { udid: DEVICE_ID, bundleId: BUNDLE_ID });
      const pid = (await macosApp()).handshake()!.pid;
      const log = await readUntil((l) => l.total === 2);
      expect(log.requests.map((r) => [r.url, r.state, r.errorText])).toEqual([
        ["https://example.com/held", "failed", "the app process ended before the request finished"],
        ["https://example.com/launch", "complete", undefined],
      ]);
      expect(log.header).toBe(`macos-native: armed, 2 requests (pid ${pid})`);
    });

    it("fails an open request when argent reconnects to the same process, completes it if it ends there, and arms the new connection", async () => {
      await run("boot-device", { macosAppPath: appPath });
      await start();
      await request("https://example.com/first", { hold: true });
      const app = await macosApp();
      await app.call("Net.drop");
      await waitUntil(() => !app.isConnected());
      // A read does not reconnect, and names the call that does.
      expect((await readLog()).header).toBe(
        `macos-native: not armed, 1 request (the app is not connected; capture arms when argent starts the app or connects to it, as network-capture-start does; ${GAP})`
      );

      // The next call reconnects through the listening socket. The request
      // may have ended while argent was not connected, so it fails...
      await app.call("Echo");
      expect((await readLog()).requests.map((r) => [r.url, r.state, r.errorText])).toEqual([
        ["https://example.com/first", "failed", NOT_RECONNECTED],
      ]);
      // ...and argent armed the new connection before the call: an end that
      // comes there completes the request.
      await app.call("Net.finish");
      const log = await readUntil((l) => l.requests[0]?.state === "complete");
      expect(log.requests).toEqual([
        expect.objectContaining({ url: "https://example.com/first", state: "complete" }),
      ]);
      expect(log.requests[0]).not.toHaveProperty("errorText");
      expect(await request("https://example.com/second")).toEqual({
        active: true,
        activations: 2,
      });
      expect(urls(await readLog())).toEqual([
        "https://example.com/first",
        "https://example.com/second",
      ]);
    });

    it("leaves the requests of a quick reconnect open when the dropped connection's exit check ends", async () => {
      await run("boot-device", { macosAppPath: appPath });
      await start();
      const app = await macosApp();
      await app.call("Net.drop");
      await waitUntil(() => !app.isConnected());
      // argent reconnects before the 2 s check of the dropped connection ends.
      await request("https://example.com/new", { hold: true });
      await new Promise((r) => setTimeout(r, 2_500));
      expect((await readLog()).requests.map((r) => [r.url, r.state])).toEqual([
        ["https://example.com/new", "pending"],
      ]);
      await app.call("Net.finish");
      const log = await readUntil((l) => l.requests[0]?.state === "complete");
      expect(log.requests[0]).toMatchObject({ url: "https://example.com/new", state: "complete" });
    }, 15_000);

    it("fails an open request when the app exits on its own", async () => {
      const { pid } = await run("boot-device", { macosAppPath: appPath });
      await start();
      await request("https://example.com/held", { hold: true });
      process.kill(pid, "SIGKILL");
      await waitUntil(() => !pidAlive(pid));
      const log = await readUntil((l) => l.requests[0]?.state === "failed");
      expect(log.requests.map((r) => [r.url, r.state, r.errorText])).toEqual([
        ["https://example.com/held", "failed", PROCESS_ENDED],
      ]);
      expect(log.header).toMatch(/^macos-native: not armed, 1 request \(the app is not connected;/);
    });

    it("fails an open request once the connection drops while the app runs and argent does not reconnect", async () => {
      const { pid } = await run("boot-device", { macosAppPath: appPath });
      await start();
      await request("https://example.com/held", { hold: true });
      const app = await macosApp();
      await app.call("Net.drop");
      await waitUntil(() => !app.isConnected());
      // argent waits for the process to exit, then fails the request as not reconnected.
      const log = await readUntil((l) => l.requests[0]?.state === "failed");
      expect(log.requests.map((r) => [r.url, r.state, r.errorText])).toEqual([
        ["https://example.com/held", "failed", NOT_RECONNECTED],
      ]);
      expect(pidAlive(pid)).toBe(true);
    });

    it("stop-simulator-server ends the capture and drops its records: the next read says not started, and the app records nothing", async () => {
      await run("boot-device", { macosAppPath: appPath });
      await start();
      await request("https://example.com/a");
      const [{ id }] = (await readLog()).requests;

      expect(await run("stop-simulator-server", { udid: DEVICE_ID })).toEqual({
        stopped: true,
        udid: DEVICE_ID,
      });
      expect(await readLog()).toMatchObject({ started: false, armed: false, count: 0, total: 0 });
      expect(await details(id)).toBe(
        `Request ${id} not found. Native network capture is not started, so no requests are recorded. Call network-capture-start with udid and bundleId, repeat the action, then list the requests with native-network-logs.`
      );
      // The next connection starts with capture off.
      expect(await request("https://example.com/b")).toEqual({ active: false, activations: 1 });
      expect((await readLog()).total).toBe(0);
    });

    it("network-capture-stop turns capture off in the app and keeps the records until the next start", async () => {
      await run("boot-device", { macosAppPath: appPath });
      // A stop before any start leaves the app as it is.
      expect(await stop()).toEqual({
        status: "ok",
        layers: [
          {
            layer: "macos-native",
            armed: false,
            total: 0,
            reason: "capture was not started for this app",
          },
        ],
      });
      await start();
      await request("https://example.com/kept");
      expect(await stop()).toEqual({
        status: "ok",
        layers: [{ layer: "macos-native", armed: false, total: 1 }],
      });
      expect(await request("https://example.com/after-stop")).toEqual({
        active: false,
        activations: 1,
      });
      expect(await readLog()).toMatchObject({
        stopped: true,
        armed: false,
        header:
          "macos-native: stopped, 1 request (capture stopped by network-capture-stop; network-capture-start turns it on again)",
      });
      // The ids of a stopped capture keep working.
      const [kept] = (await readLog()).requests;
      expect(await details(kept!.id)).toMatchObject({ requestId: kept!.id, state: "complete" });

      // restart-app does not turn it on again; the next start does, and the history stays.
      await run("restart-app", { udid: DEVICE_ID, bundleId: BUNDLE_ID });
      expect(await request("https://example.com/after-restart")).toEqual({
        active: false,
        activations: 0,
      });
      expect((await start()).layers).toEqual([{ layer: "macos-native", armed: true }]);
      await request("https://example.com/again");
      expect(urls(await readLog())).toEqual([
        "https://example.com/kept",
        "https://example.com/again",
      ]);
    });

    it("says no gap when the start waits for a launch, which arms the new process, and says it after a stop and a new start", async () => {
      const booting = run("boot-device", {
        macosAppPath: appPath,
        macosAppArgs: ["--handshake-delay=500"],
      });
      // The start comes while the launch waits for the handshake, and waits for it.
      await waitUntil(() => fakeAppPids().length > 0);
      const [{ pid }, capture] = await Promise.all([booting, start()]);
      expect(capture.layers).toEqual([{ layer: "macos-native", armed: true }]);
      await request("https://example.com/x");
      expect((await readLog()).header).toBe(`macos-native: armed, 1 request (pid ${pid})`);

      // The process ran while capture was stopped, so a new start says so.
      await stop();
      await start();
      expect((await readLog()).header).toBe(`macos-native: armed, 1 request (pid ${pid}; ${GAP})`);
    });

    it("keeps capture off in the new process when network-capture-stop comes during a restart", async () => {
      const { pid } = await run("boot-device", { macosAppPath: appPath });
      await start();
      const restarting = run("restart-app", {
        udid: DEVICE_ID,
        bundleId: BUNDLE_ID,
        launchArgs: ["--handshake-delay=500"],
      });
      // The stop comes while the new process has not connected yet.
      await waitUntil(() => fakeAppPids().some((p) => p !== pid));
      const [, stopped] = await Promise.all([restarting, stop()]);
      expect(stopped.layers).toEqual([{ layer: "macos-native", armed: false, total: 0 }]);
      expect(await request("https://example.com/after")).toEqual({ active: false, activations: 0 });
      expect(await readLog()).toMatchObject({ stopped: true, total: 0 });
    });

    it("arms the app when argent starts it after a start that found it not running", async () => {
      expect((await start()).layers).toEqual([
        {
          layer: "macos-native",
          armed: false,
          reason: `${BUNDLE_ID} is not running; capture arms when boot-device or launch-app starts it`,
        },
      ]);
      expect((await readLog()).header).toBe(
        "macos-native: not armed, 0 requests (the app is not connected; capture arms when argent starts the app or connects to it, as network-capture-start does)"
      );
      const { pid } = await run("boot-device", { macosAppPath: appPath });
      expect(await request("https://example.com/x")).toEqual({ active: true, activations: 1 });
      // Capture was on before the app started, so nothing was missed.
      expect(await readLog()).toMatchObject({
        armed: true,
        header: `macos-native: armed, 1 request (pid ${pid})`,
      });
    });

    it("says so when the app does not acknowledge Network.enable or Network.disable", async () => {
      await run("boot-device", { macosAppPath: appPath, macosAppArgs: ["--mode=network-silent"] });
      const reason =
        "the app did not acknowledge Network.enable within 5 s; network-capture-start asks again";
      expect((await start()).layers).toEqual([{ layer: "macos-native", armed: false, reason }]);
      expect((await readLog()).header).toMatch(`macos-native: not armed, 0 requests (pid `);
      expect((await readLog()).header).toContain(reason);
      expect((await stop()).layers).toEqual([
        {
          layer: "macos-native",
          armed: true,
          total: 0,
          reason:
            "the app did not acknowledge Network.disable within 5 s; argent records none of its new requests, and its next process starts without capture",
        },
      ]);
    }, 20_000);

    it("refuses another app's bundle id", async () => {
      await run("boot-device", { macosAppPath: appPath });
      for (const tool of ["native-network-logs", "network-capture-start", "network-capture-stop"]) {
        const err = await run(tool, { udid: DEVICE_ID, bundleId: "com.argent.other" }).catch(
          (e: unknown) => e
        );
        expect(codeOf(err)).toBe(FAILURE_CODES.MACOS_APP_BUNDLE_ID_MISMATCH);
      }
    });
  });

  it("launch-app and restart-app refuse another app's bundle id", async () => {
    await run("boot-device", { macosAppPath: appPath });
    for (const tool of ["launch-app", "restart-app"]) {
      const err = await run(tool, { udid: DEVICE_ID, bundleId: "com.argent.other" }).catch(
        (e: unknown) => e
      );
      expect((err as Error).message).toContain("use device macos-app-com.argent.other");
      expect(codeOf(err)).toBe(FAILURE_CODES.MACOS_APP_BUNDLE_ID_MISMATCH);
    }
    // Nothing was stopped or started.
    expect(fakeAppPids()).toHaveLength(1);
  });

  it("boot-device uses exactly macosAppArgs; launch-app and restart-app reuse the last ones unless restart-app gets launchArgs", async () => {
    const argvOf = async () => (await (await macosApp()).call<{ argv: string[] }>("Echo")).argv;
    const ARGS = ["--locale-de", "-ApplePersistenceIgnoreState", "YES"];

    const booted = await run("boot-device", { macosAppPath: appPath, macosAppArgs: ARGS });
    expect(booted.args).toEqual(ARGS);
    expect(await argvOf()).toEqual(ARGS);
    // A boot with other arguments leaves the running app as it is, and says so.
    const kept = await run("boot-device", { macosAppPath: appPath, macosAppArgs: ["-Other"] });
    expect(kept).toMatchObject({ alreadyRunning: true, args: ARGS });
    expect(kept.note).toMatch(/did not get \["-Other"\]\. .*boot-device with force: true/);

    // Running already: launch-app reports the arguments the app runs with.
    expect((await run("launch-app", { udid: DEVICE_ID, bundleId: BUNDLE_ID })).args).toEqual(ARGS);
    // restart-app and launch-app start it again with the recorded arguments.
    expect(await run("restart-app", { udid: DEVICE_ID, bundleId: BUNDLE_ID })).toEqual({
      restarted: true,
      bundleId: BUNDLE_ID,
      appPath: fs.realpathSync(appPath),
      args: ARGS,
    });
    expect(await argvOf()).toEqual(ARGS);
    await quit(getTrackedMacosApp(BUNDLE_ID)!.pid);
    expect((await run("launch-app", { udid: DEVICE_ID, bundleId: BUNDLE_ID })).args).toEqual(ARGS);
    expect(await argvOf()).toEqual(ARGS);
    const relaunch = { udid: DEVICE_ID, bundleId: BUNDLE_ID, launchArgs: ["-New"] };
    expect((await run("restart-app", relaunch)).args).toEqual(["-New"]);
    expect(await argvOf()).toEqual(["-New"]);
    expect((await run("restart-app", { ...relaunch, launchArgs: [] })).args).toEqual([]);

    // An explicit boot never reuses them, with force or after a stop, also from
    // a new tool-server that knows them only from ~/.argent/macos-apps.json.
    const forced = await run("boot-device", { macosAppPath: appPath, force: true });
    expect(forced.args).toEqual([]);
    expect(await argvOf()).toEqual([]);
    await run("restart-app", { udid: DEVICE_ID, bundleId: BUNDLE_ID });
    expect(await argvOf()).toEqual([]);

    await quit(
      (await run("boot-device", { macosAppPath: appPath, macosAppArgs: ARGS, force: true })).pid
    );
    const other = new Registry();
    other.registerBlueprint(macosAppBlueprint);
    other.registerTool(createBootDeviceTool(other));
    try {
      const fresh = await other.invokeTool<{ args: string[] }>("boot-device", {
        macosAppPath: appPath,
      });
      expect(fresh.args).toEqual([]);
    } finally {
      await other.dispose();
    }
    expect(await argvOf()).toEqual([]);
  }, 20_000);

  it("launch-app leaves a running app alone; once it quits, calls name boot-device and launch-app, list-devices drops it, and launch-app starts it from the record", async () => {
    const { pid } = await run("boot-device", { macosAppPath: appPath });
    const running = await run("launch-app", { udid: DEVICE_ID, bundleId: BUNDLE_ID });
    expect(running).toMatchObject({ launched: true, bundleId: BUNDLE_ID });
    expect(running.note).toMatch(/already running/);
    expect(fakeAppPids()).toEqual([pid]);

    const app = await macosApp();
    await quit(pid);
    await waitUntil(() => !app.isConnected());
    const err = await app.call("Echo").catch((e: unknown) => e);
    expect(codeOf(err)).toBe(FAILURE_CODES.MACOS_APP_NOT_RUNNING);
    expect((err as Error).message).toMatch(/boot-device.*launch-app/);
    expect(await macosEntries()).toEqual([]);

    expect(await run("launch-app", { udid: DEVICE_ID, bundleId: BUNDLE_ID })).toEqual({
      launched: true,
      bundleId: BUNDLE_ID,
      appPath: fs.realpathSync(appPath),
      args: [],
    });
    expect(fakeAppPids()).toEqual([getTrackedMacosApp(BUNDLE_ID)!.pid]);
  });

  it("restart-app signals an app that ignores Application.terminate", async () => {
    const { pid } = await run("boot-device", {
      macosAppPath: appPath,
      macosAppArgs: ["--mode=ignore-terminate"],
    });
    expect(await run("restart-app", { udid: DEVICE_ID, bundleId: BUNDLE_ID })).toMatchObject({
      note: expect.stringMatching(/force-quit .*did not quit within 5 s\. Unsaved changes/),
    });
    expect(pidAlive(pid)).toBe(false);
    expect(fakeAppPids()).toEqual([getTrackedMacosApp(BUNDLE_ID)!.pid]);
  }, 20_000);

  it("restart-app and boot-device force leave an app that asks to save to the agent, also on a retry", async () => {
    const { pid } = await run("boot-device", {
      macosAppPath: appPath,
      macosAppArgs: ["--mode=ask-save"],
    });
    const expectRefused = async (attempt: () => Promise<unknown>) => {
      const err = await attempt().catch((e: unknown) => e);
      expect(codeOf(err)).toBe(FAILURE_CODES.MACOS_APP_TERMINATE_FAILED);
      expect((err as Error).message).toMatch(/shows a prompt.*describe/);
      expect(fakeAppPids()).toEqual([pid]);
    };
    const restart = () => run("restart-app", { udid: DEVICE_ID, bundleId: BUNDLE_ID });
    await expectRefused(restart);

    // The prompt still waits for its answer: asked to quit again, the app would quit without saving.
    await expectRefused(restart);
    await expectRefused(() => run("boot-device", { udid: DEVICE_ID, force: true }));

    // The agent cancels the prompt: the next restart asks the app again.
    await (await macosApp()).call("Prompt.cancel");
    await expectRefused(restart);
  }, 30_000);

  it("force-quits an app that a dialog of its own keeps from quitting, and notes a quit with a dialog open", async () => {
    const { pid } = await run("boot-device", {
      macosAppPath: appPath,
      macosAppArgs: ["--mode=ignore-terminate", "--alert"],
    });
    const restarted = await run("restart-app", {
      udid: DEVICE_ID,
      bundleId: BUNDLE_ID,
      launchArgs: ["--alert"],
    });
    expect(restarted.note).toMatch(/force-quit .*a dialog it showed kept it from quitting/);
    expect(pidAlive(pid)).toBe(false);

    // The dialog may be a save prompt that argent did not ask for: the quit closed it without saving.
    const second = getTrackedMacosApp(BUNDLE_ID)!.pid;
    expect(await run("restart-app", { udid: DEVICE_ID, bundleId: BUNDLE_ID })).toMatchObject({
      note: expect.stringMatching(/quit .* while it showed a dialog\. Unsaved changes/),
    });
    expect(pidAlive(second)).toBe(false);
    expect(fakeAppPids()).toEqual([getTrackedMacosApp(BUNDLE_ID)!.pid]);
  }, 20_000);

  it.each([
    [
      "exits before the library answers",
      "--mode=crash",
      "EXITED_BEFORE_READY",
      /crashing on purpose/,
    ],
    ["never answers", "--mode=silent", "HANDSHAKE_TIMEOUT", /main thread/],
    ["speaks another protocol", "--mode=bad-protocol", "HANDSHAKE_INVALID", /protocol 2/],
    ["is refused by the helper", "--helper-fails", "SPAWN_FAILED", /refused on purpose/],
  ] as const)(
    "a launch whose app %s fails with its reason and leaves no copy",
    async (_l, arg, code, reason) => {
      const err = await (
        await macosApp()
      )
        .launch({ appPath, args: [arg], handshakeTimeoutMs: 1_000 })
        .catch((e: unknown) => e);
      expect(codeOf(err)).toBe(FAILURE_CODES[`MACOS_APP_${code}`]);
      expect((err as Error).message).toMatch(reason);
      await waitUntil(() => fakeAppPids().length === 0);
    }
  );

  it("stops an app whose library never answers also when it runs under another name, as a launcher script does", async () => {
    const err = await (
      await macosApp()
    )
      .launch({ appPath, args: ["--mode=silent", "--as-launcher"], handshakeTimeoutMs: 1_000 })
      .catch((e: unknown) => e);
    expect(codeOf(err)).toBe(FAILURE_CODES.MACOS_APP_HANDSHAKE_TIMEOUT);
    expect((err as Error).message).toContain("argent stopped it again");
    await waitUntil(() => fakeAppPids(`${executable}.sh`).length === 0);
  });

  it("without force, refuses to start a second copy beside one argent did not start, and names force", async () => {
    const outside = await startOutsideCopy();
    const err = await run("boot-device", { macosAppPath: appPath }).catch((e: unknown) => e);
    expect(codeOf(err)).toBe(FAILURE_CODES.MACOS_APP_ALREADY_RUNNING);
    expect((err as Error).message).toContain(`pid ${outside.pid}`);
    expect((err as Error).message).toContain("boot-device with force: true");
    expect((err as Error).message).toContain("Unsaved changes in that copy are lost");
    // Nothing was signalled or started.
    expect(outside.signals()).toEqual([]);
    expect(fakeAppPids()).toEqual([outside.pid]);
    expect(helperRuns()).toBe(0);
  });

  it("refuses a copy of another build of the app (another worktree's), also with force", async () => {
    // The same bundle id in another bundle, as another worktree builds it.
    const otherBuild = writeBundle(path.join(root, `worktree-${Date.now()}`), BUNDLE_ID);
    const otherExecutable = path.join(otherBuild, "Contents", "MacOS", "FakeApp");
    const outside = await startOutsideCopyOf(otherExecutable);
    for (const params of [{ macosAppPath: appPath }, { macosAppPath: appPath, force: true }]) {
      const err = await run("boot-device", params).catch((e: unknown) => e);
      expect(codeOf(err)).toBe(FAILURE_CODES.MACOS_APP_ALREADY_RUNNING);
      expect((err as Error).message).toContain(`${otherBuild} (pid ${outside.pid})`);
      expect((err as Error).message).toContain("a different build");
      expect((err as Error).message).not.toContain("force");
    }
    // The other build's copy was neither signalled nor joined by a second copy.
    expect(outside.signals()).toEqual([]);
    expect(fakeAppPids(otherExecutable)).toEqual([outside.pid]);
    expect(fakeAppPids()).toEqual([]);
    expect(helperRuns()).toBe(0);
  });

  it("refuses to boot another build while argent runs one, and leaves that copy alone", async () => {
    const first = await run("boot-device", { macosAppPath: appPath });
    const otherBuild = writeBundle(path.join(root, `worktree-${Date.now()}`), BUNDLE_ID);
    const err = await run("boot-device", { macosAppPath: otherBuild }).catch((e: unknown) => e);
    expect(codeOf(err)).toBe(FAILURE_CODES.MACOS_APP_ALREADY_RUNNING);
    expect((err as Error).message).toContain(`already runs from ${appPath} (pid ${first.pid})`);
    expect((err as Error).message).toContain("may belong to another agent or worktree");
    expect((err as Error).message).not.toContain("force");
    // The running copy is still the one argent drives.
    expect(pidAlive(first.pid)).toBe(true);
    await expect((await macosApp()).call("Echo")).resolves.toMatchObject({ pid: first.pid });
    expect(helperRuns()).toBe(1);
  });

  it("boot-device with force never quits argent's copy of another build, also after a tool-server restart", async () => {
    const first = await run("boot-device", { macosAppPath: appPath });
    const otherBuild = writeBundle(path.join(root, `worktree-${Date.now()}`), BUNDLE_ID);
    const expectRefused = (err: unknown) => {
      expect(codeOf(err)).toBe(FAILURE_CODES.MACOS_APP_ALREADY_RUNNING);
      expect((err as Error).message).toContain(`already runs from ${appPath} (pid ${first.pid})`);
      expect((err as Error).message).toContain("Quit that copy if it is yours");
      expect((err as Error).message).not.toContain("force");
      expect(pidAlive(first.pid)).toBe(true);
    };
    // The same tool-server, which the agents of a user share: the copy may be another agent's.
    expectRefused(
      await run("boot-device", { macosAppPath: otherBuild, force: true }).catch((e) => e)
    );
    await expect((await macosApp()).call("Echo")).resolves.toMatchObject({ pid: first.pid });

    // The tool-server after a restart (a stop, a crash).
    await registry.disposeService(macosAppRef(resolveDevice(DEVICE_ID)).urn);
    const other = new Registry();
    other.registerBlueprint(macosAppBlueprint);
    other.registerTool(createBootDeviceTool(other));
    try {
      expectRefused(
        await other
          .invokeTool("boot-device", { macosAppPath: otherBuild, force: true })
          .catch((e) => e)
      );
    } finally {
      await other.dispose();
    }
    expect(getTrackedMacosApp(BUNDLE_ID)).toMatchObject({ pid: first.pid, appPath });
    expect(helperRuns()).toBe(1);
  });

  it("a refused restart-app or forced boot leaves argent's copy running", async () => {
    const own = await run("boot-device", { macosAppPath: appPath });
    // Another build starts outside argent, as Xcode Run in another worktree does.
    const otherBuild = writeBundle(path.join(root, `worktree-${Date.now()}`), BUNDLE_ID);
    const outside = await startOutsideCopyOf(path.join(otherBuild, "Contents", "MacOS", "FakeApp"));
    for (const attempt of [
      () => run("restart-app", { udid: DEVICE_ID, bundleId: BUNDLE_ID }),
      () => run("boot-device", { macosAppPath: appPath, force: true }),
    ]) {
      const err = await attempt().catch((e: unknown) => e);
      expect(codeOf(err)).toBe(FAILURE_CODES.MACOS_APP_ALREADY_RUNNING);
      expect((err as Error).message).toContain(`${otherBuild} (pid ${outside.pid})`);
      expect(pidAlive(own.pid)).toBe(true);
      await expect((await macosApp()).call("Echo")).resolves.toMatchObject({ pid: own.pid });
    }
    expect(outside.signals()).toEqual([]);
    expect(helperRuns()).toBe(1);
  });

  it("a restart-app refused for the rebuilt bundle leaves argent's copy running", async () => {
    const rebuilt = writeBundle(path.join(root, `rebuilt-${Date.now()}`), BUNDLE_ID);
    const own = await run("boot-device", { macosAppPath: rebuilt });
    // Built again with the hardened runtime while the copy runs.
    execFileSync("codesign", ["--force", "--sign", "-", "--options", "runtime", rebuilt], {
      stdio: "ignore",
    });
    const err = await run("restart-app", { udid: DEVICE_ID, bundleId: BUNDLE_ID }).catch(
      (e: unknown) => e
    );
    expect(codeOf(err)).toBe(FAILURE_CODES.MACOS_APP_HARDENED_RUNTIME);
    expect(pidAlive(own.pid)).toBe(true);
    await expect((await macosApp()).call("Echo")).resolves.toMatchObject({ pid: own.pid });
  });

  it("boot-device with force quits argent's copy and the copies argent did not start, each alone, with SIGTERM then SIGKILL", async () => {
    const own = await run("boot-device", { macosAppPath: appPath });
    const outside = await startOutsideCopy();
    const stubborn = await startOutsideCopy("--ignore-term");
    const booted = await run("boot-device", { macosAppPath: appPath, force: true });
    expect(booted.alreadyRunning).toBeUndefined();
    expect(booted.note).toContain(
      `argent quit the copy of ${BUNDLE_ID} that ran without the argent library ` +
        `(pid ${outside.pid}, ${stubborn.pid})`
    );
    expect(booted.note).toContain("Unsaved changes in that copy are lost.");
    for (const copy of [outside, stubborn]) {
      expect(copy.signals()).toEqual(["SIGTERM"]);
      expect(pidAlive(copy.pid)).toBe(false);
      // The copy alone got the signal, not the process group it leads.
      expect(pidAlive(copy.child)).toBe(true);
    }
    expect(pidAlive(own.pid)).toBe(false);
    expect(fakeAppPids()).toEqual([booted.pid]);
    expect(getTrackedMacosApp(BUNDLE_ID)?.pid).toBe(booted.pid);
    await expect((await macosApp()).call("Echo")).resolves.toMatchObject({ pid: booted.pid });
  }, 20_000);

  it("never signals a found pid that runs another program by then", async () => {
    // Before SIGTERM: the search listed the pid, which now runs /bin/sleep.
    const reused = spawn("/bin/sleep", ["30"], { stdio: "ignore" });
    leftovers.push(reused.pid!);
    searched.extraPids = [reused.pid!];
    const quiet = await run("boot-device", { macosAppPath: appPath, force: true });
    expect(quiet.note).toBeUndefined();
    expect(pidAlive(reused.pid!)).toBe(true);
    expect(fakeAppPids()).toEqual([quiet.pid]);
    searched.extraPids = [];

    // Between SIGTERM and SIGKILL: the copy becomes /bin/sleep under the same
    // pid when it gets SIGTERM, so it is alive but no longer the app.
    const shell = spawn(
      "/bin/sh",
      ["-c", "trap 'exec /bin/sleep 30' TERM; while :; do sleep 0.1; done"],
      { argv0: executable, detached: true, stdio: "ignore" }
    );
    leftovers.push(shell.pid!);
    await waitUntil(() => fakeAppPids().includes(shell.pid!));
    const booted = await run("boot-device", { macosAppPath: appPath, force: true });
    expect(booted.note).toContain(`(pid ${shell.pid})`);
    // SIGKILL would have ended it; it still runs as /bin/sleep.
    expect(pidAlive(shell.pid!)).toBe(true);
    expect(fakeAppPids()).toEqual([booted.pid]);
  }, 20_000);

  it("fails and starts nothing when a copy argent did not start survives the signals", async () => {
    const outside = await startOutsideCopy();
    const kill = process.kill.bind(process);
    // A process of another user: every signal but the liveness probe is refused.
    const spy = vi
      .spyOn(process, "kill")
      .mockImplementation((pid: number, signal?: string | number) => {
        if (pid === outside.pid && signal !== 0) {
          throw Object.assign(new Error(`kill EPERM`), { code: "EPERM" });
        }
        return kill(pid, signal);
      });
    let err: unknown;
    try {
      err = await run("boot-device", { macosAppPath: appPath, force: true }).catch((e) => e);
    } finally {
      spy.mockRestore();
    }
    expect(codeOf(err)).toBe(FAILURE_CODES.MACOS_APP_TERMINATE_FAILED);
    expect((err as Error).message).toContain(
      `argent could not quit the copy of ${BUNDLE_ID} that runs without the argent library ` +
        `(pid ${outside.pid})`
    );
    expect((err as Error).message).toContain("Quit it yourself");
    expect(outside.signals()).toEqual([]);
    expect(fakeAppPids()).toEqual([outside.pid]);
    expect(helperRuns()).toBe(0);
  });

  it("restart-app refuses while a copy argent did not start runs beside argent's own, and quits neither", async () => {
    const own = await run("boot-device", { macosAppPath: appPath });
    const outside = await startOutsideCopy();
    const err = await run("restart-app", { udid: DEVICE_ID, bundleId: BUNDLE_ID }).catch(
      (e: unknown) => e
    );
    expect(codeOf(err)).toBe(FAILURE_CODES.MACOS_APP_ALREADY_RUNNING);
    expect((err as Error).message).toContain(`pid ${outside.pid}`);
    expect(outside.signals()).toEqual([]);
    expect(pidAlive(own.pid)).toBe(true);
    await expect((await macosApp()).call("Echo")).resolves.toMatchObject({ pid: own.pid });
  });

  it("launch-app and restart-app refuse a copy argent did not start and name boot-device force; force takes it over", async () => {
    // A record, so launch-app and restart-app know the app's path.
    await quit((await run("boot-device", { macosAppPath: appPath })).pid);
    const outside = await startOutsideCopy();
    const launchesBefore = helperRuns();

    for (const tool of ["launch-app", "restart-app"]) {
      const err = await run(tool, { udid: DEVICE_ID, bundleId: BUNDLE_ID }).catch(
        (e: unknown) => e
      );
      expect(codeOf(err)).toBe(FAILURE_CODES.MACOS_APP_ALREADY_RUNNING);
      expect((err as Error).message).toContain(`pid ${outside.pid}`);
      expect((err as Error).message).toContain("ask the user to quit it");
      expect((err as Error).message).toContain("boot-device with force: true");
      expect((err as Error).message).not.toContain("restart-app does");
    }
    expect(outside.signals()).toEqual([]);
    expect(fakeAppPids()).toEqual([outside.pid]);
    expect(helperRuns()).toBe(launchesBefore);

    const restarted = await run("boot-device", { macosAppPath: appPath, force: true });
    expect(restarted).toMatchObject({ bundleId: BUNDLE_ID, args: [] });
    expect(restarted.note).toContain(
      `argent quit the copy of ${BUNDLE_ID} that ran without the argent library (pid ${outside.pid})`
    );
    expect(outside.signals()).toEqual(["SIGTERM"]);
    expect(pidAlive(outside.pid)).toBe(false);
    const next = getTrackedMacosApp(BUNDLE_ID)!.pid;
    expect(fakeAppPids()).toEqual([next]);
    await expect((await macosApp()).call("Echo")).resolves.toMatchObject({ pid: next });
  });

  it("never lists, connects to or signals a recorded pid that now belongs to another process", async () => {
    recordTrackedMacosApp({
      bundleId: BUNDLE_ID,
      appPath,
      executable,
      name: "Fake",
      // This test process: alive, but not the app.
      pid: process.pid,
      sandboxed: false,
      userSelectedReadOnly: false,
      listenSocket: null,
      logPath: path.join(root, "unused.log"),
      args: [],
      startedAt: Date.now(),
    });
    expect(await macosEntries()).toEqual([]);
    await expect((await macosApp()).call("Echo")).rejects.toThrow(/is not running/);
    // A restart starts a copy of its own instead of quitting this process.
    await run("restart-app", { udid: DEVICE_ID, bundleId: BUNDLE_ID });
    expect(fakeAppPids()).toEqual([getTrackedMacosApp(BUNDLE_ID)!.pid]);
  });

  it("names the missing native artifacts", async () => {
    native.missing = true;
    const err = await run("boot-device", { macosAppPath: appPath }).catch((e: unknown) => e);
    expect(codeOf(err)).toBe(FAILURE_CODES.MACOS_APP_LIBRARY_MISSING);
  });

  it("refuses an app whose bundle id is not the device's", async () => {
    const app = await macosApp(registry, "macos-app-com.argent.other");
    const err = await app.launch({ appPath }).catch((e: unknown) => e);
    expect(codeOf(err)).toBe(FAILURE_CODES.MACOS_APP_BUNDLE_ID_MISMATCH);
    expect((err as Error).message).toContain(`Its device id is ${DEVICE_ID}`);
  });

  it("with the flag off, hides running apps and refuses boot-device", async () => {
    await run("boot-device", { macosAppPath: appPath });
    setFlag("macos-apps", false, "global");
    expect(await macosEntries()).toEqual([]);
    await expect(run("boot-device", { macosAppPath: appPath })).rejects.toThrow(
      "the macos-apps flag is off"
    );
  });

  it("open-url needs the app running, a URL with a scheme, and a scheme the app declares", async () => {
    await expect(run("open-url", { udid: DEVICE_ID, url: "fake://x" })).rejects.toThrow(
      /is not running/
    );
    await run("boot-device", { macosAppPath: appPath });
    await expect(run("open-url", { udid: DEVICE_ID, url: "-a Safari" })).rejects.toThrow(
      /needs a scheme/
    );
    const undeclared = await run("open-url", { udid: DEVICE_ID, url: "Fake://x" }).catch(
      (e: unknown) => e
    );
    expect(codeOf(undeclared)).toBe(FAILURE_CODES.MACOS_APP_OPEN_URL_FAILED);
    expect((undeclared as Error).message).toContain(
      `${BUNDLE_ID} does not declare the URL scheme 'fake'`
    );
  });

  it("refuses an app with the hardened runtime", async () => {
    const hardened = writeBundle(path.join(root, `hardened-${Date.now()}`), BUNDLE_ID);
    execFileSync("codesign", ["--force", "--sign", "-", "--options", "runtime", hardened], {
      stdio: "ignore",
    });
    const info = await inspectMacosApp(hardened);
    expect(info).toMatchObject({ hardenedRuntime: true, sandboxed: false });
    expect(info.teamId).toBeUndefined();
    const err = await run("boot-device", { macosAppPath: hardened }).catch((e: unknown) => e);
    expect(codeOf(err)).toBe(FAILURE_CODES.MACOS_APP_HARDENED_RUNTIME);
    expect(fakeAppPids()).toEqual([]);
  });

  it.each([
    ["Electron Framework.framework", "electron"],
    ["Google Chrome Framework.framework", "browser"],
    ["Microsoft Edge Framework.framework", "browser"],
    ["Brave Browser Framework.framework", "browser"],
    ["Sparkle.framework", undefined],
    // A browser's name must be a whole word of the framework's name.
    ["Knowledge Framework.framework", undefined],
    ["Chromecast Framework.framework", undefined],
    ["Chromium Embedded Framework.framework", undefined],
    [null, undefined],
  ])("marks an app that ships %s as chromium %s", async (framework, kind) => {
    const app = writeBundle(
      path.join(root, `fw-${Math.random().toString(36).slice(2, 8)}`),
      BUNDLE_ID
    );
    if (framework)
      fs.mkdirSync(path.join(app, "Contents", "Frameworks", framework), { recursive: true });
    expect((await inspectMacosApp(app)).chromium).toBe(kind);
  });
});

describe.skipIf(process.platform !== "darwin")("process checks outside a UTF-8 locale", () => {
  const LOCALE_VARS = ["LANG", "LC_ALL", "LC_CTYPE"] as const;
  let dir = "";
  let sleeper: ReturnType<typeof spawn> | undefined;
  beforeEach(() => {
    // A tool-server started by launchd or an editor often has no locale; ps
    // then escapes every non-ASCII byte of a path.
    for (const name of LOCALE_VARS) vi.stubEnv(name, undefined);
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "argent-zażółć-")));
  });
  afterEach(() => {
    sleeper?.kill("SIGKILL");
    vi.unstubAllEnvs();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("sees an app whose executable path is not ASCII", async () => {
    const appDir = path.join(dir, "Żółw.app", "Contents", "MacOS");
    fs.mkdirSync(appDir, { recursive: true });
    const executable = path.join(appDir, "Żółw");
    fs.copyFileSync("/bin/sleep", executable);
    fs.chmodSync(executable, 0o755);
    sleeper = spawn(executable, ["30"], { stdio: "ignore" });
    const pid = sleeper.pid!;
    await waitUntil(() => pidAlive(pid));

    expect((await findRunningCopies("com.example.zolw", executable)).same).toEqual([pid]);
    expect(await processRunsExecutable(pid, executable)).toBe(true);
  });

  it.skipIf(process.platform !== "darwin")(
    "reads a process of another user as running, so a take-over reports it instead of skipping it",
    async () => {
      // launchd is root's: signalling it fails with EPERM.
      expect(await processRunsExecutable(1, "/sbin/launchd")).toBe(true);
    }
  );
});

describe("otherWorktreeOfBuild", () => {
  let dir = "";
  beforeEach(() => {
    // A commit to branch from: git 2.39, which macOS ships, has no `worktree add --orphan`.
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "argent-wt-")));
    execFileSync("git", ["init", "-q", "main"], { cwd: dir });
    const commit =
      "-c user.name=t -c user.email=t@t commit -q --allow-empty --no-verify --no-gpg-sign -m init";
    execFileSync("git", ["-C", "main", ...commit.split(" ")], { cwd: dir });
    execFileSync("git", ["-C", "main", "worktree", "add", "-q", "-b", "b", "../b"], { cwd: dir });
    execFileSync("git", ["init", "-q", "unrelated"], { cwd: dir });
    for (const tree of ["main", "b", "unrelated"]) {
      fs.mkdirSync(path.join(dir, tree, "macos", "build", "Focus.app"), { recursive: true });
    }
    fs.mkdirSync(path.join(dir, "loose", "Focus.app"), { recursive: true });
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const app = (tree: string) => path.join(dir, tree, "macos", "build", "Focus.app");

  it("names the other worktree whose build a flow in this worktree would start", async () => {
    expect(await otherWorktreeOfBuild(app("b"), path.join(dir, "main"))).toBe(path.join(dir, "b"));
    expect(await otherWorktreeOfBuild(app("main"), path.join(dir, "b"))).toBe(
      path.join(dir, "main")
    );
  });

  // plutil reads the info.plist: macOS only.
  it.skipIf(process.platform !== "darwin")(
    "follows a build in Xcode's DerivedData to the project its info.plist names",
    async () => {
      const derivedData = path.join(dir, "DerivedData", "Focus-abcdef");
      const built = path.join(derivedData, "Build", "Products", "Debug", "Focus.app");
      fs.mkdirSync(built, { recursive: true });
      fs.writeFileSync(
        path.join(derivedData, "info.plist"),
        `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>WorkspacePath</key>` +
          `<string>${path.join(dir, "b", "macos", "Focus.xcworkspace")}</string></dict></plist>`
      );
      expect(await otherWorktreeOfBuild(built, path.join(dir, "main"))).toBe(path.join(dir, "b"));
      expect(await otherWorktreeOfBuild(built, path.join(dir, "b"))).toBeNull();
    }
  );

  it("stays quiet for the same worktree, another repository and a build outside git", async () => {
    expect(await otherWorktreeOfBuild(app("main"), path.join(dir, "main"))).toBeNull();
    expect(await otherWorktreeOfBuild(app("main"), path.join(dir, "main", "macos"))).toBeNull();
    expect(await otherWorktreeOfBuild(app("unrelated"), path.join(dir, "main"))).toBeNull();
    expect(
      await otherWorktreeOfBuild(path.join(dir, "loose", "Focus.app"), path.join(dir, "main"))
    ).toBeNull();
    expect(await otherWorktreeOfBuild(app("b"), path.join(dir, "loose"))).toBeNull();
  });
});

const STDERR_RUNTIME =
  "Executable=/x/Contents/MacOS/X\nIdentifier=com.x\n" +
  "CodeDirectory v=20500 size=640 flags=0x10000(runtime) hashes=9+7 location=embedded\n";
const entitlements = (...keys: string[]) =>
  '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>' +
  keys.map((k) => `<key>${k}</key><true/>`).join("") +
  "<key>com.apple.security.cs.allow-jit</key><false/></dict></plist>";
const GTA = "com.apple.security.get-task-allow";
const DLV = "com.apple.security.cs.disable-library-validation";
const DYLD = "com.apple.security.cs.allow-dyld-environment-variables";

/** An app as inspectMacosApp reads it, from fake codesign output. */
function appInfo(hardenedRuntime: boolean, keys: string[], teamId?: string): MacosAppInfo {
  const team = teamId ? `TeamIdentifier=${teamId}\n` : "TeamIdentifier=not set\n";
  return {
    appPath: "/x.app",
    bundleId: "com.x",
    name: "X",
    executable: "/x.app/Contents/MacOS/X",
    catalyst: false,
    uiElement: false,
    ...parseCodesignDisplay({
      stdout: entitlements(...keys),
      stderr: (hardenedRuntime ? STDERR_RUNTIME : "flags=0x2(adhoc)\n") + team,
    }),
  };
}

describe("stageMacosLibraries", () => {
  let dir = "";
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "argent-macos-stage-"));
    vi.stubEnv("HOME", path.join(dir, "home"));
    fs.mkdirSync(process.env.HOME!);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const shipped = (version: string) => {
    const from = path.join(dir, `shipped-${version}`);
    fs.mkdirSync(from, { recursive: true });
    const bootstrap = path.join(from, "libArgentInjectionBootstrap.dylib");
    const library = path.join(from, "libNativeDevtoolsMacos.dylib");
    fs.writeFileSync(bootstrap, `bootstrap ${version}`);
    fs.writeFileSync(library, `library ${version}`);
    return [bootstrap, library] as const;
  };
  const libRoot = () => path.join(process.env.HOME!, ".argent", "macos", "lib");
  const libraryBeside = (bootstrap: string) =>
    path.join(path.dirname(bootstrap), "libNativeDevtoolsMacos.dylib");

  it("copies both files once into one private directory named after their contents", () => {
    const files = shipped("1");
    const staged = stageMacosLibraries(...files);
    expect(staged).toMatch(STAGED_BOOTSTRAP);
    expect(fs.readFileSync(staged, "utf8")).toBe("bootstrap 1");
    expect(fs.readFileSync(libraryBeside(staged), "utf8")).toBe("library 1");
    expect(fs.statSync(path.join(process.env.HOME!, ".argent", "macos")).mode & 0o777).toBe(0o700);
    // The same contents reuse the same files.
    const inode = fs.statSync(staged).ino;
    expect(stageMacosLibraries(...files)).toBe(staged);
    expect(fs.statSync(staged).ino).toBe(inode);
    expect(fs.readdirSync(libRoot())).toEqual([path.basename(path.dirname(staged))]);
  });

  it("gives new contents a new directory and keeps the old one for apps that still map it", () => {
    const old = stageMacosLibraries(...shipped("1"));
    const next = stageMacosLibraries(...shipped("2"));
    expect(path.dirname(next)).not.toBe(path.dirname(old));
    expect(fs.readFileSync(old, "utf8")).toBe("bootstrap 1");
    expect(fs.readFileSync(next, "utf8")).toBe("bootstrap 2");
    // A change in the library alone counts too.
    const [bootstrap, library] = shipped("3");
    fs.writeFileSync(bootstrap, "bootstrap 2");
    const third = stageMacosLibraries(bootstrap, library);
    expect(path.dirname(third)).not.toBe(path.dirname(next));
  });

  it("ignores half-written temporary directories and moves an incomplete one aside", () => {
    const files = shipped("1");
    const hash = path.basename(path.dirname(stageMacosLibraries(...files)));
    fs.rmSync(libRoot(), { recursive: true });
    // What a tool-server killed while staging leaves behind.
    fs.mkdirSync(path.join(libRoot(), `.tmp-${hash}-abc123`), { recursive: true });
    fs.writeFileSync(
      path.join(libRoot(), `.tmp-${hash}-abc123`, "libArgentInjectionBootstrap.dylib"),
      "half"
    );
    // A directory with the right name but only one file.
    fs.mkdirSync(path.join(libRoot(), hash));
    fs.writeFileSync(path.join(libRoot(), hash, "libArgentInjectionBootstrap.dylib"), "stale");

    const staged = stageMacosLibraries(...files);
    expect(staged).toBe(path.join(libRoot(), hash, "libArgentInjectionBootstrap.dylib"));
    expect(fs.readFileSync(staged, "utf8")).toBe("bootstrap 1");
    const entries = fs.readdirSync(libRoot()).sort();
    expect(entries.filter((e) => !e.startsWith("."))).toEqual([hash]);
    expect(entries.some((e) => e.startsWith(`.damaged-${hash}-`))).toBe(true);
    expect(entries).toContain(`.tmp-${hash}-abc123`);
  });

  it("removes the directories of other builds that no process maps", async () => {
    const make = (name: string) => {
      fs.mkdirSync(path.join(libRoot(), name), { recursive: true });
      fs.writeFileSync(path.join(libRoot(), name, "libNativeDevtoolsMacos.dylib"), name);
    };
    for (const name of ["aaaa", "aaaa-ABCDE12345", "bbbb", ".tmp-bbbb-x1", "dddd"]) make(name);
    const mapped = fs.openSync(path.join(libRoot(), "dddd", "libNativeDevtoolsMacos.dylib"), "r");
    try {
      await removeUnusedLibraries(libRoot(), "aaaa");
    } finally {
      fs.closeSync(mapped);
    }
    expect(fs.readdirSync(libRoot()).sort()).toEqual(["aaaa", "aaaa-ABCDE12345", "dddd"]);
  });

  it("keeps the directories of another installed version, also a team's, until that install is gone or changed", async () => {
    const [bootstrap1, library1] = shipped("1");
    const ours = path.basename(path.dirname(stageMacosLibraries(...shipped("2"))));
    const other = path.basename(path.dirname(stageMacosLibraries(bootstrap1, library1)));
    const otherTeam = path.basename(
      path.dirname(stageMacosLibraries(bootstrap1, library1, "ABCDE12345"))
    );
    expect(otherTeam).toBe(`${other}-ABCDE12345`);
    // A directory from before the sources file: no install claims it.
    fs.mkdirSync(path.join(libRoot(), "eeee"));
    const names = () => fs.readdirSync(libRoot()).sort();

    await removeUnusedLibraries(libRoot(), ours.slice(0, 16));
    expect(names()).toEqual([ours, other, otherTeam].sort());

    // That install is upgraded in place: its files no longer match.
    fs.writeFileSync(library1, "library 1b");
    await removeUnusedLibraries(libRoot(), ours.slice(0, 16));
    expect(names()).toEqual([ours]);
  });

  it("never reads an install in a privacy-protected folder, and keeps its directory", async () => {
    const ours = path.basename(path.dirname(stageMacosLibraries(...shipped("2"))));
    const protectedInstall = path.join(process.env.HOME!, "Desktop", "argent", "missing");
    fs.mkdirSync(path.join(libRoot(), "cccc"));
    fs.writeFileSync(
      path.join(libRoot(), "cccc", "sources"),
      `${JSON.stringify([`${protectedInstall}/a.dylib`, `${protectedInstall}/b.dylib`])}\n`
    );
    const read = vi.spyOn(fs.promises, "readFile");
    try {
      await removeUnusedLibraries(libRoot(), ours);
      expect(read.mock.calls.map(([file]) => String(file))).not.toContain(
        `${protectedInstall}/a.dylib`
      );
    } finally {
      read.mockRestore();
    }
    expect(fs.readdirSync(libRoot()).sort()).toEqual(["cccc", ours].sort());
  });

  it("keeps a directory while one of the installs that staged it remains", async () => {
    const [bootstrap1, library1] = shipped("1");
    const copyDir = path.join(dir, "shipped-1-copy");
    fs.cpSync(path.dirname(bootstrap1), copyDir, { recursive: true });
    const other = path.basename(path.dirname(stageMacosLibraries(bootstrap1, library1)));
    stageMacosLibraries(
      path.join(copyDir, path.basename(bootstrap1)),
      path.join(copyDir, path.basename(library1))
    );
    expect(
      fs
        .readFileSync(path.join(libRoot(), other, "sources"), "utf8")
        .trim()
        .split("\n")
    ).toHaveLength(2);
    const ours = path.basename(path.dirname(stageMacosLibraries(...shipped("2"))));
    fs.rmSync(path.dirname(bootstrap1), { recursive: true });
    await removeUnusedLibraries(libRoot(), ours);
    expect(fs.readdirSync(libRoot())).toContain(other);
    fs.rmSync(copyDir, { recursive: true });
    await removeUnusedLibraries(libRoot(), ours);
    expect(fs.readdirSync(libRoot())).toEqual([ours]);
  });

  describe("stageLibraryFor", () => {
    const TEAM = "ABCDE12345";
    const debugBuild = appInfo(true, [GTA], TEAM);
    const shippedPaths = () => {
      const [bootstrap, library] = shipped("1");
      return { bootstrap, library };
    };

    it("loads a team's hardened Debug build from a folder of the team's own once both files carry its signature", async () => {
      const read: string[] = [];
      const staged = await stageLibraryFor(debugBuild, shippedPaths(), async (file) => {
        read.push(file);
        return TEAM;
      });
      expect(path.basename(path.dirname(staged))).toMatch(new RegExp(`^[0-9a-f]{16}-${TEAM}$`));
      expect(read).toEqual([staged, libraryBeside(staged)]);
    });

    it("refuses with the folder and the codesign command until then, and never rewrites the folder", async () => {
      const files = shippedPaths();
      const err = await stageLibraryFor(debugBuild, files, async () => "OTHERTEAM1").catch(
        (e: unknown) => e
      );
      expect(codeOf(err)).toBe(FAILURE_CODES.MACOS_APP_HARDENED_RUNTIME);
      const [folder] = fs.readdirSync(libRoot()).map((name) => path.join(libRoot(), name));
      const message = (err as Error).message;
      expect(message).toContain(`signed by the team ${TEAM}`);
      expect(message).toContain("ENABLE_HARDENED_RUNTIME = NO in the Debug configuration");
      expect(message).toContain("com.apple.security.cs.disable-library-validation");
      expect(message).toContain(
        `codesign --force --sign "<identity of team ${TEAM}>" ` +
          `"${folder}/libArgentInjectionBootstrap.dylib" "${folder}/libNativeDevtoolsMacos.dylib"`
      );
      expect(message).toContain("the user runs this command, not the agent");
      expect(message).toContain("A Release build with the hardened runtime cannot be driven");

      // The user signs the files in place; the next launch takes them as they are.
      fs.writeFileSync(path.join(folder!, "libNativeDevtoolsMacos.dylib"), "signed by the user");
      const staged = await stageLibraryFor(debugBuild, files, async () => TEAM);
      expect(fs.readFileSync(libraryBeside(staged), "utf8")).toBe("signed by the user");
    });

    it("names a team's release build with allow-dyld-environment-variables a release build", async () => {
      const err = await stageLibraryFor(
        appInfo(true, [DYLD], TEAM),
        shippedPaths(),
        async () => undefined
      ).catch((e: unknown) => e);
      expect(codeOf(err)).toBe(FAILURE_CODES.MACOS_APP_HARDENED_RUNTIME);
      const message = (err as Error).message;
      expect(message).toContain(
        `is a release build with the hardened runtime, signed by the team ${TEAM}`
      );
      expect(message).toContain(`codesign --force --sign "<identity of team ${TEAM}>"`);
      expect(message).not.toContain("cannot be driven");
    });

    it.each([
      ["no hardened runtime", appInfo(false, [], TEAM)],
      ["disable-library-validation", appInfo(true, [GTA, DLV], TEAM)],
    ])("uses the shipped copy for %s, without reading a signature", async (_label, info) => {
      const readTeam = vi.fn(async () => TEAM);
      expect(await stageLibraryFor(info, shippedPaths(), readTeam)).toMatch(STAGED_BOOTSTRAP);
      expect(readTeam).not.toHaveBeenCalled();
    });
  });
});

describe("code signature rules", () => {
  it("reads the runtime flag, the team and the entitlements from codesign's output", () => {
    expect(
      parseCodesignDisplay({
        stdout: entitlements(
          "com.apple.security.app-sandbox",
          "com.apple.security.files.user-selected.read-only",
          DLV
        ),
        stderr: `${STDERR_RUNTIME}TeamIdentifier=ABCDE12345\nSealed Resources version=2\n`,
      })
    ).toEqual({
      hardenedRuntime: true,
      libraryValidation: false,
      sandboxed: true,
      userSelectedReadOnly: true,
      teamId: "ABCDE12345",
      entitlements: {
        getTaskAllow: false,
        disableLibraryValidation: true,
        allowDyldEnvironmentVariables: false,
      },
    });
    const adhoc = parseCodesignDisplay({
      stdout: "",
      stderr:
        "CodeDirectory v=20400 flags=0x20002(adhoc,linker-signed) hashes=1\nTeamIdentifier=not set\n",
    });
    expect(adhoc).toMatchObject({ hardenedRuntime: false, userSelectedReadOnly: false });
    expect(adhoc.teamId).toBeUndefined();
    expect(
      parseCodesignDisplay({ stdout: "", stderr: "flags=0x2002(adhoc,library-validation)\n" })
    ).toMatchObject({ hardenedRuntime: false, libraryValidation: true });
    expect(parseCodesignDisplay(null)).toMatchObject({ hardenedRuntime: false, sandboxed: false });
    // Read-write wins over read-only, as a panel's own grant would.
    const both = parseCodesignDisplay({
      stdout: entitlements(
        "com.apple.security.files.user-selected.read-only",
        "com.apple.security.files.user-selected.read-write"
      ),
      stderr: "",
    });
    expect(both.userSelectedReadOnly).toBe(false);
  });

  it.each([
    ["no hardened runtime", false, [], undefined, null],
    ["hardened runtime alone", true, [], undefined, "release"],
    ["hardened runtime alone, team-signed", true, [], "ABCDE12345", "release"],
    ["get-task-allow alone, ad hoc", true, [GTA], undefined, "debug"],
    ["get-task-allow alone, team-signed", true, [GTA], "ABCDE12345", null],
    ["disable-library-validation alone", true, [DLV], undefined, "release"],
    ["allow-dyld-environment-variables alone, ad hoc", true, [DYLD], undefined, "dyld"],
    ["get-task-allow + disable-library-validation", true, [GTA, DLV], undefined, null],
    [
      "allow-dyld-environment-variables + disable-library-validation",
      true,
      [DYLD, DLV],
      undefined,
      null,
    ],
  ])("%s: refusal %s", (_label, hardened, keys, team, kind) => {
    const refusal = hardenedRuntimeRefusal(appInfo(hardened as boolean, keys as string[], team));
    if (kind === null) {
      expect(refusal).toBeNull();
    } else if (kind === "release") {
      // No project setting opens a release build, so the refusal asks for no rebuild.
      expect(refusal).toMatch(/release build with the hardened runtime.*cannot drive it/);
      expect(refusal).toContain("apps from other developers");
      expect(refusal).not.toContain("ENABLE_HARDENED_RUNTIME");
    } else if (kind === "dyld") {
      expect(refusal).toMatch(/release build with the hardened runtime and the entitlement/);
      expect(refusal).toContain("com.apple.security.cs.disable-library-validation");
      expect(refusal).not.toContain("is a Debug build");
    } else {
      expect(refusal).toMatch(/Debug build with the hardened runtime/);
      expect(refusal).toContain("ENABLE_HARDENED_RUNTIME = NO in the Debug configuration");
      expect(refusal).toContain("com.apple.security.cs.disable-library-validation");
    }
  });

  it.each([
    ["ad hoc", appInfo(false, [])],
    ["disable-library-validation", appInfo(false, [DLV])],
    ["a hardened Debug build with disable-library-validation", appInfo(true, [GTA, DLV])],
  ])("refuses the library-validation flag at once: %s", (_label, info) => {
    expect(hardenedRuntimeRefusal({ ...info, libraryValidation: true })).toMatch(
      /signed with library validation .*Sign the app without that option/
    );
  });

  it("points an Electron app or a Chromium browser to argent's Chromium support", () => {
    const app = appInfo(false, []);
    expect(chromiumRefusal({ ...app, chromium: "electron" })).toContain(
      "boot-device with electronAppPath"
    );
    expect(chromiumRefusal({ ...app, chromium: "browser" })).toContain("--remote-debugging-port");
    expect(chromiumRefusal(app)).toBeNull();
  });

  it.each([
    ["22.6.0", false],
    ["23.3.0", false],
    ["23.4.0", true],
    ["24.0.0", true],
  ])("drives Mac apps on Darwin %s (macOS 14.4 is 23.4): %s", (release, supported) => {
    expect(macosVersionRefusal(release) === null).toBe(supported);
  });
});
