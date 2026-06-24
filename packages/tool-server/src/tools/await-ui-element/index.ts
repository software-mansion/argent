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
import { assertSupported } from "../../utils/capability";
import { ensureDeps } from "../../utils/check-deps";
import { sleepOrAbort } from "../../utils/timing";
import type { DescribeNode, DescribeTreeData } from "../describe/contract";
import { describeIos, iosRequires } from "../describe/platforms/ios";
import { describeAndroid, androidRequires } from "../describe/platforms/android";
import { describeChromium } from "../describe/platforms/chromium";

// Tool id. Exported so run-sequence can both allow this tool and recognise its
// result shape (it returns { success: false } instead of throwing on an unmet
// condition) without hard-coding the string in two places.
export const AWAIT_UI_ELEMENT_TOOL_ID = "await-ui-element";

// True when `result` is an unmet `await-ui-element` outcome — it reports a
// timed-out condition by returning { success: false } rather than throwing.
// The orchestrating tools (`run-sequence`, `flow-execute`) use this to STOP a
// sequence at a wait that never held, instead of running the next step (often a
// tap) blind against a screen that never settled. Shared here so the result
// shape lives in one place. Result is `unknown` because it crosses the registry
// boundary untyped.
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

// A selector locates a node in the accessibility / DOM tree returned by
// `describe`. Every provided field must match (logical AND); matching is a
// case-insensitive substring test so the agent doesn't need the exact label.
const selectorSchema = z
  .object({
    text: z
      .string()
      .min(1)
      .optional()
      .describe("Case-insensitive substring of the element's visible label or value."),
    identifier: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Case-insensitive substring of the element's identifier (accessibilityIdentifier / resource-id / testid)."
      ),
    role: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Case-insensitive substring of the element's role (e.g. AXButton, button, TextView)."
      ),
  })
  .refine((s) => Boolean(s.text || s.identifier || s.role), {
    message: "selector needs at least one of text, identifier, or role",
  });

