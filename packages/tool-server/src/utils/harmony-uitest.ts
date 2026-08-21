import { readFile } from "node:fs/promises";
import { FAILURE_CODES, FailureError } from "@argent/registry";
import { hdcFileRecv, runHdcShell, shellQuote } from "./harmony-hdc";

/**
 * Driver for `uitest`, the on-device binary that is HarmonyOS' entire UI
 * automation surface — `uiautomator`, `screencap` and `input` in one:
 *
 *   uitest dumpLayout -p <path>                    the accessibility tree, as JSON
 *   uitest screenCap  -p <path>                    a PNG of the display
 *   uitest uiInput click|doubleClick|longClick     touch
 *   uitest uiInput swipe|drag|fling|dircFling      gestures
 *   uitest uiInput keyEvent <id|Back|Home|Power>   hardware keys
 *   uitest uiInput text|inputText                  typing
 *
 * Two measured properties of the tool shape everything here (hdc 3.2.0d /
 * HarmonyOS 6.0.1, on a physical Mate 60):
 *
 * - **Its exit status is trustworthy, unlike its transport's.** `hdc` exits 0
 *   for everything (see `harmony-hdc.ts`), but `uitest` itself exits 1 and names
 *   the problem — `Invalid parameters.`, `Please confirm that the coordinate
 *   values are correct.`, `The number of parameters is incorrect.` — so the
 *   status recovered by `runHdcShell` is the success signal, and `No Error` on
 *   stdout is not needed to confirm it.
 *
 * - **It validates almost nothing.** A click at `99999 99999`, far outside a
 *   1216x2688 display, returns `No Error` and exit 0 having done nothing
 *   observable. Only *negative* and non-numeric coordinates are rejected. So
 *   out-of-range coordinates are argent's to catch: `toDevicePoint` clamps into
 *   the display, which is what keeps a normalized 0-1 rounding error at the
 *   right edge from silently becoming a no-op tap.
 *
 * **Why not the simulator-server**, which is how iOS and Android reach a
 * device: neither of its controllers has a counterpart here. An Android
 * emulator is driven over the emulator's own gRPC console, and DevEco's
 * `Emulator` 6.1.1.200 is stock `ohos-qemu` behind a Qt UI — no gRPC anywhere
 * in the binary, no QEMU passthrough in its CLI, `hdc` the only host-side
 * channel it ships. An Android phone is driven by a screen-sharing agent pushed
 * over adb, which HarmonyOS has no equivalent of. What is left either way is
 * `hdc`, reaching this same `uitest` one contact at a time, from Rust instead.
 */

/** Where on-device artifacts are staged before being copied to the host. */
const REMOTE_TMP = "/data/local/tmp";

/**
 * Per-`uitest` ceiling. Exported because a caller working to a deadline of its
 * own has to cap its probe against it: a probe outliving the call that made it
 * holds this device's queue, and the next call is what waits.
 */
export const UITEST_TIMEOUT_MS = 20_000;

/**
 * Whole-call ceiling for one interaction — the display read, the wait for this
 * device's `uitest` queue and every injection come out of it together.
 *
 * None of the interaction tools declares `longRunning`, so the MCP client aborts
 * a call at 30s and *replays* it while the abandoned `hdc` children keep running
 * and keep holding the queue. For a tap that replay is a second touch for one
 * the caller believes never happened, so the tool has to fail on its own budget
 * first — which two legs on {@link UITEST_TIMEOUT_MS} each cannot do.
 */
export const HARMONY_INTERACTION_TIMEOUT_MS = 20_000;

/**
 * Ceiling for one render-service read, and the reason the whole interaction fits
 * inside one `uitest` ceiling: the read is measured at 50-190ms and the slowest
 * `hdc shell` round trip measured on an emulator is 0.8s, so this is ~6x headroom
 * for a loaded host rather than a bound a healthy read approaches.
 */
export const HARMONY_DISPLAY_TIMEOUT_MS = 5_000;

/**
 * Ceiling for the on-device cleanup delete, which runs after the caller's budget
 * is already spent. `runHdcShell`'s 30s default would add that much again past a
 * deadline the caller has exhausted; a `rm -f` is the lightest shell round trip
 * there is, against the 0.1-0.8s measured for one.
 */
