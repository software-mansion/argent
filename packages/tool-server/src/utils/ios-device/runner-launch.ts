import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { FAILURE_CODES, FailureError } from "@argent/registry";
import { readBundleIdentifier } from "../plist";
import { scheduleGroupSigkill, signalGroupThenPid } from "../process-kill";
import { sleep } from "../timing";
import { iosRelayFor, type IosRelay } from "./relay";
import { iosRelayDriver } from "./relay-driver";
import { readXctestrun, runnerAppsFromXctestrun, runnerBundleIdFromXctestrun } from "./xctestrun";

/**
 * Launch the built runner on a device, learn the port it bound, and kill it again.
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
  /**
   * The port the runner was told to bind, when the launcher could tell it one.
   * Absent for an xcodebuild launch, where the runner picks a port and logs it.
   */
  port?: number;
}

/**
 * Launch the runner on the device: `xcodebuild test-without-building` for a
 * phone on this Mac's USB, `ios runxctest` through the relay for a phone a
 * provider relays (CoreDevice cannot see that one, so xcodebuild cannot either).
 */
export async function launchRunner(opts: {
  udid: string;
  xctestrunPath: string;
  derivedDataPath: string;
}): Promise<LaunchedRunner> {
  const logDir = logsRoot();
  const resultsDir = resultsRoot();

  await Promise.all([
    fsp.mkdir(logDir, { recursive: true }),
    fsp.mkdir(resultsDir, { recursive: true }),
  ]);

  const relay = iosRelayFor(opts.udid);
  const deviceTag = (relay?.udid ?? opts.udid).slice(0, 8);
  // One log and one crash bundle per device. Each launch overwrites them.
  const logPath = path.join(logDir, `runner-${deviceTag}.log`);
  const resultBundlePath = path.join(resultsDir, `argent-${deviceTag}.xcresult`);

  // xcodebuild refuses to write onto an existing result bundle.
  await fsp.rm(resultBundlePath, { recursive: true, force: true });

  if (relay) {
    return await launchRelayedRunner(relay, opts.xctestrunPath, logPath, resultBundlePath);
  }

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

/**
 * The device-side port a relayed runner binds. Neither driver forwards the
 * runner's NSLog line, so the port is chosen here and pinned through the
 * runner's `ARGENT_RUNNER_PORT` environment variable; it only has to be free
 * on the phone, where nothing else of Argent's listens.
 */
const RELAY_RUNNER_PORT = 27042;

/**
 * Launch the runner through the relay with the selected driver. xcodebuild
 * installs the apps an xctestrun names before testing; the relay drivers do
 * not, and a shared phone may lose them between sessions, so whatever is
 * missing is installed on every launch.
 */
async function launchRelayedRunner(
  relay: IosRelay,
  xctestrunPath: string,
  logPath: string,
  resultBundlePath: string
): Promise<LaunchedRunner> {
  const driver = await iosRelayDriver();
  const document = await readXctestrun(xctestrunPath);
  const runnerBundleId = runnerBundleIdFromXctestrun(document);

  if (!runnerBundleId) {
    throw new FailureError(
      `${xctestrunPath} names no test host bundle id, so the runner cannot be launched.`,
      {
        error_code: FAILURE_CODES.IOS_DEVICE_RUNNER_NOT_READY,
        failure_stage: "ios_device_runner_spawn",
        failure_area: "tool_server",
        error_kind: "validation",
      }
    );
  }

  const installed = await driver.installedBundleIds(relay);

  for (const app of runnerAppsFromXctestrun(document, path.dirname(xctestrunPath))) {
    const bundleId =
      app.bundleId ?? (await readBundleIdentifier(path.join(app.path, "Info.plist")));

    if (bundleId && installed.has(bundleId)) continue;

    await driver.installApp(relay, app.path);
  }

  const logFd = fs.openSync(logPath, "w");

  try {
    const child = await driver.launchRunner(relay, {
      xctestrunPath,
      runnerBundleId,
      port: RELAY_RUNNER_PORT,
      logFd,
    });

    return { child, logPath, resultBundlePath, port: RELAY_RUNNER_PORT };
  } finally {
    fs.closeSync(logFd);
  }
}

/** The runner's NSLog line once its listener is ready, with the port it actually bound. */
const LISTENING_LINE_RE = /ARGENT_RUNNER_LISTENING port=(\d+)/;
const LISTENING_POLL_INTERVAL_MS = 250;

/**
 * Poll the launch log until the runner reports the loopback port it bound on
 * the device. The port is the runner's to choose (a probe on the Mac cannot
 * tell what is free on the phone), and the log is the only channel back
 * before the first command.
 */
export async function waitForRunnerListeningPort(
  logPath: string,
  opts: { timeoutMs: number }
): Promise<number> {
  const expiresAt = Date.now() + opts.timeoutMs;

  for (;;) {
    const logText = await fsp.readFile(logPath, "utf8").catch(() => "");
    const port = Number.parseInt(LISTENING_LINE_RE.exec(logText)?.[1] ?? "", 10);

    if (port > 0) {
      return port;
    }

    if (Date.now() >= expiresAt) {
      throw new Error(`the runner did not log a listening port within ${opts.timeoutMs}ms`);
    }

    await sleep(LISTENING_POLL_INTERVAL_MS);
  }
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
