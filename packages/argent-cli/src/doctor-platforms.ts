import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { getConfigValueAtScope } from "@argent/configuration-core";
import { type ToolsServerPaths } from "@argent/tools-client";
import {
  detectProjectPackageManager,
  formatShellCommand,
  probeLocalInstall,
} from "@argent/installer";
import {
  type DoctorCheck,
  type DoctorContext,
  type DoctorSection,
  type ResolvedToolsUrl,
  check,
  childFailureReason,
  home,
  samePath,
} from "./doctor-shared.js";
import { localReinstallCommand } from "./doctor-install.js";
import { stopCommand } from "./doctor-tool-server.js";

const execFileAsync = promisify(execFile);

// `argent doctor`: the Platforms section, from the tool-server's `--check-deps` report.

// Mirrors `tool-server --check-deps` (tool-server/src/utils/host-deps-report.ts).
interface HostDepsReport {
  platform: NodeJS.Platform;
  deps: Array<{ dep: string; path: string | null; hint: string; runError?: string }>;
  bundled: Array<{ name: string; path: string | null; error?: string }>;
  signing: { teamIdEnv: string | null; detectedTeams: number } | null;
  /** Absent from reports of builds that predate the field. */
  xcode?: {
    developerDir: string | null;
    simctl: boolean;
    fromEnv?: boolean;
    simctlError?: string;
    availableSimulators?: number;
    iosRuntimes?: number;
  } | null;
  chromiumPorts?: number[];
  kvmProblem?: string | null;
  /** AVDs `emulator -list-avds` names, when the emulator runs. */
  androidAvds?: number;
}

const DEPS_PROBE_TIMEOUT_MS = 30_000;

const restartNote = (stopCmd: string) =>
  `a running tool-server keeps the environment it started with, so stop it (${stopCmd} server stop) after changing the variable`;

export async function probeHostDeps(
  paths: ToolsServerPaths,
  timeoutMs = DEPS_PROBE_TIMEOUT_MS
): Promise<HostDepsReport | string> {
  try {
    const { stdout } = await execFileAsync(process.execPath, [paths.bundlePath, "--check-deps"], {
      timeout: timeoutMs,
      env: {
        ...process.env,
        ARGENT_SIMULATOR_SERVER_DIR: paths.simulatorServerDir,
        ARGENT_NATIVE_DEVTOOLS_DIR: paths.nativeDevtoolsDir,
      },
    });
    return JSON.parse(stdout) as HostDepsReport;
  } catch (err) {
    return depsProbeFailure(err, timeoutMs);
  }
}

/** A hang or a crash on a signal is not a broken install, so reinstalling won't help. */
export function depsProbeFix(failure: string, reinstall: string): string {
  return /^(timed out|killed by)/.test(failure)
    ? "Run doctor again; if it keeps failing, report it at https://github.com/software-mansion/argent/issues with this line"
    : reinstall;
}

/** Why `--check-deps` failed. Only execFile's own timeout kill sets `killed`. */
export function depsProbeFailure(err: unknown, timeoutMs = DEPS_PROBE_TIMEOUT_MS): string {
  const { stderr, killed, signal } = err as {
    stderr?: unknown;
    killed?: boolean;
    signal?: string | null;
  };
  if (killed) {
    return `timed out after ${timeoutMs / 1000}s (${signal ?? "killed"})`;
  }
  const fallback = err instanceof Error ? err.message.split("\n")[0]! : String(err);
  const reason = childFailureReason(typeof stderr === "string" ? stderr : "", fallback);
  return signal ? `killed by ${signal}: ${reason}` : reason;
}

// runProbe's message for a binary that did not answer in time.
const isHang = (runError: string) => /timed out$/.test(runError);

function simctlFailure(simctlError: string): DoctorCheck {
  const fix = isHang(simctlError)
    ? "Restart CoreSimulator (sudo killall -9 com.apple.CoreSimulator.CoreSimulatorService), then run doctor again"
    : /license/i.test(simctlError)
      ? "sudo xcodebuild -license accept"
      : "Open Xcode once to finish its setup (or run xcodebuild -runFirstLaunch)";
  return check("error", "iOS simulator: simctl fails to run", { detail: simctlError, fix });
}

/** The env var the tool-server's resolver read adb's SDK root from, if any. */
function androidRootFromEnv(adbPath: string): string | null {
  for (const name of ["ANDROID_HOME", "ANDROID_SDK_ROOT"]) {
    const root = process.env[name];
    if (root && adbPath.startsWith(path.join(root, path.sep))) return name;
  }
  return null;
}

