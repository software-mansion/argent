import type { DeviceInfo, Registry, ToolContext } from "@argent/registry";
import { getDescribeTapPoint, type DescribeFrame } from "../describe/contract";
import {
  fetchTree,
  selectorToFrame,
  findAll,
  evaluateCondition,
  firstInReadingOrder,
  isVisible,
  nodeText,
  type Selector,
  type WaitCondition,
} from "../../utils/ui-tree-match";
import { sleepOrAbort } from "../../utils/timing";
import { invokeSubTool } from "../../utils/sub-invoke";
import { bindDeviceArgs } from "./flow-device";

/** Outcome of a selector directive: ok, or a machine-readable reason it failed. */
export interface DirectiveOutcome {
  ok: boolean;
  reason?: string;
}

const DEFAULT_ACTION_TIMEOUT_MS = 5000;
const POLL_INTERVAL_MS = 300;

// `assert` is a correctness check, not an open-ended wait — but UI updates after
// an action land asynchronously, so a strictly one-shot read races the
// re-render (e.g. a counter that increments a frame after a tap). Like
// Playwright's web-first assertions, assert retries for a short grace window so
// it absorbs that latency; a genuinely-false assertion still fails quickly.
const DEFAULT_ASSERT_TIMEOUT_MS = 500;

function describeSelector(s: Selector): string {
  return Object.entries(s)
    .map(([k, v]) => `${k}="${v}"`)
    .join(" ");
}

/**
 * Poll the describe tree until a visible element matches the selector, returning
 * its frame — or undefined if the deadline passes / the run is aborted.
 */
async function waitForFrame(
  registry: Registry,
  device: DeviceInfo,
  selector: Selector,
  signal?: AbortSignal
): Promise<DescribeFrame | undefined> {
  const deadline = Date.now() + DEFAULT_ACTION_TIMEOUT_MS;
  for (;;) {
    if (signal?.aborted) return undefined;
    try {
      const { tree } = await fetchTree(registry, device);
      const frame = selectorToFrame(tree, selector);
      if (frame) return frame;
    } catch {
      // transient describe failure mid-navigation — retry until the deadline
    }
    if (Date.now() >= deadline) return undefined;
    const sleepMs = Math.min(POLL_INTERVAL_MS, Math.max(0, deadline - Date.now()));
    if (!(await sleepOrAbort(sleepMs, signal))) return undefined;
  }
}

/**
 * Tap either an element (resolve a selector → frame, auto-waiting) or a raw
 * normalized point. Coordinate taps are the fallback for elements with no
 * stable selector (e.g. an unlabeled view).
 */
export async function runTap(
  registry: Registry,
  ctx: ToolContext | undefined,
  device: DeviceInfo,
  target: { selector?: Selector; x?: number; y?: number },
  signal?: AbortSignal
): Promise<DirectiveOutcome> {
  let point: { x: number; y: number };
  if (target.selector) {
    const frame = await waitForFrame(registry, device, target.selector, signal);
    if (!frame) {
      return {
        ok: false,
        reason: `no visible element matched selector ${describeSelector(target.selector)}`,
      };
    }
    point = getDescribeTapPoint(frame);
  } else if (typeof target.x === "number" && typeof target.y === "number") {
    point = { x: target.x, y: target.y };
  } else {
    return { ok: false, reason: "tap needs a selector or x/y coordinates" };
  }
  await invokeSubTool(
    registry,
    ctx,
    "gesture-tap",
    bindDeviceArgs(registry, "gesture-tap", device.id, point)
  );
  return { ok: true };
}

/** Resolve `into` → tap to focus → type text via the keyboard tool. */
export async function runType(
  registry: Registry,
  ctx: ToolContext | undefined,
  device: DeviceInfo,
  into: Selector,
  text: string,
  signal?: AbortSignal
): Promise<DirectiveOutcome> {
  const frame = await waitForFrame(registry, device, into, signal);
  if (!frame) {
    return { ok: false, reason: `no visible field matched selector ${describeSelector(into)}` };
  }
  const { x, y } = getDescribeTapPoint(frame);
  await invokeSubTool(
    registry,
    ctx,
    "gesture-tap",
    bindDeviceArgs(registry, "gesture-tap", device.id, { x, y })
  );
  await invokeSubTool(
    registry,
    ctx,
    "keyboard",
    bindDeviceArgs(registry, "keyboard", device.id, { text })
  );
  return { ok: true };
}

/**
 * Evaluate a condition against the current tree, retrying for a short grace
 * window ({@link DEFAULT_ASSERT_TIMEOUT_MS}) so an update that lands a frame
 * after an action isn't missed. Unlike `await`, this reports a *failure* (not
 * "still waiting") if the condition never holds.
 */
export async function runAssert(
  registry: Registry,
  device: DeviceInfo,
  condition: WaitCondition,
  selector: Selector,
  expectedText: string | undefined,
  signal?: AbortSignal
): Promise<DirectiveOutcome> {
  const deadline = Date.now() + DEFAULT_ASSERT_TIMEOUT_MS;

  let lastMatches: ReturnType<typeof findAll> = [];
  let fetchError: string | undefined;

  for (;;) {
    if (signal?.aborted) return { ok: false, reason: "assertion cancelled" };
    try {
      const { tree } = await fetchTree(registry, device);
      lastMatches = findAll(tree, selector);
      fetchError = undefined;
      if (evaluateCondition(condition, expectedText, lastMatches)) return { ok: true };
    } catch (err) {
      fetchError = err instanceof Error ? err.message : String(err);
    }
    if (Date.now() >= deadline) break;
    const sleepMs = Math.min(POLL_INTERVAL_MS, Math.max(0, deadline - Date.now()));
    if (!(await sleepOrAbort(sleepMs, signal))) return { ok: false, reason: "assertion cancelled" };
  }

  if (fetchError) return { ok: false, reason: `could not read the UI tree: ${fetchError}` };
  return { ok: false, reason: assertReason(condition, selector, expectedText, lastMatches) };
}

function assertReason(
  condition: WaitCondition,
  selector: Selector,
  expectedText: string | undefined,
  matches: ReturnType<typeof findAll>
): string {
  const sel = describeSelector(selector);
  switch (condition) {
    case "exists":
      return `no element matched selector ${sel}`;
    case "visible":
      return matches.length > 0
        ? `element(s) matched ${sel} but none was visible (zero-area frame)`
        : `no element matched selector ${sel}`;
    case "hidden":
      return `an element matching ${sel} was still visible`;
    case "text": {
      const first = firstInReadingOrder(matches.filter(isVisible)) ?? firstInReadingOrder(matches);
      return first
        ? `element matched ${sel} but its text was "${nodeText(first)}" (wanted to contain "${expectedText}")`
        : `no element matched selector ${sel}`;
    }
    default:
      return `assertion failed for selector ${sel}`;
  }
}
