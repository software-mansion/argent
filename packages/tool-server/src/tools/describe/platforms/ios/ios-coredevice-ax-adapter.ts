import type { CoreDeviceAxTree } from "../../../../utils/simulator-client";
import { parseDescribeResult, type DescribeNode } from "../../contract";
import { mapNativeTraitsToDescribeRole } from "./ios-native-adapter";

/**
 * Adapts a physical iPhone's on-screen accessibility tree (from the iOS-26+
 * axAudit service, read app-free over CoreDevice) into a describe tree.
 *
 * The audit gives a rich VoiceOver caption (label + value + traits) for EVERY
 * on-screen element. It gives nothing else that reaches here: the inspector
 * publishes no frame attribute, so the payload carries no `screen` and no
 * `rect`, and the order is a rotation of the true reading order (the walk starts
 * at the device's current VoiceOver cursor). Every frame below is therefore
 * **synthesised from list position** — full-width rows spread top to bottom —
 * which makes them a rendering convenience, not a measurement. `describe`'s hint
 * and the formatter header both tell the agent to get real positions from
 * `screenshot`; nothing here should be read as a claim about where an element is.
 *
 * `parseRect` (with `tree.screen` as the normalizing basis) is nonetheless
 * honoured whenever the payload does carry geometry, so adding a geometry source
 * on the sim-server side is a producer-only change. `ios-coredevice-ax-adapter.test.ts`
 * covers both the current no-geometry payload and that forward-compatible path.
 */

// VoiceOver caption trait tokens → the trait names `mapNativeTraitsToDescribeRole`
// speaks. Going through that shared mapper (rather than emitting role strings
// directly) is what keeps this backend in the same vocabulary as the other two
// iOS describe adapters: selectors, `format-tree`'s CONTENT_ROLES and Lens's
// exact `role ===` match all key off those names, so a private spelling here
// would make every role-based selector work on a simulator and match nothing on
// a device. Order matters: the first structural trait found wins.
const TRAIT_TOKEN_TO_NATIVE: Array<[RegExp, string]> = [
  [/^Button$/i, "button"],
  [/^(Toggle|Switch)$/i, "toggleButton"],
  [/^Link$/i, "link"],
  [/^Header$/i, "header"],
  [/^Adjustable$/i, "adjustable"],
  [/^Search Field$/i, "searchField"],
  [/^Text Field$/i, "searchField"],
  [/^Tab$/i, "tabBar"],
  [/^Image$/i, "image"],
];
// Trailing tokens that are traits/states rather than content (stripped from the
// caption before it is split into label + value).
const TRAIT_TOKEN =
  /^(Button|Link|Header|Toggle|Switch|Adjustable|Search Field|Text Field|Tab|Image|Selected|Not Selected|Dimmed|Disabled|Not Enabled)$/i;

// Roles whose elements can carry a value worth splitting out. Static text and
// headings are prose: their captions routinely contain commas mid-sentence, so
// treating the last comma-separated run as a value would truncate the label
// instead of finding one. Restricting the split to value-bearing roles keeps the
// common "Wi-Fi, 1" / "Ask to Join Networks, Notify" cases while leaving a
// sentence intact.
const VALUE_BEARING_ROLES = new Set(["AXButton", "AXTextField", "AXAdjustable"]);

// State tokens the caption carries and `DescribeNode` has fields for. They are
// stripped from the label either way (they are not part of the element's name),
// so without this they would be dropped entirely and an enabled control would
// render byte-identical to a disabled one — while the describe hint promises the
// traits are exact. "Not Selected" is recorded as an explicit `false`: the device
// stating a selection state is different from an element that has none.
const STATE_TOKENS: Array<[RegExp, "disabled" | "selected", boolean]> = [
  [/^(Dimmed|Disabled|Not Enabled)$/i, "disabled", true],
  [/^Not Selected$/i, "selected", false],
  [/^Selected$/i, "selected", true],
];

/** Selection / enabled state the caption declares, as describe-node fields. */
function parseState(tokens: string[]): { disabled?: boolean; selected?: boolean } {
  const out: { disabled?: boolean; selected?: boolean } = {};
  for (const token of tokens) {
    for (const [re, field, value] of STATE_TOKENS) {
      if (re.test(token) && out[field] === undefined) out[field] = value;
    }
  }
  return out;
}

/**
 * Split a VoiceOver caption ("Wi-Fi, FiberMansion, Button") into the describe
 * node's `label`, `value` and `role`.
 *
 * The audit hands back one flat comma-joined string; the sibling adapters get
 * label and value as separate fields and every selector matcher treats `value`
 * as first-class, so collapsing both into `label` here would silently downgrade
 * `{ value: … }` selectors to label-substring guesses. The audit's own ordering
 * is label first, then value, then traits — so once the trailing traits are
 * dropped, the last remaining run is the value on a value-bearing role.
 */
