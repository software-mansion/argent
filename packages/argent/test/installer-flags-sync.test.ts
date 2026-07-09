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
  /args\.includes\("([^"]+)"\)/g,
  /extractFlag\(args,\s*"([^"]+)"\)/g,
  /arg\??\s*===\s*"(-[^"]+)"/g,
  /arg\??\.startsWith\("(-[^"]+)="\)/g,
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

  it("every value-taking flag really consumes a value in the parser", () => {
    // installerHelpRequested treats a bareword `help` after one of these as
    // the flag's value rather than a help request — so each entry must match a
    // parser site that reads the following token (extractFlag or the
    // `--flag <value>` / `--flag=<value>` lookahead pair).
    for (const command of ["init", "update", "uninstall"] as const) {
      const source = readSources(command);
      for (const flag of VALUE_TAKING_FLAGS[command]) {
        const consumesValue =
          source.includes(`extractFlag(args, "${flag}")`) || source.includes(`"${flag}="`);
        expect(consumesValue, `${command}: ${flag} must consume a value`).toBe(true);
      }
    }
  });

  it("aliases defer to a target whose value-taking flags they share", () => {
    // The dispatcher forwards `install` to init and `remove` to uninstall, so
    // their bareword-help semantics must match the target's.
    expect(VALUE_TAKING_FLAGS.install).toEqual(VALUE_TAKING_FLAGS.init);
    expect(VALUE_TAKING_FLAGS.remove).toEqual(VALUE_TAKING_FLAGS.uninstall);
  });

  it("value-taking flags are a subset of the flags the parser consults", () => {
    for (const command of ["init", "update", "uninstall"] as const) {
      const parsed = parsedFlags(command);
      for (const flag of VALUE_TAKING_FLAGS[command]) {
        expect(parsed, `${command}: ${flag}`).toContain(flag);
      }
    }
  });
});
