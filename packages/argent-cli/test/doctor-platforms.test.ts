import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  depsProbeFailure,
  depsProbeFix,
  platformChecks,
  platformsSection,
  probeHostDeps,
  sdkRootCheck,
} from "../src/doctor-platforms.js";
import { type DoctorContext, childFailureReason } from "../src/doctor-shared.js";

let projectRoot: string;

beforeEach(() => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "argent-doctor-"));
});

afterEach(() => {
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

type HostDeps = Parameters<typeof platformChecks>[0];

function hostDeps(overrides: Partial<HostDeps> = {}): HostDeps {
  return {
    platform: "darwin",
    deps: [
      { dep: "xcrun", path: "/usr/bin/xcrun", hint: "install xcode" },
      { dep: "adb", path: "/sdk/platform-tools/adb", hint: "install adb" },
      { dep: "emulator", path: "/sdk/emulator/emulator", hint: "install emulator" },
      { dep: "vega", path: null, hint: "install vega" },
    ],
    bundled: [{ name: "simulator-server", path: "/pkg/bin/darwin/simulator-server" }],
    signing: { teamIdEnv: null, detectedTeams: 1 },
    xcode: { developerDir: "/Applications/Xcode.app/Contents/Developer", simctl: true },
    ...overrides,
  };
}

describe("platformChecks", () => {
  const xcode = { developerDir: "/Applications/Xcode.app/Contents/Developer", simctl: true };

  it("fails the iOS simulator when simctl can't run, pointing at the license", () => {
    const checks = platformChecks(
      hostDeps({
        xcode: { ...xcode, simctlError: "You have not agreed to the Xcode license agreements." },
      }),
      "reinstall"
    );
    expect(checks.find((c) => c.label.startsWith("iOS simulator"))).toMatchObject({
      status: "error",
      fix: "sudo xcodebuild -license accept",
    });
  });

  it("asks for an iOS runtime when Xcode has no available simulators and no runtime", () => {
    for (const iosRuntimes of [undefined, 0]) {
      const checks = platformChecks(
        hostDeps({ xcode: { ...xcode, availableSimulators: 0, iosRuntimes } }),
        "r"
      );
      expect(checks.find((c) => c.label.startsWith("iOS simulator"))).toMatchObject({
        status: "warn",
        label: "iOS simulator: no available simulators (no iOS runtime installed?)",
        fix: expect.stringMatching(/xcodebuild -downloadPlatform iOS/),
      });
    }
  });

  it("asks for a simulator, not a runtime, when an iOS runtime is installed", () => {
    const checks = platformChecks(
      hostDeps({ xcode: { ...xcode, availableSimulators: 0, iosRuntimes: 1 } }),
      "r"
    );
    expect(checks.find((c) => c.label.startsWith("iOS simulator"))).toMatchObject({
      status: "warn",
      label: "iOS simulator: no available iOS simulators",
      fix: expect.stringMatching(/simctl create/),
    });
  });

  it("warns when only the emulator binary fails to run", () => {
    const checks = platformChecks(
      hostDeps({
        deps: [
          { dep: "xcrun", path: "/usr/bin/xcrun", hint: "install xcode" },
          { dep: "adb", path: "/sdk/adb", hint: "install adb" },
          { dep: "emulator", path: "/sdk/emulator", hint: "x", runError: "bad CPU type" },
          { dep: "vega", path: null, hint: "install vega" },
        ],
      }),
      "reinstall"
    );
    expect(checks.find((c) => c.label === "Android")?.status).toBe("ok");
    expect(checks.find((c) => c.label.startsWith("Android emulator"))).toMatchObject({
      status: "warn",
      detail: "/sdk/emulator: bad CPU type",
    });
  });

  it("fails Android when adb is found but can't run", () => {
    const checks = platformChecks(
      hostDeps({
        deps: [
          { dep: "xcrun", path: "/usr/bin/xcrun", hint: "install xcode" },
          {
            dep: "adb",
            path: "/sdk/adb",
            hint: "install adb",
            runError: "spawn Unknown system error -86",
          },
          { dep: "emulator", path: "/sdk/emulator", hint: "x", runError: "bad CPU type" },
          { dep: "vega", path: null, hint: "install vega" },
        ],
      }),
      "reinstall"
    );
    expect(checks.find((c) => c.label.startsWith("Android:"))?.status).toBe("error");
  });

  it("does not count Vega as usable when adb fails to run", () => {
    const checks = platformChecks(
      hostDeps({
        platform: "linux",
        deps: [
          { dep: "adb", path: "/sdk/adb", hint: "install adb", runError: "spawn ENOEXEC" },
          { dep: "emulator", path: null, hint: "x" },
          { dep: "vega", path: "/home/me/vega/bin/vega", hint: "install vega" },
        ],
      }),
      "reinstall"
    );
    expect(checks.find((c) => c.label.startsWith("Vega"))?.status).toBe("warn");
    expect(checks.some((c) => /No mobile platform toolchain found/.test(c.label))).toBe(false);
  });

  it("names the team from ARGENT_IOS_TEAM_ID", () => {
    const checks = platformChecks(
      hostDeps({ signing: { teamIdEnv: "ABCDE12345", detectedTeams: 0 } }),
      "reinstall"
    );
    expect(checks.find((c) => c.label.startsWith("Physical iPhone"))?.label).toMatch(/ABCDE12345/);
  });

  it("does not pass the iOS simulator without ax-service", () => {
    const checks = platformChecks(
      hostDeps({
        bundled: [
          { name: "simulator-server", path: "/pkg/bin/darwin/simulator-server" },
          { name: "ax-service", path: null, error: "not found: /pkg/bin/darwin/ax-service" },
        ],
      }),
      "reinstall"
    );
    expect(checks.some((c) => c.label === "iOS simulator")).toBe(false);
  });

  it("keeps iOS and Android rows, without an install-Xcode summary, when simulator-server is broken", () => {
    const checks = platformChecks(
      hostDeps({
        bundled: [{ name: "simulator-server", path: null, error: "not executable: /pkg/s" }],
      }),
      "reinstall"
    );
    expect(checks.find((c) => c.label.startsWith("iOS simulator"))?.label).toMatch(/unavailable/);
    expect(checks.find((c) => c.label.startsWith("Android"))?.label).toMatch(/unavailable/);
    expect(checks.some((c) => /No mobile platform toolchain/.test(c.label))).toBe(false);
  });

  it("reports a missing optional toolchain as info with its install hint", () => {
    const vega = platformChecks(hostDeps(), "reinstall").find((c) => c.label.startsWith("Vega"));
    expect(vega).toMatchObject({ status: "info", fix: "install vega" });
  });

  it("warns, without failing, when only Chromium is usable", () => {
    const none = hostDeps({
      deps: [
        { dep: "xcrun", path: null, hint: "install xcode" },
        { dep: "adb", path: null, hint: "install adb" },
        { dep: "emulator", path: null, hint: "install emulator" },
        { dep: "vega", path: null, hint: "install vega" },
      ],
    });
    const checks = platformChecks(none, "reinstall");
    expect(checks[0]).toMatchObject({ status: "warn" });
    expect(checks.some((c) => c.status === "error")).toBe(false);
    expect(platformChecks(hostDeps(), "reinstall").some((c) => c.status === "warn")).toBe(false);
  });

  it("does not count the /usr/bin/xcrun shim without simctl as iOS support", () => {
    const shimOnly = hostDeps({
      deps: [
        { dep: "xcrun", path: "/usr/bin/xcrun", hint: "install xcode" },
        { dep: "adb", path: null, hint: "install adb" },
        { dep: "emulator", path: null, hint: "install emulator" },
        { dep: "vega", path: null, hint: "install vega" },
      ],
      xcode: { developerDir: "/Library/Developer/CommandLineTools", simctl: false },
    });
    const checks = platformChecks(shimOnly, "reinstall");
    expect(checks.some((c) => c.status === "ok" && c.label === "iOS simulator")).toBe(false);
    expect(checks[0]?.label).toMatch(/No mobile platform toolchain/);
  });

  it("needs adb for Vega", () => {
    const vegaOnly = (adb: string | null) =>
      hostDeps({
        platform: "linux",
        signing: null,
        xcode: null,
        deps: [
          { dep: "xcrun", path: null, hint: "install xcode" },
          { dep: "adb", path: adb, hint: "install adb" },
          { dep: "emulator", path: null, hint: "install emulator" },
          { dep: "vega", path: "/home/me/vega/bin/vega", hint: "install vega" },
        ],
      });
    const withoutAdb = platformChecks(vegaOnly(null), "reinstall");
    expect(withoutAdb.find((c) => c.label.startsWith("Vega"))).toMatchObject({
      status: "warn",
      fix: expect.stringMatching(/platform-tools/),
    });
    expect(withoutAdb[0]?.label).toMatch(/No mobile platform toolchain/);
    const withAdb = platformChecks(vegaOnly("/sdk/adb"), "reinstall");
    expect(withAdb.find((c) => c.label.startsWith("Vega"))?.status).toBe("ok");
    expect(withAdb.some((c) => c.status === "warn")).toBe(false);
  });

  it("errors when a bundled artifact is missing (a broken install)", () => {
    const broken = hostDeps({
      bundled: [{ name: "simulator-server", path: null, error: "not found" }],
    });
    const checks = platformChecks(broken, "reinstall");
    expect(checks[0]).toMatchObject({
      status: "error",
      label: "Bundled simulator-server is missing",
      fix: "reinstall",
    });
    expect(checks.some((c) => c.label === "iOS simulator")).toBe(false);
  });

  it("skips iOS off macOS", () => {
    const linux = platformChecks(
      hostDeps({ platform: "linux", signing: null, xcode: null }),
      "reinstall"
    );
    expect(linux.find((c) => c.label.startsWith("iOS"))?.status).toBe("info");
    expect(linux.some((c) => c.label.startsWith("Physical iPhone"))).toBe(false);
  });
});

describe("sdkRootCheck", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("warns about an android.sdkRoot the shared tool-server may not see", () => {
    const home = path.join(projectRoot, "home");
    fs.mkdirSync(home);
    vi.stubEnv("HOME", home);
    const app = path.join(projectRoot, "app");
    fs.mkdirSync(path.join(app, ".argent"), { recursive: true });
    fs.mkdirSync(path.join(app, ".git"));
    expect(sdkRootCheck(app, "argent")).toBeNull();
    fs.writeFileSync(
      path.join(app, ".argent", "config.json"),
      JSON.stringify({ android: { sdkRoot: "/opt/sdk" } })
    );
    expect(sdkRootCheck(app, "argent")?.fix).toBe(
      "argent config set android.sdkRoot /opt/sdk --scope global"
    );
  });
});

describe("depsProbeFix", () => {
  it("does not offer a reinstall for a hang or a signal", () => {
    expect(depsProbeFix("timed out after 30s (SIGTERM)", "reinstall")).toMatch(/Run doctor again/);
    expect(depsProbeFix("killed by SIGABRT: FATAL ERROR", "reinstall")).toMatch(/Run doctor again/);
    expect(depsProbeFix("Error: Cannot find module", "reinstall")).toBe("reinstall");
  });
});

describe("childFailureReason error lines", () => {
  it("picks V8's FATAL ERROR out of an out-of-memory dump", () => {
    const stderr = [
      "<--- Last few GCs --->",
      "[123:0x1] 10 ms: Mark-Compact 15.8 (16.5) -> 15.7 (17.0) MB",
      "<--- JS stacktrace --->",
      "FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory",
    ].join("\n");
    expect(childFailureReason(stderr, "fallback")).toMatch(/^FATAL ERROR: Reached heap limit/);
  });
});

describe("childFailureReason", () => {
  it("picks the error line out of a Node crash dump", () => {
    const stderr = [
      "node:internal/modules/cjs/loader:1228",
      "  throw err;",
      "  ^",
      "",
      "Error: Cannot find module '@argent/registry'",
      "Require stack:",
      "- /pkg/dist/tool-server.cjs",
      "",
      "Node.js v24.21.0",
    ].join("\n");
    expect(childFailureReason(stderr, "Command failed")).toBe(
      "Error: Cannot find module '@argent/registry'"
    );
  });

  it("uses a plain stderr message as is", () => {
    expect(childFailureReason("keychain locked\n", "Command failed")).toBe("keychain locked");
  });

  it("falls back to the exec error when stderr is empty", () => {
    expect(childFailureReason("", "Command failed: node x --check-deps")).toBe(
      "Command failed: node x --check-deps"
    );
  });
});

describe("platformChecks details", () => {
  const ctOnly = (xcode: HostDeps["xcode"], platform: NodeJS.Platform = "darwin") =>
    hostDeps({
      platform,
      xcode,
      deps: [
        { dep: "xcrun", path: platform === "darwin" ? "/usr/bin/xcrun" : null, hint: "x" },
        { dep: "adb", path: null, hint: "install adb" },
        { dep: "emulator", path: null, hint: "install emulator" },
        { dep: "vega", path: null, hint: "install vega" },
      ],
    });
  const clt = "/Library/Developer/CommandLineTools";

  it("reports a developer dir without simctl as info, not as an error", () => {
    const checks = platformChecks(ctOnly({ developerDir: clt, simctl: false }), "reinstall");
    expect(checks.find((c) => c.label.startsWith("iOS simulator"))?.status).toBe("info");
    expect(checks.some((c) => c.status === "error")).toBe(false);
  });

  it("does not pass a physical iPhone without full Xcode", () => {
    const checks = platformChecks(ctOnly({ developerDir: clt, simctl: false }), "reinstall");
    expect(checks.find((c) => c.label.startsWith("Physical iPhone"))).toMatchObject({
      status: "info",
      label: expect.stringMatching(/needs full Xcode/),
    });
  });

  it("blames DEVELOPER_DIR when it selects the developer dir", () => {
    const ios = platformChecks(
      ctOnly({ developerDir: clt, simctl: false, fromEnv: true }),
      "reinstall"
    ).find((c) => c.label.startsWith("iOS simulator"));
    expect(ios?.detail).toMatch(/from DEVELOPER_DIR/);
    expect(ios?.fix).toMatch(/Unset DEVELOPER_DIR/);
  });

  it("does not offer Xcode off macOS, nor Vega without adb", () => {
    const linux = platformChecks(ctOnly(null, "linux"), "reinstall")[0]!;
    expect(linux.fix).not.toMatch(/Xcode/);
    const mac = platformChecks(ctOnly({ developerDir: clt, simctl: false }), "reinstall")[0]!;
    expect(mac.fix).toMatch(/Android platform-tools \(Android, and Vega with the Vega SDK\)/);
  });

  it("lists the ports Chromium discovery probes", () => {
    const label = (ports?: number[]) =>
      platformChecks(hostDeps({ chromiumPorts: ports }), "r").find((c) =>
        c.label.startsWith("Chromium")
      )?.label;
    expect(label([9222, 9333])).toBe("Chromium: probes CDP ports 9222, 9333");
    expect(label(undefined)).toBe("Chromium: probes CDP port 9222");
  });

  it("names a bundled binary that is not executable", () => {
    const checks = platformChecks(
      hostDeps({ bundled: [{ name: "ax-service", path: null, error: "not executable: /x" }] }),
      "reinstall"
    );
    expect(checks[0]?.label).toBe("Bundled ax-service is not executable");
  });

  it("points at the Apple Development certificate step", () => {
    const checks = platformChecks(
      hostDeps({ signing: { teamIdEnv: null, detectedTeams: 0 } }),
      "r"
    );
    expect(checks.find((c) => c.label.startsWith("Physical iPhone"))?.fix).toMatch(
      /Manage Certificates > \+ > Apple Development/
    );
  });
});

describe("platformChecks for a toolchain that is there but fails", () => {
  const xcode = { developerDir: "/Applications/Xcode.app/Contents/Developer", simctl: true };
  const deps = (adb: Partial<HostDeps["deps"][number]> | null, emulator: string | null = null) => [
    { dep: "xcrun", path: "/usr/bin/xcrun", hint: "install xcode" },
    { dep: "adb", path: null, hint: "install adb", ...adb },
    { dep: "emulator", path: emulator, hint: "install emulator" },
    { dep: "vega", path: null, hint: "install vega" },
  ];
  const ios = (checks: ReturnType<typeof platformChecks>) =>
    checks.find((c) => c.label.startsWith("iOS simulator"));
  const banner = (checks: ReturnType<typeof platformChecks>) =>
    checks.some((c) => /No mobile platform toolchain/.test(c.label));

  it("treats a simctl hang as a stuck CoreSimulator, and other failures as setup", () => {
    const hang = platformChecks(
      hostDeps({
        xcode: { ...xcode, simctlError: "`xcrun simctl list devices --json` timed out" },
      }),
      "r"
    );
    expect(ios(hang)).toMatchObject({
      status: "error",
      detail: "`xcrun simctl list devices --json` timed out",
      fix: expect.stringMatching(/CoreSimulatorService/),
    });
    const other = platformChecks(
      hostDeps({ xcode: { ...xcode, simctlError: "Unable to locate device set." } }),
      "r"
    );
    expect(ios(other)?.fix).toMatch(/runFirstLaunch/);
  });

  it("holds back the physical iPhone until the Xcode license is accepted", () => {
    const checks = platformChecks(
      hostDeps({
        xcode: { ...xcode, simctlError: "You have not agreed to the Xcode license agreements." },
        signing: { teamIdEnv: "ABCDE12345", detectedTeams: 0 },
      }),
      "r"
    );
    expect(checks.find((c) => c.label.startsWith("Physical iPhone"))).toMatchObject({
      status: "info",
      fix: "sudo xcodebuild -license accept",
    });
  });

  it("does not tell a Mac with a failing or empty Xcode to install Xcode", () => {
    for (const x of [
      { ...xcode, simctlError: "You have not agreed to the Xcode license agreements." },
      { ...xcode, simctlError: "`xcrun simctl list devices --json` timed out" },
      { ...xcode, availableSimulators: 0 },
    ]) {
      expect(banner(platformChecks(hostDeps({ xcode: x, deps: deps(null) }), "r"))).toBe(false);
    }
    const empty = platformChecks(hostDeps({ xcode: { ...xcode, availableSimulators: 0 } }), "r");
    expect(ios(empty)?.status).toBe("warn");
  });

  it("points an adb hang at the binary, since `adb version` never reaches the server", () => {
    const checks = platformChecks(
      hostDeps({
        platform: "linux",
        signing: null,
        xcode: null,
        deps: deps({ path: "/sdk/adb", runError: "`adb version` timed out" }),
      }),
      "r"
    );
    const android = checks.find((c) => c.label.startsWith("Android"));
    expect(android).toMatchObject({
      status: "error",
      label: "Android: adb does not answer",
      fix: expect.stringMatching(/^Check what \/sdk\/adb runs/),
    });
    expect(android?.fix).not.toMatch(/kill-server|Reinstall/);
    expect(banner(checks)).toBe(false);
  });

  it("asks for a writable home when adb can't create its .android dir", () => {
    const runError = "adb_utils.cpp:315 Cannot mkdir '/ro/home/.android': Permission denied";
    const android = platformChecks(
      hostDeps({ deps: deps({ path: "/sdk/adb", runError }) }),
      "r"
    ).find((c) => c.label.startsWith("Android"));
    expect(android?.fix).toBe(
      "Make /ro/home writable so adb can create .android (it keeps its keys there)"
    );
  });

  it("warns when the emulator runs but has no AVD to boot", () => {
    const linux = (androidAvds?: number) =>
      platformChecks(
        hostDeps({
          platform: "linux",
          signing: null,
          xcode: null,
          deps: [
            { dep: "xcrun", path: null, hint: "x" },
            { dep: "adb", path: "/sdk/adb", hint: "install adb" },
            { dep: "emulator", path: "/sdk/emulator", hint: "install emulator" },
            { dep: "vega", path: null, hint: "install vega" },
          ],
          ...(androidAvds === undefined ? {} : { androidAvds }),
        }),
        "r"
      ).find((c) => c.label.startsWith("Android emulator"));
    expect(linux(0)).toMatchObject({
      status: "warn",
      label: "Android emulator: no AVDs to boot",
      fix: expect.stringMatching(/avdmanager create avd/),
    });
    expect(linux(2)).toBeUndefined();
    expect(linux()).toBeUndefined();
  });

  it("counts a working adb as a platform, and reports the emulator binary", () => {
    const linux = (emulator: Partial<HostDeps["deps"][number]>) =>
      platformChecks(
        hostDeps({
          platform: "linux",
          signing: null,
          xcode: null,
          deps: [
            { dep: "xcrun", path: null, hint: "x" },
            { dep: "adb", path: "/sdk/adb", hint: "install adb" },
            { dep: "emulator", path: null, hint: "install emulator", ...emulator },
            { dep: "vega", path: null, hint: "install vega" },
          ],
        }),
        "r"
      );
    const emulatorRow = (checks: ReturnType<typeof platformChecks>) =>
      checks.find((c) => c.label.startsWith("Android emulator"));
    const missing = linux({});
    expect(banner(missing)).toBe(false);
    expect(emulatorRow(missing)).toMatchObject({ status: "info", fix: "install emulator" });
    const failing = linux({ path: "/sdk/emulator", runError: "bad CPU type" });
    expect(emulatorRow(failing)).toMatchObject({
      status: "warn",
      detail: "/sdk/emulator: bad CPU type",
    });
    expect(emulatorRow(linux({ path: "/sdk/emulator" }))).toBeUndefined();
  });

  it("warns when the emulator can't use KVM", () => {
    const checks = platformChecks(
      hostDeps({
        platform: "linux",
        signing: null,
        xcode: null,
        kvmProblem: "/dev/kvm exists but is not readable/writable by this user (code=EACCES).",
      }),
      "r"
    );
    expect(checks.find((c) => /KVM/.test(c.label))).toMatchObject({
      status: "warn",
      fix: expect.stringMatching(/usermod -aG kvm/),
    });
  });

  it("counts a working Xcode without adb as a platform", () => {
    const checks = platformChecks(hostDeps({ deps: deps(null) }), "r");
    expect(banner(checks)).toBe(false);
    expect(ios(checks)?.status).toBe("ok");
  });

  it("needs only simulator-server for Android", () => {
    const checks = platformChecks(
      hostDeps({ bundled: [{ name: "ax-service", path: null, error: "not found: /x" }] }),
      "r"
    );
    expect(checks.find((c) => c.label.startsWith("Android"))?.status).toBe("ok");
    expect(ios(checks)?.status).toBe("info");
  });

  it("notes that a running tool-server won't see an ANDROID_HOME set in this shell", () => {
    vi.stubEnv("ANDROID_HOME", "/sdk");
    try {
      const android = platformChecks(
        hostDeps({ deps: deps({ path: "/sdk/platform-tools/adb" }) }),
        "r"
      ).find((c) => c.label === "Android");
      expect(android?.detail).toMatch(/ANDROID_HOME.*argent server stop/);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("keeps each row's detail, hint and severity", () => {
    const checks = platformChecks(
      hostDeps({
        bundled: [{ name: "simulator-server", path: null, error: "not found: /pkg/s" }],
        deps: [
          { dep: "xcrun", path: null, hint: "install xcode" },
          { dep: "adb", path: null, hint: "install adb" },
          { dep: "emulator", path: null, hint: "x" },
          { dep: "vega", path: null, hint: "install vega" },
        ],
      }),
      "r"
    );
    expect(checks[0]?.detail).toBe("not found: /pkg/s");
    expect(ios(checks)).toMatchObject({ status: "info", fix: "install xcode" });
    expect(checks.find((c) => c.label.startsWith("Android"))).toMatchObject({
      status: "info",
      fix: "install adb",
    });
    const brokenAndroid = platformChecks(
      hostDeps({ bundled: [{ name: "simulator-server", path: null, error: "not found" }] }),
      "r"
    );
    expect(brokenAndroid.find((c) => c.label.startsWith("Android"))?.status).toBe("info");
    expect(ios(brokenAndroid)?.status).toBe("info");
    const adbError = platformChecks(
      hostDeps({ deps: deps({ path: "/sdk/adb", runError: "bad CPU type" }) }),
      "r"
    ).find((c) => c.label.startsWith("Android"));
    expect(adbError?.detail).toBe("/sdk/adb: bad CPU type");
    const team = (signing: HostDeps["signing"]) =>
      platformChecks(hostDeps({ signing }), "r").find((c) => c.label.startsWith("Physical iPhone"))
        ?.status;
    expect(team({ teamIdEnv: "T", detectedTeams: 0 })).toBe("ok");
    expect(team({ teamIdEnv: null, detectedTeams: 2 })).toBe("ok");
    expect(team({ teamIdEnv: null, detectedTeams: 0 })).toBe("info");
  });
});

describe("sdkRootCheck against the global value", () => {
  let home: string;
  let app: string;
  const write = (file: string, sdkRoot: string) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ android: { sdkRoot } }));
  };

  beforeEach(() => {
    home = path.join(projectRoot, "home");
    app = path.join(projectRoot, "app");
    fs.mkdirSync(home);
    fs.mkdirSync(path.join(app, ".git"), { recursive: true });
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", home);
  });

  afterEach(() => vi.unstubAllEnvs());

  it("is quiet once the global value matches, in either spelling of ~", () => {
    write(path.join(app, ".argent", "config.json"), "~/Library/Android/sdk");
    write(path.join(home, ".argent", "config.json"), path.join(home, "Library/Android/sdk"));
    expect(sdkRootCheck(app, "argent")).toBeNull();
  });

  it("does not offer to overwrite a different global value", () => {
    write(path.join(app, ".argent", "config.json"), "/opt/sdk-proj");
    write(path.join(home, ".argent", "config.json"), "/opt/sdk-global");
    const result = sdkRootCheck(app, "argent");
    expect(result?.label).toMatch(/differs from the global one/);
    expect(result?.fix).not.toMatch(/--scope global/);
  });

  it("quotes a path with a space and uses the given argent command", () => {
    write(path.join(app, ".argent", "config.json"), "/opt/my sdk");
    expect(sdkRootCheck(app, "npx argent")?.fix).toBe(
      'npx argent config set android.sdkRoot "/opt/my sdk" --scope global'
    );
  });
});

