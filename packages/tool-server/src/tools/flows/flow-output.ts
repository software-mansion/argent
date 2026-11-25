import { SECRET_PLACEHOLDER_RE } from "@argent/configuration-core";

/**
 * `{{output:PATH}}` and `{{output:PATH ?? FALLBACK}}` references to the values
 * a run's script steps return.
 *
 * A run holds one output document. Each `script` step receives it as the
 * global `output`, and what the script leaves there replaces it. A reference
 * reads a path out of the document when the step that holds it runs.
 *
 * The grammar is all there is: a path of keys and array indexes joined by
 * dots, and one literal fallback. Anything else that opens with the marker is
 * refused, so the syntax cannot grow into an expression language by accident.
 */

export const OUTPUT_REFERENCE_MARKER = "{{output:";

/** The values the script steps of one run returned. */
export type FlowOutput = Record<string, unknown>;

const SEGMENT = String.raw`(?:[A-Za-z_][A-Za-z0-9_-]*|\d+)`;
const PATH_RE = new RegExp(`^${SEGMENT}(?:\\.${SEGMENT})*$`);
const NUMBER_RE = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
const MAX_LISTED_KEYS = 20;

const GRAMMAR =
  "write `{{output:PATH}}` or `{{output:PATH ?? FALLBACK}}`, where PATH is keys and array " +
  "indexes joined by dots, e.g. `{{output:user.id}}` or `{{output:items.0.name ?? none}}`";

/** A reference that cannot resolve, or a value that cannot go where it was put. */
export class OutputReferenceError extends Error {}

interface OutputReference {
  start: number;
  end: number;
  /** As written, for messages. */
  source: string;
  path: string;
  fallback?: { value: unknown };
}

/** Why `text` holds a malformed reference, or undefined. */
export function outputReferenceProblem(text: string): string | undefined {
  try {
    scan(text);
    return undefined;
  } catch (err) {
    return (err as Error).message;
  }
}

export function holdsOutputMarker(text: string): boolean {
  return text.includes(OUTPUT_REFERENCE_MARKER);
}

function scan(text: string): OutputReference[] {
  const refs: OutputReference[] = [];
  let at = text.indexOf(OUTPUT_REFERENCE_MARKER);
  while (at !== -1) {
    const close = text.indexOf("}}", at + OUTPUT_REFERENCE_MARKER.length);
    if (close === -1) {
      throw new Error(`has a reference with no closing \`}}\`: ${GRAMMAR}`);
    }
    const source = text.slice(at, close + 2);
    const body = text.slice(at + OUTPUT_REFERENCE_MARKER.length, close);
    const parts = body.split("??");
    const path = parts[0]!.trim();
    if (!PATH_RE.test(path)) {
      throw new Error(`has an invalid reference ${JSON.stringify(source)}: ${GRAMMAR}`);
    }
    if (parts.length > 2) {
      throw new Error(
        `has an invalid reference ${JSON.stringify(source)}: a reference takes one \`??\` fallback`
      );
    }
    const ref: OutputReference = { start: at, end: close + 2, source, path };
    if (parts.length === 2) {
      const literal = parts[1]!.trim();
      if (literal.includes("{{")) {
        throw new Error(
          `has an invalid reference ${JSON.stringify(source)}: a fallback is a literal value, not another reference`
        );
      }
      ref.fallback = { value: parseFallback(literal, source) };
    }
    refs.push(ref);
    at = text.indexOf(OUTPUT_REFERENCE_MARKER, close + 2);
  }
  return refs;
}

/**
 * A JSON number, `true`, `false`, `null` or a double-quoted JSON string keeps
 * its type; any other text is a string as written. The quotes are how a
 * fallback says `"3"` rather than 3, or keeps the spaces around it.
 */
function parseFallback(literal: string, source: string): unknown {
  if (literal === "true") return true;
  if (literal === "false") return false;
  if (literal === "null") return null;
  if (NUMBER_RE.test(literal)) return Number(literal);
  if (literal.startsWith('"')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(literal);
    } catch {
      parsed = undefined;
    }
    if (typeof parsed !== "string") {
      throw new Error(
        `has an invalid reference ${JSON.stringify(source)}: a quoted fallback must be one JSON string, e.g. "3"`
      );
    }
    return parsed;
  }
  return literal;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value))
  );
}

type Lookup = { found: true; value: unknown } | { found: false; why: string };

/** The value at `path`. Missing and null are both "not found". */
export function lookupOutput(output: FlowOutput, path: string): Lookup {
  let node: unknown = output;
  let walked = "output";
  for (const segment of path.split(".")) {
    if (Array.isArray(node)) {
      const index = /^\d+$/.test(segment) ? Number(segment) : -1;
      if (index < 0 || index >= node.length) {
        return {
          found: false,
          why: `${walked} is a list of ${node.length} item${node.length === 1 ? "" : "s"}, with no index ${segment}`,
        };
      }
      node = node[index];
    } else if (isRecord(node)) {
      if (!Object.hasOwn(node, segment)) {
        const keys = Object.keys(node);
        const listed = keys.slice(0, MAX_LISTED_KEYS).join(", ");
        const more =
          keys.length > MAX_LISTED_KEYS ? `, and ${keys.length - MAX_LISTED_KEYS} more` : "";
        return {
          found: false,
          why:
            keys.length === 0
              ? `${walked} has no keys`
              : `${walked} has no key "${segment}" (keys: ${listed}${more})`,
        };
      }
      node = node[segment];
    } else {
      return { found: false, why: `${walked} is ${describe(node)}, not an object or a list` };
    }
    walked += `.${segment}`;
  }
  if (node === null) return { found: false, why: `${walked} is null` };
  return { found: true, value: node };
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return "a string";
  return `a ${typeof value}`;
}

