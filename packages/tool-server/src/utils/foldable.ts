import { execFile } from "node:child_process";
import * as fs from "node:fs";
import { promisify } from "node:util";
import { externalNativeId } from "./external-devices";
import { isFoldableSimulator } from "./ios-devices";
import { sleepOrAbort } from "./timing";

const execFileAsync = promisify(execFile);

/**
 * Which panel of a foldable simulator argent captures and touches.
 *
 * The simulator-server captures every panel and follows none: each screenshot,
 * stream, touch and wheel names the CoreSimulator screen it is for (1 is the
 * cover panel, 3 the inner one on the iPhone Duo) and gets screen 1 when it
 * names none. Which panel the guest renders to is argent's to find out, and
 * CoreDevice knows: `devicectl device info displays` reports `active` per
 * display, with the same ids, in one ~100-200 ms query.
 *
 * This module is that query plus a per-device memo of its last answer. The memo
 * is refreshed at the points where the answer can have changed — when a
 * simulator-server is spawned for the device, before and after argent's own
 * `fold`, and when a `describe` or a flow's tree read reports a panel the memo
 * disagrees with — and read by every touch and wheel in between. Callers that
 * capture without a preceding describe (`screenshot`, a live
 * `screenshot-diff`, a recording start) refresh it themselves. Nothing here
 * looks at pixels, and nothing subscribes: argent is the controller, so the
 * only unknown after a fold is which panel ended up live, and one read
 * answers that.
 *
 * A read can fail (CoreDevice wedged, the query timing out). The memo then
 * keeps its last answer, and while it has none the next touch retries the
 * read, with a short back-off, rather than aiming at the cover panel of a
 * device that may be open; a `describe`, or a flow's tree read, seeds it from
 * the panel the tree was read on, since that is the panel the device renders
 * to.
 */

/** The screen every simulator has and every command defaults to. */
export const MAIN_SCREEN_ID = 1;

export interface FoldablePanel {
  screenId: number;
  /** Native pixel size of the panel. */
  width: number;
  height: number;
}

export interface ActiveScreenState {
  /** CoreSimulator screen id of the panel the guest renders to. */
  activeScreen: number;
  /** The integrated panels CoreDevice reports, in native pixels. */
  panels: FoldablePanel[];
  /** Device orientation as CoreDevice names it (`portrait`, `landscapeRight`, ...). */
  orientation?: string;
  readAt: number;
}

/**
 * How long one CoreDevice query may take. Measured at ~170 ms on the Duo; the
 * budget is for a wedged CoreDevice, not for normal latency.
 */
const DEVICECTL_TIMEOUT_MS = 5_000;

/**
 * The hand-over lands 0.5-1.5 s after a hinge sweep, longer when the guest is
 * busy. After a fold the one-shot is polled until it reports the panel the
 * sweep implies: `HAND_OVER_TIMEOUT_MS` bounds that wait, and
 * `SETTLE_TIMEOUT_MS` the wait for a sweep whose outcome is not predicted,
 * where the panel may legitimately stay.
 */
export const HAND_OVER_TIMEOUT_MS = 6_000;
export const SETTLE_TIMEOUT_MS = 3_000;
const SETTLE_POLL_MS = 200;

/**
 * How long the guest takes to accept input again after a hinge sweep, counted
 * from the CoreDevice read that follows it (itself ~170 ms after the sweep).
 * Measured on the iPhone Duo (iOS 27.1) with taps fired every ~150 ms: a sweep
 * that ends at a stop — closed (0°) or open (180°) — takes input within
 * ~250 ms of the read, with or without a hand-over, while one that ends at any
 * other angle (half-open included, and 30° on the cover panel) drops every tap
 * for 0.4-0.8 s more, up to ~1.2 s after the sweep, again whether or not the
 * panel changed. The fold tool holds the matching time before it answers, so
 * the next command lands; the values carry margin over what was measured.
 */
export const INPUT_READY_HOLD_MS = 500;
export const INPUT_READY_HOLD_MID_ANGLE_MS = 1_500;
/**
 * The hold restarts when the panel changes under it (see
 * {@link holdActiveScreen}); this bounds the restarts, so a panel that keeps
 * flapping still gets an answer.
 */
