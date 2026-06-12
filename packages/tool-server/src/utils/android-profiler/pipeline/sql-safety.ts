/**
 * Shared SQL-identifier guards for the Android pipeline. The trace_processor
 * queries interpolate process/thread/function names directly into SQL text
 * (they're not parameterised), so the allowed alphabet IS the injection guard.
 *
 * Lives in its own module because both `index.ts` and `hang-folds-batched.ts`
 * need these, and `index.ts` imports `hang-folds-batched.ts` — sharing through
 * either of those would create a circular import.
 */

/**
 * Reject any process name that isn't package-shaped before SQL substitution —
 * the value is interpolated, not parameterised, so the alphabet is the guard. See regex.
 */
export function sanitizeProcessName(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9._-]*$/.test(name)) {
    throw new Error(
      `Refusing to substitute non-identifier-shaped process name into SQL: "${name}"`
    );
  }
  return name;
}

/**
 * Restrict thread/function identifiers to a safe alphabet before SQL
 * substitution — see the regex (allows `-`, `<>`, space for C++
 * templates/demangled names; rejects quotes/semicolons).
 */
export function sanitizeIdentifier(name: string): string {
  if (!/^[A-Za-z0-9_.:+\/\-<> ]+$/.test(name)) {
    throw new Error(`Refusing to substitute identifier with unsafe characters: "${name}"`);
  }
  return name;
}