function adbFailureFix(runError: string): string {
  const dir = /Cannot mkdir '([^']+)'/.exec(runError)?.[1];
  return dir
    ? `Make ${home(path.dirname(dir))} writable so adb can create ${path.basename(dir)} (it keeps its keys there)`
    : "Reinstall Android SDK platform-tools for this machine's architecture";
}

function kvmFix(problem: string): string {
  return /missing/.test(problem)
    ? "Enable virtualization (VT-x/AMD-V) and load the kvm module (modprobe kvm_intel or kvm_amd)"
    : "sudo usermod -aG kvm $USER, then log in again";
}

export function platformChecks(
  report: HostDepsReport,
  reinstall: string,
  stopCmd = "argent"
): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  const dep = (name: string) => report.deps.find((d) => d.dep === name);
  const brokenBundle = report.bundled.filter((b) => b.error);
  for (const b of brokenBundle) {
    const broken = b.error?.startsWith("not executable") ? "is not executable" : "is missing";
    checks.push(
      check("error", `Bundled ${b.name} ${broken}`, {
        detail: b.error,
        fix: reinstall,
      })
    );
  }
  const bundleOk = (names: string[]) => !brokenBundle.some((b) => names.includes(b.name));
  let usable = 0;
  // Installed but failing: the toolchain is there, so "install it" is the wrong advice.
  let present = 0;

  if (report.platform !== "darwin") {
    checks.push(check("info", "iOS simulator: requires a macOS host"));
  } else {
    const xcrun = dep("xcrun");
    // /usr/bin/xcrun is a shim on every Mac: simulators need a developer dir
    // with simctl (full Xcode, not just the Command Line Tools).
    const noSimctl = report.xcode != null && !report.xcode.simctl;
    const fromEnv = report.xcode?.fromEnv === true;
    const simctlError = report.xcode?.simctlError;
    if (xcrun?.path && noSimctl) {
      const dir = report.xcode?.developerDir ?? "xcode-select -p failed";
      checks.push(
        check("info", "iOS simulator: Xcode not found (no simctl in the active developer dir)", {
          detail: fromEnv ? `${dir} (from DEVELOPER_DIR)` : dir,
          fix: fromEnv
            ? "Unset DEVELOPER_DIR, or point it at /Applications/Xcode.app/Contents/Developer"
            : "Install Xcode, then sudo xcode-select -s /Applications/Xcode.app",
        })
      );
    } else if (xcrun?.path && simctlError) {
      present++;
      checks.push(simctlFailure(simctlError));
    } else if (
      xcrun?.path &&
      report.xcode?.availableSimulators === 0 &&
      (report.xcode.iosRuntimes ?? 0) > 0
    ) {
      present++;
      checks.push(
        check("warn", "iOS simulator: no available iOS simulators", {
          detail: report.xcode.developerDir ?? undefined,
          fix: "Create one in Xcode > Window > Devices and Simulators, or with xcrun simctl create",
        })
      );
    } else if (xcrun?.path && report.xcode?.availableSimulators === 0) {
      present++;
      checks.push(
        check("warn", "iOS simulator: no available simulators (no iOS runtime installed?)", {
          detail: report.xcode.developerDir ?? undefined,
          fix: "Install an iOS runtime: Xcode > Settings > Components, or xcodebuild -downloadPlatform iOS",
        })
      );
    } else if (xcrun?.path && bundleOk(["simulator-server", "ax-service"])) {
      usable++;
      checks.push(
        check("ok", "iOS simulator", {
          detail: report.xcode?.developerDir ?? `xcrun at ${xcrun.path}`,
        })
      );
    } else if (xcrun?.path) {
      checks.push(
        check("info", "iOS simulator: unavailable until the bundled binaries above work")
      );
    } else {
      checks.push(
        check("info", "iOS simulator: Xcode command-line tools not found", { fix: xcrun?.hint })
      );
    }

    const signing = report.signing;
    if (noSimctl) {
      checks.push(
        check("info", "Physical iPhone: needs full Xcode (devicectl and xcodebuild)", {
          fix: "Install Xcode and select it as the developer dir (see iOS simulator above)",
        })
      );
    } else if (simctlError && /license/i.test(simctlError)) {
      // xcodebuild and devicectl stop at the same license gate.
      checks.push(
        check("info", "Physical iPhone: blocked until the Xcode license is accepted", {
          fix: "sudo xcodebuild -license accept",
        })
      );
    } else if (signing?.teamIdEnv) {
      checks.push(
        check("ok", `Physical iPhone: signing team ${signing.teamIdEnv} (ARGENT_IOS_TEAM_ID)`, {
          detail:
            "read from this shell; a running tool-server keeps the environment it started with, so restart it after changing the variable",
        })
      );
    } else if (signing && signing.detectedTeams > 0) {
      checks.push(
        check("ok", `Physical iPhone: ${signing.detectedTeams} signing team(s) in keychain`)
      );
    } else {
      checks.push(
        check("info", "Physical iPhone: no Apple Development certificate in the keychain", {
          fix: "In Xcode > Settings > Accounts, sign in, then Manage Certificates > + > Apple Development; or set ARGENT_IOS_TEAM_ID",
        })
      );
    }
  }

  const adb = dep("adb");
  const emulator = dep("emulator");
  // Android device tools drive the emulator through simulator-server too.
  if (adb?.path && adb.runError && isHang(adb.runError)) {
    present++;
    // `adb version` never contacts the adb server, so kill-server can't help.
    checks.push(
      check("error", "Android: adb does not answer", {
        detail: `${home(adb.path)}: ${adb.runError}`,
        fix: `Check what ${home(adb.path)} runs: it hangs before reaching the adb server (a wrapper script or a stalled binary)`,
      })
    );
  } else if (adb?.path && adb.runError) {
    present++;
    checks.push(
      check("error", "Android: adb fails to run", {
        detail: `${home(adb.path)}: ${adb.runError}`,
        fix: adbFailureFix(adb.runError),
      })
    );
  } else if (adb?.path && !bundleOk(["simulator-server"])) {
    checks.push(check("info", "Android: unavailable until the bundled simulator-server works"));
  } else if (adb?.path) {
    usable++;
    const envName = androidRootFromEnv(adb.path);
    checks.push(
      check("ok", "Android", {
        detail: envName
          ? `adb at ${home(adb.path)}, found through ${envName} in this shell; ${restartNote(stopCmd)}`
          : `adb at ${home(adb.path)}`,
      })
    );
    if (emulator?.path && emulator.runError) {
      checks.push(
        check("warn", "Android emulator binary fails to run (can't boot AVDs)", {
          detail: `${home(emulator.path)}: ${emulator.runError}`,
          fix: "Reinstall the Android Emulator from Android Studio's SDK Manager",
        })
      );
    } else if (!emulator?.path) {
      checks.push(
        check("info", "Android emulator binary not found (can't boot AVDs)", {
          fix: emulator?.hint,
        })
      );
    } else if (report.kvmProblem) {
      checks.push(
        check("warn", "Android emulator: no KVM acceleration (boots slowly or not at all)", {
          detail: report.kvmProblem,
          fix: kvmFix(report.kvmProblem),
        })
      );
    } else if (report.androidAvds === 0) {
      checks.push(
        check("warn", "Android emulator: no AVDs to boot", {
          detail: `${home(emulator.path)} -list-avds names none`,
          fix: "Create one in Android Studio's Device Manager, or with avdmanager create avd",
        })
      );
    }
  } else {
    checks.push(check("info", "Android: adb not found", { fix: adb?.hint }));
  }

  const vega = dep("vega");
  if (vega?.path && adb?.path && !adb.runError) {
    usable++;
    checks.push(check("ok", "Vega (Fire TV)", { detail: `vega at ${home(vega.path)}` }));
  } else if (vega?.path && adb?.path) {
    checks.push(
      check("warn", "Vega (Fire TV): adb fails to run (see Android above), and Vega tools need it")
    );
  } else if (vega?.path) {
    // The Vega SDK does not ship adb, and most Vega tools need it.
    checks.push(
      check("warn", "Vega (Fire TV): adb not found, which Vega tools need too", {
        fix: "Install Android SDK platform-tools so adb is on PATH (or set ANDROID_HOME)",
      })
    );
  } else {
    checks.push(check("info", "Vega (Fire TV): vega CLI not found", { fix: vega?.hint }));
  }

  const ports = report.chromiumPorts ?? [9222];
  checks.push(
    check("info", `Chromium: probes CDP port${ports.length === 1 ? "" : "s"} ${ports.join(", ")}`, {
      detail: "launch with --remote-debugging-port, or set ARGENT_CHROMIUM_PORTS",
    })
  );

  // Chromium / Electron need nothing installed, so this is not a failure. A
  // broken bundle or toolchain is reported above with its own fix.
  if (usable === 0 && present === 0 && brokenBundle.length === 0) {
    checks.unshift(
      check("warn", "No mobile platform toolchain found: only Chromium / Electron apps work", {
        fix:
          report.platform === "darwin"
            ? "Install Xcode (iOS) or Android platform-tools (Android, and Vega with the Vega SDK)"
            : "Install Android platform-tools (Android, and Vega with the Vega SDK)",
      })
    );
  }
  return checks;
}

