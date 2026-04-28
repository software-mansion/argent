/**
 * Auto-screenshot configuration and helpers.
 *
 * After a successful simulator interaction tool call, the MCP layer
 * automatically captures a screenshot and appends it to the response.
 * All tunables live in this module so they can be tested in isolation.
 */

export const AUTO_SCREENSHOT_TOOLS = new Set([
  "gesture-tap",
  "gesture-swipe",
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
  "gesture-custom": 1500,
  "gesture-tap": 1500,
  "gesture-pinch": 1500,
  "gesture-rotate": 1500,
  "run-sequence": 15000,
  "button": 1500,
  "rotate": 1000,
  "keyboard": 300,
  "describe": 100,
};

const DEFAULT_DELAY_MS = 1400;

export function autoScreenshotEnabled(): boolean {
  const v = process.env.ARGENT_AUTO_SCREENSHOT;
  return v === undefined || v === "" || v === "1" || v.toLowerCase() === "true";
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
