// Turns a rejected tool invocation into the message a CLI user needs.
//
// A missing required flag is knowable here from the tool's published schema, so it is caught
// before the call goes out. A value the tool rejects (range, enum, a rule spanning two fields) is
// known only to the tool-server, which answers with a serialized validation issue list. Both
// become one `ValidationReport` rendered by one function, so the wording cannot drift.

import { flagNameFor, type JsonSchema } from "./flag-parser.js";

/** A rejected value, addressed by its path in the payload; an empty path means the payload. */
export interface InvalidField {
  path: (string | number)[];
  message: string;
}

export interface ValidationReport {
  /** Required properties absent from the payload, in schema declaration order. */
  missing: string[];
  invalid: InvalidField[];
  /** The server's issue list verbatim, for `--json` callers; null when no call was made. */
  rawIssues: unknown[] | null;
}

interface ValidationIssue {
  code: string;
  path: unknown[];
  message: string;
}

/**
 * Required properties with no value in the payload, in schema declaration order — the order the
 * help block below the message lists them in.
 *
 * Presence only: a field that is present but wrong is the tool-server's call. Fields carrying a
 * default are not marked required by the schema generator, so this cannot reject an invocation
 * the server would have accepted.
 */
export function findMissingRequired(
  payload: Record<string, unknown>,
  schema: JsonSchema | undefined
): string[] {
  const required = new Set(schema?.required ?? []);
  if (required.size === 0) return [];
  const declared = Object.keys(schema?.properties ?? {});
  // Declared order first, then any required name the schema declares no property for, which
  // would otherwise be dropped silently.
  const names = [...declared.filter((n) => required.has(n))];
  for (const name of required) {
    if (!names.includes(name)) names.push(name);
  }
  return names.filter((name) => !Object.hasOwn(payload, name));
}

/**
 * Two channels, because the wire grew one: a tool-server now sends the issue list in `issues`,
 * where before the list WAS the message. Reading the structured field first and falling back to
 * parsing the message covers a new client against an old server.
 */
function serverIssueList(err: unknown): ValidationIssue[] | null {
  const carried = (err as { issues?: unknown } | null)?.issues;
  if (Array.isArray(carried)) {
    return carried.length > 0 && carried.every(isValidationIssue) ? carried : null;
  }

  const message = err instanceof Error ? err.message : typeof err === "string" ? err : null;
  if (message === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(message);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return null;
  return parsed.every(isValidationIssue) ? parsed : null;
}

/**
 * Interpret a failed tool call as input validation, or return null to leave it alone.
 *
 * Recognition is structural — the issue list's shape and the tool's own schema decide it, never
 * the wording of a message that is not ours to depend on. Anything not provably this tool's own
 * input validation stays an ordinary runtime failure with its existing handling.
 */
export function describeServerValidationFailure(
  err: unknown,
  payload: Record<string, unknown>,
  schema: JsonSchema | undefined
): ValidationReport | null {
  const parsed = serverIssueList(err);
  if (parsed === null) return null;

  const properties = schema?.properties ?? {};
  // Every issue must address a field this tool declares, or the payload as a whole (an empty
  // path, which a rule spanning several fields produces). A tool that lets an error from validating
  // something other than its input escape — a device's response, say — names fields that are not
  // flags, and must keep its existing handling rather than be dressed up as user error.
  const addressesThisTool = (issue: ValidationIssue) =>
    issue.path.length === 0 ||
    (typeof issue.path[0] === "string" && Object.hasOwn(properties, issue.path[0]));
  if (!parsed.every(addressesThisTool)) return null;

  const required = new Set(schema?.required ?? []);
  const missing: string[] = [];
  const invalid: InvalidField[] = [];
  for (const issue of parsed) {
    const head = issue.path[0];
    // Only a required field with nothing supplied reads as "you forgot this". A rule firing on
    // an optional field would otherwise be reported as a missing required flag, contradicting the
    // help block printed underneath, which marks no such field required.
    if (
      issue.path.length === 1 &&
      typeof head === "string" &&
      required.has(head) &&
      !Object.hasOwn(payload, head)
    ) {
      missing.push(head);
    } else {
      invalid.push({ path: issue.path as (string | number)[], message: issue.message });
    }
  }

  return { missing: sortBySchemaOrder(missing, schema), invalid, rawIssues: parsed };
}

/**
 * The message shown for a rejected invocation — one renderer for both the locally detected and
 * the server-reported case, so the two read identically.
 */
export function formatValidationError(
  report: ValidationReport,
  schema: JsonSchema | undefined
): string {
  const properties = schema?.properties ?? {};
  const lines: string[] = [];

  if (report.missing.length > 0) {
    const flags = sortBySchemaOrder(report.missing, schema).map((name) =>
      flagNameFor(name, properties[name])
    );
    const noun = flags.length === 1 ? "flag" : "flags";
    lines.push(`missing required ${noun} ${flags.join(", ")}`);
  }

  for (const field of report.invalid) {
    lines.push(describeInvalidField(field, properties));
  }

  return lines.join("\n       ");
}

/** Flag names for a report's missing fields, for `--json` output. */
export function missingFlagNames(
  report: ValidationReport,
  schema: JsonSchema | undefined
): string[] {
  const properties = schema?.properties ?? {};
  return sortBySchemaOrder(report.missing, schema).map((name) =>
    flagNameFor(name, properties[name])
  );
}

function describeInvalidField(field: InvalidField, properties: Record<string, JsonSchema>): string {
  // An empty path means the rule spans the whole payload, so there is no flag to name.
  if (field.path.length === 0) return field.message;

  const [head, ...rest] = field.path;
  if (typeof head !== "string") return field.message;

  const flag = flagNameFor(head, properties[head]);
  const nested = rest.length > 0 ? ` ${head}${renderPathTail(rest)}` : "";
  return `${flag}${nested} ${field.message}`;
}

function renderPathTail(rest: (string | number)[]): string {
  return rest.map((part) => (typeof part === "number" ? `[${part}]` : `.${part}`)).join("");
}

function sortBySchemaOrder(names: string[], schema: JsonSchema | undefined): string[] {
  const order = Object.keys(schema?.properties ?? {});
  return [...names].sort((a, b) => {
    const ia = order.indexOf(a);
    const ib = order.indexOf(b);
    if (ia === -1 && ib === -1) return a.localeCompare(b);
    if (ia === -1) return 1;
    if (ib === -1) return -1;
    return ia - ib;
  });
}

function isValidationIssue(value: unknown): value is ValidationIssue {
  if (value === null || typeof value !== "object") return false;
  const issue = value as Record<string, unknown>;
  return (
    typeof issue.code === "string" && Array.isArray(issue.path) && typeof issue.message === "string"
  );
}
