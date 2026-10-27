import { z } from "zod";
import type {
  DeviceInfo,
  Registry,
  ServiceRef,
  ToolCapability,
  ToolContext,
  ToolDefinition,
} from "@argent/registry";
import { chromiumCdpRef, type ChromiumCdpApi } from "../../blueprints/chromium-cdp";
import { resolveDevice, harmonyConnectKey } from "../../utils/device-info";
import { isTvOsSimulator } from "../../utils/ios-devices";
import { isAndroidTv } from "../../utils/adb";
import { assertSupported } from "../../utils/capability";
import { ensureDeps } from "../../utils/check-deps";
import { pollDescribeTree } from "../../utils/poll-describe-tree";
import type { DescribeNode, DescribeTreeData } from "../describe/contract";
import { describeIos, iosRequires } from "../describe/platforms/ios";
import { describeIosDevice } from "../describe/platforms/ios-device";
import { describeAndroid, androidRequires } from "../describe/platforms/android";
import { describeChromium } from "../describe/platforms/chromium";
import { pollHarmonyTree, harmonyRequires } from "../describe/platforms/harmony";

const AWAIT_SCREEN_IDLE_TOOL_ID = "await-screen-idle";

const DEFAULT_TIMEOUT_MS = 3000;
const DEFAULT_POLL_INTERVAL_MS = 200;
const DEFAULT_MIN_STABLE_MS = 250;

const zodSchema = z
  .object({
    udid: z
      .string()
      .min(1)
      .describe(
        "Target device id from `list-devices` (iOS UDID, Android serial, <flag:harmonyos>HarmonyOS id, </flag:harmonyos>or Chromium id)."
      ),
    timeoutMs: z
      .number()
      .int()
      .positive()
      .max(120_000)
      .optional()
      .describe(
        `Max time to wait for the screen to settle before giving up (default ${DEFAULT_TIMEOUT_MS}).`
      ),
    pollIntervalMs: z
      .number()
      .int()
      .min(50)
      .max(5000)
      .optional()
      .describe(`How often to re-read the tree (default ${DEFAULT_POLL_INTERVAL_MS}).`),
    minStableMs: z
      .number()
      .int()
      .min(0)
      .max(10_000)
      .optional()
      .describe(
        `The screen must hold the same content for at least this long to count as settled (default ${DEFAULT_MIN_STABLE_MS}). On the ambient-motion path, the elements must hold the same structure this long and every element that moved in that time must be a loop.`
      ),
  })
  .strict();

type Params = z.infer<typeof zodSchema>;

interface IdleResult {
  /**
   * Screen rendered content and went still before the timeout, or, with
   * `ambientMotion`, held its structure while only looping animations moved.
   */
  settled: boolean;
  waitedMs: number;
  polls: number;
  /**
   * Settled although some elements are still moving: only looping animations
   * (a bobbing coach mark, a pulsing badge) were left, which never go still.
   * A spinner the tree does not mark as a progress indicator counts too, so
   * check for the destination content before trusting the screen is loaded.
   */
  ambientMotion?: true;
  /** Why what it settled on may not be the live screen. */
  note?: string;
}

const capability: ToolCapability = {
  apple: { simulator: true, device: true },
  appleRemote: { simulator: true },
  android: { emulator: true, device: true, unknown: true },
  chromium: { app: true },
  harmony: { device: true },
};

// Frames are normalized 0..1, so rounding to 0.01 tolerates sub-pixel jitter
// while still catching real motion (a slide/fade animation).
function treeSignature(root: DescribeNode): string {
  const round = (n: number) => Math.round(n * 100) / 100;
  const parts: string[] = [];
  const walk = (node: DescribeNode): void => {
    const f = node.frame;
    parts.push(
      `${node.role}|${node.label ?? ""}|${node.value ?? ""}|${round(f.x)},${round(f.y)},${round(f.width)},${round(f.height)}`
    );
    for (const child of node.children) walk(child);
  };
  for (const child of root.children) walk(child);
  return parts.join("\n");
}

type Box = [number, number, number, number];

function overlaps(a: number[], b: number[]): boolean {
  const [ax, ay, aw, ah] = a as Box;
  const [bx, by, bw, bh] = b as Box;
  return ax < bx + bw && bx < ax + aw && ay < by + bh && by < ay + ah;
}

