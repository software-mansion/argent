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
 * How long the other adb serials get to answer once one holds the marker. A
 * device reachable over two transports answers on both, and a slow or hung one
 * must not hold up every start for the full read timeout. Serials the caller
 * names in `awaitSerials` are not cut off.
 */
export const OTHER_TRANSPORTS_GRACE_MS = 500;

/** Where a debugger session's JS runtime runs, as far as its logs could tell. */
export interface RuntimeDevices {
  /**
   * The `list-devices` ids of the device, in the order they answered. Empty
   * when it was not found.
   */
  found: string[];
  /**
   * Serials from `awaitSerials` whose logcat could not be read, so they may be
   * this device too. Only set alongside an Android `found`.
   */
  unresolved: string[];
}

const NOT_FOUND: RuntimeDevices = { found: [], unresolved: [] };

/**
 * The device a debugger session's JS runtime runs on, for a session keyed by
 * Metro's `logicalDeviceId`.
 *
 * Once two devices share one Metro, `selectTarget` makes the caller connect
 * with the logicalDeviceId, a hash that nothing in argent can turn back into a
 * serial or UDID (see device-alias.ts). The runtime itself can tell: it writes a
 * one-off marker through React Native's native logger, and the device whose log
 * holds the marker is the one it runs on. Android writes it to logcat under
 * `ReactNativeJS`; an iOS simulator writes it to its unified log.
 *
 * The marker is unique, so only one device's log can hold it, but an Android
 * device reachable over two adb transports (USB and wireless, or an emulator
 * also `adb connect`ed) is listed under two serials that read the same logcat.
 * Every serial that holds the marker names this device, and state that argent
 * keys by serial, such as native network capture, may sit under any of them.
 * `awaitSerials` are the serials such state sits under: their reads are waited
 * for in full, and one that fails is reported in `unresolved`, since a read
 * that fails cannot tell this device from another.
 *
 * Nothing is found when the runtime has no native logger, or when no device
 * argent can read the log of holds the marker (a physical iPhone, a provider's
 * device).
 */
export async function findRuntimeDevices(
  cdp: Pick<CDPClient, "evaluate">,
  { awaitSerials = [] }: { awaitSerials?: readonly string[] } = {}
): Promise<RuntimeDevices> {
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
  if (logged !== true) return NOT_FOUND;

  // Android does not wait for the simulator list, the slower of the two.
  const checks = [
    async () => androidDevices(await androidSerials(), marker, awaitSerials),
    async () => {
      const udids = await bootedSimulators();
      const udid = await firstFound(udids.map((udid) => () => simulatorLogHolds(udid, marker)));
      return udid === undefined ? undefined : { found: [udid], unresolved: [] };
    },
  ];
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    const found = await firstFound(checks);
    if (found !== undefined) return found;
  }
  return NOT_FOUND;
}

/**
 * The first value a check finds, without waiting for the rest: a simulator's
 * `log show` takes about a second, adb a fraction of that. The marker is
 * unique, so no second device can hold it.
 */
function firstFound<T>(checks: Array<() => Promise<T | undefined>>): Promise<T | undefined> {
  return new Promise((resolve) => {
    let left = checks.length;
    if (left === 0) resolve(undefined);
    for (const check of checks) {
      void check().then((value) => {
        if (value !== undefined) resolve(value);
        else if (--left === 0) resolve(undefined);
      });
    }
  });
}

/**
 * The serials whose logcat holds the marker. It reads every serial at once and
 * stops once all have answered, or once {@link OTHER_TRANSPORTS_GRACE_MS} has
 * passed since the first hit and every serial in `awaitSerials` has answered.
 * Undefined when none holds it.
 */
async function androidDevices(
  serials: readonly string[],
  marker: string,
  awaitSerials: readonly string[]
): Promise<RuntimeDevices | undefined> {
  const awaited = serials.filter((serial) => awaitSerials.includes(serial));
  const answers = new Map<string, LogRead>();
  await new Promise<void>((resolve) => {
    let graceOver = false;
    let grace: ReturnType<typeof setTimeout> | undefined;
    const settle = () => {
      const allAnswered = answers.size === serials.length;
      if (allAnswered || (graceOver && awaited.every((serial) => answers.has(serial)))) {
        clearTimeout(grace);
        resolve();
      }
    };
    settle();
    for (const serial of serials) {
      void logcatHolds(serial, marker).then((read) => {
        answers.set(serial, read);
        if (read === "held") {
          grace ??= setTimeout(() => {
            graceOver = true;
            settle();
          }, OTHER_TRANSPORTS_GRACE_MS);
        }
        settle();
      });
    }
  });
  const found = [...answers].filter(([, read]) => read === "held").map(([serial]) => serial);
  if (found.length === 0) return undefined;
  const unresolved = awaited.filter((serial) => answers.get(serial) === "failed");
  return { found, unresolved };
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
  // `firstFound` counts only checks that resolve: a rejected listing would leave
  // it waiting forever, with the rejection unhandled. While Xcode's install is
  // pending the listing is refused, and so is every log read below.
  const simulators = await listIosSimulators().catch(() => []);
  return simulators.filter((s) => s.state === "Booted").map((s) => s.udid);
}

/** What one logcat read said about the marker. A read that failed says nothing. */
type LogRead = "held" | "absent" | "failed";

// `-s ReactNativeJS` matters: adbd logs each shell command it runs, and this
// one's command line holds the marker too.
async function logcatHolds(serial: string, marker: string): Promise<LogRead> {
  try {
    const { stdout } = await runAdb(
      ["-s", serial, "logcat", "-d", "-s", "ReactNativeJS", "-e", marker],
      { timeoutMs: LOG_READ_TIMEOUT_MS }
    );
    return stdout.includes(marker) ? "held" : "absent";
  } catch {
    return "failed";
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
