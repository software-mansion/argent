// Declarative option parser for argent's hand-written subcommands (`server
// start`, `link`, `flow run`, `lens`, `config`, `enable`/`disable`,
// `telemetry`, …). A command declares its options once as a spec; adding one is
// a spec entry, not another hand-rolled argv loop — and every unknown flag,
// missing value or out-of-set value is reported the same way everywhere.
//
// Supported forms:
//   --name value     (kind: "value")
//   --name=value
//   -n value         (single-letter alias of a value option)
//   --name / -n      (kind: "boolean")
//   --               (end of options; the rest are positionals)
//
// Deliberately not a schema parser: tool invocations (`argent run <tool>`) turn
// a tool's JSON Schema into a payload in flag-parser.ts, with `--args`/stdin
// escape hatches that make no sense for a fixed command surface.

export type OptionSpec =
  | {
      readonly kind: "boolean";
      /** Single-letter short form, e.g. `"y"` for `-y`. */
      readonly alias?: string;
    }
  | {
      readonly kind: "value";
      readonly alias?: string;
      /** When set, any other value is a usage error naming the accepted ones. */
      readonly choices?: readonly string[];
    };

export type OptionSpecs = Readonly<Record<string, OptionSpec>>;

/** The parsed options: `true` for a boolean that was given, the string for a
 * value option, absent when not given. A repeated option keeps the last value. */
type ParsedOptions = Record<string, string | boolean | undefined>;

interface ParsedCommandArgs {
  positionals: string[];
  options: ParsedOptions;
}

/** Bad user input (not a bug): the caller prints `message` and exits 2. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

/** `"a" or "b"` / `"a", "b" or "c"` — for messages that list accepted values. */
function listChoices(choices: readonly string[]): string {
  const quoted = choices.map((c) => `"${c}"`);
  if (quoted.length <= 1) return quoted.join("");
  return `${quoted.slice(0, -1).join(", ")} or ${quoted[quoted.length - 1]}`;
}

function resolveName(tok: string, specs: OptionSpecs): string | null {
  if (tok.startsWith("--")) return tok.slice(2) in specs ? tok.slice(2) : null;
  // `-x`: a declared single-letter alias.
  const short = tok.slice(1);
  for (const [name, spec] of Object.entries(specs)) {
    if (spec.alias === short) return name;
  }
  return null;
}

export function parseCommandArgs(argv: readonly string[], specs: OptionSpecs): ParsedCommandArgs {
  const positionals: string[] = [];
  const options: ParsedOptions = {};

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]!;

    if (tok === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    // A bare "-" is a conventional positional (stdin); anything else with a
    // leading dash is a flag.
    if (!tok.startsWith("-") || tok === "-") {
      positionals.push(tok);
      continue;
    }

    // `--name=value` splits on the first "="; a short `-n=value` does not.
    const eq = tok.startsWith("--") ? tok.indexOf("=") : -1;
    const flag = eq === -1 ? tok : tok.slice(0, eq);
    const inlineValue = eq === -1 ? undefined : tok.slice(eq + 1);
    const name = resolveName(flag, specs);
    if (name === null) throw new UsageError(`Unknown flag: ${tok}`);
    const spec = specs[name]!;
    const display = `--${name}`;

    if (spec.kind === "boolean") {
      if (inlineValue !== undefined) throw new UsageError(`${display} does not take a value`);
      // `argent run` consumes a true/false word after a boolean flag, so a user
      // who learned that syntax there will try it here — where staying silent
      // would leave the switch on while "false" was quietly taken as a
      // positional. Say so instead.
      const next = argv[i + 1]?.trim().toLowerCase();
      if (next === "true" || next === "false") {
        throw new UsageError(
          `${display} does not take a value — it is a switch; omit it to leave the option off`
        );
      }
      options[name] = true;
      continue;
    }

    // Inline `=value` wins; otherwise consume the next token — but never one
    // that reads as a flag, so `--device --json` reports the missing value
    // instead of storing "--json" (and running against a wrong target).
    let value = inlineValue;
    if (value === undefined) {
      const next = argv[i + 1];
      if (next !== undefined && (!next.startsWith("-") || next === "-")) {
        value = next;
        i += 1;
      }
    } else if (value === "") {
      // `--x=` says nothing; a separately supplied "" token is a value the
      // command validates itself (link rejects it as a bind address).
      value = undefined;
    }
    if (value === undefined) throw new UsageError(`${display} requires a value`);
    if (spec.choices && !spec.choices.includes(value)) {
      throw new UsageError(`${display} must be ${listChoices(spec.choices)}, got "${value}"`);
    }
    options[name] = value;
  }

  return { positionals, options };
}
