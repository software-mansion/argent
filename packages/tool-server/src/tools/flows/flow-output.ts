import { hasVisibleText } from "../../utils/ui-tree-match";
import { PLACEHOLDER_RE } from "../../utils/secrets";
import { describeUnusableEnvValue } from "./script/flow-script-env";

/**
 * `{{output:…}}` references: their grammar, and their resolution against the
 * output document a run's scripts build.
 *
 * A reference is parsed as a DATA PATH and never evaluated. The script computes
 * values, in whatever language it is written in, and the flow file only reads
 * one back: a `.mjs`, a `.sh` and any interpreter added later share one syntax,
 * and no JavaScript engine runs for a flow that has no JavaScript. `??` is
 * spelled the way JavaScript spells it, but it is resolved here over the JSON
 * document, and it has nothing to do with a `??` Node evaluates inside a script.
 *
 * This module knows text and documents only. Which step fields are read, and
 * how a resolved value is written back into a step, is `flow-utils.ts`'s.
 */

export const OUTPUT_REFERENCE_MARKER = "{{output:";

const REFERENCE_CLOSE = "}}";

// What a rejected flow entry or value quotes back, at most. The message travels
// verbatim into `StepReport.reason`, which `argent flow run` prints and
// flowRunToMcpContent emits into the agent's context, so an unbounded render
// would ship a multi-KB payload to both surfaces. 200 characters still shows a
// genuine flow entry in full.
const MAX_ENTRY_RENDER_CHARS = 200;

export function renderedValue(value: string): string {
  if (value.length <= MAX_ENTRY_RENDER_CHARS) return value;
  const elided = value.length - MAX_ENTRY_RENDER_CHARS;
  return `${value.slice(0, MAX_ENTRY_RENDER_CHARS)}…(+${elided} chars)`;
}

/**
 * The longest `echo` message a resolved reference may produce: the 64 KiB a
 * script step's log may hold. A whole-document reference can be a megabyte,
 * and the message goes into the MCP result and onto one CLI line.
 */
export const MAX_ECHO_MESSAGE_CHARS = 64 * 1024;

type Accessor = { key: string } | { index: number };

type Operand =
  | { kind: "path"; accessors: readonly Accessor[] }
  | { kind: "literal"; value: string | number | boolean | null };

interface OutputReference {
  /** The text between `{{output:` and `}}`, trimmed. */
  source: string;
  operands: readonly Operand[];
}

type FieldPart = { text: string } | { reference: OutputReference };

export interface OutputReferenceSyntaxError {
  /** Where the parser stopped, as a 0-based index into the field. */
  at: number;
  /** The reference it stopped in, from its `{{output:` to its `}}` or the field's end. */
  reference: string;
  message: string;
}

type ParsedOutputReferences = { parts: FieldPart[] } | { error: OutputReferenceSyntaxError };

/**
 * Split a field into its literal text and its references.
 *
 * The first `}}` after a `{{output:` closes it, even inside a quoted literal —
 * which is what keeps the end of a reference findable without parsing it, and
 * why a literal cannot hold `}}`. A near spelling (`{{ output:x }}`,
 * `{{Output:x}}`) is not a reference and stays literal text, as a near spelling
 * of `{{secret:` does.
 */
export function parseOutputReferences(text: string): ParsedOutputReferences {
  const parts: FieldPart[] = [];
  let copied = 0;
  let open = text.indexOf(OUTPUT_REFERENCE_MARKER);
  while (open !== -1) {
    const body = open + OUTPUT_REFERENCE_MARKER.length;
    const close = text.indexOf(REFERENCE_CLOSE, body);
    if (close === -1) {
      return {
        error: {
          at: open,
          reference: text.slice(open),
          message: "the reference has no closing `}}`",
        },
      };
    }
    const operands = parseOperands(text, body, close);
    if (operands instanceof ReferenceStop) {
      return {
        error: {
          at: operands.at,
          reference: text.slice(open, close + REFERENCE_CLOSE.length),
          message: operands.message,
        },
      };
    }
    if (open > copied) parts.push({ text: text.slice(copied, open) });
    parts.push({ reference: { source: text.slice(body, close).trim(), operands } });
    copied = close + REFERENCE_CLOSE.length;
    open = text.indexOf(OUTPUT_REFERENCE_MARKER, copied);
  }
  if (copied < text.length) parts.push({ text: text.slice(copied) });
  return { parts };
}