function expandHome(value: string): string {
  return path.resolve(value.replace(/^~(?=$|[\\/])/, homedir()));
}

/**
 * The shared tool-server reads config from the directory it was started in, so
 * a project-only android.sdkRoot is invisible to a server started elsewhere.
 */
export function sdkRootCheck(cwd: string, argentCmd: string): DoctorCheck | null {
  const projectValue = getConfigValueAtScope("android.sdkRoot", "project", { cwd });
  const globalValue = getConfigValueAtScope("android.sdkRoot", "global", { cwd });
  if (typeof projectValue !== "string") return null;
  if (typeof globalValue === "string") {
    if (expandHome(projectValue) === expandHome(globalValue)) return null;
    return check("warn", "android.sdkRoot here differs from the global one", {
      detail: `project ${projectValue}, global ${globalValue}: a tool-server started from another directory uses the global one`,
      fix: "Point both at the same SDK, or stop the tool-server before using this project",
    });
  }
  return check("warn", "android.sdkRoot is set only for this project", {
    detail: "the tool-server is shared, and one started from another directory won't see it",
    fix: formatShellCommand({
      bin: argentCmd,
      args: ["config", "set", "android.sdkRoot", projectValue, "--scope", "global"],
    }),
  });
}

/**
 * The tool-server the project's entries start. In a local-mode project they run
 * the project's copy, which a global argent running doctor would not check.
 */
