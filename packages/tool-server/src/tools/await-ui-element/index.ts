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
import { describeVega, vegaRequires } from "../describe/platforms/vega";
import {
  selectorSchema,
  nodeText,
  findAll,
  isVisible,
  firstInReadingOrder,
  evaluateCondition,
} from "../../utils/ui-tree-match";

// Exported so run-sequence can allowlist this tool without repeating the string.
export const AWAIT_UI_ELEMENT_TOOL_ID = "await-ui-element";

// True when `result` is a timed-out `await-ui-element`: an unmet condition is
// reported as { success: false } rather than thrown. `run-sequence` and
// `flow-execute` use this to stop a sequence instead of running the next step
// against a screen that never settled. `unknown` because the result crosses the
// registry boundary untyped.
export function isUnmetUiWaitResult(tool: string, result: unknown): boolean {
  return (
    tool === AWAIT_UI_ELEMENT_TOOL_ID &&
    typeof result === "object" &&
    result !== null &&
    (result as { success?: unknown }).success === false
  );
}

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_POLL_INTERVAL_MS = 400;

const zodSchema = z
  .object({
    udid: z
      .string()
      .min(1)
      .describe("Target device id from `list-devices` (iOS UDID, Android serial, or Chromium id)."),
    condition: z
      .enum(["exists", "visible", "hidden", "text"])
      .describe(
        "What to wait for. `exists`: selector is anywhere in the tree. " +
          "`visible`: selector is present with a non-zero on-screen frame. `hidden`: selector is absent " +
          "or zero-area. `text`: the first visible match in reading order (topmost), falling back to the first match overall if none is visible, " +
          "contains (or, with textMatch `equals`, exactly matches) " +
          "expectedText — if a loose selector hits several elements, only that one is checked, so narrow it to target the intended element."
      ),
    selector: selectorSchema.describe("Element to match (text / identifier / role)."),
    expectedText: z
      .string()
      .min(1)
      .optional()
      .describe(
        "For condition `text`: the string the first visible matched element (topmost in reading order; the first match overall if none is visible) must contain (default) or equal — see `textMatch`. Case-insensitive."
      ),
    textMatch: z
      .enum(["contains", "equals"])
      .optional()
      .describe(
        "For condition `text`: how expectedText is compared. `contains` (default) is a case-insensitive substring; `equals` is a case-insensitive full-string match."
      ),
    bundleId: z
      .string()
      .optional()
      .describe(
        "Optional iOS app bundle id, passed to the describe fallback (see `describe`). Ignored on Android / Chromium."
      ),
    timeoutMs: z
      .number()
      .int()
      .positive()
      .max(120_000)
      .optional()
      .describe(
        `Max time to wait for the condition before giving up (default ${DEFAULT_TIMEOUT_MS}).`
      ),
    pollIntervalMs: z
      .number()
      .int()
      .min(50)
      .max(5000)
      .optional()
      .describe(`How often to re-check the tree (default ${DEFAULT_POLL_INTERVAL_MS}).`),
  })
  .refine((p) => p.condition !== "text" || p.expectedText !== undefined, {
    message: "condition `text` requires expectedText",
    path: ["expectedText"],
  });

type Params = z.infer<typeof zodSchema>;

const conditionDescription = {
  exists: "appear",
  visible: "become visible",
  hidden: "become hidden",
  text: "match expected text",
} as const;

const conditionCompleted = {
  exists: "UI element appeared",
  visible: "UI element became visible",
  hidden: "UI element became hidden",
  text: "UI element matched expected text",
} as const;

interface WaitResult {
  success: boolean;
  elapsed: number;
  note?: string;
}

const capability: ToolCapability = {
  apple: { simulator: true, device: true },
  android: { emulator: true, device: true, unknown: true },
  chromium: { app: true },
  vega: { vvd: true },
};

