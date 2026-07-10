import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { INSTALLER_COMMAND_META, VALUE_TAKING_FLAGS } from "../src/installer-help.js";

// Drift tripwire between the help text in INSTALLER_COMMAND_META and the flags
// the installers actually parse. installer-help.ts is deliberately
// side-effect-free, so it cannot import the parsers; instead this test reads
// the parser sources and extracts every flag they consult through the parsing
// idioms the installer uses today (`args.includes("--x")`,
// `extractFlag(args, "--x")`, and the `arg === "--x"` / `arg?.startsWith("--x=")`
// lookahead loops). If a flag is added, removed, or renamed there — or the
// installer moves to a parsing idiom this extraction doesn't know — the set
// comparison goes red and whoever made the change updates the help (or this
// test) instead of silently under- or over-reporting flags in `--help`.

const INSTALLER_SRC = path.resolve(import.meta.dirname, "../../argent-installer/src");

// Where each command's flags are parsed. init parses everything in
// init-args.ts; update/uninstall read --global/--local through
// install-targets.ts (parseTargetFlags) and the rest inline.
const PARSER_SOURCES = {
  init: ["init-args.ts"],
  update: ["update.ts", "install-targets.ts"],
  uninstall: ["uninstall.ts", "install-targets.ts"],
} as const;

// Flags the installers parse on purpose but keep out of the help text.
// --project-root is an internal pin passed by the agent-triggered
// update-argent tool (see getProjectRootOverride in update.ts), not a flag
// users should reach for.
const INTERNAL_FLAGS: Record<keyof typeof PARSER_SOURCES, readonly string[]> = {
  init: [],
  update: ["--project-root"],
  uninstall: [],
};

const FLAG_PARSE_PATTERNS = [
  /(?<![\w.$])args\.includes\("([^"]+)"\)/g,
  /extractFlag\(args,\s*"([^"]+)"\)/g,
  /arg\??\s*===\s*"(-[^"]+)"/g,
  /arg\??\.startsWith\("(-[^"]+)="\)/g,
];

// The idioms that consume the NEXT argv token: `extractFlag(args, "--x")` and
// the `arg === "--x"` lookahead branch (which reads `args[i + 1]`). The
// `--x=value` startsWith form deliberately does NOT count — it is inline and
// consumes nothing, so its presence must not certify a flag as value-taking.
const VALUE_CONSUMING_PATTERNS = [
  /extractFlag\(args,\s*"(-[^"]+)"\)/g,
  /arg\??\s*===\s*"(-[^"]+)"/g,
];

function readSources(command: keyof typeof PARSER_SOURCES): string {
  return PARSER_SOURCES[command]
    .map((file) => fs.readFileSync(path.join(INSTALLER_SRC, file), "utf8"))
    .join("\n");
}

function parsedFlags(command: keyof typeof PARSER_SOURCES): string[] {
  const source = readSources(command);
  const flags = new Set<string>();
  for (const pattern of FLAG_PARSE_PATTERNS) {
    for (const match of source.matchAll(pattern)) {
      flags.add(match[1]!);
    }
  }
  return [...flags].sort();
}

/** The machine-readable spellings behind a display flag: `--yes, -y` → both. */
function documentedFlags(command: keyof typeof PARSER_SOURCES): string[] {
  return INSTALLER_COMMAND_META[command].options.flatMap((option) =>
    option.flag.split(",").map((spelling) => spelling.trim().split(" ")[0]!)
  );
}

describe("installer help options stay in sync with the real parsers", () => {
  for (const command of ["init", "update", "uninstall"] as const) {
    it(`\`${command}\` documents exactly the flags its parser consults`, () => {
      const documented = [...documentedFlags(command), ...INTERNAL_FLAGS[command]].sort();
      expect(parsedFlags(command)).toEqual(documented);
    });
  }

  for (const command of ["init", "update", "uninstall"] as const) {
    it(`\`${command}\`'s VALUE_TAKING_FLAGS mirror the parser's token-consuming sites exactly`, () => {
      // installerHelpRequested treats a bareword `help` after one of these as
      // the flag's value rather than a help request, so the list must match
      // the parser in BOTH directions: an entry the parser doesn't consume a
      // token for would wrongly forward `--x help` to the installer, and a
      // token-consuming parser flag missing here would wrongly swallow its
      // `help` value as a help request.
      const source = readSources(command);
      const consuming = new Set<string>();
      for (const pattern of VALUE_CONSUMING_PATTERNS) {
        for (const match of source.matchAll(pattern)) {
          consuming.add(match[1]!);
        }
      }
      expect([...consuming].sort()).toEqual([...VALUE_TAKING_FLAGS[command]].sort());
    });
  }

  it("aliases defer to a target whose value-taking flags they share", () => {
    // The dispatcher forwards `install` to init and `remove` to uninstall, so
    // their bareword-help semantics must match the target's.
    expect(VALUE_TAKING_FLAGS.install).toEqual(VALUE_TAKING_FLAGS.init);
    expect(VALUE_TAKING_FLAGS.remove).toEqual(VALUE_TAKING_FLAGS.uninstall);
  });
});
