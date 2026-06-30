import { z } from "zod";
import type {
  Registry,
  ServiceRef,
  ToolCapability,
  ToolContext,
  ToolDefinition,
} from "@argent/registry";
import { chromiumCdpRef } from "../../blueprints/chromium-cdp";
import { resolveDevice } from "../../utils/device-info";
import { isTvOsSimulator } from "../../utils/ios-devices";
import { assertSupported } from "../../utils/capability";
import { ensureDeps } from "../../utils/check-deps";
import { sleepOrAbort, settleWithin } from "../../utils/timing";
import type { DescribeNode, DescribeTreeData } from "../describe/contract";
import {
  includesCI,
  isVisible,
  nodeText,
  firstInReadingOrder,
  walkMatches,
} from "../describe/match";
import { fetchDescribeTree, appendDescribeDiagnostics } from "../describe/fetch-tree";
import { iosRequires } from "../describe/platforms/ios";
import { androidRequires } from "../describe/platforms/android";

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
          "or zero-area. `text`: the first match in reading order (topmost) contains expectedText — if a loose " +
          "selector hits several elements, only that topmost one is checked, so narrow it to target the intended element."
      ),
    selector: selectorSchema.describe("Element to match (text / identifier / role)."),
    expectedText: z
      .string()
      .min(1)
      .optional()
      .describe(
        "For condition `text`: case-insensitive substring the first matched element (topmost in reading order) must contain."
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
//
// The pure tree primitives (`includesCI`, `nodeText`, `isVisible`,
// `firstInReadingOrder`, the root-excluding `walkMatches`) live in
// `../describe/match` so `find` reuses the same hardened root-exclusion and
// reading-order rules. Only the selector-shaped predicate stays local.

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

// Every node matching the selector in the subtree, EXCLUDING the synthetic root
// (see `walkMatches`). A substring selector can match several real nodes, so
// conditions are evaluated across the whole set (see evaluateMatches). Exported
// for unit tests.
export function findAll(root: DescribeNode, selector: Selector): DescribeNode[] {
  return walkMatches(root, (n) => matchNode(n, selector));
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

// A degraded / blind read: the tree came back EMPTY and that emptiness is not
// trustworthy evidence the element is gone, so we must not let `hidden` (the only
// condition that resolves true on an empty tree) resolve positively off it. Two
// ways an empty tree is untrustworthy:
//   - the adapter flagged it as unreliable: iOS AX down or native injection
//     pending → `describeIos` returns an empty tree plus a hint / should_restart
//     instead of throwing. Android / Chromium never set these flags.
//   - the selector matched on an EARLIER poll (`everMatched`) yet the whole tree
//     is now empty. A genuinely-hidden element leaves the rest of the screen
//     behind; a wholly empty tree after we'd already read content is a transient
//     blank frame mid-navigation, not the element being hidden. This is the only
//     guard that fires on Android / Chromium, where an empty tree is otherwise
//     taken at face value — without it an `everMatched` `hidden` wait would
//     falsely resolve on a one-frame blink and release a gated tap against a
//     screen that only briefly went blank.
function isBlindRead(data: DescribeTreeData, everMatched: boolean): boolean {
  if (data.tree.children.length > 0) return false;
  return Boolean(data.hint || data.should_restart || everMatched);
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
  return appendDescribeDiagnostics(base, lastData);
}

// ── Tool ─────────────────────────────────────────────────────────────────

// `await-ui-element` is a factory (like `describe`) because the iOS / Android
// tree fetch resolves the AX / android-devtools services through the registry
// rather than through the tool's own services() declaration. Only the Chromium
// CDP session flows in as a normal service.
export function createAwaitUiElementTool(registry: Registry): ToolDefinition<Params, WaitResult> {
  return {
    id: AWAIT_UI_ELEMENT_TOOL_ID,
    description: `Block until a UI element reaches an expected state or a timeout elapses, so you don't have to poll screenshot/describe yourself.

Conditions:
  exists   — the selector matches an element anywhere in the tree.
  visible  — the selector matches an element with a non-zero on-screen frame.
  hidden   — the selector matches nothing, or only a zero-area element (e.g. a spinner that disappeared).
  text     — the FIRST match in reading order (topmost, then leftmost) contains expectedText (case-insensitive
             substring). A loose selector can match several elements; only that topmost one is inspected, so if a
             lower match is the one holding the text the wait still reports failure — narrow the selector to target it.

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

      const device = resolveDevice(params.udid);
      assertSupported(AWAIT_UI_ELEMENT_TOOL_ID, capability, device);
      if (device.platform === "ios") await ensureDeps(iosRequires);
      else if (device.platform === "android") await ensureDeps(androidRequires);

      // Resolve once, outside the poll loop — re-probing `xcrun` per fetch would
      // blow the per-fetch budget for a fake UDID that never caches.
      const isTvOs = device.platform === "ios" && (await isTvOsSimulator(device.id));

      // Start the wait clock after setup so its fixed cost isn't charged against
      // timeoutMs (the deadline should bound polling, not device resolution).
      const start = Date.now();
      const cancelled = (): WaitResult => ({
        success: false,
        elapsed: Date.now() - start,
        note: "wait was cancelled before the condition was met",
      });

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
        const settled = await settleWithin(
          // Pass the pre-resolved tvOS verdict so a poll loop doesn't re-shell
          // `xcrun` each iteration (isTvOs is resolved once above the loop).
          fetchDescribeTree(registry, device, params, services, { isTvOs }),
          remaining,
          signal
        );

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
          const matches = findAll(data.tree, selector);
          if (matches.length > 0) everMatched = true;
          // Compute `blind` after `everMatched` so an empty tree that follows an
          // earlier match counts as a transient blank, not a confirmed read.
          const blind = isBlindRead(data, everMatched);
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
