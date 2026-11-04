import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CDPClient } from "./cdp-client";
import { ADB_DEVICES_TIMEOUT_MS, parseAdbDevices, runAdb } from "../adb";
import { listIosSimulators } from "../ios-devices";
import { simctlArgsForUdid } from "../ios-device-sets";
import { SIMCTL_KILL_SIGNAL } from "../simctl-config";

const execFileAsync = promisify(execFile);

const LOG_READ_TIMEOUT_MS = 5_000;
/** The device writes the line to its log a moment after the call returns. */
const RETRY_DELAY_MS = 300;

/**
 * The `list-devices` id of the device a debugger session's JS runtime runs on,
 * for a session keyed by Metro's `logicalDeviceId`.
 *
 * Once two devices share one Metro, `selectTarget` makes the caller connect
 * with the logicalDeviceId, a hash that nothing in argent can turn back into a
 * serial or UDID (see device-alias.ts). The runtime itself can tell: it writes a
 * one-off marker through React Native's native logger, and the device whose log
 * holds the marker is the one it runs on. Android writes it to logcat under
 * `ReactNativeJS`; an iOS simulator writes it to its unified log.
 *
 * Undefined when the runtime has no native logger, or when no device argent
 * can read the log of holds the marker (a physical iPhone, a provider's device).
 */
export async function findRuntimeDevice(
  cdp: Pick<CDPClient, "evaluate">
): Promise<string | undefined> {
  const marker = `argent-device-probe:${randomUUID()}`;
  const logged = await cdp
    .evaluate(
      `(function () {
        if (typeof nativeLoggingHook !== "function") return false;
        nativeLoggingHook(${JSON.stringify(marker)}, 1);
        return true;
      })()`
    )
    .catch(() => false);
  if (logged !== true) return undefined;

  // Android does not wait for the simulator list, the slower of the two.
  const checks = [
    async () =>
      firstFound((await androidSerials()).map((serial) => () => logcatHolds(serial, marker))),
    async () =>
      firstFound((await bootedSimulators()).map((udid) => () => simulatorLogHolds(udid, marker))),
  ];
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    const found = await firstFound(checks);
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * The first device a check finds, without waiting for the rest: a simulator's
 * `log show` takes about a second, adb a fraction of that. The marker is
 * unique, so no second device can hold it.
 */
function firstFound(checks: Array<() => Promise<string | undefined>>): Promise<string | undefined> {
  return new Promise((resolve) => {
    let left = checks.length;
    if (left === 0) resolve(undefined);
    for (const check of checks) {
      void check().then((id) => {
        if (id !== undefined) resolve(id);
        else if (--left === 0) resolve(undefined);
      });
    }
  });
}

async function androidSerials(): Promise<string[]> {
  try {
    const { stdout } = await runAdb(["devices"], { timeoutMs: ADB_DEVICES_TIMEOUT_MS });
    return parseAdbDevices(stdout)
      .filter((d) => d.state === "device")
      .map((d) => d.serial);
  } catch {
    return [];
  }
}

async function bootedSimulators(): Promise<string[]> {
  const simulators = await listIosSimulators();
  return simulators.filter((s) => s.state === "Booted").map((s) => s.udid);
}

// `-s ReactNativeJS` matters: adbd logs each shell command it runs, and this
// one's command line holds the marker too.
async function logcatHolds(serial: string, marker: string): Promise<string | undefined> {
  try {
    const { stdout } = await runAdb(
      ["-s", serial, "logcat", "-d", "-s", "ReactNativeJS", "-e", marker],
      { timeoutMs: LOG_READ_TIMEOUT_MS }
    );
    return stdout.includes(marker) ? serial : undefined;
  } catch {
    return undefined;
  }
}

// `--info` matters: React Native writes the marker at info level (RCTLog maps
// `nativeLoggingHook`'s level 1 to OS_LOG_TYPE_INFO), and `log show` leaves
// info entries out without it. `process != "log"` matters too: `log show` logs
// its own arguments, the marker among them.
async function simulatorLogHolds(udid: string, marker: string): Promise<string | undefined> {
  try {
    const args = await simctlArgsForUdid(udid, [
      "spawn",
      udid,
      "log",
      "show",
      "--info",
      "--last",
      "1m",
      "--style",
      "compact",
      "--predicate",
      `eventMessage CONTAINS ${JSON.stringify(marker)} AND process != "log"`,
    ]);
    const { stdout } = await execFileAsync("xcrun", args, {
      timeout: LOG_READ_TIMEOUT_MS,
      killSignal: SIMCTL_KILL_SIGNAL,
      encoding: "utf-8",
    });
    return stdout.includes(marker) ? udid : undefined;
  } catch {
    return undefined;
  }
}
