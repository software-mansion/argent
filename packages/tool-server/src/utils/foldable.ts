import { execFile } from "node:child_process";
import * as fs from "node:fs";
import { promisify } from "node:util";
import { externalNativeId } from "./external-devices";
import { isFoldableSimulator } from "./ios-devices";
import { settleWithin, sleepOrAbort } from "./timing";

const execFileAsync = promisify(execFile);

/**
 * Which panel of a foldable simulator argent captures and touches.
 *
 * The simulator-server captures every panel and follows none: each screenshot,
 * stream, touch and wheel names the CoreSimulator screen it is for (1 is the
 * cover panel, 3 the inner one on the iPhone Duo) and gets screen 1 when it
 * names none. Which panel the guest renders to is argent's to find out, and it
 * finds out at the moment of each action: nothing here remembers an answer, so
 * nothing can be stale, whoever moved the hinge.
 *
 * {@link resolveLivePanel} asks two sources in turn:
 *
 * 1. The ax-service, the daemon the `describe` tool reads the accessibility
 *    tree through. Its `live_panel` command names the display the front app's
 *    window is on — the same panel it reads a tree on — in a few milliseconds,
 *    without walking the tree. A device whose daemon is not running yet gets
 *    it started, as a describe would.
 * 2. One CoreDevice query, `devicectl device info displays`, which reports
 *    the panel that is lit, in about 100 ms.
 *
 * Both agree in every posture and foreground state measured on the Duo (an
 * app in front, the home screen, a system app); the ax-service sees a
 * hand-over about 180 ms earlier. When neither answers, the answer is the
 * main screen with the reason, and the caller says so.
 *
 * Each source has a hard timeout, and a read in flight is shared by everyone
 * who asks for the same device meanwhile, so a gesture and the capture right
 * after it, or a recording's poll and a touch, cost one read. There is no
 * memo, no record of which source failed, no back-off and no retry in the
 * background: every action walks the chain from the start.
 */

/** The screen every simulator has and every command defaults to. */
export const MAIN_SCREEN_ID = 1;

export interface FoldablePanel {
  screenId: number;
  /** Native pixel size of the panel. */
  width: number;
  height: number;
}

/**
 * The panel the device renders to, and which source said so. `unknown` is the
 * fall-back to the main screen when neither source answered; `reason` says why,
 * for the warning the caller carries.
 */
export type LivePanel =
  | { screen: number; source: "ax-service" | "coredevice" }
  | { screen: typeof MAIN_SCREEN_ID; source: "unknown"; reason: string };

/**
 * What the ax-service offers this module: its `live_panel` command, answering
 * the display id of the live panel, or null when the daemon cannot name one.
 */
interface LivePanelSource {
  livePanel(): Promise<number | null>;
}

/**
 * How long the ax-service gets to answer `live_panel`. A healthy daemon
 * answers in a few milliseconds; the budget also covers starting a daemon
 * that is not running yet. A daemon that hangs costs every touch this much
 * before CoreDevice is asked instead — accepted, and said in the reason.
 */
export const AX_LIVE_PANEL_TIMEOUT_MS = 2_000;

/**
 * How long one CoreDevice query may take. Measured at ~100 ms on the Duo; the
 * budget is for a CoreDevice that is not answering, not for normal latency.
 */
export const DEVICECTL_TIMEOUT_MS = 5_000;

/**
 * The hand-over lands 1.5-2 s after a hinge sweep, longer when the guest is
 * busy. After a fold the live panel is polled until it is the panel the sweep
 * implies: `HAND_OVER_TIMEOUT_MS` bounds that wait, and `SETTLE_TIMEOUT_MS`
 * the wait for a sweep whose outcome is not predicted, where the panel may
 * legitimately stay.
 */
export const HAND_OVER_TIMEOUT_MS = 6_000;
export const SETTLE_TIMEOUT_MS = 3_000;
const SETTLE_POLL_MS = 200;