const HOLD_MAX_MS = 5_000;

/**
 * After a failed read, how long touches keep targeting the main screen before
 * one of them asks CoreDevice again. Short, so a device left open takes input
 * again as soon as CoreDevice recovers; long enough that a wedged CoreDevice
 * does not cost every touch its query timeout.
 */
export const READ_RETRY_AFTER_MS = 2_000;

/**
 * Where the guest hands over between the panels, in hinge degrees, for a sweep
 * that starts at a stop (closed or open). Measured on the iPhone Duo
 * (iOS 27.1) in both directions: from closed, at 75° and below the device
 * keeps rendering to the cover panel and from 90° up it switches to the inner
 * one; from open, the same bands the other way round. In between, the outcome
 * is not predicted: from closed, 76-80° switches to the inner panel for about
 * a second and then returns to the cover, and 85° switches for good.
 *
 * A sweep that starts anywhere else follows no such model: measured 75° → 90°,
 * 90° → 75°, 100° → 75° and 120° → 75° all leave the panel where it was. The
 * fold tool predicts nothing for those and reports what CoreDevice says.
 */
const COVER_MAX_ANGLE = 75;
const INNER_MIN_ANGLE = 90;

/**
 * CoreDevice's own binary. `xcrun devicectl` resolves to the same file for the
 * selected Xcode, but the direct path skips the xcrun shim and is what the
 * measurement was taken with.
 */
const DEVICECTL_BIN =
  "/Library/Developer/PrivateFrameworks/CoreDevice.framework/Versions/A/Resources/bin/devicectl";

const cache = new Map<string, ActiveScreenState>();
/** When the last read of a device failed, while the memo holds nothing newer. */
const failedReadAt = new Map<string, number>();
/**
 * The panels the device's simulator-server reported as it attached: the panel
 * list when CoreDevice has never answered, for {@link crossCheckTreeScreen}.
 */
const serverPanels = new Map<string, readonly FoldablePanel[]>();

/** Test-only: forget every memoized answer and the resolved developer dir. */
export function __resetFoldableStateForTests(): void {
  cache.clear();
  failedReadAt.clear();
  serverPanels.clear();
  developerDirPromise = null;
}

/** The last answer read for `udid`, or undefined when it was never read. */
export function getCachedActiveScreen(udid: string): ActiveScreenState | undefined {
  return cache.get(udid);
}

/** Drop the memo, e.g. when the simulator-server that used it is disposed. */
export function forgetActiveScreen(udid: string): void {
  cache.delete(udid);
  failedReadAt.delete(udid);
  serverPanels.delete(udid);
}

/** Record the panels a foldable's simulator-server reported as it attached. */
export function rememberServerPanels(udid: string, panels: readonly FoldablePanel[]): void {
  serverPanels.set(udid, panels);
}

/**
 * The screen a command for `udid` should name: the memoized active panel, or
 * the main screen when nothing was ever read (or the last read failed).
 */
export function activeScreenOrMain(udid: string): number {
  return cache.get(udid)?.activeScreen ?? MAIN_SCREEN_ID;
}

/**
 * The screen a touch or wheel names. The memo, when there is one. When there
 * is none — the read a simulator-server makes as it attaches failed, and
 * nothing has read since — the touch asks CoreDevice itself, so a device left
 * open is not driven on its dark cover panel for as long as nothing else
 * happens to read. A wedged CoreDevice is asked again no more than once per
 * {@link READ_RETRY_AFTER_MS}; in between, the main screen.
 */
export async function activeScreenForCommand(udid: string): Promise<number> {
  const cached = cache.get(udid);
  if (cached) return cached.activeScreen;
  const failedAt = failedReadAt.get(udid);
  if (failedAt !== undefined && Date.now() - failedAt < READ_RETRY_AFTER_MS) return MAIN_SCREEN_ID;
  return (await refreshActiveScreen(udid))?.activeScreen ?? MAIN_SCREEN_ID;
}

let developerDirPromise: Promise<string | undefined> | null = null;

