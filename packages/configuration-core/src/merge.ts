// Merge policies for scoped configuration values.
//
// A configuration value can be set at two scopes — `project`
// (`<project-root>/.argent/config.json`) and `global` (`~/.argent/config.json`).
// When both scopes hold a value, a *merge policy* decides the effective value.
// Feature flags get away with a single hardcoded rule (project overrides
// global) because every flag is a homogeneous opt-in boolean. Config values are
// heterogeneous — a device-set path wants project-wins, a telemetry opt-out
// wants the more-restrictive value to win so a committed project file can never
// re-enable something the user disabled globally — so each value declares its
// own policy in the schema (see `config-schema.ts`).
//
// The presets below cover the common cases; a schema entry can also supply an
// arbitrary function for a bespoke rule.

/** Built-in merge behaviors, chosen per config value in the schema. */
export type MergePreset =
  /** Project value wins; fall back to global when the project scope is unset. */
  | "prioritize-local"
  /** Global value wins; fall back to project when the global scope is unset. */
  | "prioritize-global"
  /**
   * The more restrictive of the two wins — for booleans, `false` (opt-out) beats
   * `true`; for numbers, the smaller value. Use for privacy/permission toggles
   * where a committed project file must never loosen a stricter global choice.
   *
   * Caveat: the numeric rule hardcodes "smaller = stricter". Only apply this
   * preset to a numeric config where a lower value is genuinely the safer bound.
   * If larger is stricter (e.g. a retry cap, a minimum log level, a rate limit),
   * do not use this preset — supply a custom `MergeFn` on the schema entry instead.
   */
  | "prioritize-restrictive"
  /** Arrays only: the de-duplicated union of both scopes (global first). */
  | "union"
  /** Arrays only: the elements present in BOTH scopes (order follows project). */
  | "intersection";

/** The two scope values handed to a merge function. `undefined` = unset. */
export interface MergeInputs<T> {
  /** Value from `<project-root>/.argent/config.json`, if set. */
  local: T | undefined;
  /** Value from `~/.argent/config.json`, if set. */
  global: T | undefined;
}

/**
 * A bespoke merge rule. Receives both scope values (either may be `undefined`)
 * and returns the effective value, or `undefined` to fall through to the
 * schema default. Provided as an escape hatch on a schema entry when none of
 * the presets fit.
 */
export type MergeFn<T> = (inputs: MergeInputs<T>) => T | undefined;

/** A preset name or a custom function. */
export type MergePolicy<T> = MergePreset | MergeFn<T>;

/** The set of recognized preset names, for validation and docs. */
export const MERGE_PRESETS: readonly MergePreset[] = [
  "prioritize-local",
  "prioritize-global",
  "prioritize-restrictive",
  "union",
  "intersection",
];

function mergeRestrictive<T>(local: T | undefined, global: T | undefined): T | undefined {
  if (local === undefined) return global;
  if (global === undefined) return local;
  // Booleans: any `false` (opt-out) wins over `true`.
  if (typeof local === "boolean" && typeof global === "boolean") {
    return (local && global) as unknown as T;
  }
  // Numbers: the smaller (stricter) bound wins.
  if (typeof local === "number" && typeof global === "number") {
    return Math.min(local, global) as unknown as T;
  }
  // No ordering defined for other types — keep the project value, matching the
  // fall-through of the other presets. (The schema restricts this preset to
  // boolean/number values, so this branch is a safety net, not a real path.)
  return local;
}

function toArray(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}

function mergeUnion<T>(local: T | undefined, global: T | undefined): T | undefined {
  const l = toArray(local);
  const g = toArray(global);
  // If neither scope holds an array there is nothing to union — behave like
  // prioritize-local so a mis-typed value still resolves predictably.
  if (l === null && g === null) return local ?? global;
  // Global first so project entries append after the shared baseline; dedup by
  // value (works for primitive arrays — the documented array element type).
  const merged = [...(g ?? []), ...(l ?? [])];
  return Array.from(new Set(merged)) as unknown as T;
}

function mergeIntersection<T>(local: T | undefined, global: T | undefined): T | undefined {
  const l = toArray(local);
  const g = toArray(global);
  // Intersection needs both sides. When a scope is unset there is no constraint
  // to intersect against, so the present scope passes through unchanged.
  if (l === null && g === null) return local ?? global;
  if (l === null) return global;
  if (g === null) return local;
  const globalSet = new Set(g);
  return l.filter((item) => globalSet.has(item)) as unknown as T;
}

/**
 * Combine a project (`local`) and `global` value under `policy`, returning the
 * effective value or `undefined` when neither scope contributes one. A function
 * policy is called directly; a preset name dispatches to the built-in rules.
 */
export function applyMergePolicy<T>(
  policy: MergePolicy<T>,
  local: T | undefined,
  global: T | undefined
): T | undefined {
  if (typeof policy === "function") return policy({ local, global });
  switch (policy) {
    case "prioritize-local":
      return local ?? global;
    case "prioritize-global":
      return global ?? local;
    case "prioritize-restrictive":
      return mergeRestrictive(local, global);
    case "union":
      return mergeUnion(local, global);
    case "intersection":
      return mergeIntersection(local, global);
    default: {
      // Exhaustiveness guard: a new preset added to the union without a case
      // here becomes a compile error.
      const _exhaustive: never = policy;
      return _exhaustive;
    }
  }
}
