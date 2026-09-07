// Every recognized config value: its shape, where it may be set, and how the
// two scopes merge. `argent config`, the merged reader (config-access.ts) and
// validation all read this registry.

import * as path from "node:path";
import type { FlagScope } from "./flags.js";
import type { MergePolicy } from "./merge.js";

/** One recognized configuration value. */
export interface ConfigDefinition<T = unknown> {
  /** Dotted path into config.json. */
  readonly key: string;
  /** One-line summary shown by `argent config` / `argent config list`. */
  readonly description: string;
  /** Scopes this value may be written to. Reads only merge the listed scopes. */
  readonly scopes: readonly FlagScope[];
  /** Validate + normalize a raw JSON value; `undefined` means absent/invalid. */
  readonly parse: (raw: unknown) => T | undefined;
  /**
   * The check `argent config set` applies instead of {@link parse}, for a key
   * whose `parse` is deliberately permissive. A reader cannot tell a value
   * `parse` threw away from an absent key, so a key whose own reader reports
   * what it found has to KEEP a wrong value — which is no reason to accept one
   * being typed in. Absent ⇒ `parse` is the write check too.
   */
  readonly validateWrite?: (raw: unknown) => T | undefined;
  /** How the project and global values combine into the effective value. */
  readonly merge: MergePolicy<T>;
  /** Effective value when no scope contributes one. */
  readonly default?: T;
  /**
   * `argent config set/unset` refuses this key and points at this command
   * instead — for values whose command does lifecycle work beyond writing the
   * file (telemetry drains the running client on opt-out). Still readable
   * through `argent config`.
   */
  readonly manageCommand?: string;
  /** Example value, shown by `argent config list` and when a value is rejected. */
  readonly example?: string;
  /**
   * What a valid value looks like, in words, for the message shown when one is
   * rejected. Only needed for a bespoke `parse` — a shared helper describes
   * itself, see {@link describeExpectedValue}.
   */
  readonly expected?: string;
}

/** Accept a JSON boolean. */
export function asBoolean(raw: unknown): boolean | undefined {
  return typeof raw === "boolean" ? raw : undefined;
}

/** Accept a non-blank string, trimmed. Blank/whitespace reads as unset. */
export function asString(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * Any value that is present, as text. Only for a key whose own reader checks
 * the value and reports what it found: a rejected value is invisible to that
 * reader, and a wrong one that is silently ignored fails somewhere else.
 *
 * `null` is absent here, as it is for every other parser in this file. A
 * generator that writes `null` for a key it has no value for means "unset",
 * and reading it as the text "null" makes it the one value nothing can use and
 * nothing falls back from.
 */
function asPresentText(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === "string") return raw.trim();
  // A config file is JSON, so everything that reaches here has a JSON text
  // form; `??` covers a caller that passed a live value which has none.
  return JSON.stringify(raw) ?? "(a value with no JSON form)";
}

/**
 * What a rooted Windows path looks like: a drive letter, or a UNC share. The
 * one rule, shared with the tool server's own interpreter check, because this
 * is the WRITE gate for a value that check reads back — and
 * `path.win32.isAbsolute("/usr/bin/bash")` is true, so on Windows the two
 * disagreed in exactly one direction: `argent config set` stored a POSIX path
 * that every `.sh` step then refused with "names no drive".
 */
export const WINDOWS_ROOTED_PATH_RE = /^(?:[A-Za-z]:[\\/]|[\\/][\\/])/;

/**
 * Accept a non-blank string that names an absolute path on THIS host. The
 * running platform's rules, because the path is for a program this host has to
 * start: `C:\\…` is not a path a POSIX tool server can spawn, and a
 * `/usr/bin/…` is not one a Windows tool server can.
 */
function asAbsolutePath(raw: unknown): string | undefined {
  const text = asString(raw);
  if (text === undefined) return undefined;
  const win32 = process.platform === "win32";
  // Explicit win32 semantics under win32 rather than the bare `path` object's,
  // which is the same thing on a real Windows host and is testable from a POSIX
  // one — the shape `flow-script-interpreter.ts` reads the value back with.
  if (!(win32 ? path.win32 : path.posix).isAbsolute(text)) return undefined;
  if (win32 && !WINDOWS_ROOTED_PATH_RE.test(text)) return undefined;
  return text;
}

/** Accept a finite JSON number. */
export function asNumber(raw: unknown): number | undefined {
  return typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;
}

export function asPositiveInteger(raw: unknown): number | undefined {
  return typeof raw === "number" && Number.isSafeInteger(raw) && raw > 0 ? raw : undefined;
}

/**
 * What the operating system will carry as an environment NAME, and the one rule
 * every channel that supplies one is held to: a flow file's own `env:`, a
 * `script` step's, a `flow-execute` argument, a `flow-add-script` one,
 * `argent flow run --env`, and a `scripts.env.allow` entry.
 *
 * Here rather than in the tool server because the CLI is one of those channels
 * and cannot import from it — the same reason the script bounds below live
 * here. A name outside this rule can never match one the tool server carries,
 * so honouring it silently is honouring nothing.
 */
