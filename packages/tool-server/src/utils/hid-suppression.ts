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
 * The qualifier matters. On a fast host the flag often lands *before* the buttons
 * and external keyboard connect, leaving no instant at which they exist
 * unprotected — they are dead for that `backboardd` lifetime and no amount of
 * warming up reaches them. On iOS 18.6 that is a race, and the warm-up wins it on
 * 92-95% of the boots where it is winnable. On iOS 26.5 it was not a race at all:
 * across 6 boots the services connected ~250ms later while the flag stayed put,
 * so the window was negative every time and those two services were dead with and
 * without the warm-up alike. That is one device on one host, but it means newer
 * runtimes should not be assumed to behave like 18.6.
 *
 * The digitizer survives regardless, because its service is created by a path
 * that reads the suppression flag and skips the connect, so it is never
 * terminated and the first event to arrive connects it healthy. So touch is
 * covered; hardware buttons and typed text are narrowed, not fixed.
 *
 * Protection and detection live in different places, because they have to:
 *
 *  - **Protection** is {@link startHidWarmUp}, which `boot-device` fires as a
 *    subprocess *before* `simctl boot`. The window opens ~1.0s after boot and
 *    can be shut by ~1.2s, so nothing that waits for a running simulator-server
 *    can reach it — attaching one and standing up its transports takes ~3s, and
 *    every measured cold boot lost all three services that way.
 *  - **Detection** is the rest of this file: a probe, once per boot, that says
 *    whether input is actually arriving, so tools can report a dead simulator
 *    instead of silently no-oping. It runs long after the window and protects
 *    nothing.
 *
 * Self-heal is deliberately absent. Clearing the notification and restarting
 * `backboardd` does revive the services, but it kills the foreground app and
 * bounces SpringBoard, so it belongs behind an explicit user action rather than
 * in an attach path. The two `notifyutil` calls it needs are
 * `-s com.apple.coredevice.dtuhidd.active 0 -p …` inside the guest, followed by
 * `launchctl kill SIGTERM system/com.apple.backboardd`; clear the flag first or
 * the fresh services are torn down again immediately.
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
 * whose keyboard and buttons are dead; {@link probeHidServices} inherits that
 * blind spot — which is why {@link probeHidServices} reports all three services
 * independently rather than returning one boolean. It does leave a distinct trace in
 * `backboardd` (an orphan release, logged as `downEvent:0`, plus
 * `missing a sequence` for the keyboard), and that trace is present exactly when
 * the services are alive. That is what {@link probeHidServices} looks for.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as fsAsync from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { simulatorServerBinaryPath } from "@argent/native-devtools-ios";

import type { DeviceSetPath } from "./ios-device-sets";

import type { SimulatorServerApi } from "../blueprints/simulator-server";
import { sendCommand } from "./simulator-client";
import { SIMCTL_KILL_SIGNAL, SIMCTL_SPAWN_TIMEOUT_MS } from "./simctl-config";

const execFileAsync = promisify(execFile);

/** Generous: the one-shot waits for the device, then warms for 6s. */
const WARMUP_TIMEOUT_MS = 40_000;

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Arbitrary keycode — only ever released, never pressed. */
const PROBE_KEY_CODE = 4;

/** How far back {@link probeHidServices} reads the log. */
const PROBE_WINDOW_SECONDS = 10;

/**
 * Start the simulator-server one-shot that protects the HID services.
 *
 * Call this *before* `simctl boot`, not after. The one-shot attaches in ~170ms
 * and retries until the device is up, so starting it at T0 lands the first event
 * around +300ms — before `simctl boot` itself returns, and well before the flag.
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
 * Identifier for the simulator's current boot.
 *
 * CoreSimulator regenerates the per-device CoreDevice launchd plists on every
 * boot, and their mtime matches `SIMULATOR_BOOT_TIME` exactly. Reading it is a
 * host-side `stat()` — no `simctl spawn`, so it costs nothing and can gate the
 * more expensive probe below.
 *
 * @returns epoch milliseconds, or `null` if the plist is missing.
 */
