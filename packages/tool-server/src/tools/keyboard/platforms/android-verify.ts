import type { DeviceInfo, Registry } from "@argent/registry";
import { androidDevtoolsRef, type AndroidDevtoolsApi } from "../../../blueprints/android-devtools";
import {
  attrIsTrue,
  parseUiAutomatorBounds,
  parseUiAutomatorXml,
} from "../../describe/platforms/android/uiautomator-parser";
import { injectAndroidText } from "../../../utils/android-input";
import { FLOW_MAX_NODES } from "../../flows/flow-android-tree";
import type { KeyboardVerification } from "../types";

// `EditText` also matches React Native `TextInput`, Compose `TextField` and WebView
// inputs; `AutoComplete` matches `SearchView$SearchAutoComplete`.
const EDITABLE_CLASS_RE = /EditText|AutoComplete/;

// A helper that never signals ready costs the blueprint's 30 s READY timeout on
// every resolve, and the registry does not remember the failure.
const HELPER_UNAVAILABLE_TTL_MS = 60_000;
const helperUnavailableUntil = new Map<string, number>();

export function __resetHelperAvailabilityForTests(): void {
  helperUnavailableUntil.clear();
}

interface FocusedField {
  /** For an empty field this is its hint, not "". */
  text: string;
  resourceId: string;
  className: string;
  bounds: { x: number; y: number; w: number; h: number } | null;
}

/** The focused text field, or why none can be compared. */
export function findFocusedTextField(xml: string): FocusedField | string {
  // `<hierarchy>`'s children are windows. A focused field in two of them (a
  // dialog over the app) leaves unknown which one receives the typing.
  const windows = parseUiAutomatorXml(xml)?.children ?? [];
  let field: FocusedField | null = null;
  let fieldWindow = -1;
  let password = false;
  for (let window = 0; window < windows.length; window++) {
    const stack = [windows[window]!];
    while (stack.length > 0) {
      const node = stack.pop()!;
      for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]!);
      const { attrs } = node;
      const className = attrs.class ?? "";
      if (!attrIsTrue(attrs, "focused") || !EDITABLE_CLASS_RE.test(className)) continue;
      if (field === null) {
        field = {
          text: attrs.text ?? "",
          resourceId: attrs["resource-id"] ?? "",
          className,
          bounds: parseUiAutomatorBounds(attrs.bounds ?? ""),
        };
        fieldWindow = window;
        password = attrIsTrue(attrs, "password");
      } else if (window !== fieldWindow) {
        return "more than one window has a focused text field.";
      }
    }
  }
  if (field === null) return "no focused text field was found.";
  // A masked field reads back as bullets, and reading a credential back is what
  // `{{secret:…}}` exists to avoid.
  if (password) return "the field masks its input.";
  return field;
}

/**
 * Bounds overlap rather than equality: typing can resize a field. Zero extents
 * count as 1px so a degenerate field still matches itself.
 */
function isSameField(a: FocusedField, b: FocusedField): boolean {
  if (a.className !== b.className || a.resourceId !== b.resourceId) return false;
  if (!a.bounds || !b.bounds) return false;
  const aw = Math.max(a.bounds.w, 1);
  const ah = Math.max(a.bounds.h, 1);
  const bw = Math.max(b.bounds.w, 1);
  const bh = Math.max(b.bounds.h, 1);
  return (
    a.bounds.x < b.bounds.x + bw &&
    b.bounds.x < a.bounds.x + aw &&
    a.bounds.y < b.bounds.y + bh &&
    b.bounds.y < a.bounds.y + ah
  );
}

function commonPrefix(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
}

function commonSuffix(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
  return n;
}

/** Whether `after` is `before` with one run (possibly empty) replaced by `text`. */
function replacedRun(before: string, after: string, text: string): boolean {
  const lo = Math.max(0, after.length - text.length - commonSuffix(before, after));
  const hi = Math.min(commonPrefix(before, after), after.length - text.length);
  if (after.length - text.length > before.length || hi < lo) return false;
  const at = after.indexOf(text, lo);
  return at !== -1 && at <= hi;
}

function isSubsequence(candidate: string, source: string): boolean {
  let matched = 0;
  for (let i = 0; i < source.length && matched < candidate.length; i++) {
    if (source[i] === candidate[matched]) matched++;
  }
  return matched === candidate.length;
}

/**
 * - `landed`: `text` was inserted whole, or the field now holds exactly `text`
 *   and `before` (content, a selection, or the hint of an empty field) is gone.
 * - `indeterminate`: a full and a partial landing read the same. `text` replaced
 *   a selection (or the field did not change and already held it), or every
 *   character of `text` is there in order among the field's own, as a field that
 *   reformats a phone number leaves it.
 */
export function classifyTypedText(
  before: string,
  after: string,
  text: string
): "landed" | "not-landed" | "indeterminate" {
  if (after.includes(text) && after.length === before.length + text.length) return "landed";
  const beforeSurvived =
    after.length >= before.length &&
    commonPrefix(before, after) + commonSuffix(before, after) >= before.length;
  if (after === text && !beforeSurvived) return "landed";
  if (replacedRun(before, after, text)) return "indeterminate";
  if (!after.includes(text) && isSubsequence(text, after)) return "indeterminate";
  return "not-landed";
}

const unverified = (reason: string): KeyboardVerification => ({
  note: `The text was typed but not verified: ${reason}`,
});

async function resolveDevtools(
  registry: Registry,
  device: DeviceInfo
): Promise<AndroidDevtoolsApi | null> {
  const until = helperUnavailableUntil.get(device.id);
  if (until !== undefined && Date.now() < until) return null;
  try {
    const ref = androidDevtoolsRef(device);
    return await registry.resolveService<AndroidDevtoolsApi>(ref.urn, ref.options);
  } catch {
    helperUnavailableUntil.set(device.id, Date.now() + HELPER_UNAVAILABLE_TTL_MS);
    return null;
  }
}

async function readFocusedField(devtools: AndroidDevtoolsApi): Promise<FocusedField | string> {
  try {
    // `clearCache`: the helper's node cache otherwise serves the pre-typing text.
    const { xml } = await devtools.getHierarchy({ clearCache: true, maxNodes: FLOW_MAX_NODES });
    return findFocusedTextField(xml);
  } catch {
    return "reading the field back failed.";
  }
}

/**
 * Type `text` and read the focused field before and after. `adb shell input text`
 * exits 0 even when a field that re-renders per keystroke dropped part of the
 * burst. Types exactly once on every path; a check that cannot conclude leaves
 * `verified` absent and says why in `note`.
 */
export async function typeAndroidTextVerified(
  registry: Registry,
  device: DeviceInfo,
  text: string
): Promise<KeyboardVerification> {
  const devtools = await resolveDevtools(registry, device);
  if (!devtools) {
    await injectAndroidText(device.id, text);
    return unverified("the android-devtools helper is unavailable.");
  }
  const before = await readFocusedField(devtools);
  await injectAndroidText(device.id, text);
  if (typeof before === "string") return unverified(before);
  const after = await readFocusedField(devtools);
  if (typeof after === "string") return unverified(after);
  if (!isSameField(before, after)) return unverified("focus moved to another field.");
  const verdict = classifyTypedText(before.text, after.text, text);
  if (verdict === "landed") return { verified: true };
  if (verdict === "indeterminate") {
    return unverified("the field's contents fit both a full and a partial landing.");
  }
  return {
    verified: false,
    note:
      `${text.length} characters were typed and the field holds ` +
      `${after.text.length} in total, counting any earlier content or hint. The field dropped ` +
      "part of the key-event burst, or it rejected or reformatted the input.",
  };
}