// The matching engine lives in utils/ui-tree-match so the flow directives and
// recorder reuse the exact selector semantics; `evaluateMatches` is a
// params-shaped wrapper for this tool and its tests.
export function evaluateMatches(params: Params, matches: DescribeNode[]): boolean {
  return evaluateCondition(params.condition, params.expectedText, matches, params.textMatch);
}

// An empty tree is not trustworthy evidence the element is gone, so `hidden` —
// the only condition that resolves true on one — must not resolve off it when
// the adapter flagged the read (`describeIos` returns an empty tree plus a hint /
// should_restart instead of throwing), or when the selector matched on an earlier
// poll and the tree has since gone blank mid-navigation.
function isBlindRead(data: DescribeTreeData, everMatched: boolean): boolean {
  if (data.tree.children.length > 0) return false;
  return Boolean(data.hint || data.should_restart || everMatched);
}

// Fold the read's hint / restart prompt into the timeout note so the agent sees
// the real cause rather than a bare "no element matched".
function appendDiagnostics(base: string, lastData: DescribeTreeData | null): string {
  if (!lastData) return base;
  const extras: string[] = [];
  if (lastData.should_restart) {
    extras.push(
      "the foreground app may need a restart for native inspection — call restart-app and retry"
    );
  }
  if (lastData.hint) extras.push(lastData.hint);
  return extras.length === 0 ? base : `${base} (${extras.join("; ")})`;
}

function timeoutNote(
  params: Params,
  lastTree: DescribeNode | null,
  fetchError: string | undefined,
  lastData: DescribeTreeData | null
): string {
  if (fetchError) return `last tree fetch failed: ${fetchError}`;
  const matches = lastTree ? findAll(lastTree, params.selector) : [];
  let base: string;
  switch (params.condition) {
    case "text": {
      // Visible-first, mirroring evaluateCondition, so the note quotes the
      // element the check read.
      const first = firstInReadingOrder(matches.filter(isVisible)) ?? firstInReadingOrder(matches);
      const wanted = params.textMatch === "equals" ? "equal" : "contain";
      base = first
        ? `element matched but its text was "${nodeText(first)}" (wanted to ${wanted} "${params.expectedText}")`
        : "no element matched the selector before timeout";
      break;
    }
    case "hidden":
      base = matches.some(isVisible)
        ? "an element matching the selector was still visible at timeout"
        : "could not confirm the element is hidden — the UI tree was empty or unreadable at timeout";
      break;
    case "visible":
      base =
        matches.length > 0
          ? "element(s) matched but none was visible (zero-area frame) before timeout"
          : "no element matched the selector before timeout";
      break;
    default:
      base = "no element matched the selector before timeout";
  }
  return appendDiagnostics(base, lastData);
}

