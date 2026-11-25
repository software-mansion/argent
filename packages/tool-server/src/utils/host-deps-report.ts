import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { resolveAndroidBinary } from "./android-binary";
import { xcodeFirstLaunchPending, xcodeInstallInstruction } from "./xcode-first-launch";

const execFileAsync = promisify(execFile);

interface HostDepsReport {
  adb: string | null;
  xcode: { developerDir: string | null; simctl: boolean; firstLaunch: string | null } | null;
}

async function activeDeveloperDir(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("xcode-select", ["-p"], { timeout: 5_000 });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function probeXcode(): Promise<HostDepsReport["xcode"]> {
  if (process.platform !== "darwin") return null;
  const developerDir = await activeDeveloperDir();
  const simctl = developerDir !== null && existsSync(join(developerDir, "usr", "bin", "simctl"));
  const firstLaunch =
    simctl && xcodeFirstLaunchPending("simctl") ? xcodeInstallInstruction() : null;
  return { developerDir, simctl, firstLaunch };
}

export async function collectHostDepsReport(): Promise<HostDepsReport> {
  const [adb, xcode] = await Promise.all([resolveAndroidBinary("adb"), probeXcode()]);
  return { adb, xcode };
}
