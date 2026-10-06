/**
 * trace_processor queries interpolate these names into SQL text rather than
 * parameterising them, so the allowed alphabet is the injection guard.
 *
 * Own module because `index.ts` and `hang-folds-batched.ts` both need it and
 * `index.ts` imports `hang-folds-batched.ts`.
 */

/** Package-shaped names only. */
export function sanitizeProcessName(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9._-]*$/.test(name)) {
    throw new Error(
      `Refusing to substitute non-identifier-shaped process name into SQL: "${name}"`
    );
  }
  return name;
}

/** `-`, `<>` and space are allowed for demangled C++ names. */
export function sanitizeIdentifier(name: string): string {
  if (!/^[A-Za-z0-9_.:+/\-<> ]+$/.test(name)) {
    throw new Error(`Refusing to substitute identifier with unsafe characters: "${name}"`);
  }
  return name;
}
