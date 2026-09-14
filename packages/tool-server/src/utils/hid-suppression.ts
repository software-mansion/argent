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
 * The qualifier matters: on roughly a fifth of cold boots on a fast host the flag
 * lands *before* the buttons and external keyboard connect, leaving no instant at
 * which they exist unprotected — they are dead for that `backboardd` lifetime and
 * no amount of warming up reaches them. The digitizer survives because its service
 * is created ~10-20 ms later and the teardown pass misses it. So touch is covered;
 * hardware buttons and typed text are narrowed, not fixed.
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
 * touch contacts — by design it produces none. Note too that a contact count only
 * ever speaks for the digitizer, and will report a healthy simulator on a boot
 * whose keyboard and buttons are dead; {@link probeHidDelivery} inherits that
 * blind spot — which is why {@link probeHidServices} reports the digitizer and
 * the buttons/keyboard pair separately rather than returning one boolean. It does leave a distinct trace in
 * `backboardd` (an orphan release, logged as `downEvent:0`, plus
 * `missing a sequence` for the keyboard), and that trace is present exactly when
 * the services are alive. That is what {@link probeHidServices} looks for.
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
  // Deliberately not awaited and deliberately never rejecting. This is
  // insurance, not a critical path: a transport that refuses a warm-up must not
  // fail the attach that triggered it, and must not surface as an unhandled
  // rejection either. `allSettled` gives us both. Order does not matter — each
  // event exempts its own service independently.
  void Promise.allSettled([
    // Digitizer: a release with no matching press produces no contact.
    sendCommand(api, {
      cmd: "touch",
      type: "Up",
      x: WARMUP_POINT.x,
      y: WARMUP_POINT.y,
      second_x: null,
      second_y: null,
    }),
    // Main-screen buttons: a Home release with no press does not navigate.
    sendCommand(api, { cmd: "button", direction: "Up", button: "home" }),
    // External keyboard. Note this makes backboardd log `missing a sequence for
    // <senderID…>` each time — harmless, but it will show up in simulator logs
    // and is not a symptom of anything.
    api.pressKey("Up", WARMUP_KEY_CODE),
  ]);
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
 * works with the flag at 1. Only {@link probeHidServices} says whether input
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
 * Which of the suppressible services are still delivering input.
 *
 * Buttons and the external keyboard are reported together because they share a
 * fate: `backboardd` connects them as a pair and every observed teardown takes
 * both in the same millisecond. The digitizer is tracked separately because it
 * survives boots that kill the other two —
 * `createDigitizerForTargetID:withDisplayUID:isBuiltIn:` reads the suppression
 * flag and *skips the connect* when it is set, so the object is never terminated
 * and the first Indigo event to arrive connects it healthy. The buttons and
 * keyboard are built by a path with no such check.
 */
export interface HidHealth {
  /** Taps, swipes, and every gesture built out of them. */
  touch: boolean;
  /** Hardware buttons and typed text. */
  buttonsAndKeyboard: boolean;
}

/** How long to let `backboardd` log before reading back. */
const PROBE_SETTLE_MS = 400;

/**
 * Lines `log show` prints about itself rather than about the guest.
 *
 * This matters more than it looks: the preamble echoes the predicate back
 * verbatim, so a naive `/downEvent:0/.test(stdout)` matches the filter text and
 * reports every simulator healthy — including the dead ones it was written to
 * catch.
 */
function isLogPreamble(line: string): boolean {
  return (
    line.startsWith("Filtering the log data using") ||
    line.startsWith("Timestamp") ||
    line.startsWith("Skipping info and debug messages")
  );
}

/**
 * Ask which injected HID events are actually reaching `backboardd`.
 *
 * Sends a warm-up (which also protects, if it is not already too late) and looks
 * for the orphan-release traces it leaves: `downEvent:0` for the digitizer,
 * `missing a sequence` for the keyboard. A trace is present exactly when that
 * service is alive.
 *
 * Costs roughly a second. Prefer {@link hidCaveatForDevice}, which runs this at
 * most once per boot and never on the caller's critical path.
 *
 * @returns per-service liveness, or `null` if the log could not be read (treat
 *   as unknown, never as broken).
 */