export function describeOutputReferenceSyntaxError(error: OutputReferenceSyntaxError): string {
  return (
    `${error.message} (character ${error.at + 1}, in ` +
    `${JSON.stringify(renderedValue(error.reference))})`
  );
}

/**
 * Where, and why, the parser stopped. Thrown from deep inside one operand and
 * caught once in {@link parseOperands}, so no error escapes this module.
 */
class ReferenceStop extends Error {
  constructor(
    readonly at: number,
    message: string
  ) {
    super(message);
  }
}

class Cursor {
  constructor(
    readonly text: string,
    public at: number,
    readonly end: number
  ) {}

  get done(): boolean {
    return this.at >= this.end;
  }

  peek(): string {
    return this.at < this.end ? this.text[this.at]! : "";
  }

  skipWhitespace(): void {
    while (!this.done && WHITESPACE.test(this.peek())) this.at++;
  }
}

const WHITESPACE = /^[ \t\r\n]$/;
const SEGMENT_START = /^[A-Za-z_]$/;
const SEGMENT_CHAR = /^[A-Za-z0-9_]$/;
const SEGMENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DIGIT = /^[0-9]$/;
const JSON_NUMBER = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
const OPERATOR_RUN = /^[|&+\-*/%=!<>?:,^~]+/;

const LITERAL_WORDS: ReadonlyMap<string, boolean | null> = new Map([
  ["true", true],
  ["false", false],
  ["null", null],
]);

const FIRST_OPERAND =
  "the first operand must be a path into the output document, such as `user.id`; " +
  "a literal can only follow `??`";

function parseOperands(text: string, from: number, end: number): Operand[] | ReferenceStop {
  const cursor = new Cursor(text, from, end);
  try {
    cursor.skipWhitespace();
    if (cursor.done) {
      throw new ReferenceStop(
        cursor.at,
        "the reference names no path; write one, such as `{{output:user.id}}`"
      );
    }
    const operands = [parseOperand(cursor, true)];
    for (;;) {
      const gap = cursor.at;
      cursor.skipWhitespace();
      if (cursor.done) return operands;
      if (text.startsWith("??", cursor.at)) {
        const operator = cursor.at;
        cursor.at += 2;
        cursor.skipWhitespace();
        if (cursor.done) throw new ReferenceStop(operator, "`??` needs an operand after it");
        operands.push(parseOperand(cursor, false));
        continue;
      }
      throw new ReferenceStop(cursor.at, afterOperand(cursor, cursor.at > gap));
    }
  } catch (err) {
    if (err instanceof ReferenceStop) return err;
    throw err;
  }
}

function parseOperand(cursor: Cursor, first: boolean): Operand {
  const at = cursor.at;
  const ch = cursor.peek();
  if (ch === "'" || ch === '"') {
    if (first) throw new ReferenceStop(at, FIRST_OPERAND);
    return { kind: "literal", value: parseString(cursor) };
  }
  if (ch === "-" || DIGIT.test(ch)) {
    if (first) throw new ReferenceStop(at, FIRST_OPERAND);
    return { kind: "literal", value: parseNumber(cursor) };
  }
  if (ch === "{" || ch === "[") {
    throw new ReferenceStop(
      at,
      "object and array literals are not supported; a reference reads one value, and a " +
        "script builds any structure the flow needs"
    );
  }
  if (ch === "(") {
    throw new ReferenceStop(
      at,
      "parentheses are not supported; a reference reads a path, and `??` is its only operator"
    );
  }
  if (!SEGMENT_START.test(ch)) {
    throw new ReferenceStop(
      at,
      `${JSON.stringify(ch)} cannot start an operand; write a path such as \`user.id\` or a ` +
        "literal such as 'none'"
    );
  }
  const word = readSegment(cursor);
  const literal = LITERAL_WORDS.get(word);
  if (literal !== undefined) {
    if (first) {
      throw new ReferenceStop(
        at,
        `${FIRST_OPERAND}. \`${word}\` is a literal; read a key of that name with brackets, ` +
          `such as \`flags["${word}"]\``
      );
    }
    return { kind: "literal", value: literal };
  }
  const accessors: Accessor[] = [{ key: word }];
  for (;;) {
    const next = cursor.peek();
    if (next === ".") {
      cursor.at++;
      if (!SEGMENT_START.test(cursor.peek())) {
        throw new ReferenceStop(
          cursor.at,
          'expected a name after `.`; write a key that is not a name in brackets, such as `order["order-id"]`'
        );
      }
      accessors.push({ key: readSegment(cursor) });
    } else if (next === "[") {
      cursor.at++;
      accessors.push(parseBracket(cursor));
    } else {
      return { kind: "path", accessors };
    }
  }
}

