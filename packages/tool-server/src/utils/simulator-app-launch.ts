import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { withKeyedLock } from "./keyed-lock";

const execFileAsync = promisify(execFile);

const CORE_SIMULATOR_INFO_PLIST =
  "/Library/Developer/PrivateFrameworks/CoreSimulator.framework/Versions/A/Resources/Info.plist";

// A Simulator.app built against an older CoreSimulator than the installed one
// (e.g. Xcode 16.4 selected after an Xcode 27 install) aborts up to ~1.7 s into
// every launch, popping a "Simulator quit unexpectedly" dialog each time.
const LAUNCH_WATCH_MS = 5_000;
const LAUNCH_POLL_MS = 250;

type Verdict = "runs" | "crashes";

// Serializes launches per app, so parallel boots wait for the first verdict
// instead of each crashing the app once.
const launchLocks = new Map<string, Promise<unknown>>();

function verdictFilePath(): string {
  return path.join(os.homedir(), ".argent", "simulator-app-launch.json");
}

function loadVerdicts(): Record<string, Verdict> {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(verdictFilePath(), "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, Verdict>) : {};
  } catch {
    return {};
  }
}

function persistVerdict(key: string, verdict: Verdict): void {
  const filePath = verdictFilePath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify({ ...loadVerdicts(), [key]: verdict }, null, 2));
}

async function bundleVersion(infoPlist: string): Promise<string> {
  const { stdout } = await execFileAsync(
    "plutil",
    ["-extract", "CFBundleVersion", "raw", "-o", "-", infoPlist],
    { timeout: 5_000 }
  );
  return stdout.trim();
}

/** Whether the app pairs with the installed CoreSimulator is fixed by these two builds. */
async function launchKey(simulatorApp: string): Promise<string> {
  const [appBuild, coreSimulatorBuild] = await Promise.all([
    bundleVersion(path.join(simulatorApp, "Contents", "Info.plist")),
    bundleVersion(CORE_SIMULATOR_INFO_PLIST),
  ]);
  return `${simulatorApp} ${appBuild} / CoreSimulator ${coreSimulatorBuild}`;
}

// `ps` prints the on-disk case, which a case-insensitive volume need not share
// with the path the app was opened by.
async function isRunning(executable: string): Promise<boolean> {
  const { stdout } = await execFileAsync("ps", ["-axo", "comm="], { timeout: 5_000 });
  const wanted = executable.toLowerCase();
  return stdout.split("\n").some((line) => line.trim().toLowerCase() === wanted);
}

async function survivesLaunch(executable: string): Promise<boolean> {
  for (let waited = 0; ; waited += LAUNCH_POLL_MS) {
    if (!(await isRunning(executable))) return false;
    if (waited >= LAUNCH_WATCH_MS) return true;
    await new Promise((resolve) => setTimeout(resolve, LAUNCH_POLL_MS));
  }
}

/**
 * Runs `launch` (which opens `simulatorApp`) unless this app is on record as
 * crashing at launch. The first launch of each app/CoreSimulator build pair is
 * watched for {@link LAUNCH_WATCH_MS}, and an app whose process is gone by then
 * is recorded as crashing. Records live in `~/.argent/simulator-app-launch.json`;
 * delete it to retry. Returns false when the launch was skipped.
 */
export function launchSimulatorApp(
  simulatorApp: string,
  launch: () => Promise<unknown>
): Promise<boolean> {
  return withKeyedLock(launchLocks, simulatorApp, async () => {
    const key = await launchKey(simulatorApp).catch(() => null);
    if (key === null) {
      await launch();
      return true;
    }
    const verdict = loadVerdicts()[key];
    if (verdict === "crashes") return false;
    await launch();
    if (verdict === "runs") return true;
    const executable = path.join(simulatorApp, "Contents", "MacOS", "Simulator");
    const runs = await survivesLaunch(executable).catch(() => null);
    if (runs === null) return true;
    try {
      persistVerdict(key, runs ? "runs" : "crashes");
    } catch (err) {
      process.stderr.write(
        `[simulator-app-launch] could not record that ${simulatorApp} ${runs ? "runs" : "crashes at launch"}: ${
          err instanceof Error ? err.message : String(err)
        }\n`
      );
    }
    return true;
  });
}
