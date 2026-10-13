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
        `The screen must hold the same content for at least this long to count as settled (default ${DEFAULT_MIN_STABLE_MS}).`
      ),
  })
  .strict();

type Params = z.infer<typeof zodSchema>;

interface IdleResult {
  /** Screen rendered content and went still before the timeout. */
  settled: boolean;
  waitedMs: number;
  polls: number;
  /**
   * Settled although some elements never stopped moving: only looping
   * animations (a bobbing coach mark, a pulsing badge) were left, which never
   * go still and so used to run every wait into its timeout.
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
function frameSnapshot(root: DescribeNode): { structure: string; frames: Map<string, string> } {
  const round = (n: number) => Math.round(n * 100) / 100;
  const frames = new Map<string, string>();
  const ids: string[] = [];
  const seen = new Map<string, number>();
  const walk = (node: DescribeNode): void => {
    const base = `${node.role}|${node.label ?? ""}|${node.value ?? ""}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    const id = `${base}#${n}`;
    ids.push(id);
    const f = node.frame;
    frames.set(id, `${round(f.x)},${round(f.y)},${round(f.width)},${round(f.height)}`);
    for (const child of node.children) walk(child);
  };
  for (const child of root.children) walk(child);
  return { structure: ids.join("\n"), frames };
}

/** Sign of the x/y movement between two `frameSnapshot` frames, e.g. "+0" or "0-". */
function motionDirection(prev: string, next: string): string | undefined {
  const [px, py] = prev.split(",").map(Number);
  const [nx, ny] = next.split(",").map(Number);
  const sign = (d: number) => (d > 0 ? "+" : d < 0 ? "-" : "0");
  const dir = `${sign(nx! - px!)}${sign(ny! - py!)}`;
  return dir === "00" ? undefined : dir;
}

/** Looping animations allowed to keep moving on a settled screen. */
const MAX_AMBIENT_MOVERS = 3;

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
${DEFAULT_TIMEOUT_MS}ms) is reached. Returns { settled, waitedMs, polls } — settled=false means the screen never went
still before the timeout. A screen where only up to ${MAX_AMBIENT_MOVERS} looping animations keep moving (a bobbing hint, a
pulsing badge) counts as settled and adds ambientMotion: true. Use after a launch/navigation to wait for the UI to
render before screenshotting or tapping.`,
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

      let stableSignature: string | undefined;
      let stableSince = 0;
      let ambient = false;
      // Ambient-motion tracking: the structure must hold still while the only
      // movement comes from nodes that keep returning to frames they already
      // showed (a loop). A one-shot transition never revisits a frame, so it
      // is still waited out.
      let structure: string | undefined;
      let structureSince = 0;
      let lastFrames = new Map<string, string>();
      const framesSeen = new Map<string, Set<string>>();
      const looping = new Set<string>();
      const moved = new Set<string>();
      const lastDirection = new Map<string, string>();

      const poll = await pollDescribeTree<true>({
        fetchTree: () => fetchTree(device, services, isTvOs, androidIsTv),
        timeoutMs: params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        pollIntervalMs: params.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
        signal: ctx?.signal,
        onSample: (data, nowMs) => {
          // An empty tree (blank/loading, or a degraded AX read) is not settled.
          if (data.tree.children.length === 0) {
            stableSignature = undefined;
            stableSince = 0;
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

          const snap = frameSnapshot(data.tree);
          if (snap.structure !== structure) {
            structure = snap.structure;
            structureSince = nowMs;
            framesSeen.clear();
            looping.clear();
            moved.clear();
            lastDirection.clear();
          } else {
            for (const [id, frame] of snap.frames) {
              const prev = lastFrames.get(id);
              if (prev === frame) continue;
              moved.add(id);
              // A loop either comes back to a frame it showed, or reverses
              // direction (a bob or pulse); a one-shot slide does neither.
              const dir = prev === undefined ? undefined : motionDirection(prev, frame);
              const before = lastDirection.get(id);
              if (framesSeen.get(id)?.has(frame) || (dir && before && dir !== before)) {
                looping.add(id);
              }
              if (dir) lastDirection.set(id, dir);
            }
          }
          for (const [id, frame] of snap.frames) {
            let set = framesSeen.get(id);
            if (!set) framesSeen.set(id, (set = new Set()));
            set.add(frame);
          }
          lastFrames = snap.frames;
          if (
            moved.size > 0 &&
            moved.size <= MAX_AMBIENT_MOVERS &&
            [...moved].every((id) => looping.has(id)) &&
            nowMs - structureSince >= minStableMs
          ) {
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