function readSegment(cursor: Cursor): string {
  const start = cursor.at;
  while (SEGMENT_CHAR.test(cursor.peek())) cursor.at++;
  return cursor.text.slice(start, cursor.at);
}

function parseBracket(cursor: Cursor): Accessor {
  const ch = cursor.peek();
  let accessor: Accessor;
  if (DIGIT.test(ch)) {
    const start = cursor.at;
    while (DIGIT.test(cursor.peek())) cursor.at++;
    const digits = cursor.text.slice(start, cursor.at);
    if (digits.length > 1 && digits.startsWith("0")) {
      throw new ReferenceStop(start, "an index cannot start with 0");
    }
    accessor = { index: Number(digits) };
  } else if (ch === "'" || ch === '"') {
    accessor = { key: parseString(cursor) };
  } else {
    throw new ReferenceStop(
      cursor.at,
      'expected an index such as `[0]` or a quoted key such as `["order-id"]` after `[`'
    );
  }
  if (cursor.peek() !== "]") throw new ReferenceStop(cursor.at, "expected `]`");
  cursor.at++;
  return accessor;
}

function parseString(cursor: Cursor): string {
  const start = cursor.at;
  const quote = cursor.peek();
  cursor.at++;
  let value = "";
  let copied = cursor.at;
  for (;;) {
    if (cursor.done) {
      throw new ReferenceStop(
        start,
        "the string has no closing quote (the first `}}` ends a reference, even inside a string)"
      );
    }
    const ch = cursor.peek();
    if (ch === "\\") {
      value += cursor.text.slice(copied, cursor.at);
      cursor.at++;
      if (cursor.done) continue;
      copied = cursor.at;
      cursor.at++;
      continue;
    }
    if (ch === quote) {
      value += cursor.text.slice(copied, cursor.at);
      cursor.at++;
      return value;
    }
    cursor.at++;
  }
}

function parseNumber(cursor: Cursor): number {
  const start = cursor.at;
  JSON_NUMBER.lastIndex = start;
  const match = JSON_NUMBER.exec(cursor.text);
  if (match === null || start + match[0].length > cursor.end) {
    throw new ReferenceStop(start, "expected a number after `-`");
  }
  cursor.at += match[0].length;
  if (/^-?0$/.test(match[0]) && DIGIT.test(cursor.peek())) {
    throw new ReferenceStop(start, "a number cannot start with 0");
  }
  const value = Number(match[0]);
  if (!Number.isFinite(value)) {
    throw new ReferenceStop(start, "the number is too large to hold");
  }
  return value;
}

function afterOperand(cursor: Cursor, afterWhitespace: boolean): string {
  const ch = cursor.peek();
  if (afterWhitespace && (ch === "." || ch === "[")) return "a path cannot contain whitespace";
  if (ch === "(")
    return "function calls are not supported; a reference reads a path and calls nothing";
  const operator = OPERATOR_RUN.exec(cursor.text.slice(cursor.at, cursor.end));
  if (operator) return `\`${operator[0]}\` is not supported; \`??\` is the only operator`;
  if (afterWhitespace) return "expected `??` between two operands";
  return `${JSON.stringify(ch)} cannot follow an operand; expected \`??\` or the end of the reference`;
}

export type OutputDocument = Readonly<Record<string, unknown>>;

/**
 * What a field does with the value a reference gives, which is what decides
 * which values it accepts and which parse rule its resolved text must pass
 * again. `static` is a field that must never hold a reference.
 */
export type OutputFieldKind =
  | "echo"
  | "text"
  | "identifier"
  | "role"
  | "expected"
  | "typed"
  | "arg"
  | "env"
  | "static";

export interface ResolvedOutputReference {
  source: string;
  value: unknown;
}

type OutputFieldResolution =
  | {
      ok: true;
      value: unknown;
      references: ResolvedOutputReference[];
      /** Set when a whole-field `tool.args` reference gave something other than a string. */
      wholeFieldType?: string;
    }
  | { ok: false; reason: string };

