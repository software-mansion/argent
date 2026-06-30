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
import { invokeSubTool } from "../../utils/sub-invoke";
import type { DescribeFrame, DescribeNode, DescribeTreeData } from "../describe/contract";
import { getDescribeTapPoint } from "../describe/contract";
import { includesCI, isVisible, nodeText, sortReadingOrder, walkMatches } from "../describe/match";
import { describeIos, iosRequires } from "../describe/platforms/ios";
import { describeAndroid, androidRequires } from "../describe/platforms/android";
import { describeChromium } from "../describe/platforms/chromium";

export const FIND_TOOL_ID = "find";

// `wait` blocks for the element to appear; the other actions are single-shot
// unless the caller opts into polling with `timeoutMs`.
const DEFAULT_WAIT_TIMEOUT_MS = 5000;
const DEFAULT_POLL_INTERVAL_MS = 400;
// Upper bound on the backspaces `fill` issues to clear a field, so a wrong /
// masked value length can't spray unbounded deletes into surrounding content.
const MAX_CLEAR_CHARS = 64;
// A couple of extra backspaces beyond the known text length absorbs IME / caret
// slop; over-deleting an already-empty field is a no-op, so we bias up.
const CLEAR_BUFFER = 2;
// After the focusing tap, wait before the first keystroke. Tapping a field and
// typing immediately races the platform: on Android the soft keyboard has to
// raise and the field take focus, so the first key is otherwise dropped (e.g.
// "bluesky" → "luesky"). This settle makes `type` / `fill` land the full string.
const FOCUS_SETTLE_MS = 450;

// Which attribute(s) the query is matched against. `any` (the default) spans the
// content attributes — label, value, identifier — but NOT role: role strings
// (`AXButton`, `button`, `TextView`) are generic, so folding them into `any`
// would make a content query like "image" match every icon. Match role with an
// explicit `by:"role"`.
const LOCATOR_ATTRS = ["any", "text", "label", "value", "role", "id"] as const;
type LocatorAttr = (typeof LOCATOR_ATTRS)[number];

const ACTIONS = [
  "tap",
  "focus",
  "fill",
  "type",
  "exists",
  "wait",
  "get-text",
  "get-attrs",
] as const;
type FindAction = (typeof ACTIONS)[number];

// Actions that drive the keyboard into the located element. They tap to focus it
// first, so they need a *visible* match (a zero-area frame has no usable tap
// point and isn't on screen to receive input).
const TYPING_ACTIONS = new Set<FindAction>(["fill", "type"]);
// Actions that touch the device (a tap, or a tap + typing). All require a visible
// match. Read-only actions (`exists`, `get-text`, `get-attrs`, `wait`) do not.
const TAPPING_ACTIONS = new Set<FindAction>(["tap", "focus", "fill", "type"]);

// The concrete attribute a node matched on — surfaced so the agent (and tests)
// can see why a node was chosen, which is otherwise opaque for `any` / `text`.
type MatchedField = "label" | "value" | "role" | "id";