/**
 * How long the guest takes to accept input again after a hinge sweep, counted
 * from the read that first reports the panel it settled on. Measured on the
 * iPhone Duo (iOS 27.1) with taps fired every ~150 ms, against CoreDevice: a
 * sweep that ends at a stop — closed (0°) or open (180°) — takes input within
 * ~250 ms of that read, with or without a hand-over, while one that ends at
 * any other angle (half-open included, and 30° on the cover panel) drops
 * every tap for 0.4-0.8 s more, up to ~1.2 s after the sweep, again whether
 * or not the panel changed. The ax-service, the usual source now, reports a
 * hand-over about 180 ms before CoreDevice does, so the holds carry that much
 * more. The fold tool holds the matching time before it answers, so the next
 * command lands.
 */
export const INPUT_READY_HOLD_MS = 700;
export const INPUT_READY_HOLD_MID_ANGLE_MS = 1_700;
/**
 * The hold restarts when the panel changes under it (see
 * {@link holdLivePanel}); this bounds the restarts, so a panel that keeps
 * flapping still gets an answer.
 */
const HOLD_MAX_MS = 5_000;

/**
 * The least a bounded read is waited for (see {@link readWithin}): a healthy
 * read answers within a few hundred ms at most, so a wait's last read still
 * gets to answer when the budget has almost run out, while sources that are
 * not answering cost a wait at most this much past its budget.
 */
const READ_GRACE_MS = 500;

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
 * fold tool predicts nothing for those and reports what it reads.
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

/** The read of a device now in flight, shared by every caller until it lands. */
const inFlight = new Map<string, Promise<LivePanel>>();

let axServiceFor: ((udid: string) => Promise<LivePanelSource>) | undefined;

/**
 * Wire the ax-service in: how to reach the daemon of a device, starting it
 * when it is not running. Set once when the registry is built, since the
 * daemon is a registry service and this module is not; a test sets a fake, or
 * nothing, which leaves CoreDevice as the one source.
 */
export function setLivePanelSourceProvider(
  provider: ((udid: string) => Promise<{ livePanel(): Promise<number | null> }>) | undefined
): void {
  axServiceFor = provider;
}

/** Test-only: drop the reads in flight and the resolved developer dir. */
export function __resetFoldableStateForTests(): void {
  inFlight.clear();
  developerDirPromise = null;
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
  backlightState?: string;
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
 * Whether a display is lit, by its `backlightState`: `activeOn`, `inactiveOn`
 * and `activeDimmed` are lit, `off` is dark, anything else is not known.
 */
function backlit(d: DevicectlDisplay): boolean | undefined {
  switch (d.backlightState) {
    case "activeOn":
    case "inactiveOn":
    case "activeDimmed":
      return true;
    case "off":
      return false;
    default:
      return undefined;
  }
}

/**
 * Parse `devicectl device info displays --json-output -`. Exported for the
 * unit tests; the shape is CoreDevice's, so a display missing an id or a size
 * is skipped rather than guessed at.
 *
 * The lit panel is told from `backlightState`, which every device reports (a
 * regular iPhone reports no `active` at all). `active` breaks the tie when
 * that does not decide: for about 200 ms around a hand-over the Duo reports
 * both panels `activeOn` with `active` already moved, and a panel whose
 * backlight state is not known is taken on `active` alone.
 */
export function parseDisplaysPayload(json: unknown): {
  activeScreen: number;
  panels: FoldablePanel[];
  orientation?: string;
} | null {
  const displays = (json as DevicectlDisplaysPayload)?.result?.displays;
  if (!Array.isArray(displays)) return null;
  const panels: FoldablePanel[] = [];
  const lit: number[] = [];
  const flagged: number[] = [];
  let knownBacklight = false;
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
    const on = backlit(d);
    if (on !== undefined) knownBacklight = true;
    if (on) lit.push(d.displayId);
    if (d.active === true) flagged.push(d.displayId);
  }
  if (panels.length === 0) return null;
  let activeScreen: number | undefined;
  if (lit.length === 1) activeScreen = lit[0];
  else if (lit.length > 1) activeScreen = flagged.find((id) => lit.includes(id));
  else if (!knownBacklight && flagged.length === 1) activeScreen = flagged[0];
  if (activeScreen === undefined) return null;
  const orientation = (json as DevicectlDisplaysPayload).result?.orientation
    ?.currentDeviceOrientation;
  return {
    activeScreen,
    panels,
    ...(typeof orientation === "string" ? { orientation } : {}),
  };
}