export const SCRIPT_ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The one name {@link SCRIPT_ENV_NAME_PATTERN} accepts that no channel can
 * carry: the operating system takes it, but every merge on the way to the child
 * copies the map through a plain object, where it is an accessor rather than an
 * entry — so the value is dropped and the script runs without it, silently.
 */
export const PROTO_ENV_NAME = "__proto__";

export const MIN_SCRIPT_HEAP_LIMIT_MB = 32;

/**
 * The smallest ceiling a flow `script` step can run under and still report on
 * the script rather than on the host. The step starts a process before the
 * script runs — a bash one as well as a Node one — and that start alone costs
 * tens of milliseconds, so under
 * this the same script passes or times out according to how busy the machine
 * was. Floored rather than defaulted for the reason the heap limit is: the
 * step that loses the race errors, and names neither this bound nor the value
 * that caused it.
 */
export const MIN_SCRIPT_TIMEOUT_MS = 100;

/** Accept an array of non-blank strings (blank entries dropped). */
export function asStringArray(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item === "string" && item.trim() !== "") out.push(item.trim());
  }
  return out;
}

/**
 * How each shared validator describes the value it accepts. Keyed on the
 * validator itself, so swapping a key's `parse` swaps its description with it
 * instead of letting a per-entry wording drift from what is enforced.
 */
const PARSER_EXPECTATIONS = new Map<ConfigDefinition["parse"], string>([
  [asBoolean, "a boolean (true or false)"],
  [asString, "a non-empty string"],
  [asNumber, "a number"],
  [asPositiveInteger, "a whole number greater than zero"],
  [asStringArray, "an array of strings"],
]);

/**
 * What a valid value for this key looks like, in words — undefined for a bespoke
 * validator that set no `expected`, so callers describe nothing rather than guess.
 */
export function describeExpectedValue(def: ConfigDefinition): string | undefined {
  return def.expected ?? PARSER_EXPECTATIONS.get(def.parse);
}

