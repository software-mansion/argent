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
import { describeTvFocus, hasTvCursor } from "../describe/platforms/tv-focus";
import { resolveTvApi } from "../tv/tv-service";
import type { TvControlApi } from "../../blueprints/tv-control-types";
import { pollHarmonyTree, harmonyRequires } from "../describe/platforms/harmony";
import { describeMacosForJudging } from "../flows/flow-macos-tree";

const AWAIT_SCREEN_IDLE_TOOL_ID = "await-screen-idle";

const DEFAULT_TIMEOUT_MS = 3000;
const DEFAULT_POLL_INTERVAL_MS = 200;
const DEFAULT_MIN_STABLE_MS = 250;
/**
 * How long an Apple TV screen with no cursor must hold before it counts as
 * settled. After a push or pop in Settings the list appears at 130-260 ms and the
 * cursor at 820-950 ms, up to 720 ms later (20 presses), and a remote press sent
 * in that gap is lost. A screen with nothing focusable never gets a cursor, so
 * this can only be a bound.
 */
const TV_NO_CURSOR_STABLE_MS = 1200;
/**
 * How far behind the deadline the last read that came back may lie before the
 * reader counts as hung: two polls, as `await-ui-element` allows, within 2 s.
 */
const DARK_TAIL_POLLS = 2;
const DARK_TAIL_MAX_MS = 2000;
const TV_NO_CURSOR_NOTE = "no element holds focus on this screen, so a remote press may be lost";

interface IdleResult {
  /** Screen rendered content and held it for minStableMs (0: content alone) before the timeout. */
  settled: boolean;
  waitedMs: number;
  polls: number;
  /**
   * Why the wait says what it says: a settled screen that is not live, or an
   * unsettled wait whose last read came back empty or failed.
   */
  note?: string;
}