export function projectToolServer(
  ctx: DoctorContext,
  paths: ToolsServerPaths
): { paths: ToolsServerPaths; packageDir: string } | null {
  if (ctx.mode !== "local" || paths.installKind === "local") return null;
  const { packageDir, version } = probeLocalInstall(ctx.projectRoot);
  if (!packageDir || samePath(packageDir, path.dirname(path.dirname(paths.bundlePath)))) {
    return null;
  }
  return {
    packageDir,
    paths: {
      ...paths,
      installKind: "local",
      version: version ?? undefined,
      bundlePath: path.join(packageDir, "dist", "tool-server.cjs"),
      simulatorServerDir: path.join(packageDir, "bin"),
      nativeDevtoolsDir: path.join(packageDir, "dylibs"),
    },
  };
}

export async function platformsSection(
  ctx: DoctorContext,
  paths: ToolsServerPaths,
  linked: ResolvedToolsUrl,
  reinstall: string,
  entriesAllRemote = false
): Promise<DoctorSection> {
  if (linked.url || entriesAllRemote) {
    const where = linked.url
      ? "the linked tool-server's host"
      : "the tool-server every editor entry's ARGENT_TOOLS_URL points at";
    return { title: "Platforms", checks: [check("info", `Skipped: device tools run on ${where}`)] };
  }
  const local = projectToolServer(ctx, paths);
  const checked = local?.paths ?? paths;
  const reinstallChecked = local
    ? `Reinstall argent: ${localReinstallCommand(
        detectProjectPackageManager(ctx.projectRoot),
        ctx.projectRoot,
        local.packageDir,
        ctx.installCmd
      )}`
    : reinstall;
  let source = local
    ? [
        check("info", "Checked the project's local argent, which its editor entries start", {
          detail: home(local.packageDir),
        }),
      ]
    : [];
  let report = await probeHostDeps(checked);
  let reinstallShown = reinstallChecked;
  if (local && typeof report === "string" && predatesCheckDeps(report)) {
    source = [
      check(
        "info",
        "The project's local argent predates this check, so the argent running doctor ran it",
        {
          detail: `${home(local.packageDir)}: ${report}`,
        }
      ),
    ];
    report = await probeHostDeps(paths);
    reinstallShown = reinstall;
  }
  if (typeof report === "string") {
    return {
      title: "Platforms",
      checks: [
        ...source,
        check("error", "Could not run the bundled tool-server's dependency check", {
          detail: report,
          fix: depsProbeFix(report, reinstallShown),
        }),
      ],
    };
  }
  const stopCmd = stopCommand(ctx, checked);
  const sdkRoot = sdkRootCheck(ctx.cwd, ctx.argentCmd);
  return {
    title: "Platforms",
    checks: [
      ...source,
      ...platformChecks(report, reinstallShown, stopCmd),
      ...(sdkRoot ? [sdkRoot] : []),
    ],
  };
}

/** A tool-server from before `--check-deps` rejects the flag as a command. */
function predatesCheckDeps(failure: string): boolean {
  return failure.includes("Unknown command: --check-deps");
}