// A factory (like `describe`) because the iOS / Android tree fetch resolves the
// AX / android-devtools services through the registry rather than through the
// tool's own services() declaration. Only the Chromium CDP session flows in as a
// normal service.
export function createAwaitUiElementTool(registry: Registry): ToolDefinition<Params, WaitResult> {
  async function fetchTree(
    device: DeviceInfo,
    params: Params,
    services: Record<string, unknown>,
    isTvOs: boolean,
    androidIsTv: boolean
  ): Promise<DescribeTreeData> {
    if (device.platform === "ios") {
      return describeIos(registry, device, { bundleId: params.bundleId }, { isTvOs });
    }
    if (device.platform === "android") {
      return describeAndroid(registry, device.id, undefined, androidIsTv);
    }
    if (device.platform === "vega") {
      return describeVega(device.id);
    }
    return describeChromium(services.chromium as ChromiumCdpApi);
  }

  return {
    id: AWAIT_UI_ELEMENT_TOOL_ID,
    interaction: {
      startedMsg: ({ params }) =>
        `Waiting for UI element to ${conditionDescription[params.condition]}`,
      completedMsg: ({ params }) => conditionCompleted[params.condition],
      failedMsg: ({ failureSignal }) =>
        `Failed while waiting for UI element: ${failureSignal.error_code}`,
    },
    description: `Block until a UI element reaches an expected state or a timeout elapses, so you don't have to poll screenshot/describe yourself.

Conditions:
  exists   — the selector matches an element anywhere in the tree.
  visible  — the selector matches an element with a non-zero on-screen frame.
  hidden   — the selector matches nothing, or only a zero-area element (e.g. a spinner that disappeared).
  text     — the first VISIBLE match in reading order (topmost, then leftmost; falling back to the first match
             overall if none is visible) contains expectedText (case-insensitive substring), or exactly matches
             it when textMatch is \`equals\`. A loose selector can match several elements; only that one is
             inspected, so if a different match is the one holding the text the wait still reports failure —
             narrow the selector to target it.

The selector is { text?, identifier?, role? }; every provided field must match. text and role match as
case-insensitive substrings of the element's label/value and role; identifier matches exactly (case-insensitive),
also accepting the unqualified Android resource-id name ('submit' matches 'com.example.app:id/submit').
It polls the same accessibility / DOM tree as \`describe\`
(iOS AXRuntime, Android uiautomator, Chromium CDP, Vega automation toolkit) every pollIntervalMs
(default ${DEFAULT_POLL_INTERVAL_MS}ms) until timeoutMs (default ${DEFAULT_TIMEOUT_MS}ms).

Returns { success: boolean, elapsed: number } — success=false means the condition never held before the
timeout (a \`note\` then explains what was seen). Use this after a tap/navigation to wait for the next screen,
or before tapping an element that appears asynchronously.`,
    alwaysLoad: true,
    searchHint:
      "wait await poll until visible hidden exists text appears disappears timeout element condition settle",
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
      const signal = ctx?.signal;

      const device = resolveDevice(params.udid);
      assertSupported(AWAIT_UI_ELEMENT_TOOL_ID, capability, device);
      if (device.platform === "ios") await ensureDeps(iosRequires);
      else if (device.platform === "android") await ensureDeps(androidRequires);
      else if (device.platform === "vega") await ensureDeps(vegaRequires);

      // Resolve once, outside the poll loop: an id that isn't listed is never
      // cached, so probing per fetch would re-run `simctl list` / `adb devices`
      // on every poll.
      const isTvOs = device.platform === "ios" && (await isTvOsSimulator(device.id));
      const androidIsTv = device.platform === "android" && (await isAndroidTv(device.id));

      // Clock starts after setup so its fixed cost isn't charged to timeoutMs.
      const start = Date.now();
      const cancelled = (): WaitResult => ({
        success: false,
        elapsed: Date.now() - start,
        note: "wait was cancelled before the condition was met",
      });

      const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const pollIntervalMs = params.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
      const selector = params.selector;

      // Whether the selector ever matched, so a `hidden` wait that resolves on
      // the first poll can report it may have had nothing to wait for.
      let everMatched = false;

      const poll = await pollDescribeTree<WaitResult>({
        fetchTree: () => fetchTree(device, params, services, isTvOs, androidIsTv),
        timeoutMs,
        pollIntervalMs,
        signal,
        onSample: (data) => {
          const matches = findAll(data.tree, selector);
          if (matches.length > 0) everMatched = true;
          const blind = isBlindRead(data, everMatched);
          if (!blind && evaluateMatches(params, matches)) {
            const result: WaitResult = { success: true, elapsed: Date.now() - start };
            if (params.condition === "hidden" && !everMatched) {
              result.note =
                "condition met immediately — the selector never matched any element, " +
                "so it may have already been hidden before the wait, or the selector is wrong";
            }
            return { done: true, result };
          }
          return { done: false };
        },
      });

      if (poll.aborted) return cancelled();
      if (poll.result) return poll.result;

      return {
        success: false,
        elapsed: Date.now() - start,
        note: timeoutNote(params, poll.lastData?.tree ?? null, poll.lastError, poll.lastData),
      };
    },
  };
}