const capability: ToolCapability = {
  apple: { simulator: true, device: true },
  appleRemote: { simulator: true },
  android: { emulator: true, device: true, unknown: true },
  chromium: { app: true },
  harmony: { device: true },
  macos: { app: true },
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
 * Explain an unsettled wait from whatever the last read reported. Mirrors the
 * diagnostics `await-ui-element` folds onto its timeout note — this tool had no
 * equivalent, so a caller got a silent stall on a degraded read.
 */
function unsettledNote(
  lastData: DescribeTreeData | null,
  lastError: string | undefined,
  darkTailMs: number | undefined
): string | undefined {
  if (lastError) return `last tree read failed: ${lastError}`;
  if (darkTailMs !== undefined) {
    return `the tree read stopped answering: nothing came back for the last ${darkTailMs}ms`;
  }
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

const zodSchema = z
  .object({
    udid: z
      .string()
      .min(1)
      .describe(
        "Target device id from `list-devices` (iOS UDID, Android serial, <flag:harmonyos>HarmonyOS id, </flag:harmonyos><flag:macos-apps>Mac app id, </flag:macos-apps>or Chromium id)."
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
        `The screen must hold the same content for at least this long to count as settled (default ${DEFAULT_MIN_STABLE_MS}); 0 settles on the first non-empty read, confirming content, not stillness.`
      ),
  })
  .strict();

type Params = z.infer<typeof zodSchema>;

// The MCP layer times its auto-screenshot with this: capture once the screen is
// stable instead of after a fixed delay.
export function createAwaitScreenIdleTool(registry: Registry): ToolDefinition<Params, IdleResult> {
  function fetchTree(
    device: DeviceInfo,
    services: Record<string, unknown>,
    tvApi: TvControlApi | null,
    androidIsTv: boolean,
    budgetMs: number
  ): Promise<DescribeTreeData> {
    // ios-remote reads the same AX tree through describeIos: the ax-service
    // blueprint routes it over the sim-remote tunnel, so only the preflight dep
    // differs from the local branch. It is never tvOS, matching describe.
    if (device.platform === "ios" || device.platform === "ios-remote") {
      // Physical devices poll the same XCUITest runner snapshot as describe.
      if (device.kind === "device") {
        return describeIosDevice(registry, device);
      }
      // Apple TV: describeIos short-circuits tvOS to an empty tree, so this tool
      // could never settle there (#620). Poll the focus view describe uses.
      if (tvApi) return describeTvFocus(tvApi);
      return describeIos(registry, device, {}, { isTvOs: false });
    }
    if (device.platform === "android") {
      return describeAndroid(registry, device.id, undefined, androidIsTv);
    }
    if (device.platform === "harmony") {
      return pollHarmonyTree(harmonyConnectKey(device.id), budgetMs);
    }
    if (device.platform === "macos") {
      return describeMacosForJudging(registry, device, AWAIT_SCREEN_IDLE_TOOL_ID);
    }
    return describeChromium(services.chromium as ChromiumCdpApi);
  }

  return {
    id: AWAIT_SCREEN_IDLE_TOOL_ID,
    description: `Block until the screen has rendered content and held it for minStableMs, or the timeout elapses. It polls the same element tree as \`describe\`.
Use when a launch or navigation must finish rendering before a screenshot or tap.
Returns { settled, waitedMs, polls, note? }. If that is not seen before timeoutMs, including when the tree cannot be read, it returns settled=false instead of failing. It fails at once while Xcode's first-launch component install is pending, or when it cannot reach a Chromium app or start an Apple TV's remote services.<flag:harmonyos> A note on settled=true means the screen it settled on is not live: a suspended HarmonyOS panel settles instantly on its last frame, and taps land nowhere until it is woken.</flag:harmonyos>`,
    zodSchema,
    searchHint:
      "wait until screen settles idle stable stops changing animation transition rendered ready before screenshot",
    readOnly: true,
    interaction: {
      startedMsg: () => "Waiting for screen to settle",
      completedMsg: ({ result }) =>
        result.settled ? "Screen settled" : "Screen did not settle before timeout",
      failedMsg: ({ failureSignal }) =>
        `Failed while waiting for screen to settle: ${failureSignal.error_code}`,
    },
    longRunning: true,
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
      // Resolved before the clock starts: the first resolution spawns the tvOS
      // daemons and can take seconds. A failure is infrastructure, so it throws
      // rather than reporting an unsettled screen.
      const tvApi = isTvOs ? await resolveTvApi(registry, device.id) : null;
      const androidIsTv = device.platform === "android" && (await isAndroidTv(device.id));
      const minStableMs = params.minStableMs ?? DEFAULT_MIN_STABLE_MS;

      const pollIntervalMs = params.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

      let stableSignature: string | undefined;
      let stableSince = 0;
      let lastReadAt = 0;

      const poll = await pollDescribeTree<true>({
        fetchTree: (budgetMs) => fetchTree(device, services, tvApi, androidIsTv, budgetMs),
        timeoutMs: params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        pollIntervalMs,
        signal: ctx?.signal,
        onSample: (data, nowMs) => {
          lastReadAt = nowMs;
          // An empty tree (blank/loading, or a degraded AX read) is not settled.
          if (data.tree.children.length === 0) {
            stableSignature = undefined;
            stableSince = 0;
            return { done: false };
          }
          const signature = treeSignature(data.tree);
          if (signature === stableSignature) {
            const requiredMs =
              tvApi && !hasTvCursor(data.tree)
                ? Math.max(minStableMs, TV_NO_CURSOR_STABLE_MS)
                : minStableMs;
            if (nowMs - stableSince >= requiredMs) return { done: true, result: true };
          } else {
            stableSignature = signature;
            stableSince = nowMs;
            if (minStableMs === 0) return { done: true, result: true };
          }
          return { done: false };
        },
      });

      const settled = poll.result === true;
      // The last read abandoned at the deadline is routine: the loop straddles it
      // on most timeouts. Only a gap wider than the polls explain is a hung
      // reader; without this it reads like a screen that kept moving.
      const darkTailMs = Date.now() - lastReadAt;
      const hung =
        lastReadAt > 0 && darkTailMs > Math.min(DARK_TAIL_POLLS * pollIntervalMs, DARK_TAIL_MAX_MS);
      // On settled, only a stale read needs a caveat. On unsettled, only an empty
      // or failed read has a diagnosis: a populated tree that kept changing has
      // none, and some hints (Android TV's) are standing advice, not a reason.
      const note = settled
        ? poll.lastData?.stale
          ? poll.lastData.hint
          : undefined
        : unsettledNote(poll.lastData, poll.lastError, hung ? darkTailMs : undefined);
      const populatedNoCursor =
        tvApi && poll.lastData?.tree.children.length && !hasTvCursor(poll.lastData.tree);
      const cursorNote = populatedNoCursor ? TV_NO_CURSOR_NOTE : undefined;
      return {
        settled,
        waitedMs: poll.elapsedMs,
        polls: poll.polls,
        ...(note || cursorNote ? { note: note ?? cursorNote } : {}),
      };
    },
  };
}