function parseCaption(caption: string): {
  label: string;
  value?: string;
  role: string;
  disabled?: boolean;
  selected?: boolean;
} {
  const tokens = caption.split(/,\s*/).filter((t) => t.length > 0);
  const state = parseState(tokens);
  let traits: string[] = [];
  for (const [re, native] of TRAIT_TOKEN_TO_NATIVE) {
    if (tokens.some((t) => re.test(t))) {
      traits = [native];
      break;
    }
  }
  if (traits.length === 0) traits = ["staticText"];
  const role = mapNativeTraitsToDescribeRole(traits);
  // Drop trailing trait/state tokens.
  let end = tokens.length;
  while (end > 0 && TRAIT_TOKEN.test(tokens[end - 1])) end--;
  // Nothing but traits ("Dimmed, Button", and the empty caption): there is no
  // content to split, so keep the caption whole. Returning here rather than
  // handing the untrimmed tokens to the split below is what stops a trait from
  // becoming the element's `value` — a `{ value: "Button" }` selector would then
  // match a button that has no value at all, and the label would read "Dimmed".
  if (end === 0) return { label: caption, role, ...state };
  const content = tokens.slice(0, end);
  if (content.length === 1 || !VALUE_BEARING_ROLES.has(role)) {
    return { label: content.join(", "), role, ...state };
  }
  return {
    label: content.slice(0, -1).join(", "),
    value: content[content.length - 1],
    role,
    ...state,
  };
}

const RECT_RE = /-?\d+(?:\.\d+)?/g;

/** Parse "{{x, y}, {w, h}}" (points) → normalized frame, or null. */
function parseRect(rect: string | undefined, sw: number, sh: number): DescribeNode["frame"] | null {
  if (!rect || sw <= 0 || sh <= 0) return null;
  const nums = rect.match(RECT_RE);
  if (!nums || nums.length < 4) return null;
  const [x, y, w, h] = nums.slice(0, 4).map(Number);
  const clamp = (v: number) => Math.max(0, Math.min(1, v));
  return {
    x: clamp(x / sw),
    y: clamp(y / sh),
    width: clamp(w / sw),
    height: clamp(h / sh),
  };
}

const MARGIN_X = 0.04;
const APPROX_HEIGHT = 0.05;

/** Full-width approximate frame centred at normalized y. */
function approxFrame(yCenter: number): DescribeNode["frame"] {
  const y = Math.max(0, Math.min(1 - APPROX_HEIGHT, yCenter - APPROX_HEIGHT / 2));
  return { x: MARGIN_X, y, width: 1 - 2 * MARGIN_X, height: APPROX_HEIGHT };
}

/**
 * Fill frames for elements the audit didn't give a rect: interpolate each gap's
 * y-centres between the nearest real rects above and below (reading order), so a
 * list row lands roughly where it should. Falls back to an even top-to-bottom
 * spread when there are no anchoring rects.
 */
function fillFrames(frames: Array<DescribeNode["frame"] | null>): DescribeNode["frame"][] {
  const n = frames.length;
  const yc = (f: DescribeNode["frame"]) => f.y + f.height / 2;
  const out = frames.slice();
  for (let i = 0; i < n; i++) {
    if (out[i]) continue;
    let prev = i - 1;
    while (prev >= 0 && !out[prev]) prev--;
    let next = i + 1;
    while (next < n && !out[next]) next++;
    const top = prev >= 0 ? yc(out[prev]!) : 0.06;
    const bottom = next < n ? yc(out[next]!) : 0.94;
    const span = next < n ? next : n; // denominator for even spread in the run
    const start = prev >= 0 ? prev : -1;
    const frac = (i - start) / (span - start);
    out[i] = approxFrame(top + (bottom - top) * frac);
  }
  return out as DescribeNode["frame"][];
}

export function adaptCoreDeviceAxToDescribeResult(tree: CoreDeviceAxTree): DescribeNode {
  const sw = tree.screen?.w ?? 0;
  const sh = tree.screen?.h ?? 0;
  const els = tree.elements ?? [];

  const rectFrames = els.map((e) => parseRect(e.rect, sw, sh));
  const frames = fillFrames(rectFrames);

  const children: DescribeNode[] = els.map((e, i) => {
    const { label, value, role, disabled, selected } = parseCaption(e.caption ?? "");
    const node: DescribeNode = { role, frame: frames[i], children: [] };
    if (label) node.label = label;
    if (value) node.value = value;
    if (disabled !== undefined) node.disabled = disabled;
    if (selected !== undefined) node.selected = selected;
    return node;
  });

  return parseDescribeResult({
    role: "AXGroup",
    frame: { x: 0, y: 0, width: 1, height: 1 },
    children,
  });
}