const zodSchema = z
  .object({
    udid: z
      .string()
      .min(1)
      .describe("Target device id from `list-devices` (iOS UDID, Android serial, or Chromium id)."),
    query: z
      .string()
      .min(1)
      .describe(
        'Value to match against the located attribute (case-insensitive substring), e.g. "Sign In".'
      ),
    by: z
      .enum(LOCATOR_ATTRS)
      .default("any")
      .describe(
        "Which attribute to match: any (label/value/id — the default), text (label or value), " +
          "label, value, role, id."
      ),
    action: z
      .enum(ACTIONS)
      .default("tap")
      .describe(
        "tap (default): tap the match's centre. focus: tap to give it keyboard focus. " +
          "type: focus then type `text`. fill: focus, clear, then type `text`. " +
          "exists: report whether it is present (single check). wait: block until it is visible. " +
          "get-text: return its label+value. get-attrs: return its full attributes."
      ),
    text: z.string().optional().describe("Text to enter. Required for action `type` or `fill`."),
    index: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe(
        "When several elements match, which one to act on (0 = topmost in reading order, the default)."
      ),
    timeoutMs: z
      .number()
      .int()
      .positive()
      .max(120_000)
      .optional()
      .describe(
        `For action \`wait\`, how long to block (default ${DEFAULT_WAIT_TIMEOUT_MS}ms). For any other ` +
          "action, set this to poll until the element appears before acting; omitted means a single check."
      ),
    pollIntervalMs: z
      .number()
      .int()
      .min(50)
      .max(5000)
      .optional()
      .describe(
        `How often to re-check the tree while waiting (default ${DEFAULT_POLL_INTERVAL_MS}ms).`
      ),
    bundleId: z
      .string()
      .optional()
      .describe(
        "Optional iOS app bundle id passed to the describe fallback (see `describe`). Ignored on Android / Chromium."
      ),
  })
  .refine((p) => (p.action !== "fill" && p.action !== "type" ? true : Boolean(p.text)), {
    message: "action `type`/`fill` requires `text`",
    path: ["text"],
  });

type Params = z.infer<typeof zodSchema>;

interface FindMatchInfo {
  role: string;
  label?: string;
  value?: string;
  identifier?: string;
  frame: DescribeFrame;
  tapPoint: { x: number; y: number };
  visible: boolean;
  matchedField: MatchedField;
  // Only the truthy interactivity flags are included, so the payload stays small.
  flags?: Record<string, boolean>;
}

type FindActionResult =
  | { kind: "tap"; tapped: boolean; timestampMs: number }
  | { kind: "focus"; focused: boolean; timestampMs: number }
  | { kind: "type"; typed: string; keys: number }
  | { kind: "fill"; typed: string; keys: number; clearedChars: number }
  | { kind: "get-text"; text: string }
  | { kind: "get-attrs"; attrs: FindMatchInfo };

interface FindResult {
  found: boolean;
  action: FindAction;
  by: LocatorAttr;
  query: string;
  // Total nodes matching the locator (before visibility / index selection), so
  // the agent can tell when a query is ambiguous and narrow it.
  matchCount: number;
  elapsed: number;
  // Whether a device-mutating action (tap / focus / type / fill) actually ran.
  acted: boolean;
  match?: FindMatchInfo;
  actionResult?: FindActionResult;
  note?: string;
}

const capability: ToolCapability = {
  apple: { simulator: true, device: true },
  android: { emulator: true, device: true, unknown: true },
  chromium: { app: true },
};

// ── Locator matching ───────────────────────────────────────────────────────

// The attribute (if any) `node` matches `query` on, given the locator `by`.
// Returns the first satisfying field in a stable priority (label, value, id,
// role) so `any` / `text` report a deterministic `matchedField`.
export function locatorField(
  node: DescribeNode,
  by: LocatorAttr,
  query: string
): MatchedField | null {
  const label = includesCI(node.label, query);
  const value = includesCI(node.value, query);
  const id = includesCI(node.identifier, query);
  const role = includesCI(node.role, query);
  switch (by) {
    case "label":
      return label ? "label" : null;
    case "value":
      return value ? "value" : null;
    case "role":
      return role ? "role" : null;
    case "id":
      return id ? "id" : null;
    case "text":
      return label ? "label" : value ? "value" : null;
    case "any":
      return label ? "label" : value ? "value" : id ? "id" : null;
  }
}

// All nodes matching the locator, root excluded (see `walkMatches`). Exported
// for unit tests.
export function findMatches(tree: DescribeNode, by: LocatorAttr, query: string): DescribeNode[] {
  return walkMatches(tree, (n) => locatorField(n, by, query) !== null);
}

const FLAG_KEYS: ReadonlyArray<keyof DescribeNode> = [
  "clickable",
  "longClickable",
  "scrollable",
  "checkable",
  "checked",
  "disabled",
  "password",
  "focused",
  "selected",
];

