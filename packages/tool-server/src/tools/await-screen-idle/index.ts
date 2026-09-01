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
import {
  pollDescribeTree,
  TREE_FETCH_FAILED_NOTE_PREFIX,
  type PollDescribeTreeResult,
} from "../../utils/poll-describe-tree";
import type { DescribeNode, DescribeTreeData } from "../describe/contract";
import { describeIos, iosRequires } from "../describe/platforms/ios";
import { describeAndroid, androidRequires } from "../describe/platforms/android";
import { describeChromium } from "../describe/platforms/chromium";

export const AWAIT_SCREEN_IDLE_TOOL_ID = "await-screen-idle";

const DEFAULT_TIMEOUT_MS = 3000;
const DEFAULT_POLL_INTERVAL_MS = 200;
const DEFAULT_MIN_STABLE_MS = 250;
const WAIT_CANCELLED_NOTE = "wait was cancelled before the screen settled";

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
   * Present whenever `settled: false` does not stand for "the screen kept
   * changing". Every other way this wait ends negative says so here: the last
   * tree fetch failed outright (the note carries that error), the caller
   * cancelled, the screen was never sampled twice, every read came back empty,
   * or the content held still but `minStableMs` was out of the budget's reach.
   * A bare `settled: false` with no note is the observed change.
   */
  note?: string;
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

/**
 * WHY a wait came back `settled: false`, or `undefined` when the plain reading —
 * the screen was read repeatedly and kept changing — is the true one.
 *
 * Every arm here exists because `settled: false` alone would assert an observed
 * change the wait never observed. They are ordered by how little the wait got to
 * see, most blind first.
 */
