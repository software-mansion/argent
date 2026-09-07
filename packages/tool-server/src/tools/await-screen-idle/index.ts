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
  MIN_POLL_INTERVAL_MS,
  pollDescribeTree,
  TREE_FETCH_FAILED_NOTE_PREFIX,
  type PollDescribeTreeResult,
} from "../../utils/poll-describe-tree";
import type { DescribeNode, DescribeTreeData } from "../describe/contract";
import { describeIos, iosRequires } from "../describe/platforms/ios";
import { describeIosDevice } from "../describe/platforms/ios-device";
import { describeAndroid, androidRequires } from "../describe/platforms/android";
import { describeChromium } from "../describe/platforms/chromium";

const AWAIT_SCREEN_IDLE_TOOL_ID = "await-screen-idle";

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
    .min(MIN_POLL_INTERVAL_MS)
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
  /** Tree fetch attempts, failures and deadline cut-offs included. */
  polls: number;
  /**
   * Present whenever `settled: false` does not stand for "the screen kept
   * changing, and was watched doing so up to the deadline". Every other way this
   * wait ends negative says so here: the last tree fetch failed outright (the
   * note carries that error), the caller cancelled, the screen was never sampled
   * twice, no read returned content, one read did and had nothing to be compared
   * with, the content that was read never differed and `minStableMs` was never
   * met, or content did differ and the reads then went dark before the deadline.
   * A fetch that failed earlier in the wait is appended to whichever of those
   * describes it.
   *
   * A bare `settled: false` with no note is the observed change, watched to the
   * end.
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

/** Fold the adapter's own account of an unreadable tree into the note. */
function withHint(base: string, poll: PollDescribeTreeResult<true>): string {
  return poll.lastData?.hint ? `${base} (${poll.lastData.hint})` : base;
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
    contentReads: number;
    contentChanged: boolean;
    trailingBlankReads: number;
  }
): string | undefined {
  const reason = unsettledReason(poll, wait);
  if (reason === undefined) return undefined;
  // A fetch that failed before the deadline abandoned the final one. `lastError`
  // survives it — the loop clears that only on a success and never writes the
  // abandonment there — so a set value the fetch-failed arm did not take is a
  // real failure no arm below can see. Every one of them ends in a remedy, and
  // none of those remedies is the one a dying source needs.
  const alsoFailed =
    !poll.lastAttemptSettled && poll.lastError !== undefined
      ? ` (a tree read also failed: ${poll.lastError})`
      : "";
  return `${reason}${alsoFailed}`;
}

