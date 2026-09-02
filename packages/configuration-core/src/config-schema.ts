// Every recognized config value: its shape, where it may be set, and how the
// two scopes merge. `argent config`, the merged reader (config-access.ts) and
// validation all read this registry.

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

/** Accept a finite JSON number. */
export function asNumber(raw: unknown): number | undefined {
  return typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;
}

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
] as const;

/** Look up a schema entry by key, or `undefined` when the key is unknown. */
export function getConfigDefinition(
  key: string,
  registry: readonly ConfigDefinition[] = CONFIG_SCHEMA
): ConfigDefinition | undefined {
  return registry.find((def) => def.key === key);
}
