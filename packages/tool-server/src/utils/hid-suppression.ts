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

import { simulatorServerBinaryPath } from "@argent/native-devtools-ios";

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
