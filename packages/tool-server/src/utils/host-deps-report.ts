import type { ToolDependency } from "@argent/registry";
import {
  axServiceBinaryPath,
  bootstrapDylibPath,
  nativeDevtoolsDylibPath,
  simulatorServerBinaryPath,
} from "@argent/native-devtools-ios";
import { bundledHelperApkPath } from "@argent/native-devtools-android";
import { execFile } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import { INSTALL_HINTS } from "./check-deps";
import { resolveAndroidBinary } from "./android-binary";
import { resolveVegaBinary } from "./vega-cli";
import { commandOnPath } from "./command-on-path";
import { getCandidateChromiumPorts } from "./chromium-discovery";
import { detectSigningTeams } from "./ios-device/team-detect";

/**
 * What `tool-server --check-deps` prints for `argent doctor`. The probes are the
 * same resolvers the tool-server runs before a tool call, so doctor can never
 * report a dependency as found that a tool would then reject (or vice versa).
 */
interface HostDepsReport {
  platform: NodeJS.Platform;
  deps: Array<{ dep: ToolDependency; path: string | null; hint: string }>;
  /** Artifacts shipped inside the argent package. `error` is set when missing. */
  bundled: Array<{ name: string; path: string | null; error?: string }>;
  /** Physical iPhone runner signing. Null off macOS. */
  signing: { teamIdEnv: string | null; detectedTeams: number } | null;
  /**
   * The active developer dir and whether it has simctl. Null off macOS.
   * `/usr/bin/xcrun` is a shim present on every Mac, so its presence alone
   * says nothing about whether simulators work.
   */
  xcode: { developerDir: string | null; simctl: boolean; fromEnv: boolean } | null;
  /** CDP ports Chromium discovery probes. */
  chromiumPorts: number[];
}

const execFileAsync = promisify(execFile);

// `xcode-select -p` only prints the selected dir (honouring DEVELOPER_DIR); it
// never triggers the license or install dialog a bare `xcrun` can.
async function probeXcode(): Promise<NonNullable<HostDepsReport["xcode"]>> {
  const fromEnv = Boolean(process.env.DEVELOPER_DIR?.trim());
  try {
    const { stdout } = await execFileAsync("xcode-select", ["-p"], { timeout: 5_000 });
    const developerDir = stdout.trim() || null;
    return {
      developerDir,
      simctl: developerDir !== null && existsSync(path.join(developerDir, "usr", "bin", "simctl")),
      fromEnv,
    };
  } catch {
    return { developerDir: null, simctl: false, fromEnv };
  }
}

// sim-remote is only for radon-cloud users, so doctor does not report it.
const REPORTED_DEPS: readonly ToolDependency[] = ["xcrun", "adb", "emulator", "vega"];

async function resolveDep(dep: ToolDependency): Promise<string | null> {
  if (dep === "adb" || dep === "emulator") return resolveAndroidBinary(dep);
  if (dep === "vega") return resolveVegaBinary();
  // Never run the binary: a bare `xcrun` can pop the Xcode license dialog.
  return commandOnPath(dep);
}

function bundledArtifact(
  name: string,
  resolve: () => string,
  executable = false
): HostDepsReport["bundled"][number] {
  try {
    const p = resolve();
    if (!existsSync(p)) return { name, path: null, error: `not found: ${p}` };
    if (executable && process.platform !== "win32") {
      try {
        accessSync(p, constants.X_OK);
      } catch {
        return { name, path: null, error: `not executable: ${p}` };
      }
    }
    return { name, path: p };
  } catch (err) {
    return { name, path: null, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function collectHostDepsReport(): Promise<HostDepsReport> {
  const deps = await Promise.all(
    REPORTED_DEPS.map(async (dep) => ({
      dep,
      path: await resolveDep(dep),
      hint: INSTALL_HINTS[dep],
    }))
  );

  const isMac = process.platform === "darwin";
  const bundled = [bundledArtifact("simulator-server", simulatorServerBinaryPath, true)];
  if (isMac) {
    bundled.push(
      bundledArtifact("ax-service", axServiceBinaryPath, true),
      bundledArtifact("native devtools dylib", nativeDevtoolsDylibPath),
      bundledArtifact("injection bootstrap dylib", bootstrapDylibPath)
    );
  }
  bundled.push(bundledArtifact("android helper apk", bundledHelperApkPath));

  let signing: HostDepsReport["signing"] = null;
  let xcode: HostDepsReport["xcode"] = null;
  if (isMac) {
    xcode = await probeXcode();
    const teamIdEnv = process.env.ARGENT_IOS_TEAM_ID?.trim() || null;
    // The env var wins over the keychain, so skip the `security` call when set.
    const detectedTeams = teamIdEnv ? 0 : (await detectSigningTeams()).length;
    signing = { teamIdEnv, detectedTeams };
  }

  return {
    platform: process.platform,
    deps,
    bundled,
    signing,
    xcode,
    chromiumPorts: getCandidateChromiumPorts(),
  };
}