/**
 * Two overlapping boxes of one size: one node the AX service listed twice
 * because it moved between its two collection passes.
 */
function listedTwice(boxes: number[][]): boolean {
  if (boxes.length !== 2) return false;
  const [a, b] = boxes as [Box, Box];
  const round = (n: number) => Math.round(n * 100) / 100;
  return round(a[2]) === round(b[2]) && round(a[3]) === round(b[3]) && overlaps(a, b);
}

function nearest(boxes: number[][], target: number[]): number[] {
  const distance = (box: number[]) => box.reduce((sum, v, i) => sum + Math.abs(v - target[i]!), 0);
  return boxes.reduce((best, box) => (distance(box) < distance(best) ? box : best));
}

/**
 * Frame of every node whose role/label/value is unique on the screen, keyed by
 * that identity, plus the structure the identities and their counts form.
 * Nodes that share an identity (grid cells, list rows) cannot be followed from
 * read to read, so they are kept as one list of frames per identity. A
 * followed node that has moved since the structure last changed and is listed
 * twice keeps the listing nearest its last frame.
 */
function frameSnapshot(
  root: DescribeNode,
  lastRaw: Map<string, number[]>,
  moved: Set<string>
): {
  structure: string;
  frames: Map<string, number[]>;
  raw: Map<string, number[]>;
  shared: Map<string, number[][]>;
} {
  const round = (n: number) => Math.round(n * 100) / 100;
  const byIdentity = new Map<string, DescribeNode[]>();
  const walk = (node: DescribeNode): void => {
    const id = `${node.role}|${node.label ?? ""}|${node.value ?? ""}`;
    byIdentity.set(id, [...(byIdentity.get(id) ?? []), node]);
    for (const child of node.children) walk(child);
  };
  for (const child of root.children) walk(child);

  const frames = new Map<string, number[]>();
  const raw = new Map<string, number[]>();
  const shared = new Map<string, number[][]>();
  const counts: string[] = [];
  for (const [id, nodes] of byIdentity) {
    const boxes = nodes.map(({ frame: f }) => [f.x, f.y, f.width, f.height]);
    const last = lastRaw.get(id);
    const followAsOne = last && moved.has(id) && listedTwice(boxes);
    const box = boxes.length === 1 ? boxes[0] : followAsOne && nearest(boxes, last);
    if (box) {
      raw.set(id, box);
      frames.set(id, box.map(round));
      counts.push(`${id}#1`);
    } else {
      shared.set(id, boxes);
      counts.push(`${id}#${boxes.length}`);
    }
  }
  return { structure: counts.sort().join("\n"), frames, raw, shared };
}

interface SharedMove {
  box: number[];
  /** Every frame the node's identity had on the read before. */
  before: number[][];
}

/** Where nodes that share an identity moved to between two reads. */
function movedSharedBoxes(
  prev: Map<string, number[][]>,
  next: Map<string, number[][]>
): SharedMove[] {
  const key = (box: number[]) => box.map((v) => Math.round(v * 100) / 100).join(",");
  const moved: SharedMove[] = [];
  for (const [id, boxes] of next) {
    const before = prev.get(id) ?? [];
    const seen = new Set(before.map(key));
    for (const box of boxes) if (!seen.has(key(box))) moved.push({ box, before });
  }
  return moved;
}

/**
 * Looping animations allowed to keep moving on a settled screen. Elements that
 * move together count as one animation.
 */
const MAX_AMBIENT_MOVERS = 3;

/**
 * Poll intervals a node must keep swinging, counted from its first turn, before
 * it counts as a loop. A one-time spin or shake swings at a constant amplitude
 * too, but ends within about a second.
 */
const MIN_LOOP_POLLS = 7;

/** Roles of a progress bar or spinner on Chromium, Android and iOS devices. */
const PROGRESS_ROLE = /progress|activityindicator/i;

function showsProgressIndicator(node: DescribeNode): boolean {
  return node.children.some(
    (child) => PROGRESS_ROLE.test(child.role) || showsProgressIndicator(child)
  );
}

interface AxisMotion {
  /** Last non-zero direction; 0 while the axis never moved. */
  sign: number;
  /** Values where the axis last turned around, oldest first. */
  turns: number[];
  /** When the axis first turned since its turns were last cleared. */
  swingSince: number;
  /** Widest distance between two turns in a row since `swingSince`. */
  widestSwing: number;
  lastMovedAt: number;
}