function resolveRef(ref: OutputReference, output: FlowOutput): unknown {
  const hit = lookupOutput(output, ref.path);
  if (hit.found) return hit.value;
  if (ref.fallback) return ref.fallback.value;
  throw new OutputReferenceError(`${ref.source} has no value: ${hit.why}`);
}

function asText(value: unknown, ref: OutputReference): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  throw new OutputReferenceError(
    `${ref.source} is ${Array.isArray(value) ? "a list" : value === null ? "null" : "an object"}, which ` +
      "cannot be part of text: reference one of its values"
  );
}

function secretRefusal(ref: OutputReference): OutputReferenceError {
  return new OutputReferenceError(
    `${ref.source} would put a {{secret:...}} placeholder in the step. A value from a script's ` +
      "output never resolves a secret: write the placeholder in the e2e test file instead"
  );
}

/**
 * `text` with each reference replaced by its value as text. A secret
 * placeholder that the inserted values hold, or form with the text around
 * them, is refused: only the e2e test file may name a secret.
 */
export function resolveOutputText(text: string, output: FlowOutput): string {
  const refs = scan(text);
  if (refs.length === 0) return text;
  let resolved = "";
  let copied = 0;
  const spans: Array<{ from: number; to: number; ref: OutputReference }> = [];
  for (const ref of refs) {
    resolved += text.slice(copied, ref.start);
    const value = asText(resolveRef(ref, output), ref);
    spans.push({ from: resolved.length, to: resolved.length + value.length, ref });
    resolved += value;
    copied = ref.end;
  }
  resolved += text.slice(copied);
  for (const span of spans) {
    if (resolved.slice(span.from, span.to).includes("{{secret:")) throw secretRefusal(span.ref);
  }
  for (const match of resolved.matchAll(new RegExp(SECRET_PLACEHOLDER_RE.source, "g"))) {
    const from = match.index;
    const to = from + match[0].length;
    const span = spans.find((s) => s.from < to && s.to > from);
    if (span) throw secretRefusal(span.ref);
  }
  return resolved;
}

/**
 * A `tool:` argument: a string that is exactly one reference becomes the value
 * with its JSON type, a copy of it; any other string resolves as text.
 */
export function resolveOutputValue(text: string, output: FlowOutput): unknown {
  const refs = scan(text);
  const only = refs.length === 1 ? refs[0]! : undefined;
  if (!only || only.start !== 0 || only.end !== text.length) return resolveOutputText(text, output);
  const value = resolveRef(only, output);
  if (JSON.stringify(value).includes("{{secret:")) throw secretRefusal(only);
  return structuredClone(value);
}

/** `assert: { output: PATH, <test>: <expected> }`, and the same `when:` guard. */
export interface OutputCheck {
  path: string;
  test: "exists" | "equals" | "contains" | "matches";
  /** A boolean for `exists`, text for the others. */
  expected: boolean | string;
}

export const OUTPUT_CHECK_TESTS = ["exists", "equals", "contains", "matches"] as const;

/** Why `path` cannot be an `output:` check path, or undefined. */
export function outputPathProblem(path: unknown): string | undefined {
  if (typeof path === "string" && PATH_RE.test(path)) return undefined;
  return (
    "output needs a path of keys and array indexes joined by dots, without braces, " +
    "e.g. `output: user.id`"
  );
}

/**
 * Whether the check holds, and a reason that names the value. A reference in
 * `expected` is already resolved. Text comparisons are exact and case-sensitive: an output is
 * data, not text read off a screen.
 */
export function evaluateOutputCheck(
  check: OutputCheck,
  output: FlowOutput
): { ok: boolean; reason: string } {
  const expected = check.expected;
  const hit = lookupOutput(output, check.path);
  const at = `output.${check.path}`;
  if (check.test === "exists") {
    const ok = hit.found === expected;
    return { ok, reason: hit.found ? `${at} is set` : hit.why };
  }
  if (!hit.found) return { ok: false, reason: hit.why };
  const value = hit.value;
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
    return {
      ok: false,
      reason: `${at} is ${Array.isArray(value) ? "a list" : "an object"}: check one of its values`,
    };
  }
  const actual = String(value);
  const want = String(expected);
  const ok =
    check.test === "equals"
      ? actual === want
      : check.test === "contains"
        ? actual.includes(want)
        : new RegExp(want).test(actual);
  return { ok, reason: `${at} is ${JSON.stringify(actual)}` };
}