export const CONFIG_SCHEMA: readonly ConfigDefinition[] = [
  {
    key: "telemetry.enabled",
    description:
      "Whether anonymous opt-out telemetry is enabled (on by default; environment opt-outs " +
      "like DO_NOT_TRACK are not reflected here — `argent telemetry status` shows effective consent). " +
      "`false` in either scope wins, so a committed project opt-out holds for every teammate.",
    scopes: ["project", "global"],
    parse: asBoolean,
    merge: "prioritize-restrictive",
    // Opt-out: consent.ts reads an unstored value as enabled, so the config
    // surface must show the same rather than "(unset)".
    default: true,
    // Opt-in/out goes through the dedicated command so the live client is
    // drained/reset, not just the file rewritten.
    manageCommand: "argent telemetry",
  },
  {
    key: "allowlist.enabled",
    description:
      "Whether `argent update` re-applies editor auto-approve allowlist rules. Unset (the " +
      "default) keeps the current behavior: update refreshes the rules for editors that " +
      "already have argent configured. Set to `false` to keep update from touching editor " +
      "allowlists. `false` in either scope wins, so a committed project opt-out holds for " +
      "every teammate.",
    scopes: ["project", "global"],
    parse: asBoolean,
    merge: "prioritize-restrictive",
    example: "false",
  },
  {
    key: "lens.agent",
    description: "Coding-agent id remembered by `argent lens` to skip the picker.",
    scopes: ["project", "global"],
    parse: asString,
    merge: "prioritize-local",
    example: "claude",
  },
  {
    key: "ios.additionalDeviceSets",
    description:
      "Additional CoreSimulator device-set directories whose simulators argent should see " +
      "alongside the default set. Absolute paths (or ~/…); relative entries resolve against " +
      "the project root (project scope) or home (global scope).",
    scopes: ["project", "global"],
    parse: asStringArray,
    // Additive rather than shadowing: global baseline first, project extras
    // after, deduplicated. `getAdditionalIosDeviceSets` re-implements this union
    // (path resolution must precede dedup) and guards on the preset staying "union".
    merge: "union",
    example: '["~/DeviceSets/ci"]',
  },
  {
    key: "recordings.directory",
    description:
      "Directory where finished screen recordings (mp4) are saved on the client host. " +
      "Absolute, `~`-prefixed, or relative to the project root (home dir when not in a project). " +
      "Unset ⇒ `.argent/recordings` under the project root.",
    scopes: ["project", "global"],
    parse: asString,
    // Resolved on the client (the machine the mp4 is persisted to), so with a
    // remote `argent link` tool-server it is the *client's* config that decides.
    merge: "prioritize-local",
    example: "~/Movies/argent",
  },
  {
    key: "scripts.env.allow",
    description:
      "Extra environment variable names a flow `script` process inherits from the tool " +
      "server, on top of argent's built-in allowlist (PATH, HOME, the toolchain names and " +
      "so on). A project input rather than a host control, so both scopes are read and the " +
      "two lists are unioned. Any name starting with `ARGENT_` is ignored here — the whole " +
      "prefix, not a list of the names argent uses today — and so is a name that steers the " +
      "runner's own process, or one that is not an environment variable name at all; the " +
      "run's notes say when a name was dropped. An entry that is not a string, or a blank " +
      "one, goes when the file is read, before the run can name it — `argent config set` " +
      "echoes back the list it stored. Remember the server's environment is a snapshot " +
      "from its first start, so a later `export` in your shell does not reach it.",
    scopes: ["project", "global"],
    parse: asStringArray,
    // Additive: a project names what its own scripts read, on top of whatever
    // the machine's global list already carries.
    merge: "union",
    example: '["DATABASE_URL", "AWS_PROFILE"]',
  },
  // All three `scripts.` keys below are global-scope only, for two reasons. The
  // two bounds: a checked-in `.argent/config.json` must not raise the ceiling on
  // how much of the machine a script step may occupy. `scripts.bash`: the value
  // is an absolute path judged against `process.platform`, so no one spelling
  // suits a mixed-OS team. `merge` is nominal for all three — the project scope
  // of a global-only key is never read.
  {
    key: "scripts.maxTimeoutMs",
    description:
      "Upper bound, in milliseconds, on the time limit a flow `script` step may ask for " +
      "(default 300000 — five minutes). Bounds how long one script can occupy the host. " +
      `Values below ${MIN_SCRIPT_TIMEOUT_MS} ms are refused: the step starts a process before ` +
      "the script runs, so a smaller ceiling ends a script that did nothing wrong.",
    scopes: ["global"],
    parse: (raw) => {
      const value = asPositiveInteger(raw);
      return value !== undefined && value >= MIN_SCRIPT_TIMEOUT_MS ? value : undefined;
    },
    expected: `a whole number of milliseconds, at least ${MIN_SCRIPT_TIMEOUT_MS}`,
    merge: "prioritize-global",
    default: 5 * 60_000,
    example: "300000",
  },
  {
    key: "scripts.heapLimitMb",
    description:
      "Old-space heap limit, in MiB, given to each Node process a flow `script` step starts " +
      "(default 512); a bash script is not bounded by it. " +
      `Values below ${MIN_SCRIPT_HEAP_LIMIT_MB} MiB are refused: that is already below what ` +
      "importing a real npm dependency needs, and under about 5 MiB the process dies inside " +
      "V8's own startup before any script runs.",
    scopes: ["global"],
    parse: (raw) => {
      const value = asPositiveInteger(raw);
      return value !== undefined && value >= MIN_SCRIPT_HEAP_LIMIT_MB ? value : undefined;
    },
    expected: `a whole number of MiB, at least ${MIN_SCRIPT_HEAP_LIMIT_MB}`,
    merge: "prioritize-global",
    default: 512,
    example: "512",
  },
  {
    key: "scripts.bash",
    description:
      "Absolute path to the bash a flow `script` step runs a `.sh` file with. Unset ⇒ the " +
      "first bash on the tool server's PATH, then /bin/bash and /usr/bin/bash (on Windows, " +
      "Git for Windows' bash.exe; the WSL launcher under %SystemRoot% is skipped). Each " +
      "candidate is run once and has to answer with a $BASH_VERSION. Global scope only: the " +
      "value names a path on the host running the tool server, so a committed project file " +
      "cannot hold one a mixed-OS team can all use.",
    scopes: ["global"],
    // Deliberately permissive: `readScopeValue` hands back `undefined` for a
    // value its `parse` rejected, which is indistinguishable from an absent key
    // — so a schema that refused a relative path, an empty string or a number
    // would make a hand-edited config file fall through to PATH and hide the
    // mistake behind a bash that happens to exist on this machine. Everything
    // PRESENT is kept, as the text the refusal names it by; the resolver checks
    // the value and refuses the step, naming the key. `asString` was not that:
    // it maps an empty, whitespace-only or non-string value to `undefined`.
    parse: asPresentText,
    validateWrite: asAbsolutePath,
    expected:
      "an absolute path to a bash executable, spelled the way the host running the tool server " +
      "spells one (`/bin/bash` on macOS and Linux, `C:\\...\\bash.exe` on Windows)",
    merge: "prioritize-global",
    // Host-specific for the same reason the check above is: the example is
    // printed back as a command to run, and one this host would refuse is a
    // command that reproduces the error it is offered to fix. So both strings
    // name the one path every host of that family has: macOS ships no
    // `/usr/bin/bash` at all, and `/opt/homebrew/bin/bash` exists only on an
    // arm64 Mac with Homebrew. `asAbsolutePath` checks shape and never
    // existence, so a spelling this host lacks is written and only fails later,
    // at every `.sh` step.
    example: process.platform === "win32" ? "C:\\Program Files\\Git\\bin\\bash.exe" : "/bin/bash",
  },
] as const;

/** Look up a schema entry by key, or `undefined` when the key is unknown. */
export function getConfigDefinition(
  key: string,
  registry: readonly ConfigDefinition[] = CONFIG_SCHEMA
): ConfigDefinition | undefined {
  return registry.find((def) => def.key === key);
}