function unsettledReason(
  poll: PollDescribeTreeResult<true>,
  wait: {
    timeoutMs: number;
    pollIntervalMs: number;
    minStableMs: number;
    contentReads: number;
    contentChanged: boolean;
    trailingBlankReads: number;
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
  // a screen the reader never got to compare with itself. Several things starve
  // it, taking different remedies, so name the one that applies. The sibling
  // tool draws the same lines.
  if (poll.samples < 2) {
    // Nothing ever came back: the tree outran the budget, or a stalled source
    // never answered. (A last fetch that settled with an error is the failed-read
    // arm above; an earlier error is appended by unsettledNote.)
    if (poll.samples === 0) {
      return (
        `reading the tree did not finish within the ${wait.timeoutMs}ms budget, so the screen was never ` +
        `read — this is a read that outran the budget, not an observed change. Raise timeoutMs if the ` +
        `tree is merely large, or repair the source if it has stopped answering altogether.`
      );
    }
    // One read came back and earlier fetches failed, so the window was mostly
    // blind. The single sample is not the sleep's fault; the failures took the
    // others. unsettledNote appends the error text.
    if (poll.failedFetches > 0) {
      return (
        `only one tree read returned a tree and ${poll.failedFetches} earlier ` +
        `${poll.failedFetches === 1 ? "read" : "reads"} failed, so the screen was never sampled twice — ` +
        `this is not an observed change. Restore the tree source and re-run.`
      );
    }
    // Only a fetch that SETTLED and was over half the budget rules pollIntervalMs
    // out: a second read of that size cannot fit at any interval. A fetch the
    // deadline abandoned is not that evidence — its `slowestFetchMs` is the
    // cut-off, not a read — and blaming the schedule for it withholds the remedy
    // a slow or stalled source needs, so it falls to the neutral arm below. The
    // sibling await-ui-element draws the same line on lastAttemptSettled.
    if (
      poll.lastAttemptSettled &&
      2 * poll.slowestFetchMs + MIN_POLL_INTERVAL_MS > wait.timeoutMs
    ) {
      return (
        `one tree fetch took ${poll.slowestFetchMs}ms of the ${wait.timeoutMs}ms budget, so a second read ` +
        `plus the shortest poll interval the schema allows (${MIN_POLL_INTERVAL_MS}ms) does not fit and the ` +
        `screen was never sampled twice — this is not an observed change. Raise timeoutMs; lowering ` +
        `pollIntervalMs helps only if the next read is faster than that one.`
      );
    }
    if (poll.lastAttemptSettled) {
      // Every fetch came back and a second read would have fit at some interval,
      // so what ran out was the schedule.
      return (
        `the ${wait.timeoutMs}ms budget left room for only ${poll.samples} tree read, so the screen was ` +
        `never sampled twice — this is not an observed change. The slowest fetch took ${poll.slowestFetchMs}ms; ` +
        `it is pollIntervalMs (${wait.pollIntervalMs}ms) that leaves no room for a second one, so lower it or ` +
        `raise timeoutMs.`
      );
    }
    // The final fetch was abandoned at the deadline after one read landed. Do
    // not name a knob with confidence: a second read WAS attempted, so the sleep
    // was not the constraint, and the abandoned fetch is no evidence the tree is
    // too slow either.
    return (
      `only one tree read completed within the ${wait.timeoutMs}ms budget, so the screen was never sampled ` +
      `twice — this is not an observed change. Raise timeoutMs, or lower pollIntervalMs if reads that slow ` +
      `are the exception.`
    );
  }

  // Read repeatedly and empty every time. Which of the two reasons that is —
  // nothing has rendered, or the reader cannot see the app — is the adapter's to
  // say, so the note stops short of choosing and appends the hint that does. An
  // empty iOS tree carries one; so does tvOS, where this tool's reader has no
  // focus tree to return at all.
  if (wait.contentReads === 0) {
    return withHint(
      `no tree read returned any content across ${poll.samples} reads, so the screen was never seen ` +
        `holding anything still — this is not an observed change. Either nothing has rendered yet or ` +
        `the tree could not be read.`,
      poll
    );
  }

  // One read with content and the rest empty: that content was never held up
  // against anything, so it is neither identical nor changed. The arm below
  // would call it identical.
  if (wait.contentReads === 1) {
    return withHint(
      `only 1 of the ${poll.samples} tree reads returned content and the other ` +
        `${poll.samples - 1} came back empty, so what was read was never compared with anything — ` +
        `this is not an observed change.`,
      poll
    );
  }

  // Content was read more than once and never differed between two of those
  // reads, so nothing was seen to move. What kept it from settling was
  // minStableMs — over an unbroken run, which an empty read in between breaks.
  if (!wait.contentChanged) {
    const blanks = poll.samples - wait.contentReads;
    return blanks === 0
      ? `the ${poll.samples} tree reads were all identical, but minStableMs (${wait.minStableMs}ms) never ` +
          `elapsed over them inside the ${wait.timeoutMs}ms budget — this is stillness left unconfirmed, ` +
          `not an observed change. Lower minStableMs or raise timeoutMs.`
      : withHint(
          `only ${wait.contentReads} of the ${poll.samples} tree reads returned content and those were ` +
            `identical; the other ${blanks} came back empty, so minStableMs (${wait.minStableMs}ms) never ` +
            `elapsed over an unbroken run inside the ${wait.timeoutMs}ms budget — this is stillness left ` +
            `unconfirmed, not an observed change.`,
          poll
        );
  }

  // Content changed, and then the reads went dark and stayed dark. The change is
  // real, but nothing watched the screen up to the deadline — and on iOS a
  // failing accessibility read is exactly what a run of empty trees looks like.
  // A bare `settled: false` would claim the motion was watched to the end.
  if (wait.trailingBlankReads > 0) {
    const tail =
      wait.trailingBlankReads === 1
        ? "the last tree read came back empty"
        : `the last ${wait.trailingBlankReads} tree reads came back empty`;
    return withHint(
      `the screen was seen changing, but ${tail}, so nothing watched it up to the deadline — the ` +
        `change is real, the stillness is untested.`,
      poll
    );
  }

  // Content changed, then a read FAILED and the final fetch never came back — a
  // sticky `lastError` with the final attempt abandoned (a last fetch that
  // settled with an error is the failed-read arm at the top). The reads went dark
  // by failing, not by emptying (that is the arm above) and not by the routine
  // deadline straddle of a healthy poll (no error, so this does not fire). The
  // motion is real but nothing watched the screen to the end, so this must not
  // read as a bare `settled: false`. unsettledNote appends the error.
  if (poll.lastError !== undefined) {
    return (
      `the screen was seen changing, but the reads then went dark before the deadline, so nothing watched ` +
      `it up to the end — the change is real, the stillness is untested.`
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
interval left no room for a second read), no read returned any content (nothing rendered yet, or the tree could not be
read — where the adapter offers a hint the note carries it, and on Apple TV that hint says this tool's reader has no
tree there and to use tv-remote focus instead), only one read returned content so nothing was compared with it, the
content that was read never differed and minStableMs was never met over it, or content did differ and the reads then
went dark before the deadline. Use after a launch/navigation to wait for the UI to render before screenshotting or
tapping.`,
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

      // Resolve tvOS / Android-TV once. Physical devices skip the tvOS probe. They are never tvOS simulators.
      const isTvOs =
        device.platform === "ios" && device.kind !== "device" && (await isTvOsSimulator(device.id));
      const androidIsTv = device.platform === "android" && (await isAndroidTv(device.id));
      const minStableMs = params.minStableMs ?? DEFAULT_MIN_STABLE_MS;

      const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const pollIntervalMs = params.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

      let stableSignature: string | undefined;
      let stableSince = 0;
      // Reads that came back with content, and whether two of THOSE ever
      // differed. An empty read is not a content change — it is the reader
      // seeing nothing, which on iOS is what a failing accessibility read looks
      // like too. Counting one as a change would let a tree source that died
      // mid-wait come back as the observed change `settled: false` asserts.
      let contentReads = 0;
      let contentChanged = false;
      let lastContentSignature: string | undefined;
      // Empty reads since the last one with content. A change seen early and
      // then a reader that goes dark is not a screen watched to the deadline.
      let trailingBlankReads = 0;

      const poll = await pollDescribeTree<true>({
        fetchTree: () => fetchTree(device, services, isTvOs, androidIsTv),
        timeoutMs,
        pollIntervalMs,
        signal: ctx?.signal,
        onSample: (data, nowMs) => {
          // An empty tree (blank/loading, or a degraded AX read) is not settled.
          if (data.tree.children.length === 0) {
            stableSignature = undefined;
            stableSince = 0;
            trailingBlankReads += 1;
            return { done: false };
          }
          trailingBlankReads = 0;
          contentReads += 1;
          const signature = treeSignature(data.tree);
          if (lastContentSignature !== undefined && signature !== lastContentSignature) {
            contentChanged = true;
          }
          lastContentSignature = signature;
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
      const base = { settled, waitedMs: poll.elapsedMs, polls: poll.polls };
      if (settled) return base;
      const note = unsettledNote(poll, {
        timeoutMs,
        pollIntervalMs,
        minStableMs,
        contentReads,
        contentChanged,
        trailingBlankReads,
      });
      return note === undefined ? base : { ...base, note };
    },
  };
}
