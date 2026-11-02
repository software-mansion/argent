import { readFile } from "node:fs/promises";
import { FAILURE_CODES, FailureError } from "@argent/registry";
import { hdcFileRecv, runHdcShell, shellQuote } from "./harmony-hdc";

/**
 * Driver for the on-device injectors: `uitest` (layout dump, screen capture,
 * single-contact input, keys, text) and `uinput -T -m` (up to three contacts).
 *
 * `uitest` exits non-zero with a diagnostic on failure, unlike `hdc`, but
 * validates almost nothing: an off-screen click answers `No Error`, while any
 * coordinate below 1 is refused. {@link toDevicePoint} clamps both ends.
 *
 * There is no simulator-server path: DevEco's emulator has no gRPC console and
 * HarmonyOS has no screen-sharing agent, so `hdc` is the only channel.
 */

const REMOTE_TMP = "/data/local/tmp";

/** Per-`uitest` ceiling; a probe outliving its caller holds the device's queue. */
export const UITEST_TIMEOUT_MS = 20_000;

/**
 * Whole-call ceiling for one interaction, under the MCP client's 30s
 * abort-and-replay, which would otherwise re-inject a tap the caller thinks
 * never happened.
 */
export const HARMONY_INTERACTION_TIMEOUT_MS = 20_000;

export const HARMONY_DISPLAY_TIMEOUT_MS = 5_000;

/** The cleanup `rm` runs after the caller's budget is spent, so it gets its own. */
const REMOTE_CLEANUP_TIMEOUT_MS = 5_000;

/**
 * Overlapping `uitest` calls on one device block each other until one is
 * SIGKILLed at its timeout, so calls are queued per connect key.
 */
const uitestQueues = new Map<string, Promise<void>>();