describe("platformsSection", () => {
  let dir: string;
  const ctx = (): DoctorContext => ({
    projectRoot: dir,
    cwd: dir,
    mode: "global",
    global: null,
    argentCmd: "argent",
    installCmd: "npm install",
    offPathGlobalBin: null,
  });
  const noLink = { url: null, source: "none" as const };
  // A stand-in tool-server bundle: answers --check-deps with a report built
  // from its environment, and anything else with a usage error.
  const fakeBundle = (body = "") => {
    const file = path.join(dir, "tool-server.cjs");
    fs.writeFileSync(
      file,
      `if (!process.argv.includes("--check-deps")) { console.error("Usage: tool-server <command>"); process.exit(2); }
${body}
console.log(JSON.stringify({
  platform: "linux", signing: null, xcode: null, bundled: [],
  deps: [{ dep: "adb", path: process.env.ARGENT_TEST_ADB || null, hint: "install adb" }],
}));`
    );
    return { bundlePath: file, simulatorServerDir: dir, nativeDevtoolsDir: dir };
  };

  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "argent-doctor-platforms-")));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("skips device checks when linked to a remote tool-server", async () => {
    const section = await platformsSection(
      ctx(),
      fakeBundle(),
      { url: "http://x:1", source: "env" },
      "r"
    );
    expect(section.checks).toEqual([
      { status: "info", label: "Skipped: device tools run on the linked tool-server's host" },
    ]);
  });

  it("runs --check-deps with this shell's environment", async () => {
    vi.stubEnv("ARGENT_TEST_ADB", "/from/env/adb");
    const section = await platformsSection(ctx(), fakeBundle(), noLink, "r");
    expect(section.checks.find((c) => c.label === "Android")?.detail).toBe("adb at /from/env/adb");
  });

  it("fails when the dependency check can't run, with its reason and fix", async () => {
    const section = await platformsSection(
      ctx(),
      fakeBundle("process.exit(3);"),
      noLink,
      "reinstall"
    );
    expect(section.checks).toEqual([
      expect.objectContaining({
        status: "error",
        label: "Could not run the bundled tool-server's dependency check",
        detail: expect.stringMatching(/Command failed/),
        fix: "reinstall",
      }),
    ]);
  });

  it("gives up on a hung dependency check, without suggesting a reinstall", async () => {
    const paths = fakeBundle("setTimeout(() => {}, 60_000);");
    const failure = await probeHostDeps(paths, 300);
    expect(failure).toMatch(/^timed out after 0.3s/);
    expect(depsProbeFix(failure as string, "reinstall")).toMatch(/Run doctor again/);
  });

  it("adds the android.sdkRoot check to a successful report", async () => {
    const home = path.join(dir, "home");
    fs.mkdirSync(home);
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", home);
    fs.mkdirSync(path.join(dir, ".git"));
    fs.mkdirSync(path.join(dir, ".argent"));
    fs.writeFileSync(
      path.join(dir, ".argent", "config.json"),
      JSON.stringify({ android: { sdkRoot: "/opt/sdk" } })
    );
    const section = await platformsSection(ctx(), fakeBundle(), noLink, "r");
    expect(section.checks.at(-1)?.label).toBe("android.sdkRoot is set only for this project");
  });

  it("checks a local-mode project's own copy when a global argent runs doctor", async () => {
    const pkg = path.join(dir, "node_modules", "@swmansion", "argent");
    fs.mkdirSync(path.join(pkg, "dist"), { recursive: true });
    fs.writeFileSync(
      path.join(pkg, "package.json"),
      JSON.stringify({ name: "@swmansion/argent", version: "0.30.0" })
    );
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ devDependencies: { "@swmansion/argent": "0.30.0" } })
    );
    const global = fakeBundle();
    const section = await platformsSection(
      { ...ctx(), mode: "local" },
      { ...global, installKind: "global" },
      noLink,
      "r"
    );
    expect(section.checks[0]?.label).toMatch(/Checked the project's local argent/);
    expect(section.checks[1]).toMatchObject({
      status: "error",
      fix: expect.stringMatching(
        /^Reinstall argent: delete .*node_modules\/@swmansion\/argent, then npm install$/
      ),
    });
    fs.writeFileSync(path.join(dir, "bun.lock"), "");
    const bun = await platformsSection(
      { ...ctx(), mode: "local" },
      { ...global, installKind: "global" },
      noLink,
      "r"
    );
    expect(bun.checks[1]?.fix).toBe("Reinstall argent: bun install --force");
  });

  it("falls back to its own check when the project's copy predates --check-deps", async () => {
    const pkg = path.join(dir, "node_modules", "@swmansion", "argent");
    fs.mkdirSync(path.join(pkg, "dist"), { recursive: true });
    fs.writeFileSync(
      path.join(pkg, "package.json"),
      JSON.stringify({ name: "@swmansion/argent", version: "0.30.1" })
    );
    fs.writeFileSync(
      path.join(pkg, "dist", "tool-server.cjs"),
      'console.error("Unknown command: " + process.argv[2]); process.exit(1);'
    );
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ devDependencies: { "@swmansion/argent": "0.30.1" } })
    );
    vi.stubEnv("ARGENT_TEST_ADB", "/sdk/adb");
    const section = await platformsSection(
      { ...ctx(), mode: "local" },
      { ...fakeBundle(), installKind: "global" },
      noLink,
      "r"
    );
    expect(section.checks[0]).toMatchObject({
      status: "info",
      label: expect.stringMatching(/project's local argent predates this check/),
    });
    expect(section.checks.find((c) => c.label === "Android")?.status).toBe("ok");
    expect(section.checks.some((c) => c.status === "error")).toBe(false);
  });

  it("names the stop command of the copy whose server the note is about", async () => {
    vi.stubEnv("ANDROID_HOME", "/sdk");
    vi.stubEnv("ARGENT_TEST_ADB", "/sdk/platform-tools/adb");
    const section = await platformsSection(
      ctx(),
      { ...fakeBundle(), installKind: "local" },
      noLink,
      "r"
    );
    expect(section.checks.find((c) => c.label === "Android")?.detail).toMatch(
      /\(npx argent server stop\)/
    );
  });
});

describe("depsProbeFailure", () => {
  it("reports only execFile's own kill as a timeout", () => {
    expect(depsProbeFailure({ killed: true, signal: "SIGTERM" })).toMatch(/timed out/);
    const crash = depsProbeFailure({
      killed: false,
      signal: "SIGABRT",
      stderr: "FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory\n",
    });
    expect(crash).not.toMatch(/timed out/);
    expect(crash).toMatch(/SIGABRT.*heap out of memory/);
  });
});
