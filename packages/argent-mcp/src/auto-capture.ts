/**
 * Tunables and predicates for what the MCP layer appends after a successful
 * interaction tool call: the auto-screenshot and the auto-describe element
 * tree. Each has its own tool list and opt-out flag.
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
  "fold",
  "launch-app",
  "restart-app",
  "open-url",
  "describe",
  "run-sequence",
  // A wait is almost always followed by a look at the screen it waited for.
  "await-ui-element",
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
  // The fold tool already waits for the panel hand-over; the cap covers the
  // repaint after it.
  "fold": 1500,
  "keyboard": 300,
  "paste": 300,
  "describe": 100,
  // The wait returns on the first match, often mid-transition; the cap must
  // leave `await-screen-idle` room to see two identical reads.
  "await-ui-element": 1500,
};

const DEFAULT_DELAY_MS = 1400;

// Opt-out only: the `disable-auto-screenshot` flag is off by default.
// `options` lets tests point flag storage at a temp dir.
export function autoScreenshotEnabled(options?: FlagsPathOptions): boolean {
  return !isFlagEnabled("disable-auto-screenshot", options);
}

/**
 * Tools whose result gets the accessibility element tree appended, so the
 * agent has fresh tap frames without a separate `describe` round-trip.
 * Independent of AUTO_SCREENSHOT_TOOLS; `describe` is absent because its own
 * result already is the tree.
 */
export const AUTO_DESCRIBE_TOOLS = new Set([
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
  "fold",
  "launch-app",
  "restart-app",
  "open-url",
  "run-sequence",
  "await-ui-element",
]);

// Opt-out only: the `disable-auto-describe` flag is off by default.
export function autoDescribeEnabled(options?: FlagsPathOptions): boolean {
  return !isFlagEnabled("disable-auto-describe", options);
}

/** Header line that introduces the element tree appended after an action. */
export const AUTO_DESCRIBE_HEADER = "--- Elements after action (describe) ---";

/** Legend that replaces describe's coordinate preamble in the appended tree. */
export const AUTO_DESCRIBE_LEGEND = "(frames: normalized x, y, width, height; tap the centre)";

// The five lines describe prints before a touch-screen tree. They repeat the
// coordinate contract that the describe tool description and the argent rule
// already carry, so the tree appended after an action gets the legend instead.
const DESCRIBE_PREAMBLE = [
  /^Source: \S+$/,
  /^Mode: (flat|nested)$/,
  /^Coordinates are normalized \[0,1\] fractions of the screen /,
  /^Pass them straight to gesture-tap \/ gesture-swipe \/ gesture-pinch, which expect this same space\.$/,
  /^To tap an element, use its centre: /,
];

/**
 * Output without the preamble (hints, Vega's D-pad note, physical iOS's
 * no-pinch note) is returned unchanged.
 */
export function compactAutoDescribe(description: string): string {
  const lines = description.split("\n");
  const hasPreamble = DESCRIBE_PREAMBLE.every((re, i) => re.test(lines[i] ?? ""));
  if (!hasPreamble) return description;
  return [AUTO_DESCRIBE_LEGEND, ...lines.slice(DESCRIBE_PREAMBLE.length)].join("\n");
}

export function shouldAutoDescribe(toolName: string): boolean {
  return AUTO_DESCRIBE_TOOLS.has(normalizeToolName(toolName));
}

/**
 * Marker of a server-side secret placeholder (`{{secret:NAME}}`, resolved by
 * the tool-server before typing). Copy of SECRET_PLACEHOLDER_MARKER in
 * packages/tool-server/src/utils/secrets.ts, which argent-mcp does not depend
 * on.
 */
const SECRET_PLACEHOLDER_MARKER = "{{secret:";

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
