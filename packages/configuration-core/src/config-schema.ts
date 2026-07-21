// The configuration schema: the single source of truth for every recognized
// config value, its shape, where it may be set, and how the two scopes merge.
//
// Adding a new configuration is meant to be a one-liner here: give it a dotted
// `key`, a `description`, the `scopes` it accepts, a `parse` validator, and a
// `merge` policy (a preset name, or your own function). Nothing else in the
// system needs to change — `argent config`, the merged reader, and validation
// are all schema-driven.

import type { FlagScope } from "./flags.js";
import type { MergePolicy } from "./merge.js";

/**
 * One recognized configuration value.
 *
 * `key` is a dotted path into the shared config document (`ios.deviceSet` →
 * `{ "ios": { "deviceSet": ... } }`). `parse` both validates and normalizes a
 * raw JSON value, returning `undefined` for anything malformed so a broken
 * config never crashes a reader. `merge` decides the effective value when both
 * scopes are set.
 */
export interface ConfigDefinition<T = unknown> {
  /** Dotted path into config.json, e.g. `"ios.deviceSet"`. */
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
   * When set, `argent config set/unset` refuses this key and points the user at
   * the given command instead. Used for values that have a dedicated,
   * lifecycle-aware command (e.g. telemetry, which must also drain the running
   * client on opt-out) while still surfacing them read-only under `argent config`.
   */
  readonly manageCommand?: string;
  /** Optional example value shown in help/usage. */
  readonly example?: string;
}

// ── parse/normalize helpers ──────────────────────────────────────────────
// Reusable validators so schema entries stay one-liners. Each returns the
// normalized value or `undefined` for an absent/wrong-typed input.

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

// ── The registry ─────────────────────────────────────────────────────────
// The only place you edit to add a configuration.

export const CONFIG_SCHEMA: readonly ConfigDefinition[] = [
  {
    key: "telemetry.enabled",
    description:
      "Whether anonymous opt-out telemetry is enabled (on by default; environment opt-outs " +
      "like DO_NOT_TRACK are not reflected here — `argent telemetry status` shows effective consent).",
    scopes: ["global"],
    parse: asBoolean,
    // A committed project file must never re-enable telemetry a user disabled
    // globally, so the more-restrictive (opt-out) value always wins.
    merge: "prioritize-restrictive",
    // Telemetry is opt-out: with nothing stored, consent.ts treats it as
    // enabled, and the config surface must report the same instead of "(unset)".
    default: true,
    // Read-only under `argent config`: opt-in/out goes through the dedicated
    // command so the live client is drained/reset, not just the file rewritten.
    manageCommand: "argent telemetry",
  },
  {
    key: "lens.agent",
    description: "Coding-agent id remembered by `argent lens` to skip the picker.",
    scopes: ["project", "global"],
    parse: asString,
    // A repo can pin the agent its screenshots should use; falls back to the
    // user's global remembered choice.
    merge: "prioritize-local",
    example: "claude",
  },
] as const;

/** Look up a schema entry by key, or `undefined` when the key is unknown. */
export function getConfigDefinition(
  key: string,
  registry: readonly ConfigDefinition[] = CONFIG_SCHEMA
): ConfigDefinition | undefined {
  return registry.find((def) => def.key === key);
}