function collectFlags(node: DescribeNode): Record<string, boolean> | undefined {
  const flags: Record<string, boolean> = {};
  for (const key of FLAG_KEYS) {
    if (node[key] === true) flags[key] = true;
  }
  return Object.keys(flags).length > 0 ? flags : undefined;
}

function toMatchInfo(node: DescribeNode, by: LocatorAttr, query: string): FindMatchInfo {
  const info: FindMatchInfo = {
    role: node.role,
    frame: node.frame,
    tapPoint: getDescribeTapPoint(node.frame),
    visible: isVisible(node),
    // locatorField returned non-null for every node in `findMatches`, so the
    // fallback is unreachable; it keeps the type honest without a non-null bang.
    matchedField: locatorField(node, by, query) ?? "label",
  };
  if (node.label !== undefined) info.label = node.label;
  if (node.value !== undefined) info.value = node.value;
  if (node.identifier !== undefined) info.identifier = node.identifier;
  const flags = collectFlags(node);
  if (flags) info.flags = flags;
  return info;
}

// Fold an unreliable-read hint / restart prompt onto a not-found note so the
// agent learns the real cause (degraded AX, native injection pending) rather than
// a bare "no element matched". Mirrors await-ui-element's appendDiagnostics.
function appendDiagnostics(base: string, data: DescribeTreeData | null): string {
  if (!data) return base;
  const extras: string[] = [];
  if (data.should_restart) {
    extras.push(
      "the foreground app may need a restart for native inspection — call restart-app and retry"
    );
  }
  if (data.hint) extras.push(data.hint);
  return extras.length === 0 ? base : `${base} (${extras.join("; ")})`;
}

// ── Action dispatch (delegates the device effect to the existing tools) ──────

const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));

async function tapAt(
  registry: Registry,
  ctx: ToolContext | undefined,
  udid: string,
  point: { x: number; y: number }
): Promise<{ tapped: boolean; timestampMs: number }> {
  return invokeSubTool(registry, ctx, "gesture-tap", { udid, x: point.x, y: point.y });
}

async function typeText(
  registry: Registry,
  ctx: ToolContext | undefined,
  udid: string,
  text: string
): Promise<{ typed: string; keys: number }> {
  return invokeSubTool(registry, ctx, "keyboard", { udid, text });
}

// Tap to focus a field, then wait FOCUS_SETTLE_MS so it is actually focused (and
// the soft keyboard is up) before the first key is sent — see FOCUS_SETTLE_MS.
async function focusAndSettle(
  registry: Registry,
  ctx: ToolContext | undefined,
  udid: string,
  point: { x: number; y: number }
): Promise<void> {
  await tapAt(registry, ctx, udid, point);
  await sleepOrAbort(FOCUS_SETTLE_MS, ctx?.signal);
}

// Best-effort clear of a focused field. The keyboard tool exposes no select-all
// modifier, so we backspace `value.length` (+buffer) times. This is only fully
// reliable when the focusing tap left the caret at the end of the text — `fill`
// taps near the field's trailing edge to bias that — and the field's live text is
// readable (it isn't on masked password fields). Returns the count actually sent.
async function clearField(
  registry: Registry,
  ctx: ToolContext | undefined,
  udid: string,
  currentValueLength: number
): Promise<number> {
  const count = Math.min(MAX_CLEAR_CHARS, currentValueLength + CLEAR_BUFFER);
  for (let i = 0; i < count; i++) {
    if (ctx?.signal?.aborted) break;
    await invokeSubTool(registry, ctx, "keyboard", { udid, key: "backspace" });
  }
  return count;
}

// ── Tool ─────────────────────────────────────────────────────────────────