/**
 * `DEVELOPER_DIR` for the query: CoreDevice's binary is shared by every Xcode
 * on the machine and needs to be told which one is selected. Resolved once per
 * process from `xcode-select -p`; an explicit `DEVELOPER_DIR` wins.
 */
function developerDir(): Promise<string | undefined> {
  if (process.env.DEVELOPER_DIR) return Promise.resolve(process.env.DEVELOPER_DIR);
  if (!developerDirPromise) {
    developerDirPromise = execFileAsync("xcode-select", ["-p"], { timeout: 5_000 })
      .then(({ stdout }) => stdout.trim() || undefined)
      .catch(() => undefined);
  }
  return developerDirPromise;
}

interface DevicectlDisplay {
  active?: boolean;
  displayId?: number;
  nativeSize?: [number, number];
  type?: Record<string, unknown>;
}

interface DevicectlDisplaysPayload {
  result?: {
    displays?: DevicectlDisplay[];
    orientation?: { currentDeviceOrientation?: string };
  };
}

/**
 * Parse `devicectl device info displays --json-output -`. Exported for the
 * unit tests; the shape is CoreDevice's, so a display missing an id or a size
 * is skipped rather than guessed at.
 */
export function parseDisplaysPayload(json: unknown, readAt = Date.now()): ActiveScreenState | null {
  const displays = (json as DevicectlDisplaysPayload)?.result?.displays;
  if (!Array.isArray(displays)) return null;
  const panels: FoldablePanel[] = [];
  let activeScreen: number | undefined;
  for (const d of displays) {
    if (typeof d?.displayId !== "number") continue;
    // `type` is `{ integrated: {} }` for a built-in panel; tvOut / carPlay /
    // scene surfaces are not panels.
    if (!d.type || typeof d.type !== "object" || !("integrated" in d.type)) continue;
    const size = d.nativeSize;
    if (!Array.isArray(size) || size.length !== 2) continue;
    const [width, height] = size;
    if (typeof width !== "number" || typeof height !== "number") continue;
    panels.push({ screenId: d.displayId, width, height });
    if (d.active === true && activeScreen === undefined) activeScreen = d.displayId;
  }
  if (panels.length === 0 || activeScreen === undefined) return null;
  const orientation = (json as DevicectlDisplaysPayload).result?.orientation
    ?.currentDeviceOrientation;
  return {
    activeScreen,
    panels,
    ...(typeof orientation === "string" ? { orientation } : {}),
    readAt,
  };
}

/**
 * One CoreDevice query, uncached. Null on any failure: a missing binary, a
 * timeout, a device CoreDevice does not know, or a payload with no active
 * integrated panel. Callers fall back to the main screen and say so.
 */
export async function queryActiveScreen(udid: string): Promise<ActiveScreenState | null> {
  // A provider's device is keyed by its `ext:` id everywhere in argent, but
  // CoreDevice knows it by the raw UDID.
  const nativeUdid = externalNativeId(udid);
  const args = ["device", "info", "displays", "--device", nativeUdid, "--json-output", "-"];
  const dir = await developerDir();
  const env = dir ? { ...process.env, DEVELOPER_DIR: dir } : process.env;
  // The JSON goes to stdout and the human-readable listing to stderr; only
  // stdout is read.
  const [bin, argv] = fs.existsSync(DEVICECTL_BIN)
    ? [DEVICECTL_BIN, args]
    : ["xcrun", ["devicectl", ...args]];
  try {
    const { stdout } = await execFileAsync(bin, argv, {
      env,
      timeout: DEVICECTL_TIMEOUT_MS,
      killSignal: "SIGKILL",
      maxBuffer: 4 * 1024 * 1024,
    });
    return parseDisplaysPayload(JSON.parse(stdout));
  } catch {
    return null;
  }
}

/**
 * Query and memoize. The memo is only replaced by a successful read, so a
 * transient CoreDevice failure keeps the last known panel rather than snapping
 * every touch back to screen 1; the null return tells the caller to say the
 * read failed. A failure is remembered, so the paths that would otherwise
 * settle for the main screen know to ask again (see
 * {@link activeScreenForCommand} and {@link crossCheckDescribedScreen}).
 */
