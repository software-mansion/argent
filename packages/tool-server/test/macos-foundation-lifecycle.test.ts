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
import { nativeNetworkLogsTool } from "../src/tools/native-devtools/native-network-logs";
import { resolveDevice } from "../src/utils/device-info";
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
      "native-network-logs": nativeNetworkLogsTool,
    };
    for (const tool of Object.values(tools)) registry.registerTool(tool);
  });

  afterEach(async () => {
    await registry.dispose();
    for (const pid of fakeAppPids()) {
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
    // A copy argent started from another bundle is not among fakeAppPids().
    const tracked = await runningTrackedApp(BUNDLE_ID);
    if (tracked) leftovers.push(tracked.pid);
    for (const pid of leftovers.splice(0)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already gone
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
      expect((closed as Error).message).toMatch(/argent closed its connection.*Retry the call/);
      expect((closed as Error).message).not.toMatch(/quit or crashed/);
    }
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

    // A second tool-server is turned away while this one is connected, and this one keeps
    // its connection.
    const other = new Registry();
    other.registerBlueprint(macosAppBlueprint);
    const second = await macosApp(other);
    const busy = await second.call("Echo").catch((e: unknown) => e);
    expect(codeOf(busy)).toBe(FAILURE_CODES.MACOS_APP_IN_USE);
    expect((busy as Error).message).toContain("another argent tool-server");
    expect((busy as Error).message).not.toContain("restart-app");
    await expect(fresh.call("Echo")).resolves.toMatchObject({ pid });
    // A start returns the same refusal, and a restart (restart-app, a flow launch, a forced
    // boot) leaves the app running: the other tool-server is still driving it. The refusal
    // comes first also when a check would refuse the restart too: here a copy of another
    // build runs outside argent.
    const otherBuild = writeBundle(path.join(root, `worktree-${Date.now()}`), BUNDLE_ID);
    await startOutsideCopyOf(path.join(otherBuild, "Contents", "MacOS", "FakeApp"));
    for (const takeOver of [false, true]) {
      const err = await second.launch({ takeOver }).catch((e: unknown) => e);
      expect(codeOf(err)).toBe(FAILURE_CODES.MACOS_APP_IN_USE);
    }
    expect(pidAlive(pid)).toBe(true);
    await expect(fresh.call("Echo")).resolves.toMatchObject({ pid });
    other.registerTool(openUrlTool);
    const url = { udid: DEVICE_ID, url: "https://example.com" };
    const busyUrl = await other.invokeTool("open-url", url).catch((e: unknown) => e);
    expect(codeOf(busyUrl)).toBe(FAILURE_CODES.MACOS_APP_IN_USE);

    // Once the first tool-server is gone, a new one knows the app from
    // ~/.argent/macos-apps.json alone.
    await registry.disposeService(macosAppRef(resolveDevice(DEVICE_ID)).urn);
    await expect(second.call("Echo")).resolves.toMatchObject({ pid });
    await other.dispose();
  });

  it("says when an app has no listening socket, and a restart from a tool-server that cannot reach it is refused", async () => {
    // No socket path under so long a HOME fits sun_path.
    vi.stubEnv("HOME", path.join(root, "h".repeat(90)));
    fs.mkdirSync(process.env.HOME!);
    setFlag("macos-apps", true, "global");
    const booted = await run("boot-device", { macosAppPath: appPath });
    expect(booted.note).toContain("too long for a listening socket");
    expect((await macosEntries())[0].note).toContain("too long for a listening socket");

    // This tool-server after a restart, or another one: either may not quit the app.
    await registry.disposeService(macosAppRef(resolveDevice(DEVICE_ID)).urn);
    const refused = await run("restart-app", { udid: DEVICE_ID, bundleId: BUNDLE_ID }).catch(
      (e: unknown) => e
    );
    expect(codeOf(refused)).toBe(FAILURE_CODES.MACOS_APP_NOT_CONNECTED);
    expect((refused as Error).message).toContain("call boot-device with force: true");
    expect(pidAlive(booted.pid)).toBe(true);
    const forced = await run("boot-device", { macosAppPath: appPath, force: true });
    expect(pidAlive(booted.pid)).toBe(false);
    expect(fakeAppPids()).toEqual([forced.pid]);
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

  it("restart-app starts a new process under the same device id", async () => {
    const { pid } = await run("boot-device", { macosAppPath: appPath });
    const restarted = await run("restart-app", { udid: DEVICE_ID, bundleId: BUNDLE_ID });
    expect(restarted).toEqual({ restarted: true, bundleId: BUNDLE_ID, args: [] });
    const next = getTrackedMacosApp(BUNDLE_ID)!.pid;
    expect(next).not.toBe(pid);
    expect(pidAlive(pid)).toBe(false);
    expect(fakeAppPids()).toEqual([next]);
    expect((await macosEntries()).map((d) => [d.id, d.pid])).toEqual([[DEVICE_ID, next]]);
    await expect((await macosApp()).call("Echo")).resolves.toMatchObject({ pid: next });
  });

  describe("native-network-logs", () => {
    interface NetworkLog {
      status: string;
      count: number;
      events: { method: string; params: any; timestamp: number }[];
    }
    const readLog = (extra: Record<string, unknown> = {}): Promise<NetworkLog> =>
      run("native-network-logs", { udid: DEVICE_ID, bundleId: BUNDLE_ID, ...extra });
    const request = async (url: string, count = 1) =>
      (
        await (
          await macosApp()
        ).call<{ network: { active: boolean; activations: number } }>("Net.request", {
          url,
          method: "GET",
          count,
        })
      ).network;

    it("turns the capture on at the first call and returns the app's network events", async () => {
      await run("boot-device", { macosAppPath: appPath });
      // Off until now, as on iOS: the first call has nothing to show.
      expect(await readLog()).toEqual({ status: "ok", count: 0, events: [] });

      // One request is three events; the CDP reply frame after them is not one.
      expect(await request("https://example.com/a")).toEqual({ active: true, activations: 1 });
      const log = await readLog();
      expect(log.count).toBe(3);
      expect(log.events.map((e) => e.method)).toEqual([
        "Network.requestWillBeSent",
        "Network.responseReceived",
        "Network.loadingFinished",
      ]);
      expect(log.events[0].params).toEqual({
        requestId: "fake-1",
        request: { url: "https://example.com/a", method: "GET", headers: {} },
      });
      expect(log.events.every((e) => typeof e.timestamp === "number")).toBe(true);

      // `limit` keeps the most recent; `clear` empties the log after the read.
      expect((await readLog({ limit: 1 })).events.map((e) => e.method)).toEqual([
        "Network.loadingFinished",
      ]);
      expect((await readLog({ clear: true })).count).toBe(3);
      expect((await readLog()).count).toBe(0);
    });

    it("keeps the newest 1000 events", async () => {
      await run("boot-device", { macosAppPath: appPath });
      await readLog();
      await request("https://example.com/many", 400);
      const log = await readLog({ limit: 5000 });
      expect(log.count).toBe(1000);
      // 1200 events: the first 200 are gone, so the log starts inside request 67.
      expect(log.events[0]).toMatchObject({
        method: "Network.loadingFinished",
        params: { requestId: "fake-67" },
      });
      expect(log.events[999].params.requestId).toBe("fake-400");
    });

    it("keeps the capture on across restart-app, which starts an empty log", async () => {
      // The fake app sends a request 150 ms after each start.
      await run("boot-device", { macosAppPath: appPath, macosAppArgs: ["--launch-request"] });
      await new Promise((r) => setTimeout(r, 300));
      // The capture was off at the launch, so that request is not in the log.
      expect((await readLog()).count).toBe(0);
      await request("https://example.com/before-restart");
      expect((await readLog()).count).toBe(3);

      await run("restart-app", { udid: DEVICE_ID, bundleId: BUNDLE_ID });
      let log = await readLog();
      const deadline = Date.now() + 3_000;
      while (log.count < 3 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
        log = await readLog();
      }
      // The new process's launch request, and nothing of the old process.
      expect(log.count).toBe(3);
      expect(log.events[0].params.request.url).toBe("https://example.com/launch");
    });

    it("keeps the log when the same process reconnects, and turns the capture on again", async () => {
      await run("boot-device", { macosAppPath: appPath });
      await readLog();
      await request("https://example.com/first");
      const app = await macosApp();
      await app.call("Net.drop");
      await waitUntil(() => !app.isConnected());

      // The next call reconnects through the listening socket and argent turns
      // the capture on again before the request.
      expect(await request("https://example.com/second")).toEqual({
        active: true,
        activations: 2,
      });
      const log = await readLog();
      expect(log.count).toBe(6);
      expect(
        log.events
          .filter((e) => e.method === "Network.requestWillBeSent")
          .map((e) => e.params.request.url)
      ).toEqual(["https://example.com/first", "https://example.com/second"]);
    });

    it("refuses another app's bundle id and fails when the app does not run", async () => {
      const { pid } = await run("boot-device", { macosAppPath: appPath });
      const mismatch = await readLog({ bundleId: "com.argent.other" }).catch((e: unknown) => e);
      expect(codeOf(mismatch)).toBe(FAILURE_CODES.MACOS_APP_BUNDLE_ID_MISMATCH);

      await quit(pid);
      const stopped = await readLog().catch((e: unknown) => e);
      expect(codeOf(stopped)).toBe(FAILURE_CODES.MACOS_APP_NOT_RUNNING);
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
  });

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
      args: [],
    });
    expect(fakeAppPids()).toEqual([getTrackedMacosApp(BUNDLE_ID)!.pid]);
  });

  it("restart-app signals an app that ignores Application.terminate", async () => {
    const { pid } = await run("boot-device", {
      macosAppPath: appPath,
      macosAppArgs: ["--mode=ignore-terminate"],
    });
    await run("restart-app", { udid: DEVICE_ID, bundleId: BUNDLE_ID });
    expect(pidAlive(pid)).toBe(false);
    expect(fakeAppPids()).toEqual([getTrackedMacosApp(BUNDLE_ID)!.pid]);
  }, 20_000);

  it("restart-app leaves an app that asks to save to the agent", async () => {
    const { pid } = await run("boot-device", {
      macosAppPath: appPath,
      macosAppArgs: ["--mode=ask-save"],
    });
    const err = await run("restart-app", { udid: DEVICE_ID, bundleId: BUNDLE_ID }).catch(
      (e: unknown) => e
    );
    expect(codeOf(err)).toBe(FAILURE_CODES.MACOS_APP_TERMINATE_FAILED);
    expect((err as Error).message).toMatch(/shows a prompt.*describe/);
    expect(fakeAppPids()).toEqual([pid]);
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

  it("boot-device with force replaces argent's copy with another build of the app", async () => {
    const first = await run("boot-device", { macosAppPath: appPath });
    const otherBuild = writeBundle(path.join(root, `worktree-${Date.now()}`), BUNDLE_ID);
    const booted = await run("boot-device", { macosAppPath: otherBuild, force: true });
    expect(booted.note).toBeUndefined();
    expect(pidAlive(first.pid)).toBe(false);
    expect(getTrackedMacosApp(BUNDLE_ID)).toMatchObject({ pid: booted.pid, appPath: otherBuild });
    await expect((await macosApp()).call("Echo")).resolves.toMatchObject({ pid: booted.pid });
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
  });

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
  });

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

  it("launch-app refuses a copy argent did not start and names boot-device force; restart-app takes it over", async () => {
    // A record, so launch-app and restart-app know the app's path.
    await quit((await run("boot-device", { macosAppPath: appPath })).pid);
    const outside = await startOutsideCopy();
    const launchesBefore = helperRuns();

    const err = await run("launch-app", { udid: DEVICE_ID, bundleId: BUNDLE_ID }).catch(
      (e: unknown) => e
    );
    expect(codeOf(err)).toBe(FAILURE_CODES.MACOS_APP_ALREADY_RUNNING);
    expect((err as Error).message).toContain(`pid ${outside.pid}`);
    expect((err as Error).message).toContain("boot-device with force: true");
    expect(outside.signals()).toEqual([]);
    expect(fakeAppPids()).toEqual([outside.pid]);
    expect(helperRuns()).toBe(launchesBefore);

    const restarted = await run("restart-app", { udid: DEVICE_ID, bundleId: BUNDLE_ID });
    expect(restarted).toMatchObject({ restarted: true, bundleId: BUNDLE_ID, args: [] });
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
    // No commit is needed: an orphan worktree shares the repository without one.
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "argent-wt-")));
    execFileSync("git", ["init", "-q", "main"], { cwd: dir });
    execFileSync("git", ["-C", "main", "worktree", "add", "-q", "--orphan", "-b", "b", "../b"], {
      cwd: dir,
    });
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

  it("removes the directories of other builds that no process maps and that no tool-server chose for a day", async () => {
    const dayAgo = Date.now() / 1000 - 25 * 60 * 60;
    const make = (name: string, old = true) => {
      fs.mkdirSync(path.join(libRoot(), name), { recursive: true });
      fs.writeFileSync(path.join(libRoot(), name, "libNativeDevtoolsMacos.dylib"), name);
      if (old) fs.utimesSync(path.join(libRoot(), name), dayAgo, dayAgo);
    };
    for (const name of ["aaaa", "aaaa-ABCDE12345", "bbbb", ".tmp-bbbb-x1", "dddd"]) make(name);
    make("cccc", false);
    const mapped = fs.openSync(path.join(libRoot(), "dddd", "libNativeDevtoolsMacos.dylib"), "r");
    try {
      await removeUnusedLibraries(libRoot(), "aaaa");
    } finally {
      fs.closeSync(mapped);
    }
    expect(fs.readdirSync(libRoot()).sort()).toEqual(["aaaa", "aaaa-ABCDE12345", "cccc", "dddd"]);
  });

  it("counts staging the same files again as choosing their directory", () => {
    const dir = path.dirname(stageMacosLibraries(...shipped("1")));
    fs.utimesSync(dir, 0, 0);
    stageMacosLibraries(...shipped("1"));
    expect(fs.statSync(dir).mtimeMs).toBeGreaterThan(Date.now() - 60_000);
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
    ["allow-dyld-environment-variables alone, ad hoc", true, [DYLD], undefined, "debug"],
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
    } else {
      expect(refusal).toMatch(/Debug build with the hardened runtime/);
      expect(refusal).toContain("ENABLE_HARDENED_RUNTIME = NO in the Debug configuration");
      expect(refusal).toContain("com.apple.security.cs.disable-library-validation");
    }
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
