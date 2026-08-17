// Convert a tool's JSON Schema (the input shape produced by zodObjectToJsonSchema
// in @argent/registry) plus argv into the JSON args object the tool-server expects.
//
// Supported flag forms:
//   --name value          (string / number / integer)
//   --name=value
//   --name                (boolean: true)
//   --name true|false     (boolean: explicit value — also 1|0; only these are consumed)
//   --no-name             (boolean: false)
//   --name a --name b     (array of scalars)
//   --name-json '<json>'  (arbitrary nested object/array — escape hatch)
//   --args '<json>'       (whole-payload escape hatch; merges with parsed flags)
//   --args -              (read whole-payload JSON from stdin)
//
// Exception: when the tool's own schema declares a property named `args` (e.g.
// flow-add-step, whose `args` is a JSON string of the step's tool arguments),
// `--args <value>` is treated as that per-field value — coerced by its declared
// type, exactly like any other field — NOT the whole-payload escape hatch. Such
// a tool has no whole-payload shortcut; use individual flags / --<field>-json.
//
// Scalar field types come from JSON Schema: string, number, integer, boolean, enum.
// Array fields: items.type must be a scalar to get a repeatable flag.
// Object fields and arrays of objects fall through to --field-json.

export interface JsonSchema {
  type?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  description?: string;
}

export interface FlagParseResult {
  args: Record<string, unknown>;
  positional: string[];
  helpRequested: boolean;
  rawArgs: string | null; // value passed to --args, if any (for stdin handling)
}

export interface FlagParseError {
  message: string;
}

export class FlagParseException extends Error {}

function isScalarType(type: string | undefined): boolean {
  return type === "string" || type === "number" || type === "integer" || type === "boolean";
}

/** Fields that can only be passed as JSON, because a flag value cannot express their shape. */
function isJsonField(prop: JsonSchema | undefined): boolean {
  return prop?.type === "object" || (prop?.type === "array" && !isScalarType(prop.items?.type));
}

/**
 * The flag a field is named by, with no value placeholder — for use in prose.
 *
 * The single source of truth for the `-json` suffix, so a message about a field and the help line
 * for that same field can never disagree. Tolerates an unknown field, which a malformed schema can
 * produce by listing a name it has no property for.
 */
export function flagNameFor(name: string, prop: JsonSchema | undefined): string {
  return isJsonField(prop) ? `--${name}-json` : `--${name}`;
}

/**
 * A token that can only have been meant as a boolean value: `true`/`false` or
 * `1`/`0`, case-insensitive and whitespace-tolerant. `undefined` for anything
 * else, so an ambiguous token is left alone rather than guessed at.
 *
 * The single source of truth for every form — the `--flag <value>` lookahead,
 * `--flag=<value>`, boolean array items, and the `--no-flag` contradiction
 * guard — so the same word cannot mean different things one call site apart.
 */
function booleanLiteral(raw: string): boolean | undefined {
  const value = raw.trim().toLowerCase();
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  return undefined;
}

function coerceScalar(raw: string, type: string | undefined, field: string): unknown {
  if (type === "number") {
    // Number("") and Number("   ") are 0, so reject empty/whitespace explicitly.
    if (raw.trim() === "")
      throw new FlagParseException(`--${field} expected a number, got "${raw}"`);
    const n = Number(raw);
    if (Number.isNaN(n)) throw new FlagParseException(`--${field} expected a number, got "${raw}"`);
    return n;
  }
  if (type === "integer") {
    // Number("") and Number("   ") are 0, so reject empty/whitespace explicitly.
    if (raw.trim() === "")
      throw new FlagParseException(`--${field} expected an integer, got "${raw}"`);
    const n = Number(raw);
    if (!Number.isInteger(n))
      throw new FlagParseException(`--${field} expected an integer, got "${raw}"`);
    return n;
  }
  if (type === "boolean") {
    // Shares booleanLiteral with the bare-token lookahead, so `--flag=True` and
    // `--flag True` cannot disagree about the same word.
    const value = booleanLiteral(raw);
    if (value !== undefined) return value;
    throw new FlagParseException(`--${field} expected true/false (or 1/0), got "${raw}"`);
  }
  // string or unknown: pass through
  return raw;
}

function parseJsonOrThrow(raw: string, label: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new FlagParseException(
      `${label} could not be parsed as JSON: ${err instanceof Error ? err.message : err}`
    );
  }
}

/**
 * Parses argv against the given schema. Throws FlagParseException on bad input.
 * Returned `args` contains parsed fields; the caller is responsible for merging
 * `--args` JSON (if given). Whether the required fields are present is checked
 * against the merged payload in `run-validation`; their types and constraints
 * are validated server-side.
 */