async function readBootId(udid: string): Promise<number | null> {
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
 * All three are tracked separately because they do not fail together. The
 * buttons and keyboard are connected as a pair and torn down in the same
 * millisecond, but the digitizer routinely survives boots that kill both:
 * `createDigitizerForTargetID:withDisplayUID:isBuiltIn:` reads the suppression
 * flag and *skips the connect* when it is set, so its object is never terminated
 * and the first event to arrive connects it healthy. Reporting one boolean for
 * all three mislabels precisely the boots worth reporting.
 */
interface HidHealth {
  /** Taps, swipes, and every gesture built out of them. */
  touch: boolean;
  /** Hardware buttons: home, volume, lock. */
  buttons: boolean;
  /** Typed text. */
  keyboard: boolean;
}

/** How long to let `backboardd` log before reading back. */
const PROBE_SETTLE_MS = 400;

/**
 * The trace each service leaves when a release-without-press reaches it.
 *
 * These are the traces for an *orphan release*, which is all the probe sends.
 * They are deliberately not the traces a real press leaves, and picking the
 * wrong one of the pair is the trap here — both mistakes have already shipped:
 *
 *  - `contact 1 presence: none` and `Keyboard receives keyEvent` only ever
 *    appear for a real press. Keyed on those, `touch` could never be true and
 *    `keyboard` was true only by accident, via the unrelated key-down frame kick
 *    that `Ios::new` fires on attach. Every healthy simulator was told its taps
 *    were broken.
 *  - Bare `downEvent:0` appears on touch lines *and* button lines, so an
 *    unscoped match reports a live digitizer whenever the buttons are alive.
 *
 * Hence both halves, and both must match on the same line. Verified against live
 * simulators: 8/8 rounds on a healthy device, 0 on a suppressed one, for each of
 * the three.
 */
const DELIVERY_TRACES: Record<keyof HidHealth, readonly [string, string]> = {
  touch: ["[com.apple.BackBoard:TouchEvents]", "didn't see a previous touch down"],
  buttons: ["[com.apple.BackBoard:Button]", "downEvent:0"],
  keyboard: ["[com.apple.BackBoard:Keyboard]", "missing a sequence"],
};

/**
 * Lines `log show` prints about itself rather than about the guest.
 *
 * Kept even though the current predicate contains none of the trace strings:
 * the preamble echoes the predicate back verbatim, so the moment someone matches
 * on a substring that also appears in the filter, every simulator reports
 * healthy — including the dead ones this was written to catch. That bug shipped
 * here once already.
 */
function isLogPreamble(line: string): boolean {
  return (
    line.startsWith("Filtering the log data using") ||
    line.startsWith("Timestamp") ||
    line.startsWith("Skipping info and debug messages")
  );
}

/**
 * Fire one release-without-press at each service, purely to produce a trace.
 *
 * Unlike {@link startHidWarmUp} this is not protection — by the time a
 * WebSocket is up the window is long shut. It exists only so the log read below
 * has something to find. The events are invisible: a touch `Up` with no `Down`,
 * a button `Up`, a key `Up` produce no contact, no press and no keystroke.
 */
function sendProbeEvents(api: SimulatorServerApi): void {
  void Promise.allSettled([
    sendCommand(api, {
      cmd: "touch",
      type: "Up",
      x: 0.5,
      y: 0.5,
      second_x: null,
      second_y: null,
    }),
    sendCommand(api, { cmd: "button", direction: "Up", button: "home" }),
    api.pressKey("Up", PROBE_KEY_CODE),
  ]);
}

/**
 * Ask which injected HID events are actually reaching `backboardd`.
 *
 * Costs roughly a second. Prefer {@link hidCaveatForDevice}, which runs this at
 * most once per boot and never on the caller's critical path.
 *
 * @returns per-service liveness, or `null` if the log could not be read (treat
 *   as unknown, never as broken).
 */
async function probeHidServices(udid: string, api: SimulatorServerApi): Promise<HidHealth | null> {
  sendProbeEvents(api);
  await new Promise((r) => setTimeout(r, PROBE_SETTLE_MS));

  const out = await simctlSpawn(udid, [
    "log",
    "show",
    "--last",
    `${PROBE_WINDOW_SECONDS}s`,
    "--style",
    "compact",
    "--predicate",
    // SpringBoard as well as backboardd: the keyboard's delivery trace is logged
    // by UIKit inside whichever process owns the keyboard, not by backboardd.
    'process == "backboardd" OR process == "SpringBoard"',
  ]);

  if (!out) return null;

  return matchTraces(out.split("\n").filter((l) => l.trim() !== "" && !isLogPreamble(l)));
}

/** Score already-filtered log lines against {@link DELIVERY_TRACES}. */
function matchTraces(lines: readonly string[]): HidHealth {
  const saw = (service: keyof HidHealth): boolean => {
    const [scope, trace] = DELIVERY_TRACES[service];
    return lines.some((l) => l.includes(scope) && l.includes(trace));
  };
  return { touch: saw("touch"), buttons: saw("buttons"), keyboard: saw("keyboard") };
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
  "is lost. On most simulators one reboot fixes it and a second clears the rest, because the " +
  "failure depends on a race re-run at every boot. If two reboots do not fix it, stop rebooting " +
  "— on some runtimes the buttons and keyboard cannot be protected at all, and further reboots " +
  "will only keep destroying the app state";

/**
 * Turn a probe result into something worth telling the agent, or `undefined`
 * when everything that matters works.
 */
function hidCaveat(health: HidHealth): string | undefined {
  // Each label carries its own verb: "typed text is", but "hardware buttons are".
  const dead: [string, string][] = [
    health.touch ? undefined : (["taps and gestures", "are"] as [string, string]),
    health.buttons ? undefined : (["hardware buttons", "are"] as [string, string]),
    health.keyboard ? undefined : (["typed text", "is"] as [string, string]),
  ].filter((x): x is [string, string] => x !== undefined);
  if (dead.length === 0) return undefined;

  // "a, b and c" — the list is what makes this actionable, since a simulator
  // that has lost only its buttons is still fully usable for tapping.
  const names = dead.map(([name]) => name);
  const subject =
    names.length === 1
      ? names[0]
      : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  const verb = dead.length === 1 ? dead[0]![1] : "are";
  return (
    `On this simulator ${subject} ${verb} not reaching the device. CoreDevice (usually DeviceHub) ` +
    `took over its input after it booted, and those events are being discarded silently — the ` +
    `calls that send them still report success. ${REBOOT_REMEDY}.`
  );
}

/**
 * Probe this device once for this boot, in the background.
 *
 * Call it from the attach path, never from a tool. The probe injects events to
 * produce the trace it reads, and an injection that lands in the
 * middle of a caller's gesture would corrupt it — a stray touch `Up` between a
 * drag's `Down` and its own `Up` ends the drag early. This is the only injection
 * on the attach path, which is why it happens once and on a delay.
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
 * Pure internals, exported for tests only.
 *
 * These are the parts worth pinning: which trace identifies each service, and
 * how a result is worded. Both have shipped wrong, and neither needs a simulator
 * to check.
 */
export const __testing = { DELIVERY_TRACES, hidCaveat, isLogPreamble, matchTraces };