/**
 * Resolve every reference in one field, left to right, exactly once. A value a
 * reference gave is never read for references again, so a script can put
 * literal `{{output:` text into a field.
 *
 * The field is built by concatenation, never `String.prototype.replace` with a
 * replacement string, which would expand a `$&` or `$1` inside a value.
 */
export function resolveOutputField(
  text: string,
  kind: Exclude<OutputFieldKind, "static">,
  document: OutputDocument
): OutputFieldResolution {
  const parsed = parseOutputReferences(text);
  if ("error" in parsed) {
    return {
      ok: false,
      reason: `malformed output reference: ${describeOutputReferenceSyntaxError(parsed.error)}`,
    };
  }
  const references: ResolvedOutputReference[] = [];
  for (const part of parsed.parts) {
    if (!("reference" in part)) continue;
    const resolved = resolveReference(part.reference, document);
    if ("misses" in resolved) {
      return {
        ok: false,
        reason:
          `${spell(part.reference)} did not resolve: ${resolved.misses.join("; ")}` +
          // A key a script set to null is one it meant to leave empty, which is
          // what a fallback is for.
          (resolved.nullWithoutFallback ? "; add a `??` fallback if the value can be null" : ""),
      };
    }
    references.push({ source: part.reference.source, value: resolved.value });
  }
  if (references.length === 0) return { ok: true, value: text, references };

  const [only] = parsed.parts;
  if (kind === "arg" && parsed.parts.length === 1 && only !== undefined && "reference" in only) {
    // A whole-field `tool.args` leaf keeps the JSON type of what it read: a
    // tool that takes a number or an object receives one, and a trailing
    // `?? null` is how an author accepts a missing value there.
    const value = references[0]!.value;
    const placed = placeholderInValue(value);
    if (placed !== undefined) {
      return {
        ok: false,
        reason:
          `${spell(only.reference)} gave ${describeJsonType(value)} holding the secret ` +
          `placeholder ${placed.placeholder}${placed.path ? ` at \`${placed.path}\`` : ""}. A ` +
          "secret placeholder must be written in the flow file whole; a script cannot produce one",
      };
    }
    return {
      ok: true,
      value: copyJsonValue(value),
      references,
      ...(typeof value === "string" ? {} : { wholeFieldType: describeJsonType(value) }),
    };
  }

  let built = "";
  const fromOutput: Array<[start: number, end: number]> = [];
  let next = 0;
  for (const part of parsed.parts) {
    if ("text" in part) {
      built += part.text;
      continue;
    }
    const { value } = references[next++]!;
    const rendered = textOf(value, kind === "echo");
    if (rendered === undefined) {
      return {
        ok: false,
        reason:
          value === null
            ? `${spell(part.reference)} gave null, and this field needs text; end the \`??\` ` +
              "chain with a text literal, such as 'none'"
            : `${spell(part.reference)} gave ${describeJsonType(value)}, and this field needs ` +
              "text; reference a string, a number or a boolean inside it",
      };
    }
    fromOutput.push([built.length, built.length + rendered.length]);
    built += rendered;
  }

  if (kind === "echo") return { ok: true, value: cutEchoMessage(built), references };

  // A text-entry tool resolves `{{secret:NAME}}` AFTER this, so a placeholder
  // that output helped spell would resolve a secret the flow file never names.
  // Checked on the whole field, not per value: two values can each carry half
  // of one, and a literal `{` beside a reference can complete one.
  for (const match of built.matchAll(PLACEHOLDER_RE)) {
    const start = match.index;
    const end = start + match[0].length;
    if (fromOutput.some(([from, to]) => to > from && from < end && to > start)) {
      return {
        ok: false,
        reason:
          `${JSON.stringify(renderedValue(text))} would spell the secret placeholder ` +
          `${match[0]} with text from the output document. A secret placeholder must be ` +
          "written in the flow file whole",
      };
    }
  }

  const rule = resolvedTextProblem(built, kind);
  if (rule !== undefined) {
    return {
      ok: false,
      reason:
        `${JSON.stringify(renderedValue(text))} resolved to ` +
        `${JSON.stringify(renderedValue(built))}, and ${rule}`,
    };
  }
  return { ok: true, value: built, references };
}