function newAxis(): AxisMotion {
  return { sign: 0, turns: [], swingSince: Infinity, widestSwing: 0, lastMovedAt: -Infinity };
}

/** Frames are rounded to this step. */
const ROUND_STEP = 0.01;

/** Absorbs floating point error in differences of rounded values (0.39 - 0.38). */
const FLOAT_SLACK = 1e-9;

/**
 * How far a turn may land from the matching earlier turn and still repeat the
 * swing: a quarter of the swing, absorbing where the polls happen to sample a
 * cycle, and at least the rounding step.
 */
function swingTolerance(turns: number[]): number {
  const [a, b] = turns.slice(-3);
  return Math.max(ROUND_STEP, 0.25 * Math.abs(b! - a!)) + FLOAT_SLACK;
}

/**
 * Share of its widest swing a loop keeps. A very bouncy spring repeats each
 * swing within the tolerance above, but has lost most of its swing by the time
 * it has rung for `MIN_LOOP_POLLS`.
 */
const MIN_SWING_KEPT = 0.75;

function swingHolds(axis: AxisMotion): boolean {
  const [b, c] = axis.turns.slice(-2);
  const swing = Math.abs(c! - b!);
  // Rounding can shift each end of both swings by half a step.
  const roundingSlack = 2 * ROUND_STEP;
  return swing >= MIN_SWING_KEPT * axis.widestSwing - roundingSlack - FLOAT_SLACK;
}

/**
 * The axis swung out and back and turned again where it turned two turns ago,
 * as a bob or a pulse does. One-time motion that reverses (an overshoot, a
 * decaying spring or bounce, a jump back on reload) does not repeat its swing.
 */
function swingRepeats(axis: AxisMotion): boolean {
  if (axis.turns.length < 3) return false;
  const [a, , c] = axis.turns.slice(-3);
  return Math.abs(c! - a!) <= swingTolerance(axis.turns);
}

function insideSwing(axis: AxisMotion, value: number): boolean {
  const recent = axis.turns.slice(-3);
  const tolerance = swingTolerance(axis.turns);
  return value >= Math.min(...recent) - tolerance && value <= Math.max(...recent) + tolerance;
}

function trackAxis(axis: AxisMotion, from: number, to: number, nowMs: number): void {
  const sign = Math.sign(to - from);
  if (sign === 0) return;
  // An axis coming to rest (a diagonal ease-out whose smaller axis stops first)
  // keeps its last direction, so only a real sign flip is a turn.
  if (axis.sign !== 0 && axis.sign !== sign) {
    if (axis.turns.length === 0) axis.swingSince = nowMs;
    const lastTurn = axis.turns.at(-1);
    if (lastTurn !== undefined) {
      axis.widestSwing = Math.max(axis.widestSwing, Math.abs(from - lastTurn));
    }
    axis.turns = [...axis.turns, from].slice(-3);
  }
  if (swingRepeats(axis) && !insideSwing(axis, to)) {
    axis.turns = [];
    axis.swingSince = Infinity;
    axis.widestSwing = 0;
  }
  axis.sign = sign;
  axis.lastMovedAt = nowMs;
}

/**
 * How far two nodes' per-poll moves may differ and still count as one motion.
 * AX frames snap to whole points or pixels, so children of one bobbing view
 * report moves that differ by about a point, or move one read late.
 */
const SYNC_TOLERANCE = 0.005;

const STILL = [0, 0, 0, 0];

function movesInSync(a: number[][], b: number[][], polls: number): boolean {
  for (let poll = 1; poll <= polls; poll++) {
    const da = a[poll] ?? STILL;
    const db = b[poll] ?? STILL;
    if (da.some((v, i) => Math.abs(v - db[i]!) > SYNC_TOLERANCE)) return false;
  }
  return true;
}

function encloses(outer: number[], inner: number[]): boolean {
  const [ox, oy, ow, oh] = outer as Box;
  const [ix, iy, iw, ih] = inner as Box;
  const slack = ROUND_STEP + FLOAT_SLACK;
  return (
    ix >= ox - slack && iy >= oy - slack && ix + iw <= ox + ow + slack && iy + ih <= oy + oh + slack
  );
}