export async function refreshActiveScreen(udid: string): Promise<ActiveScreenState | null> {
  const state = await queryActiveScreen(udid);
  if (state) {
    cache.set(udid, state);
    failedReadAt.delete(udid);
  } else {
    failedReadAt.set(udid, Date.now());
  }
  return state;
}

/**
 * Re-read the live panel, then answer the screen commands should name: the
 * fresh read, else the memo the failed read left in place, else the main
 * screen. For the callers that pick a panel to capture (a recording start,
 * the preview's stream): a read that fails must not move them off the panel
 * every touch and screenshot still targets.
 */
export async function readActiveScreenOrMain(udid: string): Promise<number> {
  await refreshActiveScreen(udid);
  return activeScreenOrMain(udid);
}

/**
 * Re-read the live panel for a caller that follows it (a recording's poll):
 * the fresh read, else the memo a failed read left in place — the panel every
 * touch and screenshot targets, which a `describe` corrects while CoreDevice
 * does not answer. `fresh` tells the two apart. Null only when there is
 * neither, so the caller stays where it is.
 */
export async function readActiveScreenOrMemo(
  udid: string
): Promise<{ screen: number; fresh: boolean } | null> {
  const state = await refreshActiveScreen(udid);
  if (state) return { screen: state.activeScreen, fresh: true };
  const cached = cache.get(udid);
  return cached ? { screen: cached.activeScreen, fresh: false } : null;
}

/** The screen id of a foldable's inner panel: the one panel that is not the main screen. */
function innerScreenId(panels: readonly FoldablePanel[]): number | undefined {
  return panels.find((p) => p.screenId !== MAIN_SCREEN_ID)?.screenId;
}

/**
 * The panel a foldable renders to after a sweep from a stop (closed or open)
 * to `angle`: the main screen up to {@link COVER_MAX_ANGLE}, the inner panel
 * from {@link INNER_MIN_ANGLE}, and undefined in between (or when the panel
 * list names no inner panel). Says nothing about a sweep that starts anywhere
 * else; see the constants.
 */
export function panelForHingeAngle(
  angle: number,
  panels: readonly FoldablePanel[]
): number | undefined {
  if (angle <= COVER_MAX_ANGLE) return MAIN_SCREEN_ID;
  if (angle >= INNER_MIN_ANGLE) return innerScreenId(panels);
  return undefined;
}

/**
 * After a fold: poll the one-shot until a read satisfies `done`, or the budget
 * runs out. Resolves with the first read that does, else with the last read
 * made — the caller tells the two apart by applying `done` again — and null
 * only when every read failed. Every successful read refreshes the memo, so
 * the state the tools act on is the one last seen, settled or not. An abort
 * ends the wait with what was read so far.
 */
export async function awaitActiveScreen(
  udid: string,
  done: (state: ActiveScreenState) => boolean,
  opts: { timeoutMs?: number; pollMs?: number; signal?: AbortSignal } = {}
): Promise<ActiveScreenState | null> {
  const timeoutMs = opts.timeoutMs ?? SETTLE_TIMEOUT_MS;
  const pollMs = opts.pollMs ?? SETTLE_POLL_MS;
  const deadline = Date.now() + timeoutMs;
  let last: ActiveScreenState | null = null;
  for (;;) {
    const state = await refreshActiveScreen(udid);
    if (state) {
      last = state;
      if (done(state)) return state;
    }
    if (Date.now() + pollMs > deadline) return last;
    if (!(await sleepOrAbort(pollMs, opts.signal))) return last;
  }
}

/**
 * The hold after a fold, for the guest to take input again (see the
 * `INPUT_READY_HOLD_*` constants), polling the one-shot the while. The panel
 * CoreDevice reports can still change under the hold: from closed, a sweep to
 * just past the cover panel's range shows the inner panel for about a second
 * and then returns to the cover, and a memo left on that transient panel
 * would aim the next touch at a panel that went dark. A change restarts the
 * hold, so the state returned is one that stayed put for the whole hold;
 * `maxMs` bounds the restarts. Resolves with the last read, or `initial` when
 * no read succeeded. An abort ends the hold early.
 */
