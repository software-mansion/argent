import { execFileSync, type SpawnOptions } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// The environment a Mac app launch hands the app: the extra variables of one
// start (native-profiler-start's MallocStackLogging=1) pass through, but never
// in place of the variables that connect argent's library. The helper and the
// library are stand-ins (test/fixtures/macos-fake-library): the helper passes
// its environment on to the app, as the real one does.
const native = vi.hoisted(() => ({ dir: "" }));
vi.mock("@argent/native-devtools-ios", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@argent/native-devtools-ios")>()),
  macosArtifacts: () => ({
    bootstrap: path.join(native.dir, "libArgentInjectionBootstrap.dylib"),
    library: path.join(native.dir, "libNativeDevtoolsMacos.dylib"),
    helper: path.join(native.dir, "argent-macos-helper"),
  }),
}));

const spawned = vi.hoisted(() => [] as { command: string; env: NodeJS.ProcessEnv }[]);
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (command: string, args: string[], options: SpawnOptions) => {
      spawned.push({ command, env: { ...(options?.env ?? {}) } });
      return actual.spawn(command, args, options);
    },
  };
});

import { setFlag } from "@argent/configuration-core";
import { Registry } from "@argent/registry";
import { macosAppBlueprint, macosAppRef, type MacosAppApi } from "../src/blueprints/macos-app";
import { createRestartAppTool } from "../src/tools/restart-app";
import { resolveDevice } from "../src/utils/device-info";
import { getTrackedMacosApp, processStartedWithEnv } from "../src/utils/macos-apps";

const BUNDLE_ID = `com.argent.envfake${process.pid}`;
const DEVICE_ID = `macos-app-${BUNDLE_ID}`;
const FIXTURES = path.join(__dirname, "fixtures", "macos-fake-library");

let root = "";
let appPath = "";
let registry: Registry;

function writeBundle(dir: string): string {
  const app = path.join(dir, "Fake.app");
  fs.mkdirSync(path.join(app, "Contents", "MacOS"), { recursive: true });
  fs.writeFileSync(
    path.join(app, "Contents", "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${BUNDLE_ID}</string>
<key>CFBundleExecutable</key><string>FakeApp</string>
<key>CFBundleName</key><string>Fake</string>
<key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>
`
  );
  // Never executed: the fake helper runs Node with this path as argv[0].
  fs.writeFileSync(path.join(app, "Contents", "MacOS", "FakeApp"), "#!/bin/sh\nexit 0\n", {
    mode: 0o755,
  });
  return fs.realpathSync(app);
}

/** The helper launches of this test, in order: the app inherits each one's environment. */
function helperEnvs(): NodeJS.ProcessEnv[] {
  return spawned
    .filter((s) => s.command === path.join(native.dir, "argent-macos-helper"))
    .map((s) => s.env);
}

/** The environment of a running process, as `ps` shows it to its own user. */
function processEnv(pid: number): string {
  return execFileSync("ps", ["-ww", "-E", "-o", "command=", "-p", String(pid)], {
    encoding: "utf8",
  });
}

function macosApp(): Promise<MacosAppApi> {
  const ref = macosAppRef(resolveDevice(DEVICE_ID));
  return registry.resolveService<MacosAppApi>(ref.urn, ref.options);
}

describe.skipIf(process.platform !== "darwin")("a Mac app launch with extra environment", () => {
  const pids: number[] = [];

  beforeAll(() => {
    // A short HOME: the listening socket lives under it, and sun_path holds 103 bytes.
    root = fs.realpathSync(fs.mkdtempSync("/tmp/amenv-"));
    native.dir = path.join(root, "native");
    fs.mkdirSync(native.dir);
    for (const lib of ["libArgentInjectionBootstrap.dylib", "libNativeDevtoolsMacos.dylib"]) {
      fs.writeFileSync(path.join(native.dir, lib), `stand-in ${lib}`);
    }
    fs.writeFileSync(
      path.join(native.dir, "argent-macos-helper"),
      `#!${process.execPath}\nrequire(${JSON.stringify(path.join(FIXTURES, "fake-helper.cjs"))});\n`,
      { mode: 0o755 }
    );
    appPath = writeBundle(path.join(root, "apps"));
  });

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  beforeEach(() => {
    vi.stubEnv("HOME", path.join(root, `home-${Math.random().toString(36).slice(2, 8)}`));
    fs.mkdirSync(process.env.HOME!);
    setFlag("macos-apps", true, "global");
    spawned.length = 0;
    registry = new Registry();
    registry.registerBlueprint(macosAppBlueprint);
    registry.registerTool(createRestartAppTool(registry));
  });

  afterEach(async () => {
    await registry.dispose();
    for (const pid of pids.splice(0)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
    vi.unstubAllEnvs();
  });

  it("passes an extra variable to the app, and only for that start", async () => {
    const app = await macosApp();
    const first = await app.launch({ appPath, env: { MallocStackLogging: "1" } });
    pids.push(first.pid);

    expect(helperEnvs()).toHaveLength(1);
    expect(helperEnvs()[0]!.MallocStackLogging).toBe("1");
    expect(processEnv(first.pid)).toContain("MallocStackLogging=1");
    // What native-profiler-start reads to warn that the process still logs.
    expect(await processStartedWithEnv(first.pid, "MallocStackLogging=1")).toBe(true);

    // restart-app starts the app again without it.
    await registry.invokeTool("restart-app", { udid: DEVICE_ID, bundleId: BUNDLE_ID });
    const second = getTrackedMacosApp(BUNDLE_ID)!.pid;
    pids.push(second);
    expect(second).not.toBe(first.pid);
    expect(helperEnvs()).toHaveLength(2);
    expect(helperEnvs()[1]!.MallocStackLogging).toBeUndefined();
    expect(processEnv(second)).not.toContain("MallocStackLogging");
    expect(await processStartedWithEnv(second, "MallocStackLogging=1")).toBe(false);
  });

  it("does not let an extra variable replace one of the library's", async () => {
    const app = await macosApp();
    const launched = await app.launch({
      appPath,
      env: {
        MallocStackLogging: "1",
        ARGENT_INJECT_BUNDLE_ID: "com.example.someoneelse",
        NATIVE_DEVTOOLS_FD: "9",
        NATIVE_DEVTOOLS_LISTEN_SOCKET: path.join(root, "elsewhere.sock"),
      },
    });
    pids.push(launched.pid);

    const [env] = helperEnvs();
    expect(env).toMatchObject({
      MallocStackLogging: "1",
      ARGENT_INJECT_BUNDLE_ID: BUNDLE_ID,
      NATIVE_DEVTOOLS_FD: "3",
      NATIVE_DEVTOOLS_LISTEN_SOCKET: path.join(
        process.env.HOME!,
        ".argent",
        "macos",
        `${BUNDLE_ID}.sock`
      ),
    });
    // The library in the app answered as this bundle id, over argent's channel.
    expect(launched.bundleId).toBe(BUNDLE_ID);
    await expect(app.call("Echo", { a: 1 })).resolves.toMatchObject({ pid: launched.pid });
  });
});
