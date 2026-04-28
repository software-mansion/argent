// Convert a tool's JSON Schema (the input shape produced by zodObjectToJsonSchema
// in @argent/registry) plus argv into the JSON args object the tool-server expects.
//
// Supported flag forms:
//   --name value          (string / number / integer / boolean-with-value)
//   --name=value
//   --name                (boolean: true)
//   --no-name             (boolean: false)
//   --name a --name b     (array of scalars)
//   --name-json '<json>'  (arbitrary nested object/array — escape hatch)
//   --args '<json>'       (whole-payload escape hatch; merges with parsed flags)
//   --args -              (read whole-payload JSON from stdin)
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

function coerceScalar(raw: string, type: string | undefined, field: string): unknown {
  if (type === "number") {
    const n = Number(raw);
    if (Number.isNaN(n)) throw new FlagParseException(`--${field} expected a number, got "${raw}"`);
    return n;
  }
  if (type === "integer") {
    const n = Number(raw);
    if (!Number.isInteger(n))
      throw new FlagParseException(`--${field} expected an integer, got "${raw}"`);
    return n;
  }
  if (type === "boolean") {
    if (raw === "true" || raw === "1") return true;
    if (raw === "false" || raw === "0") return false;
    throw new FlagParseException(`--${field} expected true/false, got "${raw}"`);
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
 * `--args` JSON (if given) and validating required fields server-side.
 */
export function parseFlags(argv: string[], schema: JsonSchema | undefined): FlagParseResult {
  const properties = schema?.properties ?? {};
  const args: Record<string, unknown> = {};
  const positional: string[] = [];
  let helpRequested = false;
  let rawArgs: string | null = null;

  // Track which fields have already received a scalar value. A second value for
  // an array field appends; a second value for a scalar field overwrites
  // (with a warning would be nice but we keep it silent to avoid stderr noise).
  const seenArrayFields = new Set<string>();

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
    if (flag === "args") {
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
      args[fieldName] = parseJsonOrThrow(value, `--${flag}`);
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
      } else {
        // Bare boolean flag: true. Don't consume next argv to avoid surprising
        // behavior when a positional follows.
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
          `--${flag} is an array of objects; pass it as --${flag}-json '<json>' or --args '<json>'`
        );
      }
      const { value, nextIndex } =
        inlineValue !== undefined ? { value: inlineValue, nextIndex: i } : takeNext(i, flag);
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
        `--${flag} is an object; pass it as --${flag}-json '<json>' or --args '<json>'`
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
  return lines.join("\n");
}

function renderFlagName(name: string, prop: JsonSchema): string {
  if (prop.type === "object" || (prop.type === "array" && !isScalarType(prop.items?.type))) {
    return `--${name}-json <json>`;
  }
  if (prop.type === "boolean") return `--${name}`;
  return `--${name} <value>`;
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
