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
 * The deduped zod issue codes, in ZOD_ISSUE_CODES order so one set always
 * serializes the same. Codes outside it are dropped: the telemetry allowlist
 * would void the whole array for one unknown value.
 */
export function deriveInvalidParamIssues(error: ZodError): ZodIssueCode[] {
  const raised = new Set<string>(error.issues.map((issue) => issue.code));
  return ZOD_ISSUE_CODES.filter((code) => raised.has(code));
}
