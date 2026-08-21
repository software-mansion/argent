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
import {
  pollDescribeTree,
  readCaveats,
  type PollDescribeTreeResult,
} from "../../utils/poll-describe-tree";
import { READ_CAVEAT_SOURCES } from "../describe/contract";
import type { DescribeNode, DescribeTreeData } from "../describe/contract";
import { describeIos, iosRequires } from "../describe/platforms/ios";
import { describeAndroid, androidRequires } from "../describe/platforms/android";
import { describeChromium } from "../describe/platforms/chromium";
import { describeHarmony, harmonyRequires } from "../describe/platforms/harmony";

export const AWAIT_SCREEN_IDLE_TOOL_ID = "await-screen-idle";

const DEFAULT_TIMEOUT_MS = 3000;
const DEFAULT_POLL_INTERVAL_MS = 200;
const DEFAULT_MIN_STABLE_MS = 250;

const zodSchema = z.object({
  udid: z
    .string()
    .min(1)
    .describe(
      "Target device id from `list-devices` (iOS UDID, Android serial, HarmonyOS id, or Chromium id)."
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
   * Why a false `settled` is not a screen that stayed busy — e.g. the device
   * went away — or, on a true one, why the tree it settled on may not be the
   * live screen.
   */
  note?: string;
}

const capability: ToolCapability = {
  apple: { simulator: true, device: true },
  android: { emulator: true, device: true, unknown: true },
  chromium: { app: true },
  harmony: { device: true },
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

// Why a wait ended somewhere other than on a screen that plainly settled.
//
// A screen that never settles is usually one the reader could not see — a
// degraded AX tree, a panel that is off, an app whose native inspection needs a
// restart — and none of that is recoverable from the empty tree left behind. A
// failed fetch outranks those, since a device that went away and a screen that
// stayed busy are opposite diagnoses. On a success only
// {@link READ_CAVEAT_SOURCES} applies, for the reason given there.
function idleNote(poll: PollDescribeTreeResult<true>): string | undefined {
  if (poll.result !== true) {
    if (poll.lastError) return `last tree fetch failed: ${poll.lastError}`;
    const caveats = readCaveats(poll.lastData);
    return caveats.length === 0 ? undefined : caveats.join("; ");
  }
  const settledOn = poll.lastData;
  if (!settledOn?.hint || !READ_CAVEAT_SOURCES.has(settledOn.source)) return undefined;
  return settledOn.hint;
}

// `await-screen-idle` waits for the screen to *settle* — render content and stop
// changing — rather than for a named element like `await-ui-element`. The MCP
// layer uses it to time its auto-screenshot: capture once the screen is stable
// instead of after a fixed delay.
export function createAwaitScreenIdleTool(registry: Registry): ToolDefinition<Params, IdleResult> {
  function fetchTree(
    device: DeviceInfo,
    services: Record<string, unknown>,
    isTvOs: boolean,
    androidIsTv: boolean,
    budgetMs: number
  ): Promise<DescribeTreeData> {
    if (device.platform === "ios") {
      return describeIos(registry, device, {}, { isTvOs });
    }
    if (device.platform === "android") {
      return describeAndroid(registry, device.id, undefined, androidIsTv);
    }
    if (device.platform === "harmony") {
      return describeHarmony(harmonyConnectKey(device.id), budgetMs);
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
${DEFAULT_TIMEOUT_MS}ms) is reached. Returns { settled, waitedMs, polls }, plus a note whenever the wait ended somewhere
other than a screen that plainly settled. A settled=false without a note is the ordinary one: the screen kept changing
for the whole timeout. With one, the note says the tree read failed (a device that went away, not a screen that never
went still) or what the last read said about itself — a degraded accessibility tree, a panel that is off, an app
needing a restart before native inspection can see it. On settled=true it instead means the tree it
settled on is not the whole live screen: a suspended HarmonyOS panel settles instantly on its last composited frame and
taps land nowhere until it is woken, and a Chromium page past the walker's node budget settles on a partial tree. Read
the note before acting on what settled.
Use after a launch/navigation to wait for the UI to render before screenshotting or tapping.`,
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
      else if (device.platform === "harmony") await ensureDeps(harmonyRequires);

      // Resolved once, outside the poll loop, like `isTvOs` — an unlisted
      // serial's TV probe is never cached, so leaving it inside
      // `describeAndroid` would spawn `adb devices` per poll.
      const isTvOs = device.platform === "ios" && (await isTvOsSimulator(device.id));
      const androidIsTv = device.platform === "android" && (await isAndroidTv(device.id));
      const minStableMs = params.minStableMs ?? DEFAULT_MIN_STABLE_MS;

      let stableSignature: string | undefined;
      let stableSince = 0;

      const poll = await pollDescribeTree<true>({
        fetchTree: (budgetMs) => fetchTree(device, services, isTvOs, androidIsTv, budgetMs),
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

      // A suspended HarmonyOS panel keeps dumping its last composited frame,
      // which is maximally still and so settles at once, and a truncated
      // Chromium tree stops changing because the rest of the page was never
      // walked. `await-ui-element` reports the same hints, and the same
      // caveats on its own timeout note, off the same reads; without them the
      // two wait tools disagree about a screen they both just looked at.
      const note = idleNote(poll);
      return {
        settled: poll.result === true,
        waitedMs: poll.elapsedMs,
        polls: poll.polls,
        ...(note ? { note } : {}),
      };
    },
  };
}
