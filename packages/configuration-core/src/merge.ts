// Merge policies for scoped configuration values.
//
// A configuration value can be set at two scopes — `project`
// (`<project-root>/.argent/config.json`) and `global` (`~/.argent/config.json`).
// Feature flags need only one hardcoded rule (project shadows global) because
// every flag is a homogeneous boolean; config values are heterogeneous, so each
// declares its own policy in the schema (see `config-schema.ts`) — one of the
// presets below, or an arbitrary function.

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
   * "Smaller = stricter" is hardcoded. Where a larger number is the stricter
   * bound (a retry cap, a minimum log level), supply a custom `MergeFn` instead.
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
 * A bespoke merge rule for a schema entry no preset fits. Returns the effective
 * value, or `undefined` to fall through to the schema default.
 */
export type MergeFn<T> = (inputs: MergeInputs<T>) => T | undefined;

/** A preset name or a custom function. */
export type MergePolicy<T> = MergePreset | MergeFn<T>;

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
  if (typeof local === "boolean" && typeof global === "boolean") {
    return (local && global) as unknown as T;
  }
  if (typeof local === "number" && typeof global === "number") {
    return Math.min(local, global) as unknown as T;
  }
  // No ordering defined for other types — keep the project value.
  return local;
}

function toArray(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}

function mergeUnion<T>(local: T | undefined, global: T | undefined): T | undefined {
  const l = toArray(local);
  const g = toArray(global);
  // Nothing to union — behave like prioritize-local so a mis-typed value still
  // resolves predictably.
  if (l === null && g === null) return local ?? global;
  // Global first so project entries append after the shared baseline; `Set`
  // dedup assumes primitive elements.
  const merged = [...(g ?? []), ...(l ?? [])];
  return Array.from(new Set(merged)) as unknown as T;
}

function mergeIntersection<T>(local: T | undefined, global: T | undefined): T | undefined {
  const l = toArray(local);
  const g = toArray(global);
  // A scope that is unset (or not an array) adds no constraint, so the other
  // scope passes through unchanged.
  if (l === null && g === null) return local ?? global;
  if (l === null) return global;
  if (g === null) return local;
  const globalSet = new Set(g);
  return l.filter((item) => globalSet.has(item)) as unknown as T;
}

/**
 * Combine a project (`local`) and `global` value under `policy`, returning the
 * effective value or `undefined` when neither scope contributes one.
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
      // A preset added to the union without a case here becomes a compile error.
      const _exhaustive: never = policy;
      return _exhaustive;
    }
  }
}