// `find` is a factory (like `describe` / `await-ui-element`) because the iOS /
// Android tree fetch resolves AX / android-devtools through the registry rather
// than the tool's own services() declaration. Only the Chromium CDP session
// flows in as a normal service (and backs both the tree fetch and the action).
// The action itself is delegated to `gesture-tap` / `keyboard` via invokeSubTool,
// which resolve their own transport — so `find` never eagerly spawns the
// simulator-server for a read-only action.
export function createFindTool(registry: Registry): ToolDefinition<Params, FindResult> {
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
    id: FIND_TOOL_ID,
    description: `Locate a UI element by a locator and optionally act on it — combining discovery and action in one call, so you don't have to describe → read coordinates → tap.

Locator: \`query\` is a case-insensitive substring matched against the attribute named by \`by\`:
  any (default) — label, value, or id    text — label or value    label / value / role / id — that attribute only

Actions (\`action\`, default \`tap\`):
  tap        tap the match's centre
  focus      tap to give it keyboard focus
  type       focus, then type \`text\`
  fill       focus, clear the field, then type \`text\`
  exists     report whether it is present (single check, no wait)
  wait       block until it becomes visible (\`timeoutMs\`, default ${DEFAULT_WAIT_TIMEOUT_MS}ms)
  get-text   return its label + value
  get-attrs  return its role, label, value, id, frame, and flags

Returns { found, matchCount, match?, actionResult?, acted, elapsed, note? }. When several elements match,
the topmost in reading order is used (set \`index\` to pick another); \`matchCount\` tells you how many matched.
By default a single tree snapshot is taken — set \`timeoutMs\` to poll until the element appears before acting.
Example: locate "Sign In" by its text and tap it → { query: "Sign In", by: "text", action: "tap" }.`,
    alwaysLoad: true,
    longRunning: true,
    searchHint:
      "find locate element tap focus type fill exists wait get text attrs by label value role id selector single call",
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
      const { by, query, action, index } = params;

      const device = resolveDevice(params.udid);
      assertSupported(FIND_TOOL_ID, capability, device);
      if (device.platform === "ios") await ensureDeps(iosRequires);
      else if (device.platform === "android") await ensureDeps(androidRequires);

      // `wait` blocks (default budget); every other action is a single check
      // unless the caller passes timeoutMs to opt into polling.
      const timeoutMs =
        action === "wait" ? (params.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS) : (params.timeoutMs ?? 0);
      const pollIntervalMs = params.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
      const requireVisible = action === "wait" || TAPPING_ACTIONS.has(action);
      const deadline = start + timeoutMs;

      const baseResult = (): Omit<FindResult, "found" | "matchCount" | "acted"> => ({
        action,
        by,
        query,
        elapsed: Date.now() - start,
      });

      let lastTree: DescribeNode | null = null;
      let lastData: DescribeTreeData | null = null;
      let fetchError: string | undefined;

      // ── Discovery: one snapshot, or poll until the element appears ──────────
      for (;;) {
        if (signal?.aborted) {
          return {
            ...baseResult(),
            found: false,
            matchCount: 0,
            acted: false,
            note: "find was cancelled before the element was located",
          };
        }

        try {
          lastData = await fetchTree(device, params, services);
          lastTree = lastData.tree;
          fetchError = undefined;
        } catch (err) {
          fetchError = err instanceof Error ? err.message : String(err);
        }

        const matches = lastTree ? findMatches(lastTree, by, query) : [];
        const pool = requireVisible ? matches.filter(isVisible) : matches;
        // `exists` reports presence regardless of index; the others target the
        // index-th match in reading order.
        const satisfied =
          action === "exists" ? matches.length > 0 : sortReadingOrder(pool)[index] !== undefined;

        if (satisfied || Date.now() >= deadline) break;
        if (!(await sleepOrAbort(pollIntervalMs, signal))) {
          return {
            ...baseResult(),
            found: false,
            matchCount: matches.length,
            acted: false,
            note: "find was cancelled before the element was located",
          };
        }
      }

      // ── Resolve the chosen match from the final snapshot ────────────────────
      const allMatches = lastTree ? findMatches(lastTree, by, query) : [];
      const matchCount = allMatches.length;
      const pool = requireVisible ? allMatches.filter(isVisible) : allMatches;
      const ordered = sortReadingOrder(pool);
      const chosen = ordered[index];

      if (action === "exists") {
        const result: FindResult = {
          ...baseResult(),
          found: matchCount > 0,
          matchCount,
          acted: false,
        };
        const top = sortReadingOrder(allMatches)[0];
        if (top) result.match = toMatchInfo(top, by, query);
        if (matchCount === 0 && fetchError) result.note = `tree fetch failed: ${fetchError}`;
        return result;
      }

      if (!chosen) {
        // Distinguish "no element matched" from "matched but not on screen" and
        // "matched but the requested index is out of range" so the agent can act.
        let note: string;
        if (fetchError && matchCount === 0) {
          note = `tree fetch failed: ${fetchError}`;
        } else if (matchCount === 0) {
          note = `no element matched ${by}="${query}"`;
        } else if (requireVisible && pool.length === 0) {
          note = `${matchCount} element(s) matched ${by}="${query}" but none was visible (zero-area frame), so it cannot be acted on`;
        } else {
          note = `index ${index} is out of range — only ${pool.length} element(s) matched ${by}="${query}"`;
        }
        return {
          ...baseResult(),
          found: false,
          matchCount,
          acted: false,
          note: appendDiagnostics(note, lastData),
        };
      }

      const match = toMatchInfo(chosen, by, query);
      const result: FindResult = {
        ...baseResult(),
        found: true,
        matchCount,
        acted: false,
        match,
      };
      if (matchCount > 1) {
        result.note = `${matchCount} elements matched ${by}="${query}"; acted on index ${index} (topmost in reading order). Narrow the query or set \`index\` to target another.`;
      }

      // ── Perform the action ─────────────────────────────────────────────────
      const tapPoint = TYPING_ACTIONS.has(action)
        ? // Bias the focusing tap toward the field's trailing edge so the caret
          // lands at the end of any existing text — this is what makes the
          // backspace-based clear (and append-typing) behave predictably.
          {
            x: clamp01(chosen.frame.x + chosen.frame.width * 0.92),
            y: getDescribeTapPoint(chosen.frame).y,
          }
        : match.tapPoint;

      switch (action) {
        case "tap": {
          const r = await tapAt(registry, ctx, params.udid, match.tapPoint);
          result.actionResult = { kind: "tap", tapped: r.tapped, timestampMs: r.timestampMs };
          result.acted = true;
          break;
        }
        case "focus": {
          const r = await tapAt(registry, ctx, params.udid, match.tapPoint);
          result.actionResult = { kind: "focus", focused: r.tapped, timestampMs: r.timestampMs };
          result.acted = true;
          break;
        }
        case "type": {
          await focusAndSettle(registry, ctx, params.udid, tapPoint);
          const r = await typeText(registry, ctx, params.udid, params.text!);
          result.actionResult = { kind: "type", typed: r.typed, keys: r.keys };
          result.acted = true;
          break;
        }
        case "fill": {
          await focusAndSettle(registry, ctx, params.udid, tapPoint);
          const clearedChars = await clearField(
            registry,
            ctx,
            params.udid,
            chosen.value?.length ?? 0
          );
          const r = await typeText(registry, ctx, params.udid, params.text!);
          result.actionResult = {
            kind: "fill",
            typed: r.typed,
            keys: r.keys,
            clearedChars,
          };
          result.acted = true;
          if (chosen.password && !chosen.value) {
            result.note =
              "this looks like a password field with a masked value, so the field's length was unknown — " +
              "the clear may be incomplete; verify the field is empty before relying on it.";
          }
          break;
        }
        case "wait": {
          // Discovery already blocked until the element was visible; nothing more
          // to do beyond reporting it.
          break;
        }
        case "get-text": {
          result.actionResult = { kind: "get-text", text: nodeText(chosen) };
          break;
        }
        case "get-attrs": {
          result.actionResult = { kind: "get-attrs", attrs: match };
          break;
        }
      }

      result.elapsed = Date.now() - start;
      return result;
    },
  };
}
