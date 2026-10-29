import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Each resolver is stubbed so the report reflects only what this file feeds it,
// not the host the suite runs on.
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "host-deps-report-"));
const artifact = (name: string, mode: number): string => {
  const p = path.join(fixture, name);
  fs.writeFileSync(p, "", { mode });
  return p;
};
const paths = {
  simulatorServer: artifact("simulator-server", 0o755),
  axService: artifact("ax-service", 0o644),
  dylib: artifact("devtools.dylib", 0o644),
  bootstrap: artifact("bootstrap.dylib", 0o644),
  apk: artifact("helper.apk", 0o644),
};
const developerDir = path.join(fixture, "Xcode.app", "Contents", "Developer");
fs.mkdirSync(path.join(developerDir, "usr", "bin"), { recursive: true });
fs.writeFileSync(path.join(developerDir, "usr", "bin", "simctl"), "");

// Resolvers named here throw the way the real ones do for a missing artifact.
const missing = vi.hoisted(() => new Set<string>());
function resolveArtifact(name: string, p: string): string {
  if (missing.has(name)) throw new Error(`${name} not found in the package`);
  return p;
}
vi.mock("@argent/native-devtools-ios", () => ({
  simulatorServerBinaryPath: () => resolveArtifact("simulator-server", paths.simulatorServer),
  axServiceBinaryPath: () => resolveArtifact("ax-service", paths.axService),
  nativeDevtoolsDylibPath: () => resolveArtifact("dylib", paths.dylib),
  bootstrapDylibPath: () => resolveArtifact("bootstrap", paths.bootstrap),
}));
vi.mock("@argent/native-devtools-android", () => ({
  bundledHelperApkPath: () => resolveArtifact("apk", paths.apk),
}));
// What each binary prints when run; a test overrides one to make it fail.
const runs = vi.hoisted(() => ({
  results: {} as Record<
    string,
    { stdout?: string; stderr?: string; fail?: boolean; killed?: boolean }
  >,
  calls: [] as Array<{
    cmd: string;
    args: string[];
    opts: { timeout?: number; killSignal?: string };
  }>,
}));
const defaultRuns = (): typeof runs.results => ({
  "xcode-select": { stdout: `${developerDir}\n` },
  "xcrun": {
    stdout: JSON.stringify({
      devices: {
        "com.apple.CoreSimulator.SimRuntime.iOS-18-5": [
          { isAvailable: true },
          { isAvailable: false },
        ],
      },
    }),
  },
  "/sdk/adb": { stdout: "Android Debug Bridge version 1.0.41\n" },
  "/sdk/emulator": { stdout: "Android emulator version 35.1.4\n" },
});
vi.mock("node:child_process", () => ({
  execFile: (
    cmd: string,
    args: string[],
    opts: { timeout?: number; killSignal?: string },
    cb: (err: Error | null, out: { stdout: string; stderr: string }) => void
  ) => {
    runs.calls.push({ cmd, args, opts });
    const key = args[1] === "--set" ? `${cmd} --set ${args[2]}` : cmd;
    const run = runs.results[`${cmd} ${args.join(" ")}`] ?? runs.results[key] ?? { stdout: "" };
    if (run.fail || run.killed) {
      const err = Object.assign(new Error(`Command failed: ${cmd}`), {
        stderr: run.stderr ?? "",
        killed: run.killed ?? false,
      });
      cb(err, { stdout: "", stderr: run.stderr ?? "" });
    } else {
      cb(null, { stdout: run.stdout ?? "", stderr: "" });
    }
  },
}));
// Each dependency resolves only through its own resolver, so routing one to
// another resolver reports it as missing.
vi.mock("../src/utils/command-on-path", () => ({
  commandOnPath: async (name: string) => (name === "xcrun" ? "/usr/bin/xcrun" : null),
}));
vi.mock("../src/utils/android-binary", () => ({
  resolveAndroidBinary: async (name: string) =>
    ({ adb: "/sdk/adb", emulator: "/sdk/emulator" })[name] ?? null,
}));
vi.mock("../src/utils/vega-cli", () => ({ resolveVegaBinary: async () => "/vega/bin/vega" }));
const signing = vi.hoisted(() => ({ detect: async (): Promise<unknown[]> => [{ teamId: "T1" }] }));
vi.mock("../src/utils/ios-device/team-detect", () => ({
  detectSigningTeams: () => signing.detect(),
}));
const kvm = vi.hoisted(() => ({ problem: [] as string[] | null }));
vi.mock("../src/utils/linux-preflight", () => ({ linuxBootDiagnostics: () => kvm.problem }));
const deviceSets = vi.hoisted(() => ({ list: [] as string[] }));
vi.mock("@argent/configuration-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@argent/configuration-core")>()),
  getAdditionalIosDeviceSets: () => deviceSets.list,
}));
vi.mock("../src/utils/chromium-discovery", () => ({
  getCandidateChromiumPorts: () => [9222, 9333],
}));

