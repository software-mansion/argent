import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  depsProbeFailure,
  depsProbeFix,
  platformChecks,
  sdkRootCheck,
} from "../src/doctor-platforms.js";
import { childFailureReason } from "../src/doctor-shared.js";

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

  it("warns when Xcode has no available simulators", () => {
    const checks = platformChecks(hostDeps({ xcode: { ...xcode, availableSimulators: 0 } }), "r");
    expect(checks.find((c) => c.label.startsWith("iOS simulator"))?.label).toMatch(/no available/);
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