/**
 * The parse rule of the field, asked again of what it resolved to. The parser
 * saw only the reference, and `?? ''` is the value that gets through it: an
 * empty selector text matches every element with a label, so an `assert` on it
 * passes on any screen and a `tap` presses the first labelled element.
 */
function resolvedTextProblem(
  value: string,
  kind: Exclude<OutputFieldKind, "echo" | "static">
): string | undefined {
  switch (kind) {
    // The tool validates its own arguments, and `?? ''` beside other text is an
    // ordinary argument there.
    case "arg":
      return undefined;
    case "text":
      return hasVisibleText(value)
        ? undefined
        : "selector text must contain at least one visible character (icon-font/private-use " +
            "and zero-width characters render as nothing) — use a fallback literal that names " +
            "what is on screen";
    case "identifier":
      return value.length > 0 ? undefined : "a selector identifier cannot be empty";
    case "role":
      return value.length > 0 ? undefined : "a selector role cannot be empty";
    case "expected":
      return value.length > 0
        ? undefined
        : "expected text cannot be empty — empty text is found in every element";
    case "typed":
      return value.length > 0 ? undefined : "type needs a non-empty text";
    case "env": {
      const unusable = describeUnusableEnvValue(value);
      return unusable === null
        ? undefined
        : `the value ${unusable}, which an environment cannot carry`;
    }
    default: {
      const unclassified: never = kind;
      void unclassified;
      return undefined;
    }
  }
}

function textOf(value: unknown, echo: boolean): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  // An `echo` is how an author looks at the document after a reference stopped
  // a step, so it prints what it read. Compact, because the CLI renders an echo
  // as one indented line.
  return echo ? JSON.stringify(value) : undefined;
}

function cutEchoMessage(message: string): string {
  if (message.length <= MAX_ECHO_MESSAGE_CHARS) return message;
  let cut = MAX_ECHO_MESSAGE_CHARS;
  const last = message.charCodeAt(cut - 1);
  // Never between the two halves of a surrogate pair: a lone half is not
  // valid UTF-8 in the MCP result or on the terminal.
  if (last >= 0xd800 && last <= 0xdbff) cut -= 1;
  return `${message.slice(0, cut)}…(+${message.length - cut} chars)`;
}

function spell(reference: OutputReference): string {
  return renderedValue(`${OUTPUT_REFERENCE_MARKER}${reference.source}${REFERENCE_CLOSE}`);
}

function resolveReference(
  reference: OutputReference,
  document: OutputDocument
): { value: unknown } | { misses: string[]; nullWithoutFallback: boolean } {
  const misses: string[] = [];
  let lastIsNull = false;
  for (const operand of reference.operands) {
    if (operand.kind === "literal") return { value: operand.value };
    const found = lookup(document, operand.accessors);
    if ("value" in found) return found;
    misses.push(found.miss);
    lastIsNull = found.isNull === true;
  }
  return { misses, nullWithoutFallback: reference.operands.length === 1 && lastIsNull };
}

/**
 * Walk one path. A path reads JSON data only: an own property of a plain
 * object, or an element of an array — so `name.length`, `codes.length` and
 * `user.constructor` are missing, not a number and a function. A `null` at the
 * end counts as missing too, which is what lets `??` stand in for a key a
 * script never set and for one it set to `null` alike.
 */
function lookup(
  document: OutputDocument,
  accessors: readonly Accessor[]
): { value: unknown } | { miss: string; isNull?: true } {
  let node: unknown = document;
  let at = "output";
  for (const accessor of accessors) {
    if ("key" in accessor) {
      const name = renderMember(accessor.key);
      if (isJsonObject(node)) {
        if (!Object.hasOwn(node, accessor.key)) {
          return { miss: `\`${at}\` has no \`${name}\`${keysNote(node)}` };
        }
        node = node[accessor.key];
      } else {
        return { miss: `${describeStop(at, node)}, so it has no \`${name}\`` };
      }
      at = `${at}${memberSuffix(accessor.key)}`;
      continue;
    }
    const name = `[${accessor.index}]`;
    if (!Array.isArray(node)) {
      return {
        miss:
          `${describeStop(at, node)}, so it has no \`${name}\`` +
          (isJsonObject(node) ? keysNote(node) : ""),
      };
    }
    if (accessor.index >= node.length) {
      const count = `${node.length} element${node.length === 1 ? "" : "s"}`;
      return { miss: `\`${at}\` has ${count}, so it has no \`${name}\`` };
    }
    node = node[accessor.index];
    at = `${at}${name}`;
  }
  if (node === null) return { miss: `\`${at}\` is null`, isNull: true };
  return { value: node };
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function describeStop(at: string, node: unknown): string {
  return `\`${at}\` is ${describeJsonType(node)}`;
}

export function describeJsonType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  switch (typeof value) {
    case "object":
      return "an object";
    case "string":
      return "a string";
    case "number":
      return "a number";
    case "boolean":
      return "a boolean";
    default:
      return typeof value;
  }
}

