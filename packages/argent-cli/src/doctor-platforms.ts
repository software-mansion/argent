import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getConfigValueAtScope } from "@argent/configuration-core";
import { type ToolsServerPaths } from "@argent/tools-client";
import {
  type DoctorCheck,
  type DoctorContext,
  type DoctorSection,
  type ResolvedToolsUrl,
  check,
  childFailureReason,
  home,
} from "./doctor-shared.js";

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
  } | null;
  chromiumPorts?: number[];
}

const DEPS_PROBE_TIMEOUT_MS = 30_000;

async function probeHostDeps(paths: ToolsServerPaths): Promise<HostDepsReport | string> {
  try {
    const { stdout } = await execFileAsync(process.execPath, [paths.bundlePath, "--check-deps"], {
      timeout: DEPS_PROBE_TIMEOUT_MS,
      env: {
        ...process.env,
        ARGENT_SIMULATOR_SERVER_DIR: paths.simulatorServerDir,
        ARGENT_NATIVE_DEVTOOLS_DIR: paths.nativeDevtoolsDir,
      },
    });
    return JSON.parse(stdout) as HostDepsReport;
  } catch (err) {
    return depsProbeFailure(err);
  }
}

/** A hang or a crash on a signal is not a broken install, so reinstalling won't help. */
export function depsProbeFix(failure: string, reinstall: string): string {
  return /^(timed out|killed by)/.test(failure)
    ? "Run doctor again; if it keeps failing, report it at https://github.com/software-mansion/argent/issues with this line"
    : reinstall;
}

/** Why `--check-deps` failed. Only execFile's own timeout kill sets `killed`. */
export function depsProbeFailure(err: unknown): string {
  const { stderr, killed, signal } = err as {
    stderr?: unknown;
    killed?: boolean;
    signal?: string | null;
  };
  if (killed) {
    return `timed out after ${DEPS_PROBE_TIMEOUT_MS / 1000}s (${signal ?? "killed"})`;
  }
  const fallback = err instanceof Error ? err.message.split("\n")[0]! : String(err);
  const reason = childFailureReason(typeof stderr === "string" ? stderr : "", fallback);
  return signal ? `killed by ${signal}: ${reason}` : reason;
}

export function platformChecks(report: HostDepsReport, reinstall: string): DoctorCheck[] {
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

  if (report.platform !== "darwin") {
    checks.push(check("info", "iOS simulator: requires a macOS host"));
  } else {
    const xcrun = dep("xcrun");
    // /usr/bin/xcrun is a shim on every Mac: simulators need a developer dir
    // with simctl (full Xcode, not just the Command Line Tools).
    const noSimctl = report.xcode != null && !report.xcode.simctl;
    const fromEnv = report.xcode?.fromEnv === true;
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
    } else if (xcrun?.path && report.xcode?.simctlError) {
      const license = /license/i.test(report.xcode.simctlError);
      checks.push(
        check("error", "iOS simulator: simctl fails to run", {
          detail: report.xcode.simctlError,
          fix: license
            ? "sudo xcodebuild -license accept"
            : "Open Xcode once to finish its setup (or run xcodebuild -runFirstLaunch)",
        })
      );
    } else if (xcrun?.path && report.xcode?.availableSimulators === 0) {
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
  if (adb?.path && adb.runError) {
    checks.push(
      check("error", "Android: adb fails to run", {
        detail: `${home(adb.path)}: ${adb.runError}`,
        fix: "Reinstall Android SDK platform-tools for this machine's architecture",
      })
    );
  } else if (adb?.path && !bundleOk(["simulator-server"])) {
    checks.push(check("info", "Android: unavailable until the bundled simulator-server works"));
  } else if (adb?.path) {
    usable++;
    checks.push(check("ok", "Android", { detail: `adb at ${home(adb.path)}` }));
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
    }
  } else {
    checks.push(check("info", "Android: adb not found", { fix: adb?.hint }));
  }

  const vega = dep("vega");
  if (vega?.path && adb?.path) {
    usable++;
    checks.push(check("ok", "Vega (Fire TV)", { detail: `vega at ${home(vega.path)}` }));
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
  // broken bundle is reported above with its own fix.
  if (usable === 0 && brokenBundle.length === 0) {
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

/**
 * The shared tool-server reads config from the directory it was started in, so
 * a project-only android.sdkRoot is invisible to a server started elsewhere.
 */
export function sdkRootCheck(cwd: string, argentCmd: string): DoctorCheck | null {
  const projectValue = getConfigValueAtScope("android.sdkRoot", "project", { cwd });
  const globalValue = getConfigValueAtScope("android.sdkRoot", "global", { cwd });
  if (typeof projectValue !== "string" || projectValue === globalValue) return null;
  return check("warn", "android.sdkRoot is set only for this project", {
    detail: "the tool-server is shared, and one started from another directory won't see it",
    fix: `${argentCmd} config set android.sdkRoot ${projectValue} --scope global`,
  });
}

export async function platformsSection(
  ctx: DoctorContext,
  paths: ToolsServerPaths,
  linked: ResolvedToolsUrl,
  reinstall: string
): Promise<DoctorSection> {
  if (linked.url) {
    return {
      title: "Platforms",
      checks: [check("info", "Skipped: device tools run on the linked tool-server's host")],
    };
  }
  const report = await probeHostDeps(paths);
  if (typeof report === "string") {
    return {
      title: "Platforms",
      checks: [
        check("error", "Could not run the bundled tool-server's dependency check", {
          detail: report,
          fix: depsProbeFix(report, reinstall),
        }),
      ],
    };
  }
  const sdkRoot = sdkRootCheck(ctx.cwd, ctx.argentCmd);
  return {
    title: "Platforms",
    checks: [...platformChecks(report, reinstall), ...(sdkRoot ? [sdkRoot] : [])],
  };
}
