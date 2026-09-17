/**
 * Keeps an iOS simulator's legacy HID services alive across a boot.
 *
 * # The failure this guards against
 *
 * When any CoreDevice client runs on the host — DeviceHub is the usual one, and
 * it attaches to every simulator that boots — it demand-starts `dtuhidd` inside
 * the guest, which sets the Darwin notification
 * `com.apple.coredevice.dtuhidd.active`. `backboardd` reacts by tearing down
 * three virtual HID services: the main-screen digitizer, the main-screen
 * buttons, and the external keyboard.
 *
 * That teardown is permanent for the life of `backboardd`:
 * `IOHIDEventSystemRemoveService` *terminates* the service rather than
 * unregistering it, and the reconnect path re-adds the same dead object. From
 * then on every injected touch, button and key is silently discarded, while the
 * simulator-server still acknowledges the send — it fails downstream of the
 * command. That is argent#932.
 *
 * # The escape hatch
 *
 * `backboardd` exempts any service that has already seen one Indigo HID event,
 * and skips exempt services entirely when tearing down. So a single event per
 * service, delivered before the flag is raised, protects that service for the
 * rest of `backboardd`'s lifetime — across later flag changes, app switches and
 * SpringBoard restarts.
 *
 * The window opens ~1.0s after `simctl boot` and can be shut by ~1.2s, so
 * nothing that waits for a running simulator-server can reach it — attaching
 * one and standing up its transports takes ~3s, and every measured cold boot
 * lost all three services that way. Protection is therefore a subprocess that
 * `boot-device` fires *before* `simctl boot`: the simulator-server `hid_warmup`
 * one-shot (software-mansion/radon#218), which attaches in ~170ms, retries until
 * the device is up, and loops the events for a few seconds.
 *
 * The qualifier "before the flag is raised" is load-bearing. On a fast host the
 * flag often lands *before* the buttons and external keyboard connect, leaving
 * no instant at which they exist unprotected — they are dead for that
 * `backboardd` lifetime and no amount of warming up reaches them. On iOS 18.6
 * that is a race, and the warm-up wins it on 92-95% of the boots where it is
 * winnable.
 *
 * On iOS 26.5 (23F77) it is not a race at all. Over 12 boots of a device warmed
 * past first-run setup the window ran -289ms to +23ms (median -196ms), and the
 * buttons and keyboard were torn down on 12 of 12 — including the nominally
 * positive boot, whose +23ms is narrower than a single warm-up round. The
 * services connect when they always did; it is the flag that arrives early, at a
 * median 1.119s against 18.6's 1.24-2.53s, because `dtuhidd` is demand-started
 * sooner. One device, one host, n=12, 26.3 and 27.0 untested — but newer runtimes
 * should not be assumed to behave like 18.6.
 *
 * The digitizer survives regardless, because its service is created by a path
 * that reads the suppression flag and skips the connect, so it is never
 * terminated and the first event to arrive connects it healthy. On 26.5 that is
 * the *only* reason it survives: in 11 of those 12 boots it was never registered
 * at all. So touch is covered; hardware buttons and typed text are narrowed, not
 * fixed.
 *
 * Self-heal is deliberately absent. Clearing the notification and restarting
 * `backboardd` does revive the services, but it kills the foreground app and
 * bounces SpringBoard, so it belongs behind an explicit user action rather than
 * in a boot path. The `notifyutil` recipe is in this branch's history if that
 * ever changes.
 *
 * # Why the warm-up is invisible
 *
 * Each event is a *release without a press* — a touch `Up` with no `Down`, a
 * button `Up`, a key `Up`. They set the exemption flags but produce no contact,
 * no button press and no keystroke; verified pixel-identical against a live app
 * with a modal sheet presented. One cosmetic side effect: the keyboard event
 * makes `backboardd` log `missing a sequence for <senderID…>` on every round.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { FAILURE_CODES, FailureError } from "@argent/registry";
import { simulatorServerBinaryPath } from "@argent/native-devtools-ios";

import { simctlSpawn } from "./sim-remote";

import type { DeviceSetPath } from "./ios-device-sets";

const execFileAsync = promisify(execFile);

/** Generous: the one-shot waits for the device, then warms for 6s. */
const WARMUP_TIMEOUT_MS = 40_000;

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Start the simulator-server one-shot that protects the HID services.
 *
 * Call this *before* `simctl boot`, not after, and only for a boot that is
 * actually about to happen. The one-shot attaches in ~170ms and retries until
 * the device is up, so starting it at T0 lands the first event around +300ms —
 * before `simctl boot` itself returns, and well before the flag. Against a
 * simulator that is already running it protects nothing (the window closed at
 * that boot) and only spends its warm-up duration firing events at a live app.
 *
 * Deliberately a subprocess and not a WebSocket command: by the time a
 * simulator-server is up and accepting commands the window has been shut for
 * seconds. Measured through the server, every cold boot lost all three services.
 *
 * Never rejects — a simulator we could not warm up is one whose HID we could not
 * have protected either way, and that must not fail the boot that asked for it.
 */