const LISTED_KEYS = 20;

/**
 * The step report never shows the document, so a miss on an object names what
 * IS there — the same shape the secret resolver uses to name the secrets it
 * has — and a misspelled key reads as one.
 */
function keysNote(node: Record<string, unknown>): string {
  const keys = Object.keys(node);
  if (keys.length === 0) return " (it has no keys)";
  // Spelled as a reference would read them: a key a script wrote can hold a
  // line break, and a step reason is one line on every surface.
  const listed = keys.slice(0, LISTED_KEYS).map((key) => renderedValue(renderMember(key)));
  const more = keys.length > LISTED_KEYS ? `, and ${keys.length - LISTED_KEYS} more` : "";
  return ` (its keys: ${listed.join(", ")}${more})`;
}

function renderMember(key: string): string {
  return SEGMENT.test(key) ? key : `[${JSON.stringify(key)}]`;
}

function memberSuffix(key: string): string {
  return SEGMENT.test(key) ? `.${key}` : `[${JSON.stringify(key)}]`;
}

/** A document path, spelled the way a reference would read it back. */
export function renderOutputPath(keys: ReadonlyArray<string | number>): string {
  let at = "output";
  for (const key of keys) at += typeof key === "number" ? `[${key}]` : memberSuffix(key);
  return renderedValue(at);
}

interface WalkFrame {
  node: unknown;
  parent: WalkFrame | undefined;
  key: string | number | undefined;
}

function pathOf(frame: WalkFrame): Array<string | number> {
  const keys: Array<string | number> = [];
  for (let at: WalkFrame | undefined = frame; at?.key !== undefined; at = at.parent) {
    keys.push(at.key);
  }
  return keys.reverse();
}

/**
 * Every string inside a value a whole-field reference handed to a tool, keys
 * included: no string in it may hold a placeholder, because the tool resolves
 * one wherever it sits.
 *
 * An explicit stack, because a document may be 4096 levels deep and a
 * recursive walk that carries paths overflowed at 4472 to 4687. The path is
 * rebuilt from parent links only for the hit, so a deep document costs no
 * quadratic string building.
 */
function placeholderInValue(value: unknown): { placeholder: string; path: string } | undefined {
  const pending: WalkFrame[] = [{ node: value, parent: undefined, key: undefined }];
  while (pending.length > 0) {
    const frame = pending.pop()!;
    const { node } = frame;
    if (typeof node === "string") {
      const hit = firstPlaceholder(node);
      if (hit !== undefined) return { placeholder: hit, path: pathLabel(frame) };
      continue;
    }
    if (Array.isArray(node)) {
      for (let i = node.length - 1; i >= 0; i--) {
        pending.push({ node: node[i], parent: frame, key: i });
      }
      continue;
    }
    if (!isJsonObject(node)) continue;
    const keys = Object.keys(node);
    for (let i = keys.length - 1; i >= 0; i--) {
      const key = keys[i]!;
      const hit = firstPlaceholder(key);
      if (hit !== undefined) return { placeholder: hit, path: pathLabel(frame) };
      pending.push({ node: node[key], parent: frame, key });
    }
  }
  return undefined;
}

/**
 * A deep copy of JSON data, so a tool that changes an object it was handed
 * cannot change the run's document. Iterative for the same reason as the walks
 * above: a document may nest 4096 levels, and `structuredClone` ran out of stack
 * at 1,817 on Node 20 and 2,386 on Node 26.
 */
function copyJsonValue(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  const pending: Array<{ from: object; to: Record<string, unknown> | unknown[] }> = [];
  const shell = (node: object): Record<string, unknown> | unknown[] => {
    const to = Array.isArray(node) ? [] : {};
    pending.push({ from: node, to });
    return to;
  };
  const copy = (node: unknown): unknown =>
    node === null || typeof node !== "object" ? node : shell(node);
  const root = shell(value);
  while (pending.length > 0) {
    const { from, to } = pending.pop()!;
    if (Array.isArray(from)) {
      for (const item of from as unknown[]) (to as unknown[]).push(copy(item));
    } else {
      const record = from as Record<string, unknown>;
      for (const key of Object.keys(record)) {
        (to as Record<string, unknown>)[key] = copy(record[key]);
      }
    }
  }
  return root;
}