function enqueueUitest<T>(connectKey: string, run: () => Promise<T>): Promise<T> {
  const prior = uitestQueues.get(connectKey) ?? Promise.resolve();
  const result = prior.then(run);
  // Track settlement only, so a rejection never reaches the next caller.
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

/** `uitest` follows a failure with its usage block; only the first line matters. */
function uitestDiagnostic(stdout: string): string {
  const first = stdout.split(/\r?\n/).find((l) => l.trim().length > 0);
  return first?.trim() ?? "uitest failed without a diagnostic";
}

/**
 * Milliseconds left of `deadline`, or a refusal. A spent budget cannot be passed
 * on: `execFile` reads a timeout of 0 as none.
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

/** The subcommand alone: the arguments may carry typed text. */
function uitestStep(args: string): string {
  return `\`uitest ${args.split(" ")[0]}\``;
}

/** Run one `uitest` subcommand, throwing with its own diagnostic if it exits non-zero. */
async function runUitestDirect(
  connectKey: string,
  args: string,
  timeoutMs: number
): Promise<string> {
  const { stdout, exitCode } = await runHdcShell(connectKey, `uitest ${args}`, timeoutMs);
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

/** Run a `uitest` subcommand on a ceiling of its own, queued behind this device's previous one. */
async function runUitest(connectKey: string, args: string, timeoutMs: number): Promise<string> {
  // The ceiling spans the wait in the queue too.
  const deadline = Date.now() + timeoutMs;
  return enqueueUitest(connectKey, () =>
    runUitestDirect(connectKey, args, remainingBudget(connectKey, deadline, uitestStep(args)))
  );
}

interface HarmonyDisplay {
  width: number;
  height: number;
  /** False unless the panel is fully on — see {@link INTERACTIVE_POWER_STATUS}. */
  screenOn: boolean;
}

/**
 * The `ScreenPowerStatus` values a touch can land in. An allowlist, since
 * `uitest` answers `No Error` in every state; `ON_ADVANCED` is the state a wake
 * passes through.
 */
const INTERACTIVE_POWER_STATUS = new Set(["POWER_STATUS_ON", "POWER_STATUS_ON_ADVANCED"]);

/**
 * Display geometry, in the rotated space `uitest` coordinates and layout bounds
 * use, and power state. Not cached: a foldable's resolution changes with the
 * fold, power with any timeout, and orientation with the foreground app.
 */
export async function harmonyDisplay(
  connectKey: string,
  timeoutMs = HARMONY_DISPLAY_TIMEOUT_MS
): Promise<HarmonyDisplay> {
  const { stdout } = await runHdcShell(
    connectKey,
    "hidumper -s RenderService -a screen; hidumper -s DisplayManagerService -a -a",
    timeoutMs
  );
  // Both fields from the same `screen[N]:` line, preferring an awake one, so a
  // foldable's sleeping half does not refuse input on the awake one:
  //   screen[0]: id=0, powerStatus=POWER_STATUS_ON, ..., render resolution=1320x2856, ...
  const screens = stdout
    .split("\n")
    .filter((line) => /^\s*screen\[\d+\]:/.test(line) && /render resolution=\d+x\d+/.test(line));
  const screen =
    screens.find((line) =>
      INTERACTIVE_POWER_STATUS.has(/powerStatus=(\w+)/.exec(line)?.[1] ?? "")
    ) ?? screens[0];
  const res = screen ? /render resolution=(\d+)x(\d+)/.exec(screen) : null;
  const power = screen ? /powerStatus=(\w+)/.exec(screen) : null;
  // Both or neither: an unparsed power state must not default to "on".
  if (!res || !power) {
    throw new FailureError(
      `Could not read the display size and power state of HarmonyOS device '${connectKey}' from the render service.`,
      {
        error_code: FAILURE_CODES.HARMONY_DISPLAY_UNREADABLE,
        failure_stage: "harmony_display_size",
        failure_area: "tool_server",
        error_kind: "subprocess",
        failure_command: "hdc",
      }
    );
  }
  const width = Number.parseInt(res[1], 10);
  const height = Number.parseInt(res[2], 10);
  // The render resolution is the panel's mode, and stays portrait in landscape.
  const quarterTurn = screenRotation(stdout, /\bid=(\d+)/.exec(screen!)?.[1]) % 180 === 90;
  return {
    width: quarterTurn ? height : width,
    height: quarterTurn ? width : height,
    screenOn: INTERACTIVE_POWER_STATUS.has(power[1]),
  };
}

/**
 * Degrees the display is rotated from the panel, from the display manager's
 * session for render-service screen `rsScreenId`; 0 when it names none.
 */
function screenRotation(stdout: string, rsScreenId: string | undefined): number {
  for (const section of stdout.split(/^-+ Screen ID: \d+ -+\s*$/m).slice(1)) {
    if (/^RSScreenId:\s+(\d+)/m.exec(section)?.[1] !== rsScreenId) continue;
    return Number.parseInt(/^ScreenRotation:\s+(\d+)/m.exec(section)?.[1] ?? "0", 10);
  }
  return 0;
}

/**
 * Normalized 0-1 coordinates to device pixels, clamped to [1, size - 1]:
 * `uitest` silently ignores a point past the edge and refuses 0.
 */
export function toDevicePoint(
  x: number,
  y: number,
  display: { width: number; height: number }
): { x: number; y: number } {
  const clamp = (v: number, max: number) => Math.max(1, Math.min(max - 1, Math.round(v * max)));
  return { x: clamp(x, display.width), y: clamp(y, display.height) };
}

/**
 * Refuse input `uitest` would report as delivered but that lands nowhere: a
 * `0x0` panel still compositing (every point would clamp to one corner), or a
 * suspended one.
 */
export function assertHarmonyDisplayReady(display: HarmonyDisplay, action: string): void {
  // A service that cannot name the panel says nothing trustworthy about its power.
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

type HarmonySwipeCommand = "swipe" | "fling";

/**
 * `uitest` rejects a velocity outside this range with `Invalid parameters.`, so
 * callers translating a duration into a velocity must land inside it.
 */
const HARMONY_VELOCITY_MIN = 200;
const HARMONY_VELOCITY_MAX = 40_000;

function touchArgs(command: HarmonyTouchCommand, point: { x: number; y: number }): string {
  return `uiInput ${command} ${point.x} ${point.y}`;
}

/**
 * `uitest` takes a velocity, not a duration. `fling` hands the scroller a
 * release velocity to coast on; `swipe` does not.
 */
function swipeArgs(
  command: HarmonySwipeCommand,
  from: { x: number; y: number },
  to: { x: number; y: number },
  velocity: number
): string {
  const v = Math.max(HARMONY_VELOCITY_MIN, Math.min(HARMONY_VELOCITY_MAX, Math.round(velocity)));
  return `uiInput ${command} ${from.x} ${from.y} ${to.x} ${to.y} ${v}`;
}

/** `uinput -T -m` move time bounds, in wall-clock milliseconds. */
const HARMONY_MOVE_TIME_MIN = 1;
const HARMONY_MOVE_TIME_MAX = 15_000;

/** One contact's straight-line leg of a multi-touch move, in device pixels. */
interface HarmonyFingerPath {
  from: { x: number; y: number };
  to: { x: number; y: number };
}

/**
 * `uinput -T -m x1 y1 x1' y1' [...] [ms]`. Contacts only coexist within one
 * invocation, and `-m` cannot repeat, so each contact moves along one straight
 * line: a pinch is expressible, an arc is not.
 */
function multiTouchArgs(paths: HarmonyFingerPath[], durationMs: number): string {
  const ms = Math.min(
    HARMONY_MOVE_TIME_MAX,
    Math.max(HARMONY_MOVE_TIME_MIN, Math.round(durationMs))
  );
  const points = paths.flatMap(({ from, to }) => [from.x, from.y, to.x, to.y]);
  return `-T -m ${points.join(" ")} ${ms}`;
}

/** The argument echo `uinput -T -m` prints before it has validated any of it. */
const UINPUT_ARGUMENT_ECHO = /^(startX:|fingerCount:|keepTimeMs:|smoothTimeMs:)/;

/**
 * `uinput` echoes its arguments before validating them and may follow with a
 * usage block; keep the two lines between, which carry a range refusal's bound.
 */
function uinputDiagnostic(stdout: string): string {
  const lines = stdout.split(/\r?\n/).map((line) => line.trim());
  const usage = lines.findIndex((line) => line.startsWith("Usage: uinput"));
  const body = (usage === -1 ? lines : lines.slice(0, usage)).filter(
    (line) => line.length > 0 && !UINPUT_ARGUMENT_ECHO.test(line)
  );
  return body.slice(0, 2).join(" ") || "it printed no diagnostic";
}

/**
 * The exit status is the only portable signal: some builds print nothing and
 * `hdc` does not forward stderr.
 */
async function runUinputDirect(connectKey: string, args: string, timeoutMs: number): Promise<void> {
  const { stdout, exitCode } = await runHdcShell(connectKey, `uinput ${args}`, timeoutMs);
  if (exitCode === 0) return;
  throw new FailureError(
    `uinput ${args} failed on ${connectKey} (exit ${exitCode}): ${uinputDiagnostic(stdout)}`,
    {
      error_code: FAILURE_CODES.HARMONY_UITEST_FAILED,
      failure_stage: "harmony_uinput",
      failure_area: "tool_server",
      error_kind: "subprocess",
      failure_command: "hdc",
    }
  );
}

/** The injections one hold of the device's queue may make, all on the hold's deadline. */
interface UitestSlot {
  touch(command: HarmonyTouchCommand, point: { x: number; y: number }): Promise<void>;
  swipe(
    command: HarmonySwipeCommand,
    from: { x: number; y: number },
    to: { x: number; y: number },
    velocity: number
  ): Promise<void>;
  keyEvent(key: string): Promise<void>;
  /** Type into whatever currently holds focus, in one shot. */
  type(text: string): Promise<void>;
  /** Up to three contacts, each along a straight line, over `durationMs`. */
  multiTouchMove(paths: HarmonyFingerPath[], durationMs: number): Promise<void>;
}

/**
 * Run one input interaction, display check included, in a single hold of the
 * device's queue, so the panel checked is the panel injected into. `unit` must
 * not enqueue again. Once `signal` aborts, no further input is injected.
 */
export async function holdUitestQueue<T>(
  connectKey: string,
  deadline: number,
  unit: (slot: UitestSlot) => Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  const assertNotCancelled = (): void => {
    if (!signal?.aborted) return;
    const err = new Error(
      `HarmonyOS input on '${connectKey}' was cancelled before it was injected`
    );
    err.name = "AbortError";
    throw err;
  };
  const run = async (args: string): Promise<void> => {
    assertNotCancelled();
    await runUitestDirect(
      connectKey,
      args,
      remainingBudget(connectKey, deadline, uitestStep(args))
    );
  };
  return enqueueUitest(connectKey, () => {
    assertNotCancelled();
    return unit({
      touch: (command, point) => run(touchArgs(command, point)),
      swipe: (command, from, to, velocity) => run(swipeArgs(command, from, to, velocity)),
      keyEvent: (key) => run(`uiInput keyEvent ${key}`),
      type: (text) => run(`uiInput text ${shellQuote(text)}`),
      // Not a `uitest` singleton, but interleaved input is as bad on either binary.
      multiTouchMove: async (paths, durationMs) => {
        assertNotCancelled();
        const args = multiTouchArgs(paths, durationMs);
        await runUinputDirect(
          connectKey,
          args,
          remainingBudget(connectKey, deadline, "`uinput -T -m`")
        );
      },
    });
  });
}

/**
 * Run `producer` against a unique on-device path, copy it to `localPath`, then
 * delete it even on failure: a fixed name races concurrent calls, and nothing
 * prunes the partition.
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
    // Both legs share the caller's deadline.
    await producer(remotePath, remainingBudget(connectKey, deadline, "the capture"));
    await hdcFileRecv(
      connectKey,
      remotePath,
      localPath,
      remainingBudget(connectKey, deadline, "copying the result off the device")
    );
  } finally {
    // Outside the spent budget, on a short ceiling of its own.
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

/** The merged, visible-only tree: `-i` would add every background window. */
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
