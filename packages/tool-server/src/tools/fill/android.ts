import type { DeviceInfo, Registry } from "@argent/registry";
import { androidDevtoolsRef, type AndroidDevtoolsApi } from "../../blueprints/android-devtools";
import { readAndroidUiTree } from "../ui-tree/android";
import type { UiTree, UiTreeNode } from "../ui-tree";
import {
  noFocusedFieldError,
  notAnsweredError,
  notVerifiedError,
  unsupportedFieldError,
  untypeableTextError,
} from "./errors";
import { clearPairsFor, fillByAndroidKeys, typeableOnAndroid } from "./keys";
import type { FillResult } from "./types";

/**
 * Android phone or tablet. The devtools helper finds the input-focused node,
 * sets its text with ACTION_SET_TEXT and reads it back (a password by length),
 * answering only whether it matched. A write that does not read back fails
 * with FILL_NOT_VERIFIED; keys never follow it.
 *
 * A helper older than `setText` (until the tool-server upgrades it), or one
 * that cannot start, falls back to keys.
 */
export async function fillAndroid(
  registry: Registry,
  device: DeviceInfo,
  text: string
): Promise<FillResult> {
  let helper: AndroidDevtoolsApi | null = null;
  try {
    const ref = androidDevtoolsRef(device);
    helper = await registry.resolveService<AndroidDevtoolsApi>(ref.urn, ref.options);
  } catch {
    // The helper could not be installed or started; keys need only adb.
  }
  const first = helper ? await helper.setText(text) : null;
  if (!helper || first === null) return fillWithKeys(registry, device, text, helper !== null);
  if (!first.focused) throw noFocusedFieldError("fill_android_no_focus");
  if (first.singleLine) {
    throw unsupportedFieldError(
      "a single-line text field cannot hold a newline",
      "fill_android_single_line"
    );
  }
  if (first.timedOut) throw notAnsweredError("fill_android_timeout");
  if (first.verified) return { method: "helper", verified: true, length: first.length };
  throw notVerifiedError("helper", "fill_android_not_verified");
}

/** The editable node holding focus, the innermost one when several claim it. */
function focusedEditable(tree: UiTree): UiTreeNode | undefined {
  let found: UiTreeNode | undefined;
  const walk = (node: UiTreeNode) => {
    if (node.focused && node.editable) found = node;
    node.children.forEach(walk);
  };
  tree.roots.forEach(walk);
  return found;
}

async function readTree(registry: Registry, device: DeviceInfo): Promise<UiTree | undefined> {
  try {
    return await readAndroidUiTree(registry, device);
  } catch {
    return undefined;
  }
}

/**
 * The key fallback. An older helper still reads the hierarchy, so: nothing
 * focused fails before a key is sent, the burst is sized from the field's
 * length (a password's is unknown, so it gets the full burst), and a plain
 * field is read back after typing. Without a helper the keys go out blind.
 */
async function fillWithKeys(
  registry: Registry,
  device: DeviceInfo,
  text: string,
  canReadTree: boolean
): Promise<FillResult> {
  // Checked first so nothing is deleted; the message names no character.
  if (!typeableOnAndroid(text)) throw untypeableTextError("fill_keys_untypeable_android");
  const before = canReadTree ? await readTree(registry, device) : undefined;
  const focused = before && focusedEditable(before);
  if (before && !before.truncated && !focused)
    throw noFocusedFieldError("fill_android_keys_no_focus");
  const length = focused && !focused.password ? (focused.value?.length ?? 0) : undefined;
  await fillByAndroidKeys(device.id, text, clearPairsFor(length));
  if (!focused || focused.password) return { method: "keys", verified: null };
  const after = await readTree(registry, device);
  const node = after && focusedEditable(after);
  if (!node) return { method: "keys", verified: null };
  const value = node.hintShowing ? "" : (node.value ?? "");
  if (value !== text) throw notVerifiedError("keys", "fill_android_keys_not_verified");
  return { method: "keys", verified: true, length: value.length };
}
