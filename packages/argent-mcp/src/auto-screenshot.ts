/**
 * Tunables and predicates for the screenshot the MCP layer appends after a
 * successful interaction tool call.
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
  "paste",
  "rotate",
  "launch-app",
  "restart-app",
  "open-url",
  "describe",
  "run-sequence",
]);

/**
 * Per-tool cap (ms) on the `await-screen-idle` wait before capturing; the poll
 * usually returns well under it. Doubles as a blind sleep when the tool-server
 * offers no `await-screen-idle`.
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
  "paste": 300,
  "describe": 100,
};

const DEFAULT_DELAY_MS = 1400;

// Opt-out only: the `disable-auto-screenshot` flag is off by default.
// `options` lets tests point flag storage at a temp dir.
export function autoScreenshotEnabled(options?: FlagsPathOptions): boolean {
  return !isFlagEnabled("disable-auto-screenshot", options);
}

/**
 * Marker of a server-side secret placeholder (`{{secret:NAME}}`, resolved by
 * the tool-server before typing). Copy of SECRET_PLACEHOLDER_MARKER in
 * packages/tool-server/src/utils/secrets.ts, which argent-mcp does not depend
 * on.
 */
export const SECRET_PLACEHOLDER_MARKER = "{{secret:";

/**
 * Deep-scan tool args for a secret placeholder; when one is present the
 * auto-screenshot must be skipped, because a non-secure-entry field would hand
 * the resolved plaintext back to the model as pixels. JSON.stringify reaches
 * nested shapes (run-sequence steps) without knowing each tool's schema.
 */
export function containsSecretPlaceholder(args: unknown): boolean {
  try {
    return JSON.stringify(args)?.includes(SECRET_PLACEHOLDER_MARKER) ?? false;
  } catch {
    // Unserializable args can't have come from an MCP request; fail safe.
    return true;
  }
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

/** Strip the client's `mcp__server__` prefix so the allow-list sees canonical names. */
export function normalizeToolName(name: string): string {
  const idx = name.lastIndexOf("__");
  return idx === -1 ? name : name.slice(idx + 2);
}

export function shouldAutoScreenshot(toolName: string): boolean {
  const canonical = normalizeToolName(toolName);
  return canonical !== "screenshot" && AUTO_SCREENSHOT_TOOLS.has(canonical);
}

export function getAutoScreenshotDelayMs(toolName: string): number {
  const canonical = normalizeToolName(toolName);
  const base = AUTO_SCREENSHOT_DELAY_MS_BY_TOOL[canonical] ?? DEFAULT_DELAY_MS;
  const envOverride = process.env.ARGENT_AUTO_SCREENSHOT_DELAY_MS;
  if (envOverride) {
    const envMs = parseInt(envOverride, 10);
    if (!Number.isNaN(envMs)) return Math.max(base, envMs);
  }
  return base;
}