const REMOTE_CLEANUP_TIMEOUT_MS = 5_000;

/**
 * `uitest` does not tolerate overlapping invocations: a second call on the
 * same device blocks until the first finishes, and if that takes past the
 * timeout the loser is SIGKILLed with the internal status sentinel in its
 * error. Measured: two concurrent `dumpLayout`s → one 20s failure; three →
 * two. So calls on one connect key are serialised here — queued behind each
 * other rather than raced — which turns an opaque 20s kill into the second
 * call simply starting once the first is done. Keyed per device so a phone
 * and an emulator, or two devices, still run in parallel; the map entry is
 * dropped once the queue drains so it cannot grow unboundedly.
 */
const uitestQueues = new Map<string, Promise<void>>();

function enqueueUitest<T>(connectKey: string, run: () => Promise<T>): Promise<T> {
  const prior = uitestQueues.get(connectKey) ?? Promise.resolve();
  const result = prior.then(run);
  // The queue tracks only the settlement signal, not the value, so a rejection
  // never propagates into the next caller's chain.
  const drained = result.then(
    () => undefined,
    () => undefined
  );
  uitestQueues.set(connectKey, drained);
  void drained.finally(() => {
    if (uitestQueues.get(connectKey) === drained) uitestQueues.delete(connectKey);
  });
  return result;
}

/**
 * `uitest` prints its multi-line usage block after every failure. Only the
 * leading line names the actual problem, so surface that and drop the rest —
 * pasting 12 lines of usage into an agent's context buries the diagnostic.
 */
function uitestDiagnostic(stdout: string): string {
  const first = stdout.split(/\r?\n/).find((l) => l.trim().length > 0);
  return first?.trim() ?? "uitest failed without a diagnostic";
}

/**
 * Milliseconds left of a shared deadline, or a refusal when there are none.
 *
 * A leg started with nothing left is killed the moment it begins and reported as
 * a device that hung, which is the wrong repair for a budget that was gone
 * before it — and a spent budget cannot simply be passed on, since `execFile`
 * reads a timeout of 0 as *no* timeout.
 */
export function remainingBudget(connectKey: string, deadline: number, step: string): number {
  const left = deadline - Date.now();
  if (left > 0) return left;
  throw new FailureError(
    `Ran out of time before ${step} on HarmonyOS device '${connectKey}': the call's budget was ` +
      `spent by the steps before it, waiting for this device's \`uitest\` queue included. ` +
      `Retry once the device is idle.`,
    {
      error_code: FAILURE_CODES.HARMONY_HDC_COMMAND_FAILED,
      failure_stage: "harmony_budget_exhausted",
      failure_area: "tool_server",
      error_kind: "timeout",
      failure_command: "hdc",
    }
  );
}

/** Run a `uitest` subcommand, throwing with its own diagnostic if it exits non-zero. */
async function runUitest(connectKey: string, args: string, timeoutMs: number): Promise<string> {
  // The ceiling spans the queue as well as the call. A clock started once this
  // device's queue hands over cannot see the wait in front of it, so a caller
  // queued behind another — the one case that makes an interaction outlive its
  // budget — would be charged against no ceiling at all.
  const deadline = Date.now() + timeoutMs;
  const { stdout, exitCode } = await enqueueUitest(connectKey, () =>
    runHdcShell(
      connectKey,
      `uitest ${args}`,
      // The subcommand alone — the arguments carry the text being typed.
      remainingBudget(connectKey, deadline, `\`uitest ${args.split(" ")[0]}\``)
    )
  );
  if (exitCode !== 0) {
    throw new FailureError(`uitest ${args} failed on ${connectKey}: ${uitestDiagnostic(stdout)}`, {
      error_code: FAILURE_CODES.HARMONY_UITEST_FAILED,
      failure_stage: "harmony_uitest",
      failure_area: "tool_server",
      error_kind: "subprocess",
      failure_command: "hdc",
    });
  }
  return stdout;
}

interface HarmonyDisplay {
  width: number;
  height: number;
  /** False unless the panel is fully on — see {@link INTERACTIVE_POWER_STATUS}. */
  screenOn: boolean;
}

