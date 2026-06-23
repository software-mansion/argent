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
import type { DescribeNode } from "../describe/contract";
import { describeIos, iosRequires } from "../describe/platforms/ios";
import { describeAndroid, androidRequires } from "../describe/platforms/android";
import { describeChromium } from "../describe/platforms/chromium";

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
      .optional()
      .describe(
        "Target device id from `list-devices`. Required for every condition except `time`."
      ),
    condition: z
      .enum(["time", "exists", "visible", "hidden", "text"])
      .describe(
        "What to wait for. `time`: sleep durationMs. `exists`: selector is anywhere in the tree. " +
          "`visible`: selector is present with a non-zero on-screen frame. `hidden`: selector is absent " +
          "or zero-area. `text`: the element matched by selector contains expectedText."
      ),
    durationMs: z
      .number()
      .int()
      .positive()
      .max(120_000)
      .optional()
      .describe("For condition `time`: how long to sleep, in milliseconds (max 120000)."),
    selector: selectorSchema
      .optional()
      .describe("Element to match. Required for exists/visible/hidden/text."),
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
  .refine((p) => p.condition !== "time" || p.durationMs !== undefined, {
    message: "condition `time` requires durationMs",
    path: ["durationMs"],
  })
  .refine((p) => p.condition === "time" || p.udid !== undefined, {
    message: "this condition requires udid",
    path: ["udid"],
  })
  .refine((p) => p.condition === "time" || p.selector !== undefined, {
    message: "this condition requires a selector",
    path: ["selector"],
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

// Every node matching the selector, in DFS pre-order. A substring selector can
// match several nodes — e.g. on Android a zero-area container kept only for its
// visible children plus the visible leaf you actually meant — so conditions are
// evaluated across the whole set rather than the first hit (see evaluateMatches).
// Exported for unit tests.
export function findAll(
  node: DescribeNode,
  selector: Selector,
  acc: DescribeNode[] = []
): DescribeNode[] {
  if (matchNode(node, selector)) acc.push(node);
  for (const child of node.children) findAll(child, selector, acc);
  return acc;
}

// describe prunes off-screen / zero-size nodes on Chromium and the compressed
// Android dump, and iOS AX only returns on-screen leaves — so a non-zero frame
// area is a cheap, reliable proxy for "visible".
function isVisible(node: DescribeNode): boolean {
  return node.frame.width > 0 && node.frame.height > 0;
}

// Evaluate the condition over ALL elements matching the selector, not just the
// first in tree order. `visible` holds if ANY match is on-screen; `hidden` only
// if NONE is — so a zero-area match that sorts before a visible one can't flip
// the verdict the wrong way. `text` deliberately inspects the first match: it
// asserts a specific element's content, and aggregating would hide which element
// the selector actually landed on.
export function evaluateMatches(params: Params, matches: DescribeNode[]): boolean {
  switch (params.condition) {
    case "exists":
      return matches.length > 0;
    case "visible":
      return matches.some(isVisible);
    case "hidden":
      return !matches.some(isVisible);
    case "text": {
      const first = matches[0];
      return first !== undefined && includesCI(nodeText(first), params.expectedText!);
    }
    default:
      return false;
  }
}

// Resolves true if the delay elapsed, false if `signal` aborted first. Lets the
// poll loop and the `time` sleep stop promptly when the caller cancels the
// request instead of blocking out the remaining interval / duration.
function sleepOrAbort(ms: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve(false);
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function timeoutNote(params: Params, lastTree: DescribeNode | null, fetchError?: string): string {
  if (fetchError) return `last tree fetch failed: ${fetchError}`;
  const matches = lastTree ? findAll(lastTree, params.selector!) : [];
  switch (params.condition) {
    case "text": {
      const first = matches[0];
      return first
        ? `element matched but its text was "${nodeText(first)}" (wanted to contain "${params.expectedText}")`
        : "no element matched the selector before timeout";
    }
    case "hidden":
      return "an element matching the selector was still visible at timeout";
    case "visible":
      return matches.length > 0
        ? "element(s) matched but none was visible (zero-area frame) before timeout"
        : "no element matched the selector before timeout";
    default:
      return "no element matched the selector before timeout";
  }
}

// ── Tool ─────────────────────────────────────────────────────────────────

// `wait` is a factory (like `describe`) because the iOS / Android tree fetch
// resolves the AX / android-devtools services through the registry rather than
// through the tool's own services() declaration. Only the Chromium CDP session
// flows in as a normal service.
export function createWaitTool(registry: Registry): ToolDefinition<Params, WaitResult> {
  async function fetchTree(
    device: DeviceInfo,
    params: Params,
    services: Record<string, unknown>
  ): Promise<DescribeNode> {
    if (device.platform === "ios") {
      return (await describeIos(registry, device, { bundleId: params.bundleId })).tree;
    }
    if (device.platform === "android") {
      return (await describeAndroid(registry, device.id)).tree;
    }
    return (await describeChromium(services.chromium as ChromiumCdpApi)).tree;
  }

  return {
    id: "wait",
    description: `Block until a UI condition is satisfied or a timeout elapses, so you don't have to poll screenshot/describe yourself.

Conditions:
  time     — sleep durationMs (no device needed).
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
      "wait poll until visible hidden exists text appears disappears timeout element condition sleep delay settle",
    longRunning: true,
    zodSchema,
    capability,
    services: (params): Record<string, ServiceRef> => {
      if (params.condition === "time" || !params.udid) return {};
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

      // Pure time wait — no device, no tree.
      if (params.condition === "time") {
        const completed = await sleepOrAbort(params.durationMs!, signal);
        return completed ? { success: true, elapsed: Date.now() - start } : cancelled();
      }

      const device = resolveDevice(params.udid!);
      assertSupported("wait", capability, device);
      if (device.platform === "ios") await ensureDeps(iosRequires);
      else if (device.platform === "android") await ensureDeps(androidRequires);

      const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const pollIntervalMs = params.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
      const deadline = start + timeoutMs;
      const selector = params.selector!;

      let lastTree: DescribeNode | null = null;
      let fetchError: string | undefined;
      // For `hidden`: did the selector ever match across polls? Distinguishes
      // "the element was there and disappeared" from "the selector never matched
      // at all" — otherwise a typo'd selector is an instant false-positive.
      let everMatched = false;

      for (;;) {
        if (signal?.aborted) return cancelled();
        try {
          lastTree = await fetchTree(device, params, services);
          fetchError = undefined;
          const matches = findAll(lastTree, selector);
          if (matches.length > 0) everMatched = true;
          if (evaluateMatches(params, matches)) {
            const result: WaitResult = { success: true, elapsed: Date.now() - start };
            if (params.condition === "hidden" && !everMatched) {
              result.note =
                "condition met immediately — the selector never matched any element, " +
                "so it may have already been hidden before the wait, or the selector is wrong";
            }
            return result;
          }
        } catch (err) {
          fetchError = err instanceof Error ? err.message : String(err);
        }
        if (Date.now() >= deadline) break;
        // Clamp the poll sleep to the time left before the deadline so a large
        // pollIntervalMs can't overshoot timeoutMs — without this, a wait with
        // timeoutMs 1000 / pollIntervalMs 3000 would run ~3s. The next iteration
        // then performs one final poll at the deadline before the loop breaks, so
        // the condition still gets its full time budget; overshoot is bounded to
        // a single tree fetch.
        const remaining = deadline - Date.now();
        if (!(await sleepOrAbort(Math.min(pollIntervalMs, remaining), signal))) return cancelled();
      }

      return {
        success: false,
        elapsed: Date.now() - start,
        note: timeoutNote(params, lastTree, fetchError),
      };
    },
  };
}