export async function probeHidServices(
  udid: string,
  api: SimulatorServerApi
): Promise<HidHealth | null> {
  sendHidWarmUp(api);
  await new Promise((r) => setTimeout(r, PROBE_SETTLE_MS));

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

  const lines = out.split("\n").filter((l) => l.trim() !== "" && !isLogPreamble(l));
  return {
    touch: lines.some((l) => l.includes("downEvent:0")),
    buttonsAndKeyboard: lines.some((l) => l.includes("missing a sequence")),
  };
}

/** Probe result for the device's current boot, plus whether we have said so. */
interface CachedHealth {
  bootId: number | null;
  health: HidHealth;
  told: boolean;
}

const healthByDevice = new Map<string, CachedHealth>();
const probesInFlight = new Set<string>();

/**
 * How long after attaching to wait before probing.
 *
 * The probe can only tell a dead service from one that has not connected yet by
 * running after the services are up. They connect ~1.0-1.3s after boot on the
 * hosts measured, and attaching can happen earlier than that, so leave room.
 */
const PROBE_DELAY_MS = 3_000;

const REBOOT_REMEDY =
  "Call boot-device with force=true to reboot it through argent, which protects the input " +
  "services while the simulator starts. This restarts the simulator, so anything running on it " +
  "is lost. If the reboot does not fix it, repeating it usually does — the failure depends on a " +
  "race that is re-run on every boot";

/**
 * Turn a probe result into something worth telling the agent, or `undefined`
 * when everything that matters works.
 */
export function hidCaveat(health: HidHealth): string | undefined {
  if (health.touch && health.buttonsAndKeyboard) return undefined;
  const dead = !health.touch
    ? health.buttonsAndKeyboard
      ? "Taps and gestures are"
      : "Taps, gestures, hardware buttons and typed text are"
    : "Hardware buttons and typed text are";
  return (
    `${dead} not reaching this simulator. CoreDevice (usually DeviceHub) took over its input ` +
    `devices after it booted, and the events are being discarded silently — the calls that send ` +
    `them still report success. ${REBOOT_REMEDY}.`
  );
}

/**
 * Probe this device once for this boot, in the background.
 *
 * Call it from the attach path, never from a tool. The probe injects warm-up
 * events to produce the trace it reads, and an injection that lands in the
 * middle of a caller's gesture would corrupt it — a stray touch `Up` between a
 * drag's `Down` and its own `Up` ends the drag early. Attach is already sending
 * exactly these events, so nothing new is introduced there.
 *
 * Never throws and never blocks the caller.
 */
export function scheduleHidProbe(udid: string, api: SimulatorServerApi): void {
  // A provider's simulator is not ours to spawn into, and its input never went
  // through the local CoreDevice path in the first place.
  if (api.external) return;
  if (probesInFlight.has(udid)) return;
  probesInFlight.add(udid);

  const timer = setTimeout(() => {
    void (async () => {
      try {
        const bootId = await readBootId(udid);
        const health = await probeHidServices(udid, api);
        if (health !== null) healthByDevice.set(udid, { bootId, health, told: false });
      } catch {
        // Diagnostics must never take down the attach that scheduled them.
      } finally {
        probesInFlight.delete(udid);
      }
    })();
  }, PROBE_DELAY_MS);
  // Do not hold the process open for a diagnostic.
  timer.unref?.();
}

/**
 * The caveat for this device, if a probe has already found one.
 *
 * Reads cached state only — it never probes and never injects, so it is safe to
 * call from inside a tool. The only cost is the `stat` behind
 * {@link readBootId}, which is what detects that the device has been rebooted
 * since the cached answer was taken.
 *
 * Says it once per boot. A reboot re-arms it, which is what makes the advice
 * safe to follow repeatedly: an agent that reboots into another bad race is told
 * again rather than left believing it is fixed.
 */
export async function hidCaveatForDevice(
  udid: string,
  api: SimulatorServerApi
): Promise<string | undefined> {
  if (api.external) return undefined;

  const cached = healthByDevice.get(udid);
  if (cached === undefined || cached.told) return undefined;

  // A different boot means the cached verdict describes a simulator that no
  // longer exists.
  if ((await readBootId(udid)) !== cached.bootId) {
    healthByDevice.delete(udid);
    return undefined;
  }

  const caveat = hidCaveat(cached.health);
  if (caveat === undefined) return undefined;
  cached.told = true;
  return caveat;
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