export function parseFlags(argv: string[], schema: JsonSchema | undefined): FlagParseResult {
  const properties = schema?.properties ?? {};
  // The whole-payload `--args '<json>'` escape hatch only exists when the tool
  // does NOT declare its own `args` field. When it does (e.g. flow-add-step),
  // `--args` is that per-field flag, so the "or --args '<json>'" fallback the
  // error messages suggest would be a dead end — that form re-enters per-field
  // handling instead of the hatch, and only `--<field>-json` works. Emit the
  // suggestion only when the hatch is actually available.
  const argsHatchHint = properties.args === undefined ? " or --args '<json>'" : "";
  const args: Record<string, unknown> = {};
  const positional: string[] = [];
  let helpRequested = false;
  let rawArgs: string | null = null;

  // Track which fields have already received a scalar value. A second value for
  // an array field appends; a second value for a scalar field overwrites
  // (with a warning would be nice but we keep it silent to avoid stderr noise).
  const seenArrayFields = new Set<string>();
  // Track which fields were set via `--field-json`, independent of order: a
  // field touched by BOTH `--field` (scalar-array form) and `--field-json` is
  // ambiguous no matter which came first, so both directions must throw rather
  // than one silently overwriting/discarding the other's value.
  const jsonFields = new Set<string>();

  function takeNext(i: number, flag: string): { value: string; nextIndex: number } {
    if (i + 1 >= argv.length) {
      throw new FlagParseException(`--${flag} requires a value`);
    }
    return { value: argv[i + 1]!, nextIndex: i + 1 };
  }

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]!;

    if (tok === "--help" || tok === "-h") {
      helpRequested = true;
      continue;
    }

    if (tok === "--") {
      // Treat the rest as positional.
      for (let j = i + 1; j < argv.length; j++) positional.push(argv[j]!);
      break;
    }

    if (!tok.startsWith("--")) {
      positional.push(tok);
      continue;
    }

    // Strip leading "--" and split "--name=value" into name + inline value.
    const eq = tok.indexOf("=");
    let flag: string;
    let inlineValue: string | undefined;
    if (eq >= 0) {
      flag = tok.slice(2, eq);
      inlineValue = tok.slice(eq + 1);
    } else {
      flag = tok.slice(2);
    }

    // ── Whole-payload escape hatch ──
    //
    // Skipped when the tool declares its own `args` field: then `--args` is a
    // normal per-field flag (handled below) and wins over the escape hatch, so
    // the field's value isn't silently swallowed as the whole payload.
    if (flag === "args" && properties.args === undefined) {
      const { value, nextIndex } =
        inlineValue !== undefined ? { value: inlineValue, nextIndex: i } : takeNext(i, "args");
      rawArgs = value;
      i = nextIndex;
      continue;
    }

    // ── Per-field JSON escape hatch: --foo-json '<json>' ──
    if (flag.endsWith("-json")) {
      const fieldName = flag.slice(0, -"-json".length);
      const { value, nextIndex } =
        inlineValue !== undefined ? { value: inlineValue, nextIndex: i } : takeNext(i, flag);
      if (seenArrayFields.has(fieldName)) {
        // A prior --${fieldName} (scalar-array form) already populated this
        // field; overwriting it here would silently discard those values.
        throw new FlagParseException(
          `--${fieldName} and --${flag} cannot be mixed for the same field; pass it entirely as --${flag} '<json>'${argsHatchHint}`
        );
      }
      args[fieldName] = parseJsonOrThrow(value, `--${flag}`);
      jsonFields.add(fieldName);
      i = nextIndex;
      continue;
    }

    // ── --no-foo: explicit false for boolean flags ──
    if (flag.startsWith("no-")) {
      const fieldName = flag.slice(3);
      const propSchema = properties[fieldName];
      if (propSchema?.type === "boolean") {
        if (inlineValue !== undefined) {
          throw new FlagParseException(`--no-${fieldName} does not take a value`);
        }
        // Now that a boolean value after a flag is consumed as its value,
        // `--no-flag false` would read as a double negative and `--no-flag true`
        // would contradict itself. Neither can be a typo for anything but the
        // positive form, so name that form rather than silently picking one.
        const following = i + 1 < argv.length ? booleanLiteral(argv[i + 1]!) : undefined;
        if (following !== undefined) {
          throw new FlagParseException(
            `--no-${fieldName} does not take a value; use --${fieldName} ${following}`
          );
        }
        args[fieldName] = false;
        continue;
      }
      // Not a known boolean field; fall through to be treated as a normal flag
      // (so users can still pass an unknown --no-foo if the tool wants it).
    }

    const propSchema = properties[flag];

    // ── Boolean: bare flag means true; allow --foo=true|false explicitly ──
    if (propSchema?.type === "boolean") {
      if (inlineValue !== undefined) {
        args[flag] = coerceScalar(inlineValue, "boolean", flag);
        continue;
      }
      // A bare boolean flag is true — unless the next token is `true`/`false`
      // or `1`/`0`, which can only have been meant as this flag's value.
      // An earlier comment here declined to look ahead, to avoid stealing a
      // following positional; `argent run` is the sole caller and never reads
      // `positional`, so there is nothing to steal. Only those four tokens are
      // taken, and `--flag -- false` still keeps `false` positional.
      const next = i + 1 < argv.length ? booleanLiteral(argv[i + 1]!) : undefined;
      if (next !== undefined) {
        args[flag] = next;
        i += 1;
      } else {
        args[flag] = true;
      }
      continue;
    }

    // ── Array: repeatable. items.type must be scalar; otherwise tell the user
    //    to use --field-json. ──
    if (propSchema?.type === "array") {
      const itemType = propSchema.items?.type;
      if (!isScalarType(itemType)) {
        throw new FlagParseException(
          `--${flag} is an array of objects; pass it as --${flag}-json '<json>'${argsHatchHint}`
        );
      }
      const { value, nextIndex } =
        inlineValue !== undefined ? { value: inlineValue, nextIndex: i } : takeNext(i, flag);
      if (jsonFields.has(flag)) {
        // --${flag}-json already set this field (in either order relative to
        // this occurrence); mixing the two forms is ambiguous and one would
        // silently clobber or corrupt the other's value. Checked BEFORE
        // coerceScalar so a mixed --field/--field-json with an also-invalid
        // plain value surfaces this (more actionable) mixing error rather than
        // a scalar-coercion error — matching the --field-json branch above,
        // which checks mixing before parsing the JSON.
        throw new FlagParseException(
          `--${flag} and --${flag}-json cannot be mixed for the same field; pass it entirely as --${flag}-json '<json>'${argsHatchHint}`
        );
      }
      const coerced = coerceScalar(value, itemType, flag);
      if (!seenArrayFields.has(flag)) {
        args[flag] = [coerced];
        seenArrayFields.add(flag);
      } else {
        (args[flag] as unknown[]).push(coerced);
      }
      if (inlineValue === undefined) i = nextIndex;
      continue;
    }

    // ── Object field: must use --field-json ──
    if (propSchema?.type === "object") {
      throw new FlagParseException(
        `--${flag} is an object; pass it as --${flag}-json '<json>'${argsHatchHint}`
      );
    }

    // ── Scalar (string / number / integer / enum) or unknown field. We still
    //    accept unknown flags so tools can evolve their schemas without
    //    breaking the CLI; tool-server will return a 400 if invalid. ──
    const { value, nextIndex } =
      inlineValue !== undefined ? { value: inlineValue, nextIndex: i } : takeNext(i, flag);
    args[flag] = coerceScalar(value, propSchema?.type, flag);
    if (inlineValue === undefined) i = nextIndex;
  }

  return { args, positional, helpRequested, rawArgs };
}