/**
 * The `ScreenPowerStatus` values that mean a touch can land.
 *
 * An allowlist, because the enum is long and mostly not interactive: the
 * HarmonyOS 6.1.1 system image also names `STANDBY`, `SUSPEND`, `OFF`,
 * `OFF_ADVANCED`, `OFF_FAKE`, `DOZE`, `DOZE_SUSPEND`, `ERROR` and `BUTT`
 * (read out of `system.img`). `uitest uiInput` answers `No Error` on every one
 * of them, so naming the two that are on makes an unmeasured state refuse
 * rather than report a touch that reached nothing.
 *
 * `ON_ADVANCED` is the pre-power-on state a wake passes through. Refusing it
 * would fail exactly the retry this guard's own message prescribes.
 */
const INTERACTIVE_POWER_STATUS = new Set(["POWER_STATUS_ON", "POWER_STATUS_ON_ADVANCED"]);

/**
 * Display geometry and power state, read from the render service.
 *
 * Not cached. The obvious optimisation is wrong on this platform: HarmonyOS'
 * flagship form factors are foldables, whose resolution changes when the user
 * unfolds the device, and `powerStatus` changes on any screen timeout. A cached
 * width would silently misplace every subsequent tap on the other half of a
 * fold. The call is a local service dump measured at 50-190ms, cheap enough to
 * pay per gesture rather than risk that.
 */
export async function harmonyDisplay(
  connectKey: string,
  timeoutMs = HARMONY_DISPLAY_TIMEOUT_MS
): Promise<HarmonyDisplay> {
  const { stdout } = await runHdcShell(
    connectKey,
    "hidumper -s RenderService -a screen",
    timeoutMs
  );
  // One line per panel, carrying both fields — measured on HarmonyOS 6.1.1:
  //   screen[0]: id=0, powerStatus=POWER_STATUS_ON, ..., render resolution=1320x2856, ...
  // Both read off the SAME line: scanning the whole dump for POWER_STATUS_OFF
  // refuses every gesture on an awake foldable the moment its other half sleeps.
  const screen = stdout
    .split("\n")
    .find((line) => /^\s*screen\[\d+\]:/.test(line) && /render resolution=\d+x\d+/.test(line));
  const res = screen ? /render resolution=(\d+)x(\d+)/.exec(screen) : null;
  const power = screen ? /powerStatus=(\w+)/.exec(screen) : null;
  // Both or neither: defaulting an unparsed power state to "on" is the one
  // answer that lets a suspended panel through every input tool.
  if (!res || !power) {
    throw new FailureError(
      `Could not read the display size and power state of HarmonyOS device '${connectKey}' from the render service.`,
      {
        // The display, not `uitest`: this is a `hidumper` dump, and no `uitest`
        // ran. `failure_stage` is what separates a dump that could not be parsed
        // from one that parsed and reported nothing usable.
        error_code: FAILURE_CODES.HARMONY_DISPLAY_UNREADABLE,
        failure_stage: "harmony_display_size",
        failure_area: "tool_server",
        error_kind: "subprocess",
        failure_command: "hdc",
      }
    );
  }
  return {
    width: Number.parseInt(res[1], 10),
    height: Number.parseInt(res[2], 10),
    screenOn: INTERACTIVE_POWER_STATUS.has(power[1]),
  };
}

/**
 * Convert argent's normalized 0-1 coordinates to device pixels.
 *
 * Clamped to the last addressable pixel rather than the bound itself: `uitest`
 * accepts an out-of-range coordinate silently (see the header), so `y = 1.0`
 * would otherwise inject at `height`, one row past the display, and report
 * success for a touch that never happened.
 */
export function toDevicePoint(
  x: number,
  y: number,
  display: { width: number; height: number }
): { x: number; y: number } {
  const clamp = (v: number, max: number) => Math.max(0, Math.min(max - 1, Math.round(v * max)));
  return { x: clamp(x, display.width), y: clamp(y, display.height) };
}