function unsettledNote(
  poll: PollDescribeTreeResult<true>,
  wait: {
    timeoutMs: number;
    pollIntervalMs: number;
    minStableMs: number;
    nonEmptyReads: number;
    signatureChanged: boolean;
  }
): string | undefined {
  if (poll.aborted) return WAIT_CANCELLED_NOTE;

  // A fetch that failed outright — a locked screen, a dead helper — must reach
  // the agent as itself rather than be folded into a latency diagnosis: every
  // fetch failing also leaves `samples` at 0, and telling the agent to raise
  // timeoutMs there is advice that cannot help. `lastAttemptSettled` keeps this
  // off the slow-read arm below, where the loop leaves `lastError` set to its
  // own budget-expiry message for a read it abandoned at the deadline.
  if (poll.lastAttemptSettled && poll.lastError !== undefined) {
    return `${TREE_FETCH_FAILED_NOTE_PREFIX}${poll.lastError}`;
  }

  // Settling takes two samples that agree across minStableMs, so one sample is
  // a screen the reader never got to compare with itself. Two different things
  // starve it and they take opposite remedies, so name the right knob:
  // `lastAttemptSettled` is false only when the deadline cut a fetch off, which
  // is the read outrunning the budget. True means every fetch came back and the
  // SCHEDULE ran out — one read plus one pollIntervalMs sleep does not fit in
  // timeoutMs — where raising timeoutMs is not the smaller change.
  if (poll.samples < 2) {
    return poll.lastAttemptSettled
      ? `the ${wait.timeoutMs}ms budget left room for only ${poll.samples} tree read, so the screen was ` +
          `never sampled twice — this is not an observed change. The read itself finished; it is ` +
          `pollIntervalMs (${wait.pollIntervalMs}ms) that leaves no room for a second one, so lower it ` +
          `or raise timeoutMs.`
      : `reading the tree did not finish within the ${wait.timeoutMs}ms budget, so the screen was never ` +
          `sampled twice — this is a read that outran the budget, not an observed change. Raise ` +
          `timeoutMs for a tree this large.`;
  }

  // Read repeatedly and empty every time: there was never any content to go
  // still, which `settled: false` on its own would report as motion. The
  // adapter's own hint (tvOS has no readable tree at all) says why.
  if (wait.nonEmptyReads === 0) {
    const base =
      `all ${poll.samples} tree reads came back empty, so no content ever rendered to go still — ` +
      `this is not an observed change.`;
    return poll.lastData?.hint ? `${base} (${poll.lastData.hint})` : base;
  }

  // Read repeatedly, and no two reads ever differed. The screen was not seen
  // changing; minStableMs simply never elapsed over a run of identical reads
  // inside the budget.
  if (!wait.signatureChanged) {
    return (
      `the ${poll.samples} tree reads were all identical, but minStableMs (${wait.minStableMs}ms) never ` +
      `elapsed over them inside the ${wait.timeoutMs}ms budget — this is stillness left unconfirmed, not ` +
      `an observed change. Lower minStableMs or raise timeoutMs.`
    );
  }

  return undefined;
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
    if (device.platform === "ios") {
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
        result.settled
          ? "Screen settled"
          : result.note === undefined
            ? "Screen did not settle before timeout"
            : result.note.startsWith(TREE_FETCH_FAILED_NOTE_PREFIX)
              ? "Screen read failed before timeout"
              : result.note === WAIT_CANCELLED_NOTE
                ? "Wait for the screen cancelled"
                : "Screen stillness went untested before timeout",
      failedMsg: ({ failureSignal }) =>
        `Failed while waiting for screen to settle: ${failureSignal.error_code}`,
    },
    description: `Block until the screen has rendered content and stopped changing, or a timeout elapses.

Polls the same accessibility / DOM tree as \`describe\` every pollIntervalMs (default ${DEFAULT_POLL_INTERVAL_MS}ms) until it
has content and that content holds identical for minStableMs (default ${DEFAULT_MIN_STABLE_MS}ms), or timeoutMs (default
${DEFAULT_TIMEOUT_MS}ms) is reached. Returns { settled, waitedMs, polls, note? } — settled=false means the screen never
went still before the timeout ONLY when no note is present. A note says stillness went untested instead, and which
way: the last tree fetch failed outright (fix its cause — e.g. unlock the device), the wait was cancelled, the tree
was never read twice inside the budget (the note names the knob — timeoutMs for a slow tree, pollIntervalMs when the
interval left no room for a second read), every read came back empty (nothing rendered; on tvOS the tree is empty by
design), or the content held still but minStableMs is longer than the budget can reach. Use after a launch/navigation
to wait for the UI to render before screenshotting or tapping.`,
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

      let stableSignature: string | undefined;
      let stableSince = 0;
      // Reads that came back with content, and whether the content ever differed
      // between two of them. Together they separate "nothing rendered" and "the
      // screen was still all along" from the observed change `settled: false`
      // otherwise asserts.
      let nonEmptyReads = 0;
      let signatureChanged = false;

      const poll = await pollDescribeTree<true>({
        fetchTree: () => fetchTree(device, services, isTvOs, androidIsTv),
        timeoutMs,
        pollIntervalMs,
        signal: ctx?.signal,
        onSample: (data, nowMs) => {
          // An empty tree (blank/loading, or a degraded AX read) is not settled.
          if (data.tree.children.length === 0) {
            if (stableSignature !== undefined) signatureChanged = true;
            stableSignature = undefined;
            stableSince = 0;
            return { done: false };
          }
          nonEmptyReads += 1;
          const signature = treeSignature(data.tree);
          if (signature === stableSignature) {
            if (nowMs - stableSince >= minStableMs) return { done: true, result: true };
          } else {
            if (stableSignature !== undefined) signatureChanged = true;
            stableSignature = signature;
            stableSince = nowMs;
            if (minStableMs === 0) return { done: true, result: true };
          }
          return { done: false };
        },
      });

      const settled = poll.result === true;
      const base = { settled, waitedMs: poll.elapsedMs, polls: poll.polls };
      if (settled) return base;
      const note = unsettledNote(poll, {
        timeoutMs,
        pollIntervalMs,
        minStableMs,
        nonEmptyReads,
        signatureChanged,
      });
      return note === undefined ? base : { ...base, note };
    },
  };
}