/**
 * Render a tool's schema as a human-readable usage block: one line per field
 * showing flag, type, required flag, and (if present) enum values. Used by
 * both `tools describe` and the auto-help fallback in `run --help`.
 */
export function formatSchemaUsage(schema: JsonSchema | undefined): string {
  if (!schema || !schema.properties) return "  (no parameters)";
  const required = new Set(schema.required ?? []);
  const lines: string[] = [];
  const entries = Object.entries(schema.properties);
  if (entries.length === 0) return "  (no parameters)";

  // Determine column width for flag names so types align.
  let maxFlagLen = 0;
  for (const [name, prop] of entries) {
    const display = renderFlagName(name, prop);
    if (display.length > maxFlagLen) maxFlagLen = display.length;
  }

  for (const [name, prop] of entries) {
    const flag = renderFlagName(name, prop).padEnd(maxFlagLen, " ");
    const typeLabel = renderType(prop);
    const req = required.has(name) ? " (required)" : "";
    const desc = prop.description ? `  ${prop.description}` : "";
    lines.push(`  ${flag}  ${typeLabel}${req}${desc}`);
  }

  // One legend rather than widening every flag row: the value syntax is the
  // same for all of them, and the flag column is padded across every field of
  // every tool.
  //
  // It must NOT start with `--` after the indent. scripts/e2e-full/lib/
  // discover-tools.sh treats any line in the Flags: section matching
  // /^[[:space:]]*--/ as a flag row and takes the first --token as its name, so
  // a legend beginning with a flag would inject a phantom flag into every
  // tool model it builds.
  if (entries.some(([, prop]) => prop.type === "boolean")) {
    lines.push(
      "",
      "  Booleans: --flag, --flag true, or --flag 1 sets true; --flag false, --flag 0, " +
        "--flag=false, or --no-flag sets false."
    );
  }
  return lines.join("\n");
}

function renderFlagName(name: string, prop: JsonSchema): string {
  const flag = flagNameFor(name, prop);
  if (isJsonField(prop)) return `${flag} <json>`;
  if (prop.type === "boolean") return flag;
  return `${flag} <value>`;
}

function renderType(prop: JsonSchema): string {
  if (prop.enum && Array.isArray(prop.enum)) {
    return `enum: ${prop.enum.map((v) => JSON.stringify(v)).join(" | ")}`;
  }
  if (prop.type === "array") {
    const item = prop.items?.type ?? "any";
    const suffix = isScalarType(prop.items?.type) ? " (repeatable)" : "";
    return `array<${item}>${suffix}`;
  }
  return prop.type ?? "any";
}
