// Minimal declarative option parser for the small subcommands (`argent
// telemetry`, …) whose whole surface is a few `--name value` options. Declaring
// the accepted options up front means adding one is a spec entry, not another
// hand-rolled loop — and every unknown flag, missing value or out-of-set value
// is rejected the same way.
//
// Supported forms:
//   --name value     (kind: "value")
//   --name=value
//   --name           (kind: "boolean")
//   --               (end of options; the rest are positionals)
//
// Tool invocations (`argent run`) have a schema-driven parser in flag-parser.ts;
// this one is for commands with a fixed, hand-written option set.

export type OptionSpec =
  | { readonly kind: "boolean" }
  | {
      readonly kind: "value";
      /** When set, any other value is a usage error. */
      readonly choices?: readonly string[];
    };

export type OptionSpecs = Readonly<Record<string, OptionSpec>>;

interface ParsedCommandArgs {
  positionals: string[];
  /** `true` for a boolean option that was given; the string for a value option. */
  options: Record<string, string | boolean>;
}

/** Bad user input (not a bug): the caller prints `message` and exits 2. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export function parseCommandArgs(argv: readonly string[], specs: OptionSpecs): ParsedCommandArgs {
  const positionals: string[] = [];
  const options: Record<string, string | boolean> = {};

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]!;

    if (tok === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (!tok.startsWith("--")) {
      positionals.push(tok);
      continue;
    }

    const eq = tok.indexOf("=");
    const name = eq === -1 ? tok.slice(2) : tok.slice(2, eq);
    const inlineValue = eq === -1 ? undefined : tok.slice(eq + 1);
    const spec = specs[name];
    if (!spec) throw new UsageError(`Unknown flag "${tok}".`);

    if (spec.kind === "boolean") {
      if (inlineValue !== undefined) throw new UsageError(`--${name} does not take a value.`);
      options[name] = true;
      continue;
    }

    // Value option: inline `=value` wins, otherwise consume the next token —
    // but never a following flag, so `--scope --json` reports the missing
    // value instead of storing "--json".
    let value = inlineValue;
    if (value === undefined) {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        value = next;
        i += 1;
      }
    }
    if (value === undefined || value === "") {
      throw new UsageError(
        `--${name} requires a value${spec.choices ? ` (${spec.choices.join("|")})` : ""}.`
      );
    }
    if (spec.choices && !spec.choices.includes(value)) {
      throw new UsageError(
        `--${name} must be one of ${spec.choices.map((c) => `"${c}"`).join(", ")} (got "${value}").`
      );
    }
    options[name] = value;
  }

  return { positionals, options };
}
