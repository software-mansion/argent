/**
 * Auto-screenshot configuration and helpers.
 *
 * After a successful simulator interaction tool call, the MCP layer
 * automatically captures a screenshot and appends it to the response.
 * All tunables live in this module so they can be tested in isolation.
 */

import { isFlagEnabled, type FlagsPathOptions } from "@argent/configuration-core";

export const AUTO_SCREENSHOT_TOOLS = new Set([
  "gesture-tap",
  "gesture-swipe",
  "gesture-scroll",
  "gesture-drag",
  "gesture-custom",
  "gesture-pinch",
  "gesture-rotate",
  "button",
  "keyboard",
  "rotate",
  "launch-app",
  "restart-app",
  "open-url",
  "describe",
  "find",
  "run-sequence",
]);

/**
 * Per-tool delay (ms) before capturing the screenshot.
 * +1 000 ms over baseline research values to cover slow devices/transitions.
 */
export const AUTO_SCREENSHOT_DELAY_MS_BY_TOOL: Record<string, number> = {
  "launch-app": 3000,
  "restart-app": 3000,
  "open-url": 2000,
  "gesture-swipe": 1500,
  "gesture-scroll": 1500,
  "gesture-drag": 1500,
  "gesture-custom": 1500,
  "gesture-tap": 1500,
  "gesture-pinch": 1500,
  "gesture-rotate": 1500,
  "run-sequence": 15000,
  "button": 1500,
  "rotate": 1000,
  "keyboard": 300,
  "describe": 100,
  // `find`'s headline action is a tap (which can trigger a transition), so match
  // gesture-tap's settle delay. Its read-only actions (exists/get-text/get-attrs/
  // wait) don't mutate the screen, so they use the shorter describe-style delay
  // instead — see `getAutoScreenshotDelayMs`, which keys off `args.action`.
  "find": 1500,
};

const DEFAULT_DELAY_MS = 1400;

// `find` actions that don't touch the device — their auto-screenshot doesn't need
// the tap settle delay (it would just over-wait ~1.5s for an unchanged screen).
// Kept in sync with the tool's ACTIONS by name (argent-mcp must not import from
// tool-server); the default action is `tap`, so an omitted action is NOT read-only.
const READ_ONLY_FIND_ACTIONS = new Set(["exists", "get-text", "get-attrs", "wait"]);

function isReadOnlyFindAction(args: unknown): boolean {
  if (!args || typeof args !== "object") return false;
  const action = (args as { action?: unknown }).action;
  return typeof action === "string" && READ_ONLY_FIND_ACTIONS.has(action);
}

// Auto-screenshot is on by default; the opt-out is the off-by-default
// `disable-auto-screenshot` flag. `options` mirrors isFlagEnabled so tests can
// point storage at a temp dir.
export function autoScreenshotEnabled(options?: FlagsPathOptions): boolean {
  return !isFlagEnabled("disable-auto-screenshot", options);
}

export function getUdidFromArgs(args: unknown): string | undefined {
  if (
    args &&
    typeof args === "object" &&
    "udid" in args &&
    typeof (args as { udid: unknown }).udid === "string"
  ) {
    return (args as { udid: string }).udid;
  }
  return undefined;
}

/**
 * Strip known MCP prefix so the allow-list matches canonical names.
 * Cursor sends `mcp__argent__tap`; we need `tap`.
 */
export function normalizeToolName(name: string): string {
  const idx = name.lastIndexOf("__");
  return idx === -1 ? name : name.slice(idx + 2);
}

export function shouldAutoScreenshot(toolName: string): boolean {
  const canonical = normalizeToolName(toolName);
  return canonical !== "screenshot" && AUTO_SCREENSHOT_TOOLS.has(canonical);
}

export function getAutoScreenshotDelayMs(toolName: string, args?: unknown): number {
  const canonical = normalizeToolName(toolName);
  const base =
    canonical === "find" && isReadOnlyFindAction(args)
      ? AUTO_SCREENSHOT_DELAY_MS_BY_TOOL["describe"]!
      : (AUTO_SCREENSHOT_DELAY_MS_BY_TOOL[canonical] ?? DEFAULT_DELAY_MS);
  const envOverride = process.env.ARGENT_AUTO_SCREENSHOT_DELAY_MS;
  if (envOverride) {
    const envMs = parseInt(envOverride, 10);
    if (!Number.isNaN(envMs)) return Math.max(base, envMs);
  }
  return base;
}
