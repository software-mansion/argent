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
import { resolveDevice } from "../../utils/device-info";
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

const AWAIT_SCREEN_IDLE_TOOL_ID = "await-screen-idle";

const DEFAULT_TIMEOUT_MS = 3000;
const DEFAULT_POLL_INTERVAL_MS = 200;
const DEFAULT_MIN_STABLE_MS = 250;

const zodSchema = z
  .object({
    udid: z
      .string()
      .min(1)
      .describe("Target device id from `list-devices` (iOS UDID, Android serial, or Chromium id)."),
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
   * A looping loading indicator counts too, so check for the destination
   * content before trusting the screen is loaded.
   */
  ambientMotion?: true;
}

const capability: ToolCapability = {
  apple: { simulator: true, device: true },
  appleRemote: { simulator: true },
  android: { emulator: true, device: true, unknown: true },
  chromium: { app: true },
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

/**
 * Frame of every node, keyed by an identity that ignores position
 * (role/label/value, numbered for duplicates), plus the structure those
 * identities form.
 */
function frameSnapshot(root: DescribeNode): {
  structure: string;
  frames: Map<string, number[]>;
  raw: Map<string, number[]>;
} {
  const round = (n: number) => Math.round(n * 100) / 100;
  const frames = new Map<string, number[]>();
  const raw = new Map<string, number[]>();
  const ids: string[] = [];
  const seen = new Map<string, number>();
  const walk = (node: DescribeNode): void => {
    const base = `${node.role}|${node.label ?? ""}|${node.value ?? ""}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    const id = `${base}#${n}`;
    ids.push(id);
    const f = node.frame;
    frames.set(id, [round(f.x), round(f.y), round(f.width), round(f.height)]);
    raw.set(id, [f.x, f.y, f.width, f.height]);
    for (const child of node.children) walk(child);
  };
  for (const child of root.children) walk(child);
  return { structure: ids.join("\n"), frames, raw };
}

/**
 * Looping animations allowed to keep moving on a settled screen. Elements that
 * move together count as one animation.
 */
const MAX_AMBIENT_MOVERS = 3;

/**
 * Direction reversals a node must show before it counts as a loop. One is not
 * enough: an overshooting ease (easeOutBack, a spring) reverses once at the end
 * of a one-time entrance. A bob or a pulse reverses every half cycle.
 */
const MIN_LOOP_REVERSALS = 2;

interface NodeMotion {
  /** Last non-zero sign of x, y, width, height; 0 while that axis never moved. */
  signs: number[];
  reversals: number;
  lastMovedAt: number;
}

/** Fold one value into a 32-bit hash. */
function mix(hash: number, value: number): number {
  return (Math.imul(hash, 31) + value) | 0;
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
  private readonly motion = new Map<string, NodeMotion>();
  /**
   * Hash of every unrounded move (poll index and delta) per node. Nodes that
   * move rigidly together, like a coach mark's container, arrow, text and
   * button, share it, so they count as one animation.
   */
  private readonly path = new Map<string, number>();
  private polls = 0;

  /** Forget everything, e.g. after a blank read: the next screen starts fresh. */
  reset(): void {
    this.structure = undefined;
    this.structureSince = 0;
    this.lastFrames = new Map();
    this.lastRaw = new Map();
    this.motion.clear();
    this.path.clear();
    this.polls = 0;
  }

  /** Feed one sample; true once only loops have moved for the last `windowMs`. */
  sample(root: DescribeNode, nowMs: number, minStableMs: number, windowMs: number): boolean {
    const snap = frameSnapshot(root);
    if (snap.structure !== this.structure) {
      this.reset();
      this.structure = snap.structure;
      this.structureSince = nowMs;
      this.lastFrames = snap.frames;
      this.lastRaw = snap.raw;
      return false;
    }
    this.polls += 1;
    for (const [id, frame] of snap.raw) {
      const prev = this.lastRaw.get(id);
      if (!prev || prev.every((v, i) => v === frame[i])) continue;
      let hash = mix(this.path.get(id) ?? 0, this.polls);
      for (let i = 0; i < 4; i++) hash = mix(hash, Math.round((frame[i]! - prev[i]!) * 10_000));
      this.path.set(id, hash);
    }
    this.lastRaw = snap.raw;
    for (const [id, frame] of snap.frames) {
      const prev = this.lastFrames.get(id);
      if (!prev || prev.every((v, i) => v === frame[i])) continue;
      let m = this.motion.get(id);
      if (!m) this.motion.set(id, (m = { signs: [0, 0, 0, 0], reversals: 0, lastMovedAt: 0 }));
      const signs = frame.map((v, i) => Math.sign(v - prev[i]!));
      // Only a sign flip on an axis is a reversal. An axis coming to rest
      // (a diagonal ease-out whose smaller axis stops first) is not.
      let reversed = false;
      signs.forEach((sign, i) => {
        if (sign === 0) return;
        if (m.signs[i] !== 0 && m.signs[i] !== sign) reversed = true;
        m.signs[i] = sign;
      });
      if (reversed) m.reversals += 1;
      m.lastMovedAt = nowMs;
    }
    this.lastFrames = snap.frames;

    if (nowMs - this.structureSince < minStableMs) return false;
    const recent = [...this.motion].filter(([, m]) => nowMs - m.lastMovedAt < windowMs);
    if (recent.length === 0) return false;
    if (!recent.every(([, m]) => m.reversals >= MIN_LOOP_REVERSALS)) return false;
    const animations = new Set(recent.map(([id]) => this.path.get(id)));
    return animations.size <= MAX_AMBIENT_MOVERS;
  }
}

// The MCP layer times its auto-screenshot with this: capture once the screen is
// stable instead of after a fixed delay.
export function createAwaitScreenIdleTool(registry: Registry): ToolDefinition<Params, IdleResult> {
  function fetchTree(
    device: DeviceInfo,
    services: Record<string, unknown>,
    isTvOs: boolean,
    androidIsTv: boolean
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
${DEFAULT_TIMEOUT_MS}ms) is reached. Returns { settled, waitedMs, polls }; settled=false means the screen never went
still before the timeout. A screen where only up to ${MAX_AMBIENT_MOVERS} looping animations keep moving (a bobbing hint, a
pulsing badge) counts as settled and adds ambientMotion: true; those elements are still moving. A loop that changes a
label or value (an animated "Loading..." label) is a content change and is waited out. Use after a launch/navigation to
wait for the UI to render before screenshotting or tapping.`,
    searchHint:
      "wait until screen settles idle stable stops changing animation transition rendered ready before screenshot",
    longRunning: true,
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
      const ambientMotion = new AmbientMotion();

      const poll = await pollDescribeTree<true>({
        fetchTree: () => fetchTree(device, services, isTvOs, androidIsTv),
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

          if (ambientMotion.sample(data.tree, nowMs, minStableMs, ambientWindowMs)) {
            ambient = true;
            return { done: true, result: true };
          }
          return { done: false };
        },
      });

      return {
        settled: poll.result === true,
        waitedMs: poll.elapsedMs,
        polls: poll.polls,
        ...(ambient ? { ambientMotion: true as const } : {}),
      };
    },
  };
}