/** A frame's move from one read to the next. */
type FrameMove = [from: number[], to: number[]];

/** Where `box` lands if it keeps its place within a frame that moves or scales. */
function carriedBy(box: number[], [from, to]: FrameMove): number[] {
  const scaleX = from[2]! > 0 ? to[2]! / from[2]! : 1;
  const scaleY = from[3]! > 0 ? to[3]! / from[3]! : 1;
  return [
    to[0]! + (box[0]! - from[0]!) * scaleX,
    to[1]! + (box[1]! - from[1]!) * scaleY,
    box[2]! * scaleX,
    box[3]! * scaleY,
  ];
}

function closeTo(a: number[], b: number[]): boolean {
  return a.every((v, i) => Math.abs(v - b[i]!) <= SYNC_TOLERANCE);
}

/** The node sits inside or around the moving node and kept its place relative to it. */
function movesWith({ box, before }: SharedMove, mover: FrameMove): boolean {
  const [, moverNow] = mover;
  if (!encloses(moverNow, box) && !encloses(box, moverNow)) return false;
  return before.some((was) => closeTo(carriedBy(was, mover), box));
}

/**
 * Groups `ids` so that every member moves with its group's first member, and
 * stops counting once there are more than `max` groups.
 */
function countGroups(
  ids: string[],
  together: (a: string, b: string) => boolean,
  max: number
): number {
  const leaders: string[] = [];
  for (const id of ids) {
    if (leaders.some((leader) => together(leader, id))) continue;
    leaders.push(id);
    if (leaders.length > max) break;
  }
  return leaders.length;
}

/**
 * Tracks which nodes keep moving while the tree structure holds, and whether
 * every recent mover is a loop. A one-time transition that has stopped drops
 * out of the recent movers once it has held still for the window.
 */
class AmbientMotion {
  private structure: string | undefined;
  private structureSince = 0;
  private lastFrames = new Map<string, number[]>();
  private lastRaw = new Map<string, number[]>();
  private lastShared = new Map<string, number[][]>();
  /** Frames that moved on the last read. */
  private lastMoves: FrameMove[] = [];
  /** Last read where a node that shares its identity moved without a moving node carrying it. */
  private sharedMovedAt = -Infinity;
  private readonly motion = new Map<string, AxisMotion[]>();
  /** Unrounded frame change per node, indexed by poll. */
  private readonly moves = new Map<string, number[][]>();
  private polls = 0;

  /** Forget everything, e.g. after a blank read: the next screen starts fresh. */
  reset(): void {
    this.structure = undefined;
    this.structureSince = 0;
    this.lastFrames = new Map();
    this.lastRaw = new Map();
    this.lastShared = new Map();
    this.lastMoves = [];
    this.sharedMovedAt = -Infinity;
    this.motion.clear();
    this.moves.clear();
    this.polls = 0;
  }

