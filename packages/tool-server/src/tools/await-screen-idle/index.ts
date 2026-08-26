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
import { sleepOrAbort } from "../../utils/timing";
import type { DescribeNode, DescribeTreeData, DescribeUnreadable } from "../describe/contract";
import { capturePixelsWithin, comparePixels, statusBarMaskFraction } from "../flows/flow-pixels";
import { describeIos, iosRequires } from "../describe/platforms/ios";
import { describeAndroid, androidRequires } from "../describe/platforms/android";
import { describeChromium } from "../describe/platforms/chromium";

export const AWAIT_SCREEN_IDLE_TOOL_ID = "await-screen-idle";

const DEFAULT_TIMEOUT_MS = 3000;
const DEFAULT_POLL_INTERVAL_MS = 200;
const DEFAULT_MIN_STABLE_MS = 250;

// Per-poll accessibility read budget. Each read is bounded so an app that stops
// answering is caught INSIDE the wait, with PIXEL_RESERVE_MS left to judge
// stillness from screen captures instead — but never below MIN_AX_READ_MS, so a
// merely large tree (a long web page reads in ~700ms) is not mistaken for a
// stalled one. A wait shorter than the floor cannot switch to pixels; it reports
// the unanswered read instead (see `unreadable` on the result).
const MIN_AX_READ_MS = 3000;
const PIXEL_RESERVE_MS = 1500;

function axReadBudget(remainingMs: number): number {
  return Math.max(MIN_AX_READ_MS, remainingMs - PIXEL_RESERVE_MS);
}

// The verdict for a wait whose only read never came back: not a stall proven by
// a timeout, but the same fact for the caller — the tree source did not answer
// within the budget, so an empty result is not evidence of a blank screen.
const UNANSWERED: DescribeUnreadable = {
  stage: "ax-service",
  error_code: "AX_READ_UNANSWERED",
  message: "the accessibility read did not answer within the wait budget",
};

const zodSchema = z.object({
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
});

type Params = z.infer<typeof zodSchema>;

interface IdleResult {
  /** Screen rendered content and went still before the timeout. */
  settled: boolean;
  waitedMs: number;
  polls: number;
  /**
   * How the verdict was reached. `tree`: the element tree held still. `pixels`:
   * the tree source stopped answering (see `unreadable`), so stillness was
   * judged from two screen captures instead — motion is still caught, but
   * "has content" is not: a blank screen that holds still counts as settled.
   */
  method: "tree" | "pixels";
  /** Set when the tree source did not answer within the budget. */
  unreadable?: DescribeUnreadable;
}

const capability: ToolCapability = {
  apple: { simulator: true, device: true },
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

// The MCP layer times its auto-screenshot with this: capture once the screen is
// stable instead of after a fixed delay.
export function createAwaitScreenIdleTool(registry: Registry): ToolDefinition<Params, IdleResult> {
  function fetchTree(
    device: DeviceInfo,
    services: Record<string, unknown>,
    isTvOs: boolean,
    androidIsTv: boolean,
    remainingMs: number
  ): Promise<DescribeTreeData> {
    if (device.platform === "ios") {
      // A settle probe never pays for the native fallback: an app that isn't
      // answering AX isn't answering a main-thread RPC either, and the probe
      // has a pixel fallback of its own.
      return describeIos(
        registry,
        device,
        {},
        { isTvOs, axTimeoutMs: axReadBudget(remainingMs), fallbackOnUnreadable: false }
      );
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
${DEFAULT_TIMEOUT_MS}ms) is reached. Returns { settled, waitedMs, polls, method, unreadable? } — settled=false means the
screen never went still before the timeout. If the tree source stops answering (a busy app), the wait switches to
comparing screen captures for the rest of the budget: method="pixels", and \`unreadable\` names the read that did not
complete. Use after a launch/navigation to wait for the UI to render before screenshotting or tapping.`,
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
      else if (device.platform === "android") await ensureDeps(androidRequires);

      // Hoisted out of the poll loop: `isAndroidTv` runs `adb devices` (plus an
      // avdName getprop) on every call, even on a cache hit, so letting
      // `describeAndroid` probe would pay that per poll.
      const isTvOs = device.platform === "ios" && (await isTvOsSimulator(device.id));
      const androidIsTv = device.platform === "android" && (await isAndroidTv(device.id));
      const minStableMs = params.minStableMs ?? DEFAULT_MIN_STABLE_MS;
      const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const pollIntervalMs = params.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
      const start = Date.now();
      const deadline = start + timeoutMs;

      let stableSignature: string | undefined;
      let stableSince = 0;
      let unreadable: DescribeUnreadable | undefined;

      const poll = await pollDescribeTree<"settled" | "unreadable">({
        fetchTree: () => fetchTree(device, services, isTvOs, androidIsTv, deadline - Date.now()),
        timeoutMs,
        pollIntervalMs,
        signal: ctx?.signal,
        onSample: (data, nowMs) => {
          // The source never answered: polling it again only queues behind the
          // same stuck read. Hand over to the pixel comparison below.
          if (data.unreadable) {
            unreadable = data.unreadable;
            return { done: true, result: "unreadable" };
          }
          // An empty tree (blank/loading, or a degraded AX read) is not settled.
          if (data.tree.children.length === 0) {
            stableSignature = undefined;
            stableSince = 0;
            return { done: false };
          }
          const signature = treeSignature(data.tree);
          if (signature === stableSignature) {
            if (nowMs - stableSince >= minStableMs) return { done: true, result: "settled" };
          } else {
            stableSignature = signature;
            stableSince = nowMs;
            if (minStableMs === 0) return { done: true, result: "settled" };
          }
          return { done: false };
        },
      });

      if (poll.result !== "unreadable") {
        const unanswered = poll.lastData === null && !poll.lastAttemptSettled && !poll.aborted;
        return {
          settled: poll.result === "settled",
          waitedMs: poll.elapsedMs,
          polls: poll.polls,
          method: "tree",
          ...(unanswered ? { unreadable: UNANSWERED } : {}),
        };
      }

      // Pixel settle for the rest of the budget. A screen capture never touches
      // the app's accessibility path, so it answers while the app is pinned;
      // two captures minStableMs apart that differ only by a caret or a spinner
      // count as still, the same verdict the flow runner uses.
      const env = { registry, device, signal: ctx?.signal };
      const mask = await statusBarMaskFraction(device);
      let polls = poll.polls;
      let prev = await capturePixelsWithin(env, deadline, true);
      if (prev) polls += 1;
      while (prev && Date.now() < deadline) {
        const gap = Math.min(
          Math.max(minStableMs, pollIntervalMs),
          Math.max(0, deadline - Date.now())
        );
        if (!(await sleepOrAbort(gap, ctx?.signal))) break;
        const next = await capturePixelsWithin(env, deadline, false);
        if (!next) break;
        polls += 1;
        if (comparePixels(prev, next, mask) !== "moving") {
          return {
            settled: true,
            waitedMs: Date.now() - start,
            polls,
            method: "pixels",
            unreadable,
          };
        }
        prev = next;
      }
      return { settled: false, waitedMs: Date.now() - start, polls, method: "pixels", unreadable };
    },
  };
}
