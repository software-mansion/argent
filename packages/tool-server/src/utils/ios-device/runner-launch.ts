import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { FAILURE_CODES, FailureError } from "@argent/registry";
import { scheduleGroupSigkill, signalGroupThenPid } from "../process-kill";

/**
 * Launch the built runner on a device and kill it again.
 */

function logsRoot(): string {
  return path.join(os.homedir(), ".argent", "ios-device-runner", "logs");
}

function resultsRoot(): string {
  return path.join(os.homedir(), ".argent", "ios-device-runner", "results");
}

export interface LaunchedRunner {
  child: ChildProcess;
  logPath: string;
  /** This device's one crash bundle. Overwritten on every launch. */
  resultBundlePath: string;
}

/**
 * Launch the runner on the device with `xcodebuild test-without-building`.
 */
export async function launchRunner(opts: {
  udid: string;
  xctestrunPath: string;
  derivedDataPath: string;
  port: number;
}): Promise<LaunchedRunner> {
  const logDir = logsRoot();
  const resultsDir = resultsRoot();

  await Promise.all([
    fsp.mkdir(logDir, { recursive: true }),
    fsp.mkdir(resultsDir, { recursive: true }),
  ]);

  const deviceTag = opts.udid.slice(0, 8);
  // One log and one crash bundle per device. Each launch overwrites them.
  const logPath = path.join(logDir, `runner-${deviceTag}.log`);
  const resultBundlePath = path.join(resultsDir, `argent-${deviceTag}.xcresult`);

  // xcodebuild refuses to write onto an existing result bundle.
  await fsp.rm(resultBundlePath, { recursive: true, force: true });

  const logFd = fs.openSync(logPath, "w");

  const child = spawn(
    "xcodebuild",
    [
      "test-without-building",
      "-only-testing",
      "ArgentRunnerUITests/ArgentRunnerSession/testServeCommands",
      "-parallel-testing-enabled",
      "NO",
      "-test-timeouts-enabled",
      "NO",
      "-collect-test-diagnostics",
      "never",
      "-maximum-concurrent-test-device-destinations",
      "1",
      "-destination-timeout",
      "20",
      "-resultBundlePath",
      resultBundlePath,
      "-xctestrun",
      opts.xctestrunPath,
      "-derivedDataPath",
      opts.derivedDataPath,
      "-destination",
      `platform=iOS,id=${opts.udid}`,
    ],
    {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      // xcodebuild forwards TEST_RUNNER_* into the test process with the prefix stripped.
      env: { ...process.env, TEST_RUNNER_ARGENT_RUNNER_PORT: String(opts.port) },
    }
  );

  // Detached and unref'd. The runner outlives this call.
  child.unref();
  fs.closeSync(logFd);

  try {
    // Spawn failure must reject here.
    await once(child, "spawn");
  } catch (error) {
    throw new FailureError(
      "xcodebuild could not be started. Check that Xcode is installed and on PATH.",
      {
        error_code: FAILURE_CODES.IOS_DEVICE_RUNNER_NOT_READY,
        failure_stage: "ios_device_runner_spawn",
        failure_area: "tool_server",
        error_kind: "subprocess",
      },
      { cause: error as Error }
    );
  }

  // A late "error" event must never become an uncaught exception.
  child.on("error", () => {});

  return {
    child,
    logPath,
    resultBundlePath,
  };
}

/** Kill a runner's whole process group (xcodebuild spawns helpers). */
export function killRunnerProcess(child: ChildProcess): void {
  const pid = child.pid;

  if (!pid) {
    return;
  }

  signalGroupThenPid(process.kill.bind(process), pid, "SIGTERM");
  // Unconditional after the grace period. This path accepts the recycled-pgid window.
  scheduleGroupSigkill(pid, 5_000, { gateOnGroupLiveness: false });
}
