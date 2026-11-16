import type { ZodError } from "zod";
import { isOmittedParamIssue } from "@argent/registry";
import { INVALID_PARAM_ISSUES, type InvalidParamIssue } from "@argent/telemetry";

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

function collectIssueCodes(issues: ZodError["issues"], into: Set<string>): void {
  for (const issue of issues) {
    into.add(issue.code);
    if (issue.code !== "invalid_union") continue;
    // Skip branches that rejected the value's type outright (a string against
    // z.array()), or an unknown enum name would also read as invalid_type. A
    // non-integer number is not one: zod reports it as invalid_type "int".
    const typed = issue.errors.filter(
      (branch) =>
        !branch.some(
          (i) => i.code === "invalid_type" && i.expected !== "int" && i.path.length === 0
        )
    );
    (typed.length ? typed : issue.errors).forEach((branch) => collectIssueCodes(branch, into));
  }
}

/**
 * The deduped issue codes, in INVALID_PARAM_ISSUES order so one set always
 * serializes the same. A field `params` left out reads "missing", not zod's
 * code for it (see isOmittedParamIssue). Codes outside INVALID_PARAM_ISSUES are
 * dropped: the telemetry allowlist would void the whole array for one.
 */
export function deriveInvalidParamIssues(error: ZodError, params: unknown): InvalidParamIssue[] {
  const raised = new Set<string>();
  const supplied = error.issues.filter((issue) => !isOmittedParamIssue(issue, params));
  if (supplied.length < error.issues.length) raised.add("missing");
  collectIssueCodes(supplied, raised);
  return INVALID_PARAM_ISSUES.filter((code) => raised.has(code));
}
