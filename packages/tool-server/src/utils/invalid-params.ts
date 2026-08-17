import type { ZodError } from "zod";

/**
 * Telemetry-safe list of parameter names that failed zod validation.
 *
 * Privacy contract (see Telemetry.md): only names DECLARED in Argent's own tool
 * schema may be emitted — never user-typed keys and never values. A strict
 * object's unknown-key violation is reported as the literal token
 * "unrecognized_keys" rather than the offending key names.
 *
 * Capped at 16 HERE because the telemetry sanitize layer's array validator
 * voids the whole property (not just the overflow) for longer arrays.
 */
export function deriveInvalidParams(error: ZodError, declared: Set<string>): string[] {
  const out: string[] = [];
  for (const issue of error.issues) {
    const name =
      issue.code === "unrecognized_keys" ? "unrecognized_keys" : String(issue.path[0] ?? "");
    if (!name) continue;
    if (name !== "unrecognized_keys" && !declared.has(name)) continue;
    if (!out.includes(name)) out.push(name);
    if (out.length >= 16) break;
  }
  return out;
}