/**
 * Refuse an input injection against a display that cannot receive one.
 *
 * `uitest uiInput` reports `No Error` whether or not the touch landed, so both
 * states it cannot land in are argent's to catch, off the one read every input
 * tool already makes:
 *
 * - **A non-positive panel.** The render service prints `render resolution=0x0`
 *   while the guest's compositor is still coming up, and every normalized
 *   coordinate then clamps to the origin — a tap at (0.83, 0.42) goes out as
 *   `uiInput click 0 0` and comes back as the tap that was asked for.
 *   `boot-device` refuses the same read as unreadable rather than act on it.
 * - **A suspended panel.** Measured: a tap on the WLAN row of Settings with
 *   `powerStatus=POWER_STATUS_OFF` returned success and changed nothing.
 *   `describe` is honest about this state (its asleep hint); the input tools
 *   must be too, or a screen timeout mid-session turns every later gesture into
 *   a silent no-op that reports success.
 */
export function assertHarmonyDisplayReady(display: HarmonyDisplay, action: string): void {
  // Before the power state, which is read off the same dump: a service that
  // could not name a panel has said nothing trustworthy about that panel's
  // power either.
  if (display.width <= 0 || display.height <= 0) {
    throw new FailureError(
      `Cannot ${action} on a HarmonyOS device whose render service reports a ` +
        `${display.width}x${display.height} display: the panel has not composited yet, or the ` +
        `render service answered with nothing usable. \`uitest uiInput\` answers \`No Error\` ` +
        `either way, so the call would report input that reached nothing — and a tap or swipe ` +
        `would additionally collapse onto the top-left pixel, having no size to scale against. ` +
        `Retry once the device has finished booting.`,
      {
        error_code: FAILURE_CODES.HARMONY_DISPLAY_UNREADABLE,
        failure_stage: "harmony_display_zero",
        failure_area: "tool_server",
        error_kind: "validation",
      }
    );
  }
  if (display.screenOn) return;
  throw new FailureError(
    `Cannot ${action} on a HarmonyOS device whose display is off: injected input lands nowhere ` +
      `while the panel is suspended. Wake it with \`button\` (power), then retry.`,
    {
      error_code: FAILURE_CODES.HARMONY_SCREEN_OFF,
      failure_stage: "harmony_screen_off",
      failure_area: "tool_server",
      error_kind: "validation",
    }
  );
}

type HarmonyTouchCommand = "click" | "doubleClick";

export async function harmonyTouch(
  connectKey: string,
  command: HarmonyTouchCommand,
  point: { x: number; y: number },
  timeoutMs: number
): Promise<void> {
  await runUitest(connectKey, `uiInput ${command} ${point.x} ${point.y}`, timeoutMs);
}

type HarmonySwipeCommand = "swipe" | "fling";

/**
 * `uitest` rejects a velocity outside this range with `Invalid parameters.`, so
 * callers translating a duration into a velocity must land inside it.
 */
const HARMONY_VELOCITY_MIN = 200;
const HARMONY_VELOCITY_MAX = 40_000;

/**
 * `uitest` takes a **velocity**, not a duration, so the duration argent's tools
 * speak is converted by the caller: velocity = pixels travelled / seconds.
 * Doing it the other way — passing a fixed velocity — would make a short swipe
 * and a screen-length one take wildly different times, and the callers that
 * pace a scroll loop against `durationMs` would be pacing against nothing.
 *
 * `settle` picks the verb rather than reshaping the path. `uitest` exposes both
 * `swipe` (a drag that ends where it ends) and `fling` (which hands the scroller
 * a release velocity to coast on), so the momentum-free request maps onto the
 * one the platform already means by it. That is the vendor's own distinction
 * between the two commands; the resulting difference in coast distance was not
 * measured here.
 */
export async function harmonySwipe(
  connectKey: string,
  command: HarmonySwipeCommand,
  from: { x: number; y: number },
  to: { x: number; y: number },
  velocity: number,
  timeoutMs: number
): Promise<void> {
  const v = Math.max(HARMONY_VELOCITY_MIN, Math.min(HARMONY_VELOCITY_MAX, Math.round(velocity)));
  await runUitest(
    connectKey,
    `uiInput ${command} ${from.x} ${from.y} ${to.x} ${to.y} ${v}`,
    timeoutMs
  );
}

export async function harmonyKeyEvent(
  connectKey: string,
  key: string,
  timeoutMs: number
): Promise<void> {
  await runUitest(connectKey, `uiInput keyEvent ${key}`, timeoutMs);
}

