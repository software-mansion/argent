import type { DeviceInfo, Registry } from "@argent/registry";
import {
  axServiceRef,
  type AXServiceApi,
  type AXTreeNode,
  type AXTreeResponse,
} from "../../blueprints/ax-service";
import {
  noFocusedFieldError,
  notAnsweredError,
  notVerifiedError,
  unsupportedFieldError,
  untypeableTextError,
} from "./errors";
import {
  clearPairsFor,
  fillBySimulatorKeys,
  pressSimulatorBackspace,
  typeableOnSimulator,
  typeOnSimulator,
} from "./keys";
import { textMatches } from "./text-match";
import type { FillResult } from "./types";

const NEWLINE = /[\r\n]/;
// XCUIElementType TextView.
const TEXT_VIEW_TYPE = 52;

/**
 * iOS simulator, local or remote. The ax-service selects all through the AX
 * text operations and inserts (or deletes), with no app injection; the app
 * sees an ordinary edit. It reads the field back itself, by its selection
 * length, and answers only whether it matched.
 *
 * - A native secure field drops inserted text: the daemon clears it, and the
 *   text is typed with keys and read back.
 * - A web password input ignores the delete but keeps its text selected, and
 *   one HID backspace clears it.
 * - A write that does not read back fails with FILL_NOT_VERIFIED. Keys never
 *   follow a native write: they would type into whatever the write left.
 * - An ax-service older than `fill` falls back to keys, sized and checked
 *   through its `tree` where it has one.
 */
export async function fillIos(
  registry: Registry,
  device: DeviceInfo,
  text: string
): Promise<FillResult> {
  const ref = axServiceRef(device);
  const ax = await registry.resolveService<AXServiceApi>(ref.urn, ref.options);

  // Keys on a secure field type into a single-line input, where a newline is
  // Return: it would submit the form.
  const typeable = typeableOnSimulator(text) && !NEWLINE.test(text);
  const first = await ax.fill(text, { typeable });
  if (first === null) return fillWithLegacyDaemon(registry, device, ax, text);
  if (!first.focused) throw noFocusedFieldError("fill_ios_no_focus");
  if (first.unsupported) {
    throw unsupportedFieldError(
      "the focused element is not a text input (a date or time input, or a picker)",
      "fill_ios_unsupported_field"
    );
  }
  if (first.singleLine) {
    throw unsupportedFieldError(
      "a single-line text field cannot hold a newline",
      "fill_ios_single_line"
    );
  }
  if (first.timedOut) throw notAnsweredError("fill_ios_timeout");
  if (first.verified) return { method: "accessibility", verified: true, length: first.length };

  if (first.secure) {
    if (!typeable) {
      throw unsupportedFieldError(
        "a secure text field takes only text the keyboard can type on one line, and this text has a character it cannot",
        "fill_ios_secure_untypeable"
      );
    }
    if (!first.cleared) throw notVerifiedError("accessibility", "fill_ios_secure_not_cleared");
    await typeOnSimulator(registry, device, text);
    const check = await ax.fill(text, { check: true });
    if (check?.verified) return { method: "keys", verified: true, length: check.length };
    throw notVerifiedError("keys", "fill_ios_not_verified");
  }

  if (first.needsBackspace) {
    await pressSimulatorBackspace(registry, device);
    const check = await ax.fill(text, { check: true });
    if (check?.verified) return { method: "accessibility", verified: true, length: check.length };
  }
  throw notVerifiedError("accessibility", "fill_ios_not_verified");
}

/** The input holding keyboard focus in a `tree` answer, if the answer names one. */
function focusedTreeNode(tree: AXTreeResponse): AXTreeNode | undefined {
  // The last match is the innermost: the walk is in document order.
  return [...tree.nodes].reverse().find((node) => node.traits?.includes("isEditing"));
}

async function readTree(ax: AXServiceApi): Promise<AXTreeResponse | undefined> {
  try {
    return await ax.tree();
  } catch {
    // A daemon older than `tree`, or one that timed out: nothing to go on.
    return undefined;
  }
}

/** Whether a focused `tree` node shows `text`. Only lengths and booleans leave here. */
function treeNodeHolds(node: AXTreeNode, text: string): boolean {
  const value = node.value ?? "";
  if (text === "") return value === "" || node.hintShowing === true || value === node.placeholder;
  return textMatches(value, text);
}

/**
 * The key fallback for an ax-service without `fill`. Its `tree` (0.27 and up)
 * names the focused input: nothing focused fails before a key is sent, the
 * burst is sized from the input's length, a newline is refused for a
 * single-line input, and the text is read back after typing.
 */
async function fillWithLegacyDaemon(
  registry: Registry,
  device: DeviceInfo,
  ax: AXServiceApi,
  text: string
): Promise<FillResult> {
  // Checked first so nothing is deleted; the message names no character.
  if (!typeableOnSimulator(text)) throw untypeableTextError("fill_keys_untypeable_ios");
  const before = await readTree(ax);
  const focused = before && focusedTreeNode(before);
  if (before && !before.truncated && !focused) throw noFocusedFieldError("fill_ios_keys_no_focus");
  if (focused && NEWLINE.test(text)) {
    const multiline =
      focused.traits?.includes("textView") === true || focused.elementType === TEXT_VIEW_TYPE;
    if (!multiline) {
      throw unsupportedFieldError(
        "a single-line text field cannot hold a newline",
        "fill_ios_keys_newline"
      );
    }
  }
  await fillBySimulatorKeys(registry, device, text, clearPairsFor(focused?.value?.length));
  if (!focused) return { method: "keys", verified: null };
  const after = await readTree(ax);
  const node = after && focusedTreeNode(after);
  if (!node) return { method: "keys", verified: null };
  if (!treeNodeHolds(node, text)) throw notVerifiedError("keys", "fill_ios_keys_not_verified");
  return { method: "keys", verified: true, length: text === "" ? 0 : (node.value?.length ?? 0) };
}
