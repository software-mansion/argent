import { z } from "zod";
import type {
  Platform,
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
import { invokeSubTool } from "../../utils/sub-invoke";
import type { DescribeFrame, DescribeNode, DescribeTreeData } from "../describe/contract";
import { getDescribeTapPoint } from "../describe/contract";
import {
  includesCI,
  isVisible,
  nodeText,
  firstInReadingOrder,
  sortReadingOrder,
  walkMatches,
} from "../describe/match";
import { fetchDescribeTree, appendDescribeDiagnostics } from "../describe/fetch-tree";
import { iosRequires } from "../describe/platforms/ios";
import { androidRequires } from "../describe/platforms/android";

export const FIND_TOOL_ID = "find";

// `wait` blocks for the element to appear; the other actions are single-shot
// unless the caller opts into polling with `timeoutMs`.
const DEFAULT_WAIT_TIMEOUT_MS = 5000;
const DEFAULT_POLL_INTERVAL_MS = 400;
// Per-fetch budget for a single-shot (non-polling) action. The describe fetch
// isn't cancellable, so this just caps a genuinely hung read (the Android
// `uiautomator dump` can take ~20s) while still letting an abort be observed.
const SINGLE_SHOT_FETCH_BUDGET_MS = 30_000;
// Upper bound on the backspaces `fill` issues to clear a field, so a wrong /
// masked value length can't spray unbounded deletes into surrounding content.
const MAX_CLEAR_CHARS = 64;
// A couple of extra backspaces beyond the known text length absorbs IME / caret
// slop; over-deleting an already-empty field is a no-op, so we bias up.
const CLEAR_BUFFER = 2;

// After the focusing tap, wait before the first keystroke so the field is
// actually focused. Android must also raise the soft keyboard, so tapping and
// typing immediately drops the first key ("bluesky" → "luesky"); iOS focuses
// quickly (small insurance) and Chromium focus over CDP is synchronous.
function focusSettleMs(platform: Platform): number {
  if (platform === "android") return 450;
  if (platform === "ios") return 150;
  return 0;
}

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

// Actions that touch the device (a tap, or a tap + typing). All require a visible
// match (a zero-area frame has no usable tap point). Read-only actions (`exists`,
// `get-text`, `get-attrs`, `wait`) do not tap.
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
    text: z
      .string()
      .optional()
      .describe("Text to enter into the field. Required for action `type` or `fill`."),
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
  | { kind: "get-text"; text: string };

interface FindResult {
  found: boolean;
  action: FindAction;
  by: LocatorAttr;
  query: string;
  // How many actionable matches the locator found: visible matches for tapping
  // actions / `wait`, all matches for the read-only checks. Same space as
  // `index`, so the agent can tell when a query is ambiguous and narrow it.
  matchCount: number;
  elapsed: number;
  // Present whenever an element was located. For `get-attrs` this IS the answer.
  match?: FindMatchInfo;
  // Present for actions that do something beyond locating (tap/focus/type/fill/get-text).
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
// Returns the first satisfying field in a stable priority (label, value, id) so
// `any` / `text` report a deterministic `matchedField`.
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

// ── Action dispatch (delegates the device effect to the existing tools) ──────

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

// Tap to focus a field, then wait `settleMs` so it is actually focused (and the
// soft keyboard is up) before the first key. Returns false if the request was
// aborted during the settle, so the caller can skip typing.
async function focusAndSettle(
  registry: Registry,
  ctx: ToolContext | undefined,
  udid: string,
  point: { x: number; y: number },
  settleMs: number
): Promise<boolean> {
  await tapAt(registry, ctx, udid, point);
  return sleepOrAbort(settleMs, ctx?.signal);
}

// Length of a field's current editable text, on the platforms where the tree
// actually exposes it: iOS (and an Android EditText WITH a content-desc) put the
// typed text in `value` while `label` is a static placeholder, whereas an Android
// EditText WITHOUT a content-desc surfaces the typed text as `label` with `value`
// unset. We can't tell placeholder from content, so we take the longer of the
// two: the real editable text is exactly one of them, so `max` is never shorter
// than it, and over-deleting past the end of a field is a no-op (a focusing tap
// parks the caret at the end) — whereas UNDER-deleting leaves stale text for
// `fill` to type on top of.
//
// This is NOT reliable on Chromium: `describeChromium`'s accessibleName prefers a
// static aria-label / placeholder over the live `el.value`, and a form control's
// `value` (ownText) is always empty — so for a placeholder/aria-labelled input
// the current content is in NEITHER attribute and its length is unknowable here.
// The `fill` handler special-cases Chromium instead of trusting this.
function editableTextLength(node: DescribeNode): number {
  return Math.max(node.value?.length ?? 0, node.label?.length ?? 0);
}

// Send `count` backspaces to a focused field, stopping early on abort. The
// keyboard tool exposes no select-all modifier, so a clear is N backspaces; a
// focusing tap parks the caret at the end of the text, so they delete leftwards
// through the value. Returns how many were actually sent. Deciding `count` (and
// whether it may fall short of the field's true length) is the caller's job,
// since only it knows how reliably the platform reported the field's text.
async function clearField(
  registry: Registry,
  ctx: ToolContext | undefined,
  udid: string,
  count: number
): Promise<number> {
  for (let i = 0; i < count; i++) {
    if (ctx?.signal?.aborted) return i;
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
  return {
    id: FIND_TOOL_ID,
    description: `Locate a UI element by a locator and optionally act on it — discovery + action in one call, so you don't have to describe → read coordinates → tap.

Locator: \`query\` is a case-insensitive substring matched against the attribute named by \`by\` (any = label/value/id, the default; text = label or value; or label / value / role / id).
Actions (\`action\`, default \`tap\`): tap (centre), focus, type (focus + type \`text\`), fill (focus + clear + type \`text\`), exists (single presence check), wait (block until visible, \`timeoutMs\` default ${DEFAULT_WAIT_TIMEOUT_MS}ms), get-text, get-attrs.

Returns { found, matchCount, match?, actionResult?, elapsed, note? }. When several match, the topmost in reading order is used (set \`index\` to pick another; \`matchCount\` reports how many). A single snapshot is taken by default — set \`timeoutMs\` to poll until the element appears before acting.
Example: tap "Sign In" → { query: "Sign In", by: "text", action: "tap" }.`,
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
      const { by, query, action, index } = params;

      const device = resolveDevice(params.udid);
      assertSupported(FIND_TOOL_ID, capability, device);
      if (device.platform === "ios") await ensureDeps(iosRequires);
      else if (device.platform === "android") await ensureDeps(androidRequires);

      // Resolve the tvOS verdict once, before the wait clock and outside the
      // per-fetch budget: describeIos would otherwise re-shell `xcrun` on every
      // poll (blowing a tight timeoutMs for an uncached UDID). Mirrors
      // await-ui-element; passed through to fetchDescribeTree below.
      const isTvOs = device.platform === "ios" && (await isTvOsSimulator(device.id));

      // Start the discovery clock after setup so its fixed cost isn't charged
      // against timeoutMs (the deadline should bound polling, not resolution).
      const start = Date.now();

      // `wait` blocks (default budget); every other action is a single check
      // unless the caller passes timeoutMs to opt into polling.
      const timeoutMs =
        action === "wait" ? (params.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS) : (params.timeoutMs ?? 0);
      const pollIntervalMs = params.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
      const polling = timeoutMs > 0;
      const requireVisible = action === "wait" || TAPPING_ACTIONS.has(action);
      const deadline = start + timeoutMs;

      const baseResult = (): Omit<FindResult, "found" | "matchCount"> => ({
        action,
        by,
        query,
        elapsed: Date.now() - start,
      });
      const cancelled = (): FindResult => ({
        ...baseResult(),
        found: false,
        matchCount: 0,
        note: "find was cancelled before the element was located",
      });

      let lastTree: DescribeNode | null = null;
      let lastData: DescribeTreeData | null = null;
      let fetchError: string | undefined;

      // ── Discovery: one snapshot, or poll until the element appears ──────────
      for (;;) {
        if (signal?.aborted) return cancelled();

        // Bound each fetch: in poll mode to the time left before the deadline (so
        // a slow describe can't overshoot timeoutMs); in single-shot mode to a
        // generous cap. Either way an abort mid-fetch is observed promptly.
        const budget = polling ? Math.max(0, deadline - Date.now()) : SINGLE_SHOT_FETCH_BUDGET_MS;
        const settled = await settleWithin(
          fetchDescribeTree(registry, device, params, services, { isTvOs }),
          budget,
          signal
        );

        if (settled.type === "aborted") return cancelled();
        if (settled.type === "timeout") {
          if (lastTree === null) {
            fetchError ??= `tree fetch did not complete within the ${polling ? `${timeoutMs}ms wait` : "fetch"} budget`;
          }
          break;
        }
        if (settled.type === "error") {
          fetchError = settled.error;
        } else {
          lastData = settled.value;
          lastTree = settled.value.tree;
          fetchError = undefined;
        }

        const matches = lastTree ? findMatches(lastTree, by, query) : [];
        const pool = requireVisible ? matches.filter(isVisible) : matches;
        // `exists` reports presence regardless of index; the others need the
        // index-th match in reading order to be present.
        const satisfied =
          action === "exists" ? matches.length > 0 : sortReadingOrder(pool)[index] !== undefined;

        if (satisfied || Date.now() >= deadline) break;
        // Clamp the poll sleep to the time left so a large pollIntervalMs can't
        // overshoot the deadline before the final poll.
        const sleepMs = Math.min(pollIntervalMs, Math.max(0, deadline - Date.now()));
        if (!(await sleepOrAbort(sleepMs, signal))) return cancelled();
      }

      // ── Resolve the chosen match from the final snapshot ────────────────────
      const allMatches = lastTree ? findMatches(lastTree, by, query) : [];
      const pool = requireVisible ? allMatches.filter(isVisible) : allMatches;
      const matchCount = pool.length;
      const chosen = sortReadingOrder(pool)[index];

      if (action === "exists") {
        const result: FindResult = { ...baseResult(), found: matchCount > 0, matchCount };
        const top = firstInReadingOrder(allMatches);
        if (top) result.match = toMatchInfo(top, by, query);
        if (matchCount === 0) {
          const base = fetchError
            ? `tree fetch failed: ${fetchError}`
            : `no element matched ${by}="${query}"`;
          result.note = appendDescribeDiagnostics(base, lastData);
        }
        return result;
      }

      if (!chosen) {
        // Distinguish "no element matched" from "matched but not on screen" and
        // "matched but the requested index is out of range" so the agent can act.
        let note: string;
        if (fetchError && allMatches.length === 0) {
          note = `tree fetch failed: ${fetchError}`;
        } else if (allMatches.length === 0) {
          note = `no element matched ${by}="${query}"`;
        } else if (requireVisible && pool.length === 0) {
          note = `${allMatches.length} element(s) matched ${by}="${query}" but none is visible (zero-area frame), so it cannot be acted on`;
        } else {
          note = `index ${index} is out of range — only ${pool.length} actionable element(s) matched ${by}="${query}"`;
        }
        return {
          ...baseResult(),
          found: false,
          matchCount,
          note: appendDescribeDiagnostics(note, lastData),
        };
      }

      const match = toMatchInfo(chosen, by, query);
      const result: FindResult = { ...baseResult(), found: true, matchCount, match };
      if (matchCount > 1) {
        const verb = TAPPING_ACTIONS.has(action) ? "acted on" : "selected";
        // Only index 0 is the topmost; label any other index without implying it is.
        const which =
          index === 0 ? "index 0 (topmost in reading order)" : `index ${index} (0 = topmost)`;
        result.note = `${matchCount} elements matched ${by}="${query}"; ${verb} ${which}. Narrow the query or set \`index\` to target another.`;
      }

      // A cancel that lands AFTER the element was located and a device effect was
      // already dispatched (the focus tap always fires; a `fill` may also have
      // sent backspaces). Unlike `cancelled()`, report the element as found with
      // an accurate account of what was mutated, so a caller doing recovery isn't
      // told "nothing happened" when the field was in fact focused / partly cleared.
      const cancelledMidAction = (detail: string): FindResult => ({
        ...baseResult(),
        found: true,
        matchCount,
        match,
        note: [result.note, `find was cancelled ${detail}`].filter(Boolean).join(" "),
      });

      // ── Perform the action ─────────────────────────────────────────────────
      switch (action) {
        case "tap": {
          const r = await tapAt(registry, ctx, params.udid, match.tapPoint);
          result.actionResult = { kind: "tap", tapped: r.tapped, timestampMs: r.timestampMs };
          break;
        }
        case "focus": {
          const r = await tapAt(registry, ctx, params.udid, match.tapPoint);
          result.actionResult = { kind: "focus", focused: r.tapped, timestampMs: r.timestampMs };
          break;
        }
        case "type": {
          const focused = await focusAndSettle(
            registry,
            ctx,
            params.udid,
            match.tapPoint,
            focusSettleMs(device.platform)
          );
          if (!focused)
            return cancelledMidAction(
              "after focusing the element but before typing; the field is focused but no text was entered"
            );
          const r = await typeText(registry, ctx, params.udid, params.text!);
          result.actionResult = { kind: "type", typed: r.typed, keys: r.keys };
          break;
        }
        case "fill": {
          const focused = await focusAndSettle(
            registry,
            ctx,
            params.udid,
            match.tapPoint,
            focusSettleMs(device.platform)
          );
          if (!focused)
            return cancelledMidAction(
              "after focusing the element but before clearing; the field is focused but not yet modified"
            );
          // Size the clear. On Chromium the DOM a11y snapshot never gives a
          // reliable editable length: a form control's live `el.value` is masked
          // behind a static aria-label / placeholder (and `value` is empty), while
          // a contenteditable reports only its *direct* text nodes in `value` — an
          // undercount that omits text nested in inline children (a <b>, a mention
          // span). Trusting either would under-clear and leave stale text for the
          // new value to be typed on top of, so on Chromium we always clear up to
          // the cap and flag it. Elsewhere max(value,label) is the true length and
          // never shorter than the real text.
          const lengthHidden = device.platform === "chromium";
          const knownLength = editableTextLength(chosen);
          const clearTarget = lengthHidden ? MAX_CLEAR_CHARS : knownLength;
          const clearCount = Math.min(MAX_CLEAR_CHARS, clearTarget + CLEAR_BUFFER);
          const clearedChars = await clearField(registry, ctx, params.udid, clearCount);
          // clearField stops early on abort but can't signal it; bail before
          // typing so a cancelled fill doesn't push `text` in and report success.
          if (signal?.aborted)
            return cancelledMidAction(
              `after focusing and deleting ${clearedChars} character(s) but before typing; the field may be partially cleared`
            );
          const r = await typeText(registry, ctx, params.udid, params.text!);
          result.actionResult = { kind: "fill", typed: r.typed, keys: r.keys, clearedChars };
          // Surface any caveat that the clear may have left stale text behind, so
          // the leftover-plus-new-text failure mode is never a silent success.
          const clearCaveats: string[] = [];
          if (lengthHidden) {
            clearCaveats.push(
              `on Chromium the field's current text is not reliably exposed by the DOM ` +
                `accessibility snapshot (an input's live value is masked by a placeholder / ` +
                `aria-label, and a contenteditable reports only its direct text nodes), so the ` +
                `clear was sized to the ${MAX_CLEAR_CHARS}-char cap; a longer field may retain ` +
                `text — verify it before relying on it.`
            );
          } else if (knownLength > MAX_CLEAR_CHARS) {
            // Cap is measured against the field's real length, not length+buffer,
            // so a 63–64 char field (fully cleared by the 64 backspaces) doesn't
            // draw a spurious warning.
            clearCaveats.push(
              `the field holds more than ${MAX_CLEAR_CHARS} characters, so the clear was capped at ` +
                `${MAX_CLEAR_CHARS} and may be incomplete — verify the field before relying on it.`
            );
          }
          // A password's real length is hidden: `value` is unset and any `label`
          // is a redacted placeholder ("[password]"), so the clear can't be sized
          // reliably — warn even though some backspaces were sent.
          if (chosen.password && !chosen.value) {
            clearCaveats.push(
              "this looks like a password field with a masked value, so the field's length was unknown — " +
                "the clear may be incomplete; verify the field is empty before relying on it."
            );
          }
          if (clearCaveats.length > 0) {
            result.note = [result.note, ...clearCaveats].filter(Boolean).join(" ");
          }
          break;
        }
        case "wait":
          // Discovery already blocked until the element was visible; nothing more.
          break;
        case "get-text":
          result.actionResult = { kind: "get-text", text: nodeText(chosen) };
          break;
        case "get-attrs":
          // The answer is `result.match` (the full attributes); no separate action.
          break;
      }

      result.elapsed = Date.now() - start;
      return result;
    },
  };
}