type Selector = z.infer<typeof selectorSchema>;

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
          "or zero-area. `text`: the element matched by selector contains expectedText."
      ),
    selector: selectorSchema.describe("Element to match (text / identifier / role)."),
    expectedText: z
      .string()
      .min(1)
      .optional()
      .describe(
        "For condition `text`: case-insensitive substring the matched element must contain."
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

interface WaitResult {
  success: boolean;
  elapsed: number;
  note?: string;
}

const capability: ToolCapability = {
  apple: { simulator: true, device: true },
  android: { emulator: true, device: true, unknown: true },
  chromium: { app: true },
};

// ── Tree matching ────────────────────────────────────────────────────────

function nodeText(node: DescribeNode): string {
  return [node.label, node.value].filter(Boolean).join(" ");
}

function includesCI(haystack: string | undefined, needle: string): boolean {
  return Boolean(haystack) && haystack!.toLowerCase().includes(needle.toLowerCase());
}

function matchNode(node: DescribeNode, selector: Selector): boolean {
  if (selector.text !== undefined) {
    if (!includesCI(node.label, selector.text) && !includesCI(node.value, selector.text)) {
      return false;
    }
  }
  if (selector.identifier !== undefined && !includesCI(node.identifier, selector.identifier)) {
    return false;
  }
  if (selector.role !== undefined && !includesCI(node.role, selector.role)) {
    return false;
  }
  return true;
}

function collectMatches(node: DescribeNode, selector: Selector, acc: DescribeNode[]): void {
  if (matchNode(node, selector)) acc.push(node);
  for (const child of node.children) collectMatches(child, selector, acc);
}

// Every node matching the selector in the subtree, EXCLUDING `root` itself.
// `root` is the synthetic full-screen container every describe adapter injects
// (iOS `AXGroup`, Android `hierarchy`/`Screen`, Chromium `html`; frame
// `0,0,1,1`). `describe` renders it only as a non-selectable `ROOT` header line
// — never as a matchable element — and its `1×1` frame always passes
// `isVisible`. Matching it would let a role selector that is a substring of the
// root role (e.g. `role:"AXGroup"`, also iOS's default role for untyped
// elements) satisfy `visible`/`exists` on any screen — including an empty AX
// tree — and make `hidden` impossible. So we mirror format-tree, which walks
// `root.children`, never `root`. A substring selector can still match several
// real nodes, so conditions are evaluated across the whole set (see
// evaluateMatches). Exported for unit tests.
export function findAll(root: DescribeNode, selector: Selector): DescribeNode[] {
  const acc: DescribeNode[] = [];
  for (const child of root.children) collectMatches(child, selector, acc);
  return acc;
}

// describe prunes off-screen / zero-size nodes on Chromium and the compressed
// Android dump, and iOS AX only returns on-screen leaves — so a non-zero frame
// area is a cheap, reliable proxy for "visible".
function isVisible(node: DescribeNode): boolean {
  return node.frame.width > 0 && node.frame.height > 0;
}

// The describe tool renders iOS leaves sorted into reading order (top-to-bottom,
// then left-to-right) via format-tree's renderFlat, so the element the agent
// "sees first" is the one with the smallest (y, then x). The `text` verdict and
// the timeout note key off a single element, so pick that same one — otherwise
// they'd refer to whichever node DFS happened to reach first, which on iOS can
// differ from what the agent read at the top of describe. Returns undefined for
// an empty set.
function firstInReadingOrder(matches: DescribeNode[]): DescribeNode | undefined {
  let best: DescribeNode | undefined;
  for (const n of matches) {
    if (
      best === undefined ||
      n.frame.y < best.frame.y ||
      (n.frame.y === best.frame.y && n.frame.x < best.frame.x)
    ) {
      best = n;
    }
  }
  return best;
}

// Evaluate the condition over ALL elements matching the selector, not just the
// first in tree order. `visible` holds if ANY match is on-screen; `hidden` only
// if NONE is — so a zero-area match that sorts before a visible one can't flip
// the verdict the wrong way. `text` deliberately inspects the first match in
// reading order: it asserts a specific element's content, and aggregating would
// hide which element the selector actually landed on.
export function evaluateMatches(params: Params, matches: DescribeNode[]): boolean {
  switch (params.condition) {
    case "exists":
      return matches.length > 0;
    case "visible":
      return matches.some(isVisible);
    case "hidden":
      return !matches.some(isVisible);
    case "text": {
      const first = firstInReadingOrder(matches);
      return first !== undefined && includesCI(nodeText(first), params.expectedText!);
    }
    default:
      return false;
  }
}

// A degraded / blind read: the tree came back EMPTY *and* the adapter flagged it
// as unreliable (iOS AX down or native injection pending → `describeIos` returns
// an empty tree plus a hint / should_restart instead of throwing). Absence in
// such a tree is not evidence the element is gone, so we must not let `hidden`
// resolve positively off it — otherwise "AX is down" reads as "element hidden".
function isBlindRead(data: DescribeTreeData): boolean {
  return data.tree.children.length === 0 && Boolean(data.hint || data.should_restart);
}

// Fold an unreliable-read hint / restart prompt onto a timeout note so the agent
// learns the real cause (degraded AX, native injection pending) rather than a
// bare "no element matched".
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
      const first = firstInReadingOrder(matches);
      base = first
        ? `element matched but its text was "${nodeText(first)}" (wanted to contain "${params.expectedText}")`
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

// ── Per-fetch deadline / abort ─────────────────────────────────────────────

type Settled<T> =
  | { type: "value"; value: T }
  | { type: "error"; error: string }
  | { type: "timeout" }
  | { type: "aborted" };

// Race a tree fetch against the remaining wait budget and the abort signal. The
// underlying describe fetch isn't cancellable (no AbortSignal reaches adb /
// AXRuntime), so a slow or hung fetch — e.g. the Android `uiautomator dump`
// fallback, which allows up to 20s — would otherwise blow past `timeoutMs` and
// ignore an abort that arrives mid-fetch. We can't kill the orphaned fetch, but
// we stop waiting on it; its eventual settle is consumed here (handlers attached
// up front) so it can't surface as an unhandled rejection.
function settleWithin<T>(p: Promise<T>, ms: number, signal?: AbortSignal): Promise<Settled<T>> {
  return new Promise((resolve) => {
    let done = false;
    const teardown: Array<() => void> = [];
    const finish = (r: Settled<T>) => {
      if (done) return;
      done = true;
      for (const fn of teardown) fn();
      resolve(r);
    };
    // Attach the settle handlers up front so a late settle from an abandoned
    // fetch is always consumed (no unhandled rejection) even after we've moved on.
    p.then(
      (value) => finish({ type: "value", value }),
      (err) => finish({ type: "error", error: err instanceof Error ? err.message : String(err) })
    );
    if (signal?.aborted) return finish({ type: "aborted" });
    const onAbort = () => finish({ type: "aborted" });
    signal?.addEventListener("abort", onAbort, { once: true });
    teardown.push(() => signal?.removeEventListener("abort", onAbort));
    const timer = setTimeout(() => finish({ type: "timeout" }), Math.max(0, ms));
    teardown.push(() => clearTimeout(timer));
  });
}

// ── Tool ─────────────────────────────────────────────────────────────────

// `await-ui-element` is a factory (like `describe`) because the iOS / Android
// tree fetch resolves the AX / android-devtools services through the registry
// rather than through the tool's own services() declaration. Only the Chromium
// CDP session flows in as a normal service.
export function createAwaitUiElementTool(registry: Registry): ToolDefinition<Params, WaitResult> {
  async function fetchTree(
    device: DeviceInfo,
    params: Params,
    services: Record<string, unknown>
  ): Promise<DescribeTreeData> {
    if (device.platform === "ios") {
      return describeIos(registry, device, { bundleId: params.bundleId });
    }
    if (device.platform === "android") {
      return describeAndroid(registry, device.id);
    }
    return describeChromium(services.chromium as ChromiumCdpApi);
  }

  return {
    id: AWAIT_UI_ELEMENT_TOOL_ID,
    description: `Block until a UI element reaches an expected state or a timeout elapses, so you don't have to poll screenshot/describe yourself.

Conditions:
  exists   — the selector matches an element anywhere in the tree.
  visible  — the selector matches an element with a non-zero on-screen frame.
  hidden   — the selector matches nothing, or only a zero-area element (e.g. a spinner that disappeared).
  text     — the element matched by the selector contains expectedText (case-insensitive substring).

The selector is { text?, identifier?, role? }; every provided field must match (case-insensitive substring).
text matches the element's label or value. It polls the same accessibility / DOM tree as \`describe\`
(iOS AXRuntime, Android uiautomator, Chromium CDP) every pollIntervalMs (default ${DEFAULT_POLL_INTERVAL_MS}ms)
until timeoutMs (default ${DEFAULT_TIMEOUT_MS}ms).

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
      const start = Date.now();
      const cancelled = (): WaitResult => ({
        success: false,
        elapsed: Date.now() - start,
        note: "wait was cancelled before the condition was met",
      });

      const device = resolveDevice(params.udid);
      assertSupported(AWAIT_UI_ELEMENT_TOOL_ID, capability, device);
      if (device.platform === "ios") await ensureDeps(iosRequires);
      else if (device.platform === "android") await ensureDeps(androidRequires);

      const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const pollIntervalMs = params.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
      const deadline = start + timeoutMs;
      const selector = params.selector;

      let lastTree: DescribeNode | null = null;
      let lastData: DescribeTreeData | null = null;
      let fetchError: string | undefined;
      // For `hidden`: did the selector ever match across polls? Distinguishes
      // "the element was there and disappeared" from "the selector never matched
      // at all" — otherwise a typo'd selector is an instant false-positive.
      let everMatched = false;

      for (;;) {
        if (signal?.aborted) return cancelled();

        // Bound each fetch to the time left before the deadline so a slow / hung
        // describe can't overshoot timeoutMs, and an abort mid-fetch is observed
        // promptly instead of after the fetch resolves.
        const remaining = Math.max(0, deadline - Date.now());
        const settled = await settleWithin(fetchTree(device, params, services), remaining, signal);

        if (settled.type === "aborted") return cancelled();
        if (settled.type === "timeout") {
          // The fetch outran the time left before the deadline. Two cases:
          //  - We never got a usable tree (a genuinely slow/hung fetch, e.g. the
          //    Android 20s dump under a small timeoutMs) → report that as the
          //    cause so the agent knows the screen was never read.
          //  - We already have a tree from an earlier poll and this final fetch
          //    merely straddled the deadline (describe latency varies) → fall
          //    through to the normal condition-not-met note built from lastTree,
          //    which is far more useful than "fetch did not complete".
          if (lastTree === null) {
            fetchError ??= `tree fetch did not complete within the ${timeoutMs}ms wait budget`;
          }
          break;
        }
        if (settled.type === "error") {
          fetchError = settled.error;
        } else {
          const data = settled.value;
          lastData = data;
          lastTree = data.tree;
          fetchError = undefined;
          const blind = isBlindRead(data);
          const matches = findAll(data.tree, selector);
          if (matches.length > 0) everMatched = true;
          if (!blind && evaluateMatches(params, matches)) {
            const result: WaitResult = { success: true, elapsed: Date.now() - start };
            if (params.condition === "hidden" && !everMatched) {
              result.note =
                "condition met immediately — the selector never matched any element, " +
                "so it may have already been hidden before the wait, or the selector is wrong";
            }
            return result;
          }
        }

        if (Date.now() >= deadline) break;
        // Clamp the poll sleep to the time left before the deadline so a large
        // pollIntervalMs can't overshoot timeoutMs. The next iteration then does
        // one final poll at the deadline before the loop breaks, so the
        // condition still gets its full time budget.
        const sleepMs = Math.min(pollIntervalMs, Math.max(0, deadline - Date.now()));
        if (!(await sleepOrAbort(sleepMs, signal))) return cancelled();
      }

      return {
        success: false,
        elapsed: Date.now() - start,
        note: timeoutNote(params, lastTree, fetchError, lastData),
      };
    },
  };
}
