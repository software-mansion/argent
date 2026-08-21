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
import { describeAndroid, androidRequires } from "../describe/platforms/android";
import { describeChromium } from "../describe/platforms/chromium";
import { describeTvFocus } from "../describe/platforms/tv-focus";
import { resolveTvApi } from "../tv/tv-service";

export const AWAIT_SCREEN_IDLE_TOOL_ID = "await-screen-idle";

const DEFAULT_TIMEOUT_MS = 3000;
const DEFAULT_POLL_INTERVAL_MS = 200;
const DEFAULT_MIN_STABLE_MS = 250;

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
  /** True if the screen rendered content and went still before the timeout. */
  settled: boolean;
  /** Wall-clock time waited (ms). */
  waitedMs: number;
  /** Number of tree reads taken. */
  polls: number;
  /**
   * Why it did not settle, when the last read said something useful — a
   * degraded accessibility read, a still-launching TV app. Absent on success.
   * Without it an unsettled result is a silent stall: the caller waits the full
   * budget and is told only `settled: false` (#620).
   */
  note?: string;
}

const capability: ToolCapability = {
  apple: { simulator: true, device: true },
  android: { emulator: true, device: true, unknown: true },
  chromium: { app: true },
};

// A cheap fingerprint of the screen: role + label + value + frame (rounded to
// 1% of the screen) for every node below the synthetic root. Rounding tolerates
// sub-pixel jitter while still catching real motion (a slide/fade animation),
// so an unchanged signature means the screen has genuinely stopped moving.
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
 * Explain an unsettled wait from whatever the last read reported. Mirrors the
 * diagnostics `await-ui-element` folds onto its timeout note — this tool had no
 * equivalent, so a caller got a silent stall on a degraded read.
 */
function unsettledNote(
  lastData: DescribeTreeData | null,
  lastError: string | undefined
): string | undefined {
  if (lastError) return `last tree read failed: ${lastError}`;
  if (!lastData) return undefined;
  // A non-empty tree that never held still is self-explanatory: the screen was
  // genuinely moving. Only an empty one needs a reason.
  if (lastData.tree.children.length > 0) return undefined;
  const parts: string[] = ["the screen reported no content"];
  if (lastData.should_restart) {
    parts.push("the foreground app may need a restart for native inspection");
  }
  if (lastData.hint) parts.push(lastData.hint);
  return parts.join("; ");
}

// `await-screen-idle` waits for the screen to *settle* — render content and stop
// changing — rather than for a named element like `await-ui-element`. The MCP
// layer uses it to time its auto-screenshot: capture once the screen is stable
// instead of after a fixed delay.
export function createAwaitScreenIdleTool(registry: Registry): ToolDefinition<Params, IdleResult> {
  async function fetchTree(
    device: DeviceInfo,
    services: Record<string, unknown>,
    isTvOs: boolean,
    androidIsTv: boolean
  ): Promise<DescribeTreeData> {
    if (device.platform === "ios") {
      // Apple TV: `describeIos` short-circuits every tvOS read to an empty tree,
      // so this tool could never settle there (#620). Poll the focus view the
      // `describe` tool already uses successfully instead.
      //
      // Resolved lazily, INSIDE the fetch, on purpose: the first resolution
      // spawns the tvOS ax/HID daemons and can take seconds. pollDescribeTree
      // already races each fetch against the remaining deadline, and the
      // registry caches the running service, so only the first poll pays — and
      // it can never overrun the caller's budget. Resolving up front and
      // bounding it separately would double-count the wait against a timeout
      // this tool exists to respect.
      if (isTvOs) return describeTvFocus(await resolveTvApi(registry, device.id));
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
${DEFAULT_TIMEOUT_MS}ms) is reached. Returns { settled, waitedMs, polls, note? } — settled=false means the screen never went
still before the timeout, and \`note\` explains why when the last read said something useful
(a degraded accessibility read, an app still launching).
On an Apple TV it polls the focus view rather than a pixel-backed tree: settled means the app,
the focusable set and the cursor stopped changing, so playback or animation the focus engine
cannot see will not hold it unsettled. Use after a launch/navigation to wait for the UI to render before screenshotting or tapping.`,
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

      // Resolved once, outside the poll loop, like `isTvOs` — an unlisted
      // serial's TV probe is never cached, so leaving it inside
      // `describeAndroid` would spawn `adb devices` per poll.
      const isTvOs = device.platform === "ios" && (await isTvOsSimulator(device.id));
      const androidIsTv = device.platform === "android" && (await isAndroidTv(device.id));
      const minStableMs = params.minStableMs ?? DEFAULT_MIN_STABLE_MS;

      let stableSignature: string | undefined;
      let stableSince = 0;

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
          return { done: false };
        },
      });

      const settled = poll.result === true;
      // Only ever explain a FAILURE, and only from a read that came back empty:
      // a populated tree that simply kept changing has no diagnosis to offer,
      // and some hints (Android TV's "prefer tv-remote over taps") are standing
      // advice rather than a reason, so folding them unconditionally would bury
      // the real cause in noise.
      const note = settled ? undefined : unsettledNote(poll.lastData, poll.lastError);
      return {
        settled,
        waitedMs: poll.elapsedMs,
        polls: poll.polls,
        ...(note ? { note } : {}),
      };
    },
  };
}
