import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  type FailureCode,
  FAILURE_CODES,
  FailureError,
  subprocessFailureMetadata,
} from "@argent/registry";
import { runAdb } from "./adb";
import { deviceSetForUdid, simctlPrefix } from "./ios-device-sets";

const execFileAsync = promisify(execFile);
const INSTALL_TIMEOUT_MS = 180_000;

interface InstallFailureOptions {
  errorCode: FailureCode;
  failureStage: string;
  signal?: AbortSignal;
}

interface LocalIosInstallOptions extends InstallFailureOptions {
  prefix?: readonly string[];
}

export async function installAndroidPackage(
  udid: string,
  apkPath: string,
  options: InstallFailureOptions
): Promise<void> {
  const { stdout, stderr } = await runAdb(["-s", udid, "install", "-r", "-d", "-g", apkPath], {
    timeoutMs: INSTALL_TIMEOUT_MS,
    signal: options.signal,
  });
  const output = `${stdout}\n${stderr}`;
  if (!/Success/i.test(output)) {
    throw new FailureError(`adb install failed: ${output.trim()}`, {
      error_code: options.errorCode,
      failure_stage: options.failureStage,
      failure_area: "tool_server",
      error_kind: "subprocess",
      failure_command: "adb",
    });
  }
}

export async function installLocalIosApp(
  udid: string,
  appPath: string,
  options: LocalIosInstallOptions
): Promise<void> {
  try {
    const prefix = options.prefix ?? simctlPrefix(await deviceSetForUdid(udid));
    await execFileAsync("xcrun", [...prefix, "install", udid, appPath], {
      timeout: INSTALL_TIMEOUT_MS,
      killSignal: "SIGKILL",
      maxBuffer: 16 * 1024 * 1024,
      signal: options.signal,
    });
  } catch (error) {
    throw new FailureError(
      `Failed to install iOS app bundle on ${udid}.`,
      {
        error_code: options.errorCode,
        failure_stage: options.failureStage,
        failure_area: "tool_server",
        error_kind: options.signal?.aborted ? "unknown" : "subprocess",
        ...subprocessFailureMetadata(error, "xcrun_simctl"),
      },
      { cause: error instanceof Error ? error : new Error(String(error)) }
    );
  }
}

export const INSTALL_FAILURE_CODES = {
  androidRemote: FAILURE_CODES.ANDROID_INSTALL_FAILED,
  androidReinstall: FAILURE_CODES.ANDROID_REINSTALL_INSTALL_FAILED,
  iosRemote: FAILURE_CODES.IOS_INSTALL_FAILED,
  iosReinstall: FAILURE_CODES.IOS_REINSTALL_INSTALL_FAILED,
} as const;
