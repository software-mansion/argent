// Convert a tool's JSON Schema (produced by zodObjectToJsonSchema in @argent/registry)
// plus argv into the JSON args object the tool-server expects.
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
// Exception: a tool whose own schema declares an `args` property (e.g. flow-add-step)
// has no whole-payload hatch — `--args <value>` is that field, coerced by its declared
// type; use individual flags / --<field>-json instead.
//
// Array fields need a scalar items.type to get a repeatable flag; object fields and
// arrays of objects fall through to --field-json.

export interface JsonSchema {
  type?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  description?: string;
}

interface FlagParseResult {
  args: Record<string, unknown>;
  positional: string[];
  helpRequested: boolean;
  rawArgs: string | null; // raw --args value, if any; "-" means stdin
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
 * Single source of truth for the `-json` suffix, so a message about a field and its help line
 * cannot disagree. Tolerates an unknown field: a schema may list a required name it declares no
 * property for.
 */
export function flagNameFor(name: string, prop: JsonSchema | undefined): string {
  return isJsonField(prop) ? `--${name}-json` : `--${name}`;
}

/**
 * `true`/`false` or `1`/`0`, case-insensitive and whitespace-tolerant; `undefined`
 * for anything else, so an ambiguous token is left alone rather than guessed at.
 *
 * Single source of truth for every form — the `--flag <value>` lookahead,
 * `--flag=<value>`, boolean array items and the `--no-flag` guard — so the same
 * word cannot mean two things one call site apart.
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
 * The caller merges `--args` JSON; required fields are then checked against the
 * merged payload in `run-validation`, and their types and constraints server-side.
 */
export function parseFlags(argv: string[], schema: JsonSchema | undefined): FlagParseResult {
  const properties = schema?.properties ?? {};
  // A tool declaring its own `args` field has no whole-payload hatch, so suggesting
  // "or --args '<json>'" there would be a dead end: that form re-enters per-field
  // handling, and only `--<field>-json` works.
  const argsHatchHint = properties.args === undefined ? " or --args '<json>'" : "";
  const args: Record<string, unknown> = {};
  const positional: string[] = [];
  let helpRequested = false;
  let rawArgs: string | null = null;

  const seenArrayFields = new Set<string>();
  // Order-independent: a field touched by BOTH `--field` (scalar-array form) and
  // `--field-json` is ambiguous whichever came first, so both directions throw
  // rather than one silently discarding the other's value.
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
      for (let j = i + 1; j < argv.length; j++) positional.push(argv[j]!);
      break;
    }

    if (!tok.startsWith("--")) {
      positional.push(tok);
      continue;
    }

    const eq = tok.indexOf("=");
    let flag: string;
    let inlineValue: string | undefined;
    if (eq >= 0) {
      flag = tok.slice(2, eq);
      inlineValue = tok.slice(eq + 1);
    } else {
      flag = tok.slice(2);
    }

    // Skipped when the tool declares its own `args` field, so that field's value
    // isn't silently swallowed as the whole payload.
    if (flag === "args" && properties.args === undefined) {
      const { value, nextIndex } =
        inlineValue !== undefined ? { value: inlineValue, nextIndex: i } : takeNext(i, "args");
      rawArgs = value;
      i = nextIndex;
      continue;
    }

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

    if (flag.startsWith("no-")) {
      const fieldName = flag.slice(3);
      const propSchema = properties[fieldName];
      if (propSchema?.type === "boolean") {
        if (inlineValue !== undefined) {
          throw new FlagParseException(`--no-${fieldName} does not take a value`);
        }
        // A boolean literal after a flag is consumed as its value, so `--no-flag false`
        // reads as a double negative and `--no-flag true` contradicts itself. Name the
        // positive form rather than silently picking one.
        const following = i + 1 < argv.length ? booleanLiteral(argv[i + 1]!) : undefined;
        if (following !== undefined) {
          throw new FlagParseException(
            `--no-${fieldName} does not take a value; use --${fieldName} ${following}`
          );
        }
        args[fieldName] = false;
        continue;
      }
      // Not a known boolean field; fall through and treat it as a normal flag.
    }

    const propSchema = properties[flag];

    if (propSchema?.type === "boolean") {
      if (inlineValue !== undefined) {
        args[flag] = coerceScalar(inlineValue, "boolean", flag);
        continue;
      }
      const next = i + 1 < argv.length ? booleanLiteral(argv[i + 1]!) : undefined;
      if (next !== undefined) {
        args[flag] = next;
        i += 1;
      } else {
        args[flag] = true;
      }
      continue;
    }

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
        // Mixing the two forms is ambiguous in either order. Checked BEFORE
        // coerceScalar so an also-invalid plain value surfaces this (more actionable)
        // mixing error, matching the --field-json branch above.
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

    if (propSchema?.type === "object") {
      throw new FlagParseException(
        `--${flag} is an object; pass it as --${flag}-json '<json>'${argsHatchHint}`
      );
    }

    // Unknown flags are accepted too, so tools can evolve their schemas without
    // breaking the CLI; tool-server answers 400 if the payload is invalid.
    const { value, nextIndex } =
      inlineValue !== undefined ? { value: inlineValue, nextIndex: i } : takeNext(i, flag);
    args[flag] = coerceScalar(value, propSchema?.type, flag);
    if (inlineValue === undefined) i = nextIndex;
  }

  return { args, positional, helpRequested, rawArgs };
}

/**
 * Render a tool's schema as a usage block: one line per field showing flag, type,
 * required marker and enum values. Used by both `tools describe` and `run` help.
 */
export function formatSchemaUsage(schema: JsonSchema | undefined): string {
  if (!schema || !schema.properties) return "  (no parameters)";
  const required = new Set(schema.required ?? []);
  const lines: string[] = [];
  const entries = Object.entries(schema.properties);
  if (entries.length === 0) return "  (no parameters)";

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

  // One legend rather than widening every flag row: the value syntax is the same
  // for all of them.
  //
  // It must NOT start with `--` after the indent: scripts/e2e-full/lib/discover-tools.sh
  // treats any line in the Flags: section matching /^[[:space:]]*--/ as a flag row and
  // takes its first --token as a flag name, so a legend beginning with a flag would
  // inject a phantom flag into every tool model it builds.
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
