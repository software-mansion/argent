/**
 * Keeps an iOS simulator's legacy HID services alive, and reports when they are
 * already gone.
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
 * then on every injected touch, button and key is silently discarded — and
 * because `sendCommand` is fire-and-forget, argent reports success for all of
 * them. That is argent#932.
 *
 * # The escape hatch
 *
 * `backboardd` exempts any service that has already seen one Indigo HID event,
 * and skips exempt services entirely when tearing down. So a single event per
 * service, delivered before the flag is raised, protects that service for the
 * rest of `backboardd`'s lifetime — across later flag changes, app switches and
 * SpringBoard restarts.
 *
 * The real fix lives in `simulator-server`, which is the only component that can
 * reach the window (it opens ~1.1s after boot and can close 166ms later, while
 * the WebSocket this file uses is not accepting commands until ~7s). What we do
 * here is complementary and still worth having:
 *
 *  - **Warm up on every attach.** Cannot win a cold-boot race, but it *does*
 *    protect against a mid-session demand-start — someone opening DeviceHub
 *    while argent is already attached, which is otherwise an instant break.
 *  - **Detect** a simulator whose services are already dead, so tools can say so
 *    instead of silently no-oping.
 *
 * # Why the warm-up is invisible
 *
 * Each event is a *release without a press* — a touch `Up` with no `Down`, a
 * button `Up`. They set the exemption flags but produce no contact, no button
 * press and no keystroke; verified pixel-identical against a live app with a
 * modal sheet presented.
 *
 * The consequence for detection is that a warm-up cannot be verified by counting
 * touch contacts — by design it produces none. It does leave a distinct trace in
 * `backboardd` (an orphan release, logged as `downEvent:0`, plus
 * `missing a sequence` for the keyboard), and that trace is present exactly when
 * the services are alive. That is what {@link probeHidDelivery} looks for.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as fsAsync from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import type { SimulatorServerApi } from "../blueprints/simulator-server";
import { sendCommand } from "./simulator-client";
import { SIMCTL_KILL_SIGNAL, SIMCTL_SPAWN_TIMEOUT_MS } from "./simctl-config";

const execFileAsync = promisify(execFile);

/** The notification `backboardd` watches to decide whether CoreDevice owns HID. */
export const DTUHIDD_ACTIVE_KEY = "com.apple.coredevice.dtuhidd.active";

/**
 * Mid-screen, in the normalized 0..1 space `gesture-tap` uses. Irrelevant for a
 * release with no press, but keeps the event inside any device's bounds.
 */
const WARMUP_POINT = { x: 0.5, y: 0.5 } as const;

/** Arbitrary keycode — only ever released, never pressed. */
const WARMUP_KEY_CODE = 4;

/** How far back {@link probeHidDelivery} reads the log. */
const PROBE_WINDOW_SECONDS = 10;

/**
 * Send one warm-up event to each of the three suppressible services.
 *
 * Fire-and-forget and idempotent: re-sending once the exemption flags are set is
 * a no-op, so callers can do this on every attach without tracking state.
 */
export function sendHidWarmUp(api: SimulatorServerApi): void {
  // Digitizer: a release with no matching press produces no contact.
  sendCommand(api, {
    cmd: "touch",
    type: "Up",
    x: WARMUP_POINT.x,
    y: WARMUP_POINT.y,
    second_x: null,
    second_y: null,
  });
  // Main-screen buttons: a Home release with no press does not navigate.
  sendCommand(api, { cmd: "button", direction: "Up", button: "home" });
  // External keyboard. Note this makes backboardd log `missing a sequence for
  // <senderID…>` each time — harmless, but it will show up in simulator logs
  // and is not a symptom of anything.
  api.pressKey("Up", WARMUP_KEY_CODE);
}

/** Run a command inside the booted simulator, returning stdout ("" on failure). */
async function simctlSpawn(udid: string, args: string[]): Promise<string> {
  return execFileAsync("xcrun", ["simctl", "spawn", udid, ...args], {
    timeout: SIMCTL_SPAWN_TIMEOUT_MS,
    killSignal: SIMCTL_KILL_SIGNAL,
    maxBuffer: 8 * 1024 * 1024,
  })
    .then(({ stdout }) => stdout)
    .catch(() => "");
}