  /** Feed one sample; true once only loops have moved for the last `windowMs`. */
  sample(
    root: DescribeNode,
    nowMs: number,
    minStableMs: number,
    windowMs: number,
    minLoopMs: number
  ): boolean {
    const moved = new Set(
      [...this.motion].filter(([, axes]) => axes.some((axis) => axis.sign !== 0)).map(([id]) => id)
    );
    const snap = frameSnapshot(root, this.lastRaw, moved);
    if (snap.structure !== this.structure) {
      this.reset();
      this.structure = snap.structure;
      this.structureSince = nowMs;
      this.lastFrames = snap.frames;
      this.lastRaw = snap.raw;
      this.lastShared = snap.shared;
      return false;
    }
    this.polls += 1;
    const frameMoves: FrameMove[] = [];
    for (const [id, frame] of snap.raw) {
      const prev = this.lastRaw.get(id);
      if (!prev || prev.every((v, i) => v === frame[i])) continue;
      if (!this.moves.has(id)) this.moves.set(id, []);
      this.moves.get(id)![this.polls] = frame.map((v, i) => v - prev[i]!);
      frameMoves.push([prev, frame]);
    }
    this.lastRaw = new Map([...this.lastRaw, ...snap.raw]);
    for (const [id, frame] of snap.frames) {
      const prev = this.lastFrames.get(id);
      if (!prev) continue;
      if (!this.motion.has(id))
        this.motion.set(
          id,
          frame.map(() => newAxis())
        );
      this.motion.get(id)!.forEach((axis, i) => trackAxis(axis, prev[i]!, frame[i]!, nowMs));
    }
    this.lastFrames = new Map([...this.lastFrames, ...snap.frames]);
    const movedRecently = (axis: AxisMotion) => nowMs - axis.lastMovedAt < windowMs;
    const recent = [...this.motion].filter(([, axes]) => axes.some(movedRecently));
    // AX frames of a view's children can move one read after the view does.
    const moverMoves = [...frameMoves, ...this.lastMoves];
    const movesWithAMover = (move: SharedMove) =>
      moverMoves.some((mover) => movesWith(move, mover));
    if (!movedSharedBoxes(this.lastShared, snap.shared).every(movesWithAMover)) {
      this.sharedMovedAt = nowMs;
    }
    this.lastShared = snap.shared;
    this.lastMoves = frameMoves;

    if (nowMs - this.structureSince < minStableMs) return false;
    if (nowMs - this.sharedMovedAt < windowMs) return false;
    if (showsProgressIndicator(root)) return false;
    if (recent.length === 0) return false;
    const keepsLooping = (axis: AxisMotion) =>
      swingRepeats(axis) && swingHolds(axis) && nowMs - axis.swingSince >= minLoopMs;
    const isLoop = (axes: AxisMotion[]) => axes.filter(movedRecently).every(keepsLooping);
    if (!recent.every(([, axes]) => isLoop(axes))) return false;
    const animations = countGroups(
      recent.map(([id]) => id),
      (a, b) => this.oneAnimation(a, b),
      MAX_AMBIENT_MOVERS
    );
    return animations <= MAX_AMBIENT_MOVERS;
  }

  /**
   * Nodes that move rigidly together (a coach mark's container, arrow, text and
   * button), or a node and the moving node it sits inside (a pulsing card and
   * its children), are one animation.
   */
  private oneAnimation(a: string, b: string): boolean {
    const frameA = this.lastFrames.get(a)!;
    const frameB = this.lastFrames.get(b)!;
    if (encloses(frameA, frameB) || encloses(frameB, frameA)) return true;
    return movesInSync(this.moves.get(a) ?? [], this.moves.get(b) ?? [], this.polls);
  }
}

