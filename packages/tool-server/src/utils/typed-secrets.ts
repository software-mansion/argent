import type { DescribeNode } from "../tools/describe/contract";
import { SECRET_PLACEHOLDER_MARKER } from "./secrets";

/**
 * What this tool-server knows about the `{{secret:NAME}}` values typed on each
 * device, so that screen text quoted in a result can name the placeholder
 * instead of the value.
 *
 * A text field that is not secure shows what was typed into it, and a check
 * that fails on that field quotes the text it read. The check can run long
 * after the typing: in a later step, in a later e2e test of a directory run, or
 * in the run around a nested one. So the knowledge is kept per device for the
 * life of the tool-server, not per run.
 *
 * Three things are kept, from the most exact to the least:
 *
 * - the resolved values, noted by the tools that type them;
 * - the text a field showed after a step typed a secret into it, which is not
 *   the value when the field capitalizes, corrects or formats what it gets;
 * - the identifiers of those fields, for text that changed after it was read.
 *
 * In memory only. Nothing here is logged or written anywhere.
 */

interface SecretField {
  /** The field's texts before the first secret went into it: not secret. */
  before: { label?: string; value?: string };
  /** The step's text as its author wrote it, placeholders unresolved. */
  typed: string;
}

interface DeviceSecrets {
  /** Resolved value to the placeholder that names it. */
  values: Map<string, string>;
  /** Text a field showed to the step text that put it there. */
  shown: Map<string, string>;
  /** Identifier of a field a secret was typed into. */
  fields: Map<string, SecretField>;
}

/** Most entries of one kind for one device; the oldest goes first. */
const MAX_ENTRIES = 256;

const devices = new Map<string, DeviceSecrets>();

/** A UDID can arrive in either case; no two devices differ by case alone. */
function deviceKey(deviceId: string): string {
  return deviceId.toLowerCase();
}

function secretsOf(deviceId: string): DeviceSecrets {
  const key = deviceKey(deviceId);
  let known = devices.get(key);
  if (!known) {
    known = { values: new Map(), shown: new Map(), fields: new Map() };
    devices.set(key, known);
  }
  return known;
}

function remember<V>(map: Map<string, V>, key: string, value: V): void {
  map.delete(key);
  map.set(key, value);
  if (map.size > MAX_ENTRIES) map.delete(map.keys().next().value as string);
}

/**
 * Note the secrets a text-entry tool is about to type on a device. By value: a
 * name can resolve to a second value later, and the first can still be in a
 * field.
 */
export function noteTypedSecrets(
  deviceId: string,
  secrets: ReadonlyArray<{ name: string; value: string }>
): void {
  for (const { name, value } of secrets) {
    if (value.length === 0) continue;
    remember(secretsOf(deviceId).values, value, `${SECRET_PLACEHOLDER_MARKER}${name}}}`);
  }
}

/**
 * Note the text a field showed after a step typed `typed` into it, when that
 * text is not the value itself.
 */
export function noteShownSecret(deviceId: string, shown: string, typed: string): void {
  if (shown.trim().length === 0) return;
  remember(secretsOf(deviceId).shown, shown, typed);
}

/**
 * Note a field a secret is about to be typed into, with the texts it had
 * before. The first note of a field stands: a later one would record a secret
 * as the text the field had before.
 */
export function noteSecretField(deviceId: string, identifier: string, field: SecretField): void {
  const { fields } = secretsOf(deviceId);
  if (!fields.has(identifier)) remember(fields, identifier, field);
}

/** Forget the fields of a device: its app started again, and so did they. */
export function forgetSecretFields(deviceId: string): void {
  devices.get(deviceKey(deviceId))?.fields.clear();
}

/** What a quote shows for the text of a field that took a secret and no longer shows a known form of it. */
function withheld(typed: string): string {
  return `[withheld: a step typed ${typed} into this field]`;
}

type Needle = readonly [text: string, replacement: string];

/** Lowercase when that keeps every character where it was, so positions still line up. */
function fold(text: string): string {
  const lower = text.toLowerCase();
  return lower.length === text.length ? lower : text;
}

/**
 * Replace each needle in `text`, the longest first at any position and without
 * regard to case: a field can capitalize what is typed into it. One pass over
 * the original text, so a replacement is never searched again. `covered` says
 * whether the needles account for all of `text`.
 */
function replaceNeedles(
  text: string,
  needles: readonly Needle[]
): { out: string; covered: boolean } {
  const ordered = needles
    .filter(([needle]) => needle.length > 0)
    .map(([needle, replacement]) => [fold(needle), replacement] as const)
    .sort((a, b) => b[0].length - a[0].length);
  const folded = fold(text);
  let out = "";
  let covered = true;
  for (let at = 0; at < text.length;) {
    const hit = ordered.find(([needle]) => folded.startsWith(needle, at));
    if (hit) {
      out += hit[1];
      at += hit[0].length;
    } else {
      out += text[at];
      covered = false;
      at += 1;
    }
  }
  return { out, covered };
}

function* nodesOf(node: DescribeNode): Generator<DescribeNode> {
  yield node;
  for (const child of node.children) yield* nodesOf(child);
}

/**
 * Screen text of a device, fit to quote: with the placeholder in place of each
 * secret value typed on that device, and of each text a field showed for one.
 *
 * `tree` is the tree the text was read from. With it, the text of a field that
 * took a secret is also withheld when it is no known form of that secret: the
 * field changed it after it was read, or it was never read. Text that holds no
 * secret comes back as it is.
 *
 * Meant for the text read off the screen only. A caller's own wording, and the
 * text an author expected, stay out of it: a short value would be found in
 * them by chance.
 */
export function redactTypedSecrets(deviceId: string, text: string, tree?: DescribeNode): string {
  const known = devices.get(deviceKey(deviceId));
  if (!known || text.length === 0) return text;
  const forms: Needle[] = [...known.values, ...known.shown];
  const needles = [...forms];
  if (tree && known.fields.size > 0) {
    for (const node of nodesOf(tree)) {
      const field = node.identifier === undefined ? undefined : known.fields.get(node.identifier);
      if (!field) continue;
      for (const key of ["value", "label"] as const) {
        const now = node[key];
        if (!now || now === field.before[key]) continue;
        if (!replaceNeedles(now, forms).covered) needles.push([now, withheld(field.typed)]);
      }
    }
  }
  if (needles.length === 0) return text;
  return replaceNeedles(text, needles).out;
}

/** @internal The registry outlives a run on purpose, so tests clear it. */
export function __resetTypedSecretsForTesting(): void {
  devices.clear();
}