/**
 * Read the suppression flag from inside the guest.
 *
 * Must be read in the guest: the simulator runs its own `notifyd`, so a
 * host-side read of the same key is a silent false negative (host reports 0
 * while the guest reports 1).
 *
 * **This is diagnostic only — never treat it as a fault signal.** A set flag is
 * the normal state of a perfectly healthy simulator whenever a CoreDevice client
 * is running; if the services were exempted before it was raised, everything
 * works with the flag at 1. Only {@link probeHidDelivery} says whether input
 * actually lands.
 *
 * @returns `true`/`false`, or `null` if the flag could not be read.
 */
export async function readSuppressionFlag(udid: string): Promise<boolean | null> {
  // `simctl spawn` needs a bare binary name; an absolute path fails with
  // SimXPCErrorDomain 111.
  const out = await simctlSpawn(udid, ["notifyutil", "-g", DTUHIDD_ACTIVE_KEY]);
  const match = out.match(/\s(\d+)\s*$/m);
  return match ? match[1] !== "0" : null;
}

/**
 * Identifier for the simulator's current boot.
 *
 * CoreSimulator regenerates the per-device CoreDevice launchd plists on every
 * boot, and their mtime matches `SIMULATOR_BOOT_TIME` exactly. Reading it is a
 * host-side `stat()` — no `simctl spawn`, so it costs nothing and can gate the
 * more expensive probe below.
 *
 * @returns epoch milliseconds, or `null` if the plist is missing.
 */
export async function readBootId(udid: string): Promise<number | null> {
  const plist = path.join(
    os.homedir(),
    "Library/Developer/CoreSimulator/Devices",
    udid,
    "data/Library/LaunchDaemons/com.apple.coredevice.dtuhidd.plist"
  );
  return fsAsync
    .stat(plist)
    .then((s) => s.mtimeMs)
    .catch(() => null);
}

/**
 * Ask whether injected HID events are actually reaching `backboardd`.
 *
 * Sends a warm-up (which also protects, if it is not too late already) and looks
 * for the orphan-release trace it leaves. Present → the services are alive.
 * Absent → they have been torn down and every injection is being discarded.
 *
 * Costs roughly a second, so gate it on {@link readBootId} rather than running
 * it on every call.
 *
 * @returns `true` if delivery was observed, `false` if not, `null` if the log
 *   could not be read (treat as unknown, never as broken).
 */
export async function probeHidDelivery(
  udid: string,
  api: SimulatorServerApi
): Promise<boolean | null> {
  sendHidWarmUp(api);
  // Give backboardd a moment to log before reading back.
  await new Promise((r) => setTimeout(r, 400));

  const predicate =
    'process == "backboardd" AND ' +
    '(eventMessage CONTAINS "downEvent:0" OR eventMessage CONTAINS "missing a sequence")';
  const out = await simctlSpawn(udid, [
    "log",
    "show",
    "--last",
    `${PROBE_WINDOW_SECONDS}s`,
    "--style",
    "compact",
    "--predicate",
    predicate,
  ]);

  if (!out) return null;
  return /downEvent:0|missing a sequence/.test(out);
}

/**
 * Clear the suppression flag.
 *
 * `dtuhidd` only writes it at daemon start, so clearing it sticks even while the
 * daemon keeps running. Does nothing about services that are already terminated
 * — that needs {@link restartBackboardd}.
 */
export async function clearSuppressionFlag(udid: string): Promise<void> {
  await simctlSpawn(udid, ["notifyutil", "-s", DTUHIDD_ACTIVE_KEY, "0", "-p", DTUHIDD_ACTIVE_KEY]);
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
export async function restartBackboardd(udid: string): Promise<void> {
  await simctlSpawn(udid, ["launchctl", "kill", "SIGTERM", "system/com.apple.backboardd"]);
}
