import * as os from "node:os";
import * as path from "node:path";

export const ARGENT_IOS_DEVICE_SET_ENV = "ARGENT_IOS_DEVICE_SET_PATH";

export function iosDeviceSetPath(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env[ARGENT_IOS_DEVICE_SET_ENV];
  if (!raw?.trim()) return null;
  return path.resolve(raw.trim());
}

export function defaultIosDeviceSetPath(): string {
  return path.join(os.homedir(), "Library/Developer/CoreSimulator/Devices");
}

export function activeIosDeviceSetPath(env: NodeJS.ProcessEnv = process.env): string {
  return iosDeviceSetPath(env) ?? defaultIosDeviceSetPath();
}

export function simctlArgs(
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env
): string[] {
  const deviceSet = iosDeviceSetPath(env);
  return deviceSet ? ["simctl", "--set", deviceSet, ...args] : ["simctl", ...args];
}