/** The first line of an error, for a reason a warning quotes. */
function firstLine(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.split("\n")[0]?.trim() || "unknown error";
}

/**
 * One CoreDevice query. Null, with the reason, on any failure: a missing
 * binary, a timeout, a device CoreDevice does not know, or a payload with no
 * lit integrated panel.
 */
export async function readCoreDeviceDisplays(udid: string): Promise<{
  displays: { activeScreen: number; panels: FoldablePanel[]; orientation?: string } | null;
  reason?: string;
}> {
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
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(bin, argv, {
      env,
      timeout: DEVICECTL_TIMEOUT_MS,
      killSignal: "SIGKILL",
      maxBuffer: 4 * 1024 * 1024,
    }));
  } catch (err) {
    const timedOut = (err as { killed?: boolean; signal?: string })?.signal === "SIGKILL";
    return {
      displays: null,
      reason: timedOut
        ? `CoreDevice did not answer within ${DEVICECTL_TIMEOUT_MS / 1000} s`
        : `CoreDevice failed (${firstLine(err)})`,
    };
  }
  let payload: unknown;
  try {
    payload = JSON.parse(stdout);
  } catch {
    return { displays: null, reason: "CoreDevice answered something that is not JSON" };
  }
  const displays = parseDisplaysPayload(payload);
  if (!displays) return { displays: null, reason: "CoreDevice reported no lit integrated panel" };
  return { displays };
}

/** Ask the ax-service; the display id, or the reason it gave none. */
async function askAxService(udid: string): Promise<number | string> {
  if (!axServiceFor) return "no accessibility service is wired in";
  const provider = axServiceFor;
  const settled = await settleWithin(
    Promise.resolve().then(() => provider(udid).then((source) => source.livePanel())),
    AX_LIVE_PANEL_TIMEOUT_MS
  );
  switch (settled.type) {
    case "value":
      return settled.value ?? "the accessibility service could not name the panel";
    case "timeout":
      return `the accessibility service did not answer within ${AX_LIVE_PANEL_TIMEOUT_MS / 1000} s`;
    case "error":
      return `the accessibility service failed (${firstLine(settled.cause)})`;
    case "aborted":
      return "the accessibility service read was aborted";
  }
}

async function resolveLivePanelUncached(udid: string): Promise<LivePanel> {
  const ax = await askAxService(udid);
  if (typeof ax === "number") return { screen: ax, source: "ax-service" };
  const { displays, reason } = await readCoreDeviceDisplays(udid);
  if (displays) return { screen: displays.activeScreen, source: "coredevice" };
  return { screen: MAIN_SCREEN_ID, source: "unknown", reason: `${ax}; ${reason}` };
}

/**
 * The panel the device renders to, right now: the ax-service's answer, else
 * CoreDevice's, else the main screen with the reason (see the module
 * comment). One read per device at a time: a caller that asks while one is
 * in flight shares its answer, so a source that is not answering has at most
 * one query hanging on it per device, whatever polls.
 */
export function resolveLivePanel(udid: string): Promise<LivePanel> {
  const pending = inFlight.get(udid);
  if (pending) return pending;
  const read = resolveLivePanelUncached(udid).finally(() => {
    if (inFlight.get(udid) === read) inFlight.delete(udid);
  });
  inFlight.set(udid, read);
  return read;
}

/**
 * The sentence a result carries when the live panel could not be resolved:
 * what was tried, what the commands target meanwhile, and what to check.
 */
export function unresolvedPanelNote(
  udid: string,
  reason: string,
  what: string,
  panels?: readonly FoldablePanel[]
): string {
  return (
    `The panel this foldable simulator renders to could not be resolved (${reason}), so ${what} ` +
    `${screenLabel(MAIN_SCREEN_ID, panels)}. Check that the simulator is booted and responsive: ` +
    `\`describe\` starts the accessibility service, and \`xcrun devicectl device info displays ` +
    `--device ${externalNativeId(udid)}\` shows what CoreDevice answers.`
  );
}

