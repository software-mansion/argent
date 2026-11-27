import type { DescribeNode, DescribeTreeData } from "../tools/describe/contract";
import { SECRET_PLACEHOLDER_MARKER } from "./secrets";

/**
 * The `{{secret:NAME}}` values typed on each device, so that screen text quoted
 * in a result can name the placeholder instead of the value.
 *
 * A text field that is not secure shows what was typed into it, and a check
 * that fails on that field quotes the text it read. The check can run long
 * after the typing: in a later step, in a later e2e test of a directory run, or
 * in the run around a nested one. So the values are kept per device for the
 * life of the tool-server, not per run. In memory only: nothing here is logged
 * or written anywhere.
 *
 * Nothing is inferred. A value is found only where the screen shows it exactly
 * as it was typed. What a field made of a value (a capital letter, a
 * correction, a format) is not looked for: the tree that reads the text of
 * text inputs withholds that text instead, once a secret was typed on the
 * device (see {@link WITHHELD_INPUT_TEXT}).
 */

/** Most values kept for one device; the oldest goes first. */
const MAX_VALUES = 256;

/**
 * Resolved value to the placeholder that names it, per device. A device has an
 * entry from its first secret on, also after every value was evicted: that a
 * secret was typed on it is never forgotten.
 */
const devices = new Map<string, Map<string, string>>();

/** A UDID can arrive in either case; no two devices differ by case alone. */
function deviceKey(deviceId: string): string {
  return deviceId.toLowerCase();
}

/**
 * Note the secrets a text-entry tool is about to type on a device, before the
 * first key goes out: a tool that fails partway has typed part of a value. By
 * value: a name can resolve to a second value later, and the first can still be
 * in a field.
 */
export function noteTypedSecrets(
  deviceId: string,
  secrets: ReadonlyArray<{ name: string; value: string }>
): void {
  if (secrets.length === 0) return;
  const key = deviceKey(deviceId);
  const values = devices.get(key) ?? new Map<string, string>();
  devices.set(key, values);
  for (const { name, value } of secrets) {
    if (value.length === 0) continue;
    values.delete(value);
    values.set(value, `${SECRET_PLACEHOLDER_MARKER}${name}}}`);
    if (values.size > MAX_VALUES) values.delete(values.keys().next().value as string);
  }
}

/**
 * Every secret value typed on any device, by name, newest first per device. A
 * value typed under a name that now resolves to another value is still here.
 */
export function typedSecrets(): Array<{ name: string; value: string }> {
  return [...devices.values()].flatMap((values) =>
    [...values].reverse().map(([value, placeholder]) => ({
      name: placeholder.slice(SECRET_PLACEHOLDER_MARKER.length, -2),
      value,
    }))
  );
}

/** Whether a secret was ever typed on the device, for the life of the tool-server. */
export function secretTypedOn(deviceId: string): boolean {
  return devices.has(deviceKey(deviceId));
}

/**
 * What a quote shows in place of the text a text input holds, on a device a
 * secret was typed on. The field can hold the secret in a form no value
 * matches, so its text is not quoted at all.
 */
export const WITHHELD_INPUT_TEXT = "[text withheld: a secret was typed on this device]";

/**
 * Screen text of a device, fit to quote: with the placeholder in place of each
 * secret value typed on that device. The match is exact and case-sensitive, the
 * longest value first at any position, in one pass over the text, so a
 * placeholder is never searched again.
 *
 * Meant for text read off the screen only. A caller's own wording, and the
 * text an author expected, stay out of it: a short value would be found in
 * them by chance.
 */
export function redactTypedSecrets(deviceId: string, text: string): string {
  const values = devices.get(deviceKey(deviceId));
  if (!values || values.size === 0) return text;
  const longestFirst = [...values].sort((a, b) => b[0].length - a[0].length);
  let out = "";
  for (let at = 0; at < text.length;) {
    const hit = longestFirst.find(([value]) => text.startsWith(value, at));
    out += hit ? hit[1] : text[at];
    at += hit ? hit[0].length : 1;
  }
  return out;
}

/** The node of `quotable` at the place `node` has in `tree`: the two have one shape. */
function twinOf(
  tree: DescribeNode,
  quotable: DescribeNode,
  node: DescribeNode
): DescribeNode | undefined {
  if (tree === node) return quotable;
  for (let i = 0; i < tree.children.length; i++) {
    const twin = quotable.children[i];
    const found = twin && twinOf(tree.children[i], twin, node);
    if (found) return found;
  }
  return undefined;
}

/**
 * The text of `node`, a node of `data.tree`, as a result may quote it: the
 * reason of a failed `text` check is the one place the runner quotes the
 * screen. `read` takes the text off a node, as the check did.
 *
 * A tree that came with a quotable projection (see
 * `DescribeTreeData.quotableTree`) is quoted from it, so text that is withheld
 * was never part of what is assembled here. Every other tree is quoted as it
 * was read, with each secret value typed on the device named by its
 * placeholder.
 */
export function quotedText(
  data: DescribeTreeData,
  deviceId: string,
  node: DescribeNode,
  read: (node: DescribeNode) => string
): string {
  if (!data.quotableTree) return redactTypedSecrets(deviceId, read(node));
  const twin = twinOf(data.tree, data.quotableTree, node);
  return twin ? read(twin) : WITHHELD_INPUT_TEXT;
}

/** @internal The values outlive a run on purpose, so tests clear them. */
export function __resetTypedSecretsForTesting(): void {
  devices.clear();
}