// The MCP layer times its auto-screenshot with this: capture once the screen is
// stable instead of after a fixed delay.
export function createAwaitScreenIdleTool(registry: Registry): ToolDefinition<Params, IdleResult> {
  function fetchTree(
    device: DeviceInfo,
    services: Record<string, unknown>,
    isTvOs: boolean,
    androidIsTv: boolean,
    budgetMs: number
  ): Promise<DescribeTreeData> {
    // ios-remote reads the same AX tree through describeIos: the ax-service
    // blueprint routes it over the sim-remote tunnel, so only the preflight dep
    // differs from the local branch. `isTvOs` is false for it, matching describe.
    if (device.platform === "ios" || device.platform === "ios-remote") {
      // Physical devices poll the same XCUITest runner snapshot as describe.
      if (device.kind === "device") {
        return describeIosDevice(registry, device);
      }
      return describeIos(registry, device, {}, { isTvOs });
    }
    if (device.platform === "android") {
      return describeAndroid(registry, device.id, undefined, androidIsTv);
    }
    if (device.platform === "harmony") {
      return pollHarmonyTree(harmonyConnectKey(device.id), budgetMs);
    }
    return describeChromium(services.chromium as ChromiumCdpApi);
  }

  return {
    id: AWAIT_SCREEN_IDLE_TOOL_ID,
    interaction: {
      startedMsg: () => "Waiting for screen to settle",
      completedMsg: ({ result }) =>
        result.settled ? "Screen settled" : "Screen did not settle before timeout",
      failedMsg: ({ failureSignal }) =>
        `Failed while waiting for screen to settle: ${failureSignal.error_code}`,
    },
    description: `Block until the screen has rendered content and stopped changing, or a timeout elapses.

Polls the same accessibility / DOM tree as \`describe\` every pollIntervalMs (default ${DEFAULT_POLL_INTERVAL_MS}ms) until it
has content and that content holds identical for minStableMs (default ${DEFAULT_MIN_STABLE_MS}ms), or timeoutMs (default
${DEFAULT_TIMEOUT_MS}ms) is reached. Returns { settled, waitedMs, polls<flag:harmonyos>, note?</flag:harmonyos> }; settled=false means the screen never went
still before the timeout. A screen where only up to ${MAX_AMBIENT_MOVERS} looping animations keep moving (a bobbing hint, a
pulsing badge) counts as settled and adds ambientMotion: true; those elements are still moving. A loop counts once it has
swung through a full period and for at least ${MIN_LOOP_POLLS} poll intervals, so a loop slower than about 2s rarely settles
within the default timeout. A progress bar or spinner role on screen turns that path off (the iOS simulator reports no
such role), but an indicator whose frame holds still (an indeterminate bar) settles like any still screen, and so does a
loop that changes a label or value (an animated "Loading..." label) once one step holds for minStableMs. settled=true
does not mean loading finished: confirm the content you expect with await-ui-element. <flag:harmonyos>A note on settled=true
means the screen it settled on is not live: a suspended HarmonyOS panel settles instantly on its last frame, and taps land
nowhere until it is woken.
</flag:harmonyos>Use after a launch/navigation to wait for the UI to render before screenshotting or tapping.`,
    searchHint:
      "wait until screen settles idle stable stops changing animation transition rendered ready before screenshot",
    longRunning: true,
    readOnly: true,
    zodSchema,
    capability,
    services: (params): Record<string, ServiceRef> => {
      const device = resolveDevice(params.udid);
      if (device.platform === "chromium") {
        return { chromium: chromiumCdpRef(device) };
      }
      return {};
    },
    async execute(services, params, ctx?: ToolContext) {
      const device = resolveDevice(params.udid);
      assertSupported(AWAIT_SCREEN_IDLE_TOOL_ID, capability, device);
      if (device.platform === "ios") await ensureDeps(iosRequires);
      else if (device.platform === "ios-remote") await ensureDeps(["sim-remote"]);
      else if (device.platform === "android") await ensureDeps(androidRequires);
      else if (device.platform === "harmony") await ensureDeps(harmonyRequires);

      // Resolve tvOS / Android-TV once. Physical devices skip the tvOS probe. They are never tvOS simulators.
      const isTvOs =
        device.platform === "ios" && device.kind !== "device" && (await isTvOsSimulator(device.id));
      const androidIsTv = device.platform === "android" && (await isAndroidTv(device.id));
      const minStableMs = params.minStableMs ?? DEFAULT_MIN_STABLE_MS;
      const pollIntervalMs = params.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

      let stableSignature: string | undefined;
      let stableSince = 0;
      let ambient = false;
      // A node only counts as moving if it moved within this window, so a
      // one-time slide that has held still for it no longer blocks the
      // ambient path. Two polls at least, so a loop seen every poll stays in.
      const ambientWindowMs = Math.max(minStableMs, 2 * pollIntervalMs);
      const minLoopMs = MIN_LOOP_POLLS * pollIntervalMs;
      const ambientMotion = new AmbientMotion();

      const poll = await pollDescribeTree<true>({
        fetchTree: (budgetMs) => fetchTree(device, services, isTvOs, androidIsTv, budgetMs),
        timeoutMs: params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        pollIntervalMs,
        signal: ctx?.signal,
        onSample: (data, nowMs) => {
          // An empty tree (blank/loading, or a degraded AX read) is not settled.
          if (data.tree.children.length === 0) {
            stableSignature = undefined;
            stableSince = 0;
            ambientMotion.reset();
            return { done: false };
          }
          const signature = treeSignature(data.tree);
          if (signature === stableSignature) {
            if (nowMs - stableSince >= minStableMs) return { done: true, result: true };
          } else {
            stableSignature = signature;
            stableSince = nowMs;
            if (minStableMs === 0) return { done: true, result: true };
          }

          if (ambientMotion.sample(data.tree, nowMs, minStableMs, ambientWindowMs, minLoopMs)) {
            ambient = true;
            return { done: true, result: true };
          }
          return { done: false };
        },
      });

      const note = poll.result === true && poll.lastData?.stale ? poll.lastData.hint : undefined;
      return {
        settled: poll.result === true,
        waitedMs: poll.elapsedMs,
        polls: poll.polls,
        ...(ambient ? { ambientMotion: true as const } : {}),
        ...(note ? { note } : {}),
      };
    },
  };
}