/** Type into whatever currently holds focus. */
export async function harmonyTypeText(
  connectKey: string,
  text: string,
  timeoutMs: number
): Promise<void> {
  await runUitest(connectKey, `uiInput text ${shellQuote(text)}`, timeoutMs);
}

/**
 * Run `producer` against a freshly-named path under the device's tmp directory,
 * copy the result to `localPath`, then delete the on-device copy.
 *
 * The unique name matters for more than tidiness: two tool calls racing a fixed
 * path would have one overwrite the other's capture between write and fetch, and
 * the loser would silently receive the winner's screen. The delete runs even
 * when the fetch throws — otherwise a device accumulates a multi-hundred-KB PNG
 * per failed screenshot, on a partition nothing else prunes.
 */
async function viaDeviceTmp(
  connectKey: string,
  suffix: string,
  localPath: string,
  producer: (remotePath: string, timeoutMs: number) => Promise<void>,
  deadline: number
): Promise<void> {
  const remotePath = `${REMOTE_TMP}/argent-${process.pid}-${process.hrtime.bigint()}${suffix}`;
  try {
    // A caller working to a deadline spends it across BOTH round trips, so each
    // leg is handed what is left of it rather than a ceiling of its own — a
    // producer given the full budget leaves the fetch a sliver, and a fetch left
    // on `hdc`'s 30s default runs that far past a deadline the caller has
    // already exhausted.
    await producer(remotePath, remainingBudget(connectKey, deadline, "the capture"));
    await hdcFileRecv(
      connectKey,
      remotePath,
      localPath,
      remainingBudget(connectKey, deadline, "copying the result off the device")
    );
  } finally {
    // The delete is outside the shared budget — it runs after that budget is
    // spent, and leaving a multi-hundred-KB capture on a partition nothing
    // prunes is not the way to save the time — but on a ceiling of its own, so a
    // wedged daemon cannot add 30s to a call that is already over.
    await runHdcShell(
      connectKey,
      `rm -f ${shellQuote(remotePath)}`,
      REMOTE_CLEANUP_TIMEOUT_MS
    ).catch(() => {});
  }
}

/** Capture the display to `localPath` as a PNG. */
export async function harmonyScreenCap(
  connectKey: string,
  localPath: string,
  timeoutMs = UITEST_TIMEOUT_MS
): Promise<void> {
  await viaDeviceTmp(
    connectKey,
    ".png",
    localPath,
    async (remotePath, leftMs) => {
      await runUitest(connectKey, `screenCap -p ${shellQuote(remotePath)}`, leftMs);
    },
    Date.now() + timeoutMs
  );
}

/** A node of the tree `uitest dumpLayout` writes. */
export interface HarmonyLayoutNode {
  attributes: Record<string, string>;
  children?: HarmonyLayoutNode[];
}

/**
 * The current UI tree.
 *
 * `-i` is deliberately not passed: without it `uitest` merges the window stack
 * into one tree and filters invisible nodes, which is the view a caller asking
 * "what is on screen" wants. The unmerged form exposes every background window
 * of every app, including ones the user cannot see.
 */
export async function harmonyDumpLayout(
  connectKey: string,
  localPath: string,
  timeoutMs = UITEST_TIMEOUT_MS
): Promise<HarmonyLayoutNode> {
  await viaDeviceTmp(
    connectKey,
    ".json",
    localPath,
    async (remotePath, leftMs) => {
      await runUitest(connectKey, `dumpLayout -p ${shellQuote(remotePath)}`, leftMs);
    },
    Date.now() + timeoutMs
  );
  const raw = await readFile(localPath, "utf8");
  try {
    return JSON.parse(raw) as HarmonyLayoutNode;
  } catch (err) {
    throw new FailureError(
      `HarmonyOS device '${connectKey}' returned a layout dump that is not valid JSON ` +
        `(${raw.length} bytes).`,
      {
        error_code: FAILURE_CODES.HARMONY_UITEST_FAILED,
        failure_stage: "harmony_dump_layout",
        failure_area: "tool_server",
        error_kind: "subprocess",
        failure_command: "hdc",
      },
      { cause: err as Error }
    );
  }
}