/**
 * One read, waited for no longer than `budgetMs` (but at least
 * {@link READ_GRACE_MS}) or until an abort: the panel, or null when nothing
 * resolved it or the wait ran out first. A read that outlasts the wait is not
 * cut short — a caller that asks meanwhile shares it — the caller only stops
 * waiting. For the fold tool's waits, whose budgets are wall clock even when
 * both sources take their whole timeouts to fail.
 */
async function readWithin(
  udid: string,
  budgetMs: number,
  signal?: AbortSignal
): Promise<LivePanel | null> {
  if (signal?.aborted) return null;
  const read = await settleWithin(
    resolveLivePanel(udid),
    Math.max(budgetMs, READ_GRACE_MS),
    signal
  );
  if (read.type !== "value" || read.value.source === "unknown") return null;
  return read.value;
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
 * After a fold: poll the live panel until a read satisfies `done`, or the
 * budget runs out. Resolves with the first read that does, else with the last
 * read made — the caller tells the two apart by applying `done` again — and
 * null only when nothing resolved the panel. An abort ends the wait with what
 * was read so far. The budget is wall clock: a read that the sources take
 * their whole timeouts to fail is not waited out past it (see
 * {@link readWithin}).
 */
export async function awaitLivePanel(
  udid: string,
  done: (screen: number) => boolean,
  opts: { timeoutMs?: number; pollMs?: number; signal?: AbortSignal } = {}
): Promise<LivePanel | null> {
  const timeoutMs = opts.timeoutMs ?? SETTLE_TIMEOUT_MS;
  const pollMs = opts.pollMs ?? SETTLE_POLL_MS;
  const deadline = Date.now() + timeoutMs;
  let last: LivePanel | null = null;
  for (;;) {
    const panel = await readWithin(udid, deadline - Date.now(), opts.signal);
    if (panel) {
      last = panel;
      if (done(panel.screen)) return panel;
    }
    if (Date.now() + pollMs > deadline) return last;
    if (!(await sleepOrAbort(pollMs, opts.signal))) return last;
  }
}

/**
 * The hold after a fold, for the guest to take input again (see the
 * `INPUT_READY_HOLD_*` constants), polling the live panel the while. The panel
 * can still change under the hold: from closed, a sweep to just past the
 * cover panel's range shows the inner panel for about a second and then
 * returns to the cover, and an answer taken on that transient panel would aim
 * the next touch at a panel that went dark. A change restarts the hold, so
 * the panel returned is one that stayed put for the whole hold; `maxMs`
 * bounds the restarts. Resolves with the last read, or `initial` when no read
 * succeeded. An abort ends the hold early, and so does the hold's own clock:
 * a read is waited for only as long as the hold has left, plus the grace of
 * {@link readWithin}.
 */
export async function holdLivePanel(
  udid: string,
  initial: LivePanel | null,
  holdMs: number,
  opts: { maxMs?: number; pollMs?: number; signal?: AbortSignal } = {}
): Promise<LivePanel | null> {
  const pollMs = opts.pollMs ?? SETTLE_POLL_MS;
  const maxMs = opts.maxMs ?? HOLD_MAX_MS;
  const start = Date.now();
  let holdStart = start;
  let last = initial;
  for (;;) {
    const remaining = holdStart + holdMs - Date.now();
    if (remaining <= 0) return last;
    if (!(await sleepOrAbort(Math.min(pollMs, remaining), opts.signal))) return last;
    const panel = await readWithin(udid, holdStart + holdMs - Date.now(), opts.signal);
    if (!panel) continue;
    if (last && panel.screen !== last.screen && Date.now() - start < maxMs) {
      holdStart = Date.now();
    }
    last = panel;
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
 * The panel list comes from one CoreDevice read (the pure-PNG diff of a
 * foldable's screenshots touches no simulator-server, which is where argent
 * otherwise has it); a read that fails leaves the postures unnamed.
 */
export async function foldablePostureHint(
  udid: string,
  expected: Size,
  actual: Size
): Promise<string | undefined> {
  if (!(await isFoldableSimulator(udid))) return undefined;
  const panels = (await readCoreDeviceDisplays(udid)).displays?.panels;
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
