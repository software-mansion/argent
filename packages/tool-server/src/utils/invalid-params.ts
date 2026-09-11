import type { ZodError } from "zod";
import { ZOD_ISSUE_CODES, type ZodIssueCode } from "@argent/telemetry";

/**
 * Privacy contract (Telemetry.md): only names declared in Argent's own tool schema
 * may be emitted, never user-typed keys or values — hence the literal
 * "unrecognized_keys" token in place of the offending key names.
 *
 * Capped at 16 because the telemetry sanitize layer's arrayOf voids the whole
 * property (not just the overflow) for longer arrays.
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

/**
 * Which constraints the rejected parameters broke, deduped and capped like
 * {@link deriveInvalidParams}. Zod's issue codes are a closed vocabulary from
 * the schema library, so this carries no user-typed text.
 *
 * Unknown codes are dropped rather than passed through: the telemetry
 * allowlist would void the whole array for one stray value, taking the
 * recognised codes with it.
 */
export function deriveInvalidParamIssues(error: ZodError): ZodIssueCode[] {
  const known = new Set<string>(ZOD_ISSUE_CODES);
  const out: ZodIssueCode[] = [];
  for (const issue of error.issues) {
    if (!known.has(issue.code)) continue;
    const code = issue.code as ZodIssueCode;
    if (!out.includes(code)) out.push(code);
    if (out.length >= 16) break;
  }
  return out;
}