export async function holdActiveScreen(
  udid: string,
  initial: ActiveScreenState | null,
  holdMs: number,
  opts: { maxMs?: number; pollMs?: number; signal?: AbortSignal } = {}
): Promise<ActiveScreenState | null> {
  const pollMs = opts.pollMs ?? SETTLE_POLL_MS;
  const maxMs = opts.maxMs ?? HOLD_MAX_MS;
  const start = Date.now();
  let holdStart = start;
  let last = initial;
  for (;;) {
    const remaining = holdStart + holdMs - Date.now();
    if (remaining <= 0) return last;
    if (!(await sleepOrAbort(Math.min(pollMs, remaining), opts.signal))) return last;
    const state = await refreshActiveScreen(udid);
    if (!state) continue;
    if (last && state.activeScreen !== last.activeScreen && Date.now() - start < maxMs) {
      holdStart = Date.now();
    }
    last = state;
  }
}

/** `cover panel` for the main screen, `inner panel` for any other. */
export function panelName(screenId: number): string {
  return screenId === MAIN_SCREEN_ID ? "cover panel" : "inner panel";
}

/** `screen 3 (inner panel, 2007x2853)` — the size only when a panel list knows it. */
export function screenLabel(screenId: number, panels?: readonly FoldablePanel[]): string {
  const panel = panels?.find((p) => p.screenId === screenId);
  const size = panel ? `, ${panel.width}x${panel.height}` : "";
  return `screen ${screenId} (${panelName(screenId)}${size})`;
}

/**
 * `?screen=<id>` on the MJPEG stream URL for a panel other than the main one.
 * The main screen keeps the bare `stream_ready` URL, byte-identical to what a
 * device that is not foldable streams.
 */
export function streamUrlForScreen(streamUrl: string, screenId: number): string {
  if (screenId === MAIN_SCREEN_ID) return streamUrl;
  const separator = streamUrl.includes("?") ? "&" : "?";
  return `${streamUrl}${separator}screen=${screenId}`;
}

/**
 * The note a `describe` carries when the accessibility tree was read on one
 * panel and argent targets another, and the correction that goes with it.
 *
 * The memo is compared first, since a `describe` runs on every interaction
 * and CoreDevice is the cost this module exists to avoid paying twice. A memo
 * that disagrees is re-read once: a fold made outside argent (Device Hub)
 * leaves a stale memo, and the fresh read both fixes it and agrees with the
 * tree. A fresh read that still disagrees is the one case worth a note: a
 * describe issued mid-fold, where the two sides briefly differ.
 *
 * An empty memo is re-read too when a read has failed before — a
 * simulator-server attached while CoreDevice was not answering — since until
 * something reads, every touch goes to the main screen. When CoreDevice still
 * does not answer, the panel the daemon read the tree on is the best word
 * there is on which panel is live, and the memo takes it, so the touches that
 * follow go where the frames are.
 *
 * Undefined when there is no memo and nothing has tried to read one: without a
 * simulator-server for the device nothing has targeted a panel, so there is
 * nothing to disagree with.
 */
export async function crossCheckDescribedScreen(
  udid: string,
  describedScreen: number
): Promise<string | undefined> {
  const cached = cache.get(udid);
  if (cached?.activeScreen === describedScreen) return undefined;
  if (!cached && !failedReadAt.has(udid)) return undefined;
  const fresh = await refreshActiveScreen(udid);
  if (fresh) {
    if (fresh.activeScreen === describedScreen) return undefined;
    return (
      `The accessibility tree was read on ${screenLabel(describedScreen, fresh.panels)}, but ` +
      `CoreDevice reports ${screenLabel(fresh.activeScreen, fresh.panels)} as the panel the device ` +
      `renders to, so the frames above and the panel argent taps disagree — the device is probably ` +
      `mid-fold. Call await-screen-idle, then describe again before tapping.`
    );
  }
  const panels = cached?.panels ?? [];
  cache.set(udid, { activeScreen: describedScreen, panels, readAt: Date.now() });
  failedReadAt.delete(udid);
  return (
    `CoreDevice did not report which panel this foldable simulator renders to; commands now target ` +
    `${screenLabel(describedScreen, panels)}, the panel this tree was read on.`
  );
}