import { collectHostDepsReport } from "../src/utils/host-deps-report";
import { INSTALL_HINTS } from "../src/utils/check-deps";

async function reportOn(platform: NodeJS.Platform) {
  const original = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: platform });
  try {
    return await collectHostDepsReport();
  } finally {
    Object.defineProperty(process, "platform", original);
  }
}

beforeEach(() => {
  runs.results = defaultRuns();
  runs.calls = [];
  missing.clear();
  deviceSets.list = [];
  signing.detect = async () => [{ teamId: "T1" }];
});

const ranCommands = () => runs.calls.map((c) => c.cmd);

afterEach(() => {
  vi.unstubAllEnvs();
});

afterAll(() => {
  fs.rmSync(fixture, { recursive: true, force: true });
});

describe("collectHostDepsReport", () => {
  it("reports every dependency doctor reads, with its own install hint", async () => {
    const report = await reportOn("linux");
    expect(report.platform).toBe("linux");
    expect(report.deps.map((d) => [d.dep, d.path])).toEqual([
      ["xcrun", "/usr/bin/xcrun"],
      ["adb", "/sdk/adb"],
      ["emulator", "/sdk/emulator"],
      ["vega", "/vega/bin/vega"],
    ]);
    for (const d of report.deps) expect(d.hint).toBe(INSTALL_HINTS[d.dep]);
    expect(report.chromiumPorts).toEqual([9222, 9333]);
  });

  it("reads signing and Xcode only on macOS", async () => {
    const linux = await reportOn("linux");
    expect(linux.signing).toBeNull();
    expect(linux.xcode).toBeNull();

    const mac = await reportOn("darwin");
    expect(mac.platform).toBe("darwin");
    expect(mac.signing).toEqual({ teamIdEnv: null, detectedTeams: 1 });
    expect(mac.xcode).toEqual({
      developerDir,
      simctl: true,
      fromEnv: false,
      availableSimulators: 1,
      iosRuntimes: 1,
    });

    vi.stubEnv("ARGENT_IOS_TEAM_ID", "ABCDE12345");
    vi.stubEnv("DEVELOPER_DIR", developerDir);
    const pinned = await reportOn("darwin");
    expect(pinned.signing).toEqual({ teamIdEnv: "ABCDE12345", detectedTeams: 0 });
    expect(pinned.xcode?.fromEnv).toBe(true);
  });

  it("runs simctl and reports why it fails", async () => {
    runs.results.xcrun = {
      fail: true,
      stderr: "You have not agreed to the Xcode license agreements.\n",
    };
    expect((await reportOn("darwin")).xcode?.simctlError).toMatch(/Xcode license/);
  });

  it("counts available simulators, so a missing runtime shows as zero", async () => {
    runs.results.xcrun = {
      stdout: JSON.stringify({
        devices: { "com.apple.CoreSimulator.SimRuntime.iOS-18-5": [{ isAvailable: false }] },
      }),
    };
    expect((await reportOn("darwin")).xcode?.availableSimulators).toBe(0);
  });

  it("counts only iOS simulators and iOS runtimes", async () => {
    runs.results.xcrun = {
      stdout: JSON.stringify({
        devices: {
          "com.apple.CoreSimulator.SimRuntime.watchOS-11-5": [{ isAvailable: true }],
          "com.apple.CoreSimulator.SimRuntime.iOS-18-5": [{ isAvailable: false }],
          "com.apple.CoreSimulator.SimRuntime.iOS-17-5": [],
        },
      }),
    };
    expect((await reportOn("darwin")).xcode).toMatchObject({
      availableSimulators: 0,
      iosRuntimes: 2,
    });
  });

  it("does not count a deleted runtime that still lists its simulators", async () => {
    runs.results.xcrun = {
      stdout: JSON.stringify({
        devices: {
          "com.apple.CoreSimulator.SimRuntime.iOS-17-0": [
            {
              isAvailable: false,
              availabilityError: 'runtime profile not found using "System" match policy',
            },
          ],
        },
      }),
    };
    expect((await reportOn("darwin")).xcode).toMatchObject({
      availableSimulators: 0,
      iosRuntimes: 0,
    });
  });

  it("counts simulators in the additional device sets list-devices reads", async () => {
    const radonSet = path.join(fixture, "radon-devices");
    fs.mkdirSync(radonSet, { recursive: true });
    deviceSets.list = [radonSet, path.join(fixture, "missing-set")];
    runs.results.xcrun = {
      stdout: JSON.stringify({ devices: { "com.apple.CoreSimulator.SimRuntime.iOS-18-5": [] } }),
    };
    runs.results[`xcrun --set ${radonSet}`] = {
      stdout: JSON.stringify({
        devices: { "com.apple.CoreSimulator.SimRuntime.iOS-18-5": [{ isAvailable: true }] },
      }),
    };
    expect((await reportOn("darwin")).xcode).toMatchObject({
      availableSimulators: 1,
      iosRuntimes: 1,
    });
    const setArgs = runs.calls.filter((c) => c.args[1] === "--set").map((c) => c.args[2]);
    expect(setArgs).toEqual([radonSet]);
  });

  it("reports simctl output it can't parse", async () => {
    runs.results.xcrun = { stdout: "not json" };
    expect((await reportOn("darwin")).xcode?.simctlError).toMatch(/unreadable output/);
  });

  it("does not run simctl when the developer dir has none", async () => {
    const clt = path.join(fixture, "CommandLineTools");
    fs.mkdirSync(path.join(clt, "usr", "bin"), { recursive: true });
    runs.results["xcode-select"] = { stdout: `${clt}\n` };
    expect((await reportOn("darwin")).xcode).toEqual({
      developerDir: clt,
      simctl: false,
      fromEnv: false,
    });
    expect(ranCommands()).not.toContain("xcrun");
  });

  it("does not run simctl when xcode-select fails", async () => {
    runs.results["xcode-select"] = { fail: true, stderr: "unable to get active developer dir" };
    expect((await reportOn("darwin")).xcode).toEqual({
      developerDir: null,
      simctl: false,
      fromEnv: false,
    });
    expect(ranCommands()).not.toContain("xcrun");
  });

  it("runs only flags of adb and the emulator that touch no daemon, with a timeout", async () => {
    await reportOn("linux");
    const calls = runs.calls.map((c) => [c.cmd, c.args, c.opts.timeout]);
    expect(calls).toHaveLength(3);
    expect(calls).toEqual(
      expect.arrayContaining([
        ["/sdk/adb", ["version"], 10_000],
        ["/sdk/emulator", ["-version"], 10_000],
        ["/sdk/emulator", ["-list-avds"], 10_000],
      ])
    );
  });

  it("counts the AVDs the emulator lists, without its diagnostic lines", async () => {
    runs.results["/sdk/emulator -list-avds"] = {
      stdout: "INFO    | Storing crashdata in: /tmp/x\nPixel_9_API_35\nmedium_phone\n",
    };
    expect((await reportOn("linux")).androidAvds).toBe(2);
    runs.results["/sdk/emulator -list-avds"] = { stdout: "" };
    expect((await reportOn("linux")).androidAvds).toBe(0);
    runs.results["/sdk/emulator -list-avds"] = { fail: true, stderr: "boom\n" };
    expect((await reportOn("linux")).androidAvds).toBeUndefined();
    runs.results["/sdk/emulator"] = { fail: true, stderr: "bad CPU type in executable\n" };
    expect((await reportOn("linux")).androidAvds).toBeUndefined();
  });

  it("kills a timed-out simctl with SIGKILL, which a wedged CoreSimulatorService can't ignore", async () => {
    await reportOn("darwin");
    const simctl = runs.calls.find((c) => c.cmd === "xcrun");
    expect(simctl?.opts).toMatchObject({ timeout: 10_000, killSignal: "SIGKILL" });
  });

  it("reports a found emulator that fails to run", async () => {
    runs.results["/sdk/emulator"] = { fail: true, stderr: "bad CPU type in executable\n" };
    const emulator = (await reportOn("linux")).deps.find((d) => d.dep === "emulator");
    expect(emulator?.runError).toBe("bad CPU type in executable");
  });

  it("names a probe that timed out", async () => {
    runs.results["/sdk/adb"] = { killed: true };
    const adb = (await reportOn("linux")).deps.find((d) => d.dep === "adb");
    expect(adb?.runError).toBe("`adb version` timed out");
  });

  it("skips blank stderr lines when naming a run failure", async () => {
    runs.results["/sdk/adb"] = { fail: true, stderr: "\n  \nreal cause\n" };
    const adb = (await reportOn("linux")).deps.find((d) => d.dep === "adb");
    expect(adb?.runError).toBe("real cause");
  });

  it("reads a failed keychain lookup as no detected teams", async () => {
    signing.detect = async () => {
      throw new Error("security failed");
    };
    expect((await reportOn("darwin")).signing).toEqual({ teamIdEnv: null, detectedTeams: 0 });
  });

  it("checks the macOS-only artifacts only on macOS", async () => {
    expect((await reportOn("linux")).bundled.map((b) => b.name)).toEqual([
      "simulator-server",
      "android helper apk",
    ]);
    expect((await reportOn("darwin")).bundled.map((b) => b.name)).toEqual([
      "simulator-server",
      "ax-service",
      "native devtools dylib",
      "injection bootstrap dylib",
      "android helper apk",
    ]);
  });

  it("does not run simctl off macOS", async () => {
    runs.results.xcrun = { fail: true, stderr: "should not run" };
    expect((await reportOn("linux")).xcode).toBeNull();
  });

  it("reports an adb that is found but fails to run", async () => {
    runs.results["/sdk/adb"] = { fail: true, stderr: "spawn Unknown system error -86\n" };
    const adb = (await reportOn("linux")).deps.find((d) => d.dep === "adb");
    expect(adb).toMatchObject({ path: "/sdk/adb", runError: "spawn Unknown system error -86" });
  });

  it("reports a bundled binary that is not executable", async () => {
    const report = await reportOn("darwin");
    expect(report.bundled.find((b) => b.name === "simulator-server")).toEqual({
      name: "simulator-server",
      path: paths.simulatorServer,
    });
    expect(report.bundled.find((b) => b.name === "ax-service")?.error).toMatch(/not executable/);
    expect(report.bundled.find((b) => b.name === "android helper apk")?.error).toBeUndefined();
  });

  it("needs the exec bit on simulator-server, but not on the dylibs", async () => {
    fs.chmodSync(paths.simulatorServer, 0o644);
    try {
      const report = await reportOn("darwin");
      expect(report.bundled.find((b) => b.name === "simulator-server")?.error).toMatch(
        /not executable/
      );
      for (const name of ["native devtools dylib", "injection bootstrap dylib"]) {
        expect(report.bundled.find((b) => b.name === name)?.error).toBeUndefined();
      }
    } finally {
      fs.chmodSync(paths.simulatorServer, 0o755);
    }
  });

  it("reports an artifact whose resolver throws, as the real ones do when it is missing", async () => {
    missing.add("simulator-server");
    expect((await reportOn("darwin")).bundled.find((b) => b.name === "simulator-server")).toEqual({
      name: "simulator-server",
      path: null,
      error: "simulator-server not found in the package",
    });
  });

  it("reports the KVM preflight on Linux only", async () => {
    kvm.problem = ["/dev/kvm is missing — KVM module is not loaded"];
    expect((await reportOn("linux")).kvmProblem).toMatch(/\/dev\/kvm is missing/);
    kvm.problem = [];
    expect((await reportOn("linux")).kvmProblem).toBeNull();
    kvm.problem = null;
    expect((await reportOn("darwin")).kvmProblem).toBeNull();
  });

  it("reports a bundled artifact that is gone", async () => {
    fs.renameSync(paths.apk, `${paths.apk}.bak`);
    try {
      const report = await reportOn("linux");
      expect(report.bundled.find((b) => b.name === "android helper apk")?.error).toMatch(
        /not found/
      );
    } finally {
      fs.renameSync(`${paths.apk}.bak`, paths.apk);
    }
  });
});
