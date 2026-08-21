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
import { describeIos, iosRequires, PHYSICAL_IOS_AX_LIMIT } from "../describe/platforms/ios";
import { describeAndroid, androidRequires } from "../describe/platforms/android";
import { describeChromium } from "../describe/platforms/chromium";

export const AWAIT_SCREEN_IDLE_TOOL_ID = "await-screen-idle";

const DEFAULT_TIMEOUT_MS = 3000;
// A physical iPhone's accessibility read is a round trip over the CoreDevice
// tunnel and takes ~2s, against the few milliseconds a simulator or emulator
// needs. Settling takes at least two reads, so the 3s default would allow one
// or two polls and report `settled: false` on a screen that never moved —
// measured on an iPhone 15 / iOS 27, where a still Safari page needed 4.3s.
// An explicit `timeoutMs` still wins; this only moves the default.
const DEFAULT_DEVICE_TIMEOUT_MS = 15000;
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
      `Max time to wait for the screen to settle before giving up (default ${DEFAULT_TIMEOUT_MS}, or ${DEFAULT_DEVICE_TIMEOUT_MS} on a physical iPhone, whose reads are far slower).`
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
  /** Why the answer is what it is, when `settled: false` has a knowable cause. */
  note?: string;
}

// Sorting the signature cancels the CoreDevice read's rotation only while the
// whole screen fits inside one read. `describeIos` asks for at most
// PHYSICAL_IOS_AX_LIMIT elements and the audit walk starts at the device's
// VoiceOver cursor, advancing one step per read — so past that ceiling each poll
// covers a *different window* of the screen rather than a rotation of the same
// set, and no amount of sorting makes two windows equal. Stillness is then not
// decidable from the content at all, and polling to the deadline only turns that
// into an unexplained `settled: false` on a screen that never moved.
const TRUNCATED_READ_NOTE =
  `the screen has at least ${PHYSICAL_IOS_AX_LIMIT} accessibility elements, which is the most one ` +
  `CoreDevice read returns; because each read starts one element further along, consecutive reads ` +
  `cover different parts of the screen and stillness cannot be decided from them. Use screenshot, ` +
  `or await-ui-element with condition "exists" for something specific.`;

const capability: ToolCapability = {
  apple: { simulator: true, device: true },
  android: { emulator: true, device: true, unknown: true },
  chromium: { app: true },
};

// A cheap fingerprint of the screen: role + label + value + frame (rounded to
// 1% of the screen) for every node below the synthetic root. Rounding tolerates
// sub-pixel jitter while still catching real motion (a slide/fade animation),
// so an unchanged signature means the screen has genuinely stopped moving.
//
// `orderAndFrameFree` drops both the ordering and the frames, for the physical
// iPhone: its accessibility read starts from the device's VoiceOver cursor and
// advances it, so consecutive reads return the same elements rotated by one,
// each with a frame resynthesised from its new list position. Sorting the
// role/label/value parts and dropping frames cancels exactly those two
// distortions — verified against a live device, where three consecutive reads
// of one still screen gave three different orderings and one identical sorted
// signature — as long as the whole screen fits in one read; past
// PHYSICAL_IOS_AX_LIMIT the reads are windows over different parts of it and
// nothing can cancel that, which is why the caller checks the count before
// consulting this at all (see TRUNCATED_READ_NOTE). The cost is that motion is
// only visible through the accessibility content: an animation that moves pixels
// without changing any element's label/value (a spinner, an indeterminate
// progress bar) reads as settled.
function treeSignature(root: DescribeNode, orderAndFrameFree = false): string {
  const round = (n: number) => Math.round(n * 100) / 100;
  const parts: string[] = [];
  const walk = (node: DescribeNode): void => {
    const f = node.frame;
    const frame = orderAndFrameFree
      ? ""
      : `|${round(f.x)},${round(f.y)},${round(f.width)},${round(f.height)}`;
    parts.push(`${node.role}|${node.label ?? ""}|${node.value ?? ""}${frame}`);
    for (const child of node.children) walk(child);
  };
  for (const child of root.children) walk(child);
  if (orderAndFrameFree) parts.sort();
  return parts.join("\n");
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
        result.settled ? "Screen settled" : "Screen did not settle before timeout",
      failedMsg: ({ failureSignal }) =>
        `Failed while waiting for screen to settle: ${failureSignal.error_code}`,
    },
    description: `Block until the screen has rendered content and stopped changing, or a timeout elapses.

Polls the same accessibility / DOM tree as \`describe\` every pollIntervalMs (default ${DEFAULT_POLL_INTERVAL_MS}ms) until it
has content and that content holds identical for minStableMs (default ${DEFAULT_MIN_STABLE_MS}ms), or timeoutMs (default
${DEFAULT_TIMEOUT_MS}ms) is reached. Returns { settled, waitedMs, polls, note? } — settled=false means the screen never went
still before the timeout, and \`note\` says why when the cause is known. Use after a launch/navigation to wait for the UI to render before screenshotting or tapping.
On a physical iPhone each read is a ~2s round trip, so the default timeout there is ${DEFAULT_DEVICE_TIMEOUT_MS}ms; its accessibility
read also carries no usable element geometry, so stillness means the on-screen elements stopped changing and an
animation that moves only pixels (a spinner) reads as settled. A screen with more elements than one CoreDevice read
returns cannot be judged still at all; a wait that runs out after such a read says so in \`note\`.`,
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
      // A physical iPhone answers false without a probe (see isTvOsSimulator,
      // which short-circuits a hardware UDID), so no extra narrowing is needed
      // here — same as the screenshot and screen-recording-start call sites.
      const isTvOs = device.platform === "ios" && (await isTvOsSimulator(device.id));
      const androidIsTv = device.platform === "android" && (await isAndroidTv(device.id));
      const minStableMs = params.minStableMs ?? DEFAULT_MIN_STABLE_MS;
      const rotatingRead = device.platform === "ios" && device.kind === "device";

      let stableSignature: string | undefined;
      let stableSince = 0;
      // Whether any read came back at the CoreDevice ceiling — see
      // TRUNCATED_READ_NOTE. Only consulted once the wait has failed.
      let sawFullRead = false;

      const poll = await pollDescribeTree<true>({
        fetchTree: () => fetchTree(device, services, isTvOs, androidIsTv),
        timeoutMs:
          params.timeoutMs ?? (rotatingRead ? DEFAULT_DEVICE_TIMEOUT_MS : DEFAULT_TIMEOUT_MS),
        pollIntervalMs: params.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
        signal: ctx?.signal,
        onSample: (data, nowMs) => {
          if (rotatingRead && data.tree.children.length >= PHYSICAL_IOS_AX_LIMIT) {
            sawFullRead = true;
          }
          // An empty tree (blank/loading, or a degraded AX read) is not settled.
          if (data.tree.children.length === 0) {
            stableSignature = undefined;
            stableSince = 0;
            return { done: false };
          }
          const signature = treeSignature(data.tree, rotatingRead);
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
      return {
        settled,
        waitedMs: poll.elapsedMs,
        polls: poll.polls,
        ...(!settled && sawFullRead ? { note: TRUNCATED_READ_NOTE } : {}),
      };
    },
  };
}