export function startHidWarmUp(udid: string, deviceSet: DeviceSetPath): Promise<void> {
  let binary: string;
  try {
    binary = simulatorServerBinaryPath();
  } catch (err) {
    process.stderr.write(
      `[hid-warmup ${udid.slice(0, 8)}] simulator-server binary not found (${errText(err)}); ` +
        `HID suppression protection is not active for this boot.\n`
    );
    return Promise.resolve();
  }

  const args = ["hid_warmup", "--id", udid];
  if (deviceSet) args.push("--device-set", deviceSet);

  return execFileAsync(binary, args, {
    timeout: WARMUP_TIMEOUT_MS,
    // It prints CoreSimulator noise on every failed attach attempt — ~80KB
    // against a device that never comes up. Well under Node's 1MB default, but
    // the default is the only headroom there is, so name one.
    maxBuffer: 4 * 1024 * 1024,
  })
    .then(() => undefined)
    .catch((err: unknown) => {
      process.stderr.write(
        `[hid-warmup ${udid.slice(0, 8)}] warm-up did not run (${errText(err)}); ` +
          `input may be silently dropped on this simulator.\n`
      );
    });
}

/**
 * The Darwin notification `dtuhidd` raises inside the guest when a CoreDevice
 * client attaches. `backboardd` reads it and tears down the HID services.
 */
export const DTUHIDD_ACTIVE_KEY = "com.apple.coredevice.dtuhidd.active";

/**
 * Run one guest command and require it to succeed.
 *
 * `simctlSpawn` reports a failed guest command through `exitCode`, not by
 * throwing, so a `notifyutil` or `launchctl` that fails would otherwise let
 * {@link reviveHidServices} resolve and the tool claim `revived: true` over a
 * simulator it never touched — the exact silent success this repair exists to
 * end. `stderr` goes into the message because it is the only diagnostic the
 * guest gives.
 */
async function guestCommand(udid: string, args: string[], stage: string): Promise<string> {
  const { exitCode, stdout, stderr } = await simctlSpawn(udid, { args });
  // Strict `=== 0`: a missing exit code is no confirmation either. `simctlSpawn`
  // maps a null `exit_code` to `undefined`, and letting that through would let a
  // command whose outcome is unknown count as a success.
  if (exitCode !== 0) {
    throw new FailureError(
      `\`${args.join(" ")}\` failed inside ${udid} (exit ${exitCode ?? "unknown"})` +
        (stderr.trim() ? `: ${stderr.trim()}` : ""),
      {
        error_code: FAILURE_CODES.IOS_HID_REVIVE_FAILED,
        failure_stage: stage,
        failure_area: "tool_server",
        error_kind: "subprocess",
        failure_command: "xcrun_simctl",
        ...(exitCode !== undefined ? { failure_exit_code: exitCode } : {}),
      }
    );
  }
  return stdout;
}

/**
 * Read the suppression flag from inside the guest.
 *
 * Must be read in the guest: the simulator runs its own `notifyd`, so a
 * host-side read of the same key is a silent false negative.
 *
 * **Diagnostic only.** A set flag is the normal state of a healthy simulator
 * whenever a CoreDevice client is running; if the services were exempted before
 * it was raised, everything works with the flag at 1.
 *
 * @returns `true`/`false`, or `null` if the flag could not be read.
 */
export async function readSuppressionFlag(udid: string): Promise<boolean | null> {
  // `simctl spawn` needs a bare binary name; an absolute path fails with
  // SimXPCErrorDomain 111.
  const stdout = await guestCommand(
    udid,
    ["notifyutil", "-g", DTUHIDD_ACTIVE_KEY],
    "hid_revive_read_flag"
  );
  const match = stdout.match(/\s(\d+)\s*$/m);
  return match ? match[1] !== "0" : null;
}

/**
 * Clear the suppression flag.
 *
 * `dtuhidd` only writes it at daemon start, so clearing it sticks even while the
 * daemon keeps running. Does nothing about services that are already terminated
 * — that needs {@link restartBackboardd}.
 */
async function clearSuppressionFlag(udid: string): Promise<void> {
  await guestCommand(
    udid,
    ["notifyutil", "-s", DTUHIDD_ACTIVE_KEY, "0", "-p", DTUHIDD_ACTIVE_KEY],
    "hid_revive_clear_flag"
  );
}

/**
 * Restart `backboardd` so it builds fresh HID services.
 *
 * This is the only known way to revive a simulator whose services have already
 * been terminated — the service objects cannot be resurrected, only replaced.
 *
 * **Disruptive**: the foreground app is killed and SpringBoard restarts. Clear
 * the flag first, or the new services are torn down again immediately and only
 * the digitizer survives.
 */
async function restartBackboardd(udid: string): Promise<void> {
  await guestCommand(
    udid,
    ["launchctl", "kill", "SIGTERM", "system/com.apple.backboardd"],
    "hid_revive_restart_backboardd"
  );
}

/**
 * Revive a simulator whose HID services were already torn down.
 *
 * The boot-time warm-up in {@link startHidWarmUp} is a race, and on runtimes
 * newer than 18.6 it is one the host frequently loses: on 26.5 the flag lands
 * before the buttons and external keyboard even connect, and measurements on
 * **26.4 with Xcode 27.0** show the same shape — 3 of 3 boots with buttons and
 * keyboard dead while the digitizer stayed healthy. There is no boot-path fix
 * for a window that has already closed; the services have to be rebuilt.
 *
 * Deliberately NOT called from `boot-device`. It kills the foreground app and
 * bounces SpringBoard, which is unacceptable as an implicit side effect of a
 * boot but perfectly reasonable when an agent or a human asks for it after the
 * probe reports that input is not landing.
 *
 * Clearing the flag first is load-bearing: without it `backboardd` tears the new
 * services down as soon as it rebuilds them, and only the digitizer survives.
 */
export async function reviveHidServices(udid: string): Promise<{ flagWasSet: boolean | null }> {
  const flagWasSet = await readSuppressionFlag(udid);
  await clearSuppressionFlag(udid);
  await restartBackboardd(udid);
  return { flagWasSet };
}