/**
 * Whether two JSON values hold the same data, key order aside: `jq -S`, or a
 * script that rebuilds an object, reorders keys without changing anything.
 * Iterative, for the same depth as every walk here.
 */
export function sameJsonValue(left: unknown, right: unknown): boolean {
  const pending: Array<[unknown, unknown]> = [[left, right]];
  while (pending.length > 0) {
    const [a, b] = pending.pop()!;
    if (a === b) continue;
    if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
    if (Array.isArray(a) || Array.isArray(b)) {
      if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
      for (let i = 0; i < a.length; i++) pending.push([a[i], b[i]]);
      continue;
    }
    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) return false;
    for (const key of keys) {
      if (!Object.hasOwn(b, key)) return false;
      pending.push([(a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]]);
    }
  }
  return true;
}

function firstPlaceholder(text: string): string | undefined {
  for (const match of text.matchAll(PLACEHOLDER_RE)) return match[0];
  return undefined;
}

function pathLabel(frame: WalkFrame): string {
  const keys = pathOf(frame);
  if (keys.length === 0) return "";
  return renderOutputPath(keys).slice("output".length);
}

/**
 * The warning a script step owes when the document it returned holds an
 * integer JSON cannot carry exactly. `JSON.parse` rounds one past 2^53 — jq
 * writes `12345678901234567891` and the run keeps `12345678901234567000` — and
 * every later script receives the rounded value. Argent does not fight that; it
 * says so, and says to write identifiers as strings.
 *
 * Only paths the script changed are reported: a script is handed the whole
 * document and hands it back, so a value rounded by an earlier step comes back
 * identical and is not that step's to warn about again.
 *
 * An explicit stack, for the same reason as {@link placeholderInValue}: a
 * recursive walk comparing two documents overflowed at 3,369 to 3,844 levels,
 * under the 4096 a document may nest.
 */
export function describeUnsafeIntegers(
  given: OutputDocument,
  returned: OutputDocument
): string | undefined {
  interface Frame extends WalkFrame {
    peer: unknown;
  }
  const pending: Frame[] = [{ node: returned, peer: given, parent: undefined, key: undefined }];
  let first: Frame | undefined;
  let others = 0;
  while (pending.length > 0) {
    const frame = pending.pop()!;
    const { node, peer } = frame;
    if (typeof node === "number") {
      if (Number.isInteger(node) && !Number.isSafeInteger(node) && peer !== node) {
        if (first === undefined) first = frame;
        else others++;
      }
      continue;
    }
    if (Array.isArray(node)) {
      const peers = Array.isArray(peer) ? peer : undefined;
      for (let i = node.length - 1; i >= 0; i--) {
        const child: unknown = node[i];
        if (child === null || (typeof child !== "object" && typeof child !== "number")) continue;
        pending.push({
          node: child,
          peer: peers !== undefined && i < peers.length ? peers[i] : undefined,
          parent: frame,
          key: i,
        });
      }
      continue;
    }
    if (!isJsonObject(node)) continue;
    const peers = isJsonObject(peer) ? peer : undefined;
    const keys = Object.keys(node);
    for (let i = keys.length - 1; i >= 0; i--) {
      const key = keys[i]!;
      const child = node[key];
      if (child === null || (typeof child !== "object" && typeof child !== "number")) continue;
      pending.push({
        node: child,
        peer: peers !== undefined && Object.hasOwn(peers, key) ? peers[key] : undefined,
        parent: frame,
        key,
      });
    }
  }
  if (first === undefined) return undefined;
  const more =
    others === 0
      ? ""
      : ` ${others} more path${others === 1 ? " holds" : "s hold"} an integer past that limit.`;
  return (
    `${renderOutputPath(pathOf(first))} is ${JSON.stringify(first.node)}, past the largest ` +
    `integer a JSON number holds exactly (${Number.MAX_SAFE_INTEGER}), so it may have been ` +
    `rounded; write an identifier as a string.${more}`
  );
}
