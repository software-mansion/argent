import * as path from "node:path";
import type { FlagScope } from "./flags.js";
import type { MergePolicy } from "./merge.js";

export interface ConfigDefinition<T = unknown> {
  readonly key: string;
  readonly description: string;
  readonly scopes: readonly FlagScope[];
  readonly parse: (raw: unknown) => T | undefined;
  readonly validateWrite?: (raw: unknown) => T | undefined;
  readonly merge: MergePolicy<T>;
  readonly default?: T;
  /**
   * `argent config set/unset` refuses this key and points at this command
   * instead — for values whose command does lifecycle work beyond writing the
   * file (telemetry drains the running client on opt-out). Still readable
   * through `argent config`.
   */
  readonly manageCommand?: string;
  readonly example?: string;
  readonly expected?: string;
}

export function asBoolean(raw: unknown): boolean | undefined {
  return typeof raw === "boolean" ? raw : undefined;
}

export function asString(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
}

function asPresentText(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === "string") return raw.trim();
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

function asAbsolutePath(raw: unknown): string | undefined {
  const text = asString(raw);
  if (text === undefined) return undefined;
  const win32 = process.platform === "win32";
  if (!(win32 ? path.win32 : path.posix).isAbsolute(text)) return undefined;
  if (win32 && !WINDOWS_ROOTED_PATH_RE.test(text)) return undefined;
  return text;
}

export function asNumber(raw: unknown): number | undefined {
  return typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;
}

export function asPositiveInteger(raw: unknown): number | undefined {
  return typeof raw === "number" && Number.isSafeInteger(raw) && raw > 0 ? raw : undefined;
}

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

export function asStringArray(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item === "string" && item.trim() !== "") out.push(item.trim());
  }
  return out;
}

const PARSER_EXPECTATIONS = new Map<ConfigDefinition["parse"], string>([
  [asBoolean, "a boolean (true or false)"],
  [asString, "a non-empty string"],
  [asNumber, "a number"],
  [asPositiveInteger, "a whole number greater than zero"],
  [asStringArray, "an array of strings"],
]);

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
      "Old-space heap limit, in MiB, for `.mjs` flow scripts (default 512). " +
      "This limit does not apply to Bash. " +
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
      "Absolute path to Bash for `.sh` flow scripts. Global scope only. " +
      "If unset, Argent searches PATH, then standard install locations. " +
      "On Windows, use Bash from Git for Windows.",
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
      "an absolute path to Bash on the tool-server host (`/bin/bash`; on Windows, `C:\\...\\bash.exe`)",
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

export function getConfigDefinition(
  key: string,
  registry: readonly ConfigDefinition[] = CONFIG_SCHEMA
): ConfigDefinition | undefined {
  return registry.find((def) => def.key === key);
}