/**
 * The flow tree's counterpart of {@link crossCheckDescribedScreen}. A flow
 * reads the app's own view hierarchy, which names no panel, but it reports the
 * size of the screen the app's windows are on, in the screen's fixed
 * orientation — and a foldable's panels differ in shape (the Duo's cover panel
 * is 466x678 pt, its inner panel 669x951). A tree whose screen has the shape of
 * one panel while the memo names another was read after a fold made outside
 * argent (Device Hub), and without this every touch of the flow would go to
 * the panel that went dark. So the memo is re-read, or, while CoreDevice does
 * not answer, set to the panel of the tree's shape: the one the app renders to.
 *
 * An empty memo left by a failed read — a simulator-server attached while
 * CoreDevice was not answering, so every touch goes to the main screen — is
 * treated the same way, with the panel list that server reported.
 *
 * Costs nothing while the two agree, which is every read but the first after
 * such a fold. Leaves the memo alone when nothing has tried to read it (no
 * simulator-server targets a panel yet), and when the shape matches no panel,
 * or more than one.
 */
export async function crossCheckTreeScreen(udid: string, screen: Size): Promise<void> {
  const cached = cache.get(udid);
  if (!cached && !failedReadAt.has(udid)) return;
  const panels = cached?.panels ?? serverPanels.get(udid) ?? [];
  const shaped = panels.filter((p) => sameAspect(screen, p));
  if (shaped.length !== 1) return;
  const treeScreen = shaped[0].screenId;
  if (treeScreen === cached?.activeScreen) return;
  if (await refreshActiveScreen(udid)) return;
  cache.set(udid, { activeScreen: treeScreen, panels: [...panels], readAt: Date.now() });
  failedReadAt.delete(udid);
}

interface Size {
  width: number;
  height: number;
}

/** Aspect of two sizes within half a percent: the same panel at some scale. */
function sameAspect(a: Size, b: Size): boolean {
  if (a.width <= 0 || a.height <= 0 || b.width <= 0 || b.height <= 0) return false;
  return Math.abs(a.width / a.height - b.width / b.height) < 0.005;
}

/**
 * The posture that produced a capture of `size`, for the aspect-mismatch
 * message of the visual tools: `the cover panel (closed)` or `the inner panel
 * (half-open or open)`. Undefined when the size matches no panel.
 */
function postureForSize(size: Size, panels: readonly FoldablePanel[]): string | undefined {
  const panel = panels.find((p) => sameAspect(size, p));
  if (!panel) return undefined;
  return panel.screenId === MAIN_SCREEN_ID
    ? "the cover panel (closed)"
    : "the inner panel (half-open or open)";
}

/**
 * The sentence the visual tools add to their aspect-mismatch failure on a
 * foldable simulator: baselines are per posture, and here is which posture
 * produced each size. Undefined for any device that is not foldable, so the
 * message is unchanged everywhere else.
 *
 * The panel list comes from the memo when there is one and from a single
 * CoreDevice read otherwise (the pure-PNG diff of a foldable's screenshots
 * touches no simulator-server, so nothing memoized it).
 */
export async function foldablePostureHint(
  udid: string,
  expected: Size,
  actual: Size
): Promise<string | undefined> {
  if (!(await isFoldableSimulator(udid))) return undefined;
  const panels = (cache.get(udid) ?? (await refreshActiveScreen(udid)))?.panels;
  const base =
    "This simulator is foldable: a baseline belongs to the posture that produced it, and the " +
    "cover and inner panels differ in size, so a capture in another posture can never match.";
  if (!panels) return `${base} Take the baseline in the posture under test.`;
  const from = postureForSize(expected, panels);
  const to = postureForSize(actual, panels);
  if (!from || !to) return `${base} Take the baseline in the posture under test.`;
  return (
    `${base} ${expected.width}x${expected.height} is ${from}; ${actual.width}x${actual.height} is ` +
    `${to}. Fold the device to the baseline's posture with the fold tool, or take a baseline ` +
    `for this posture.`
  );
}
