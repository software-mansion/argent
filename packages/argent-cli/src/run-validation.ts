// Turns a rejected tool invocation into the message a CLI user needs.
//
// Two things can make an invocation invalid, and they are found in different places:
//
//   - a required flag was not passed. Knowable here, from the tool's published schema, so it is
//     caught before the call goes out.
//   - a value was passed but the tool rejected it (out of range, bad enum, a rule spanning two
//     fields). Only the tool-server knows these, and it answers with a serialized validation
//     issue list.
//
// Both end up as one `ValidationReport` rendered by one function, so the wording cannot drift
// between them.

import { flagNameFor, type JsonSchema } from "./flag-parser.js";

/** A field the tool rejected, addressed by its path within the payload. */
export interface InvalidField {
  path: (string | number)[];
  message: string;
}

export interface ValidationReport {
  /** Names of required properties absent from the payload, in schema declaration order. */
  missing: string[];
  invalid: InvalidField[];
  /** The server's issue list verbatim, for `--json` callers. Null when we never called out. */
  rawIssues: unknown[] | null;
}

interface ValidationIssue {
  code: string;
  path: unknown[];
  message: string;
}

/**
 * Required properties with no value in the payload, in the order the schema declares them — the
 * same order the help block below the message lists them in.
 *
 * A presence check only: a field that is present but wrong is the tool-server's call, not ours.
 * Fields carrying a default are not marked required by the schema generator, so this cannot
 * reject an invocation the server would have accepted.
 */
export function findMissingRequired(
  payload: Record<string, unknown>,
  schema: JsonSchema | undefined
): string[] {
  const required = new Set(schema?.required ?? []);
  if (required.size === 0) return [];
  const declared = Object.keys(schema?.properties ?? {});
  // Iterate the declared properties so the result is in schema order, then append any required
  // name the schema forgot to declare, which would otherwise be dropped silently.
  const names = [...declared.filter((n) => required.has(n))];
  for (const name of required) {
    if (!names.includes(name)) names.push(name);
  }
  return names.filter((name) => !Object.hasOwn(payload, name));
}

/**
 * The server's schema-validation issue list, from whichever channel carried it — or null when this
 * failure did not carry one.
 *
 * Two channels, because the wire changed. A tool-server now answers a rejected call with PROSE in
 * `error` and the issue list beside it in `issues`; before that, the issue list WAS the message.
 * Reading the structured field first and falling back to parsing the message covers NEW client ->
 * OLD server.
 *
 * The reverse direction is a real break and is reachable, since `argent link` can point a local
 * CLI at a remote tool-server with no version handshake: an already-released CLI knows only
 * `JSON.parse(message)`, so prose makes it fall through to a bare `console.error(message)`, losing
 * the `--flag` attribution, the help block, and a `--json` caller's JSON object. Nothing here can
 * fix that. (`argent flow run` is unaffected — `requireLocalToolServer` refuses env/link routing.)
 *
 * Neither channel is trusted on faith: the payload must still BE a non-empty list of issues.
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
 * Recognition is structural — the shape of the issue list and the tool's own schema decide it,
 * never the wording of any message, which is not ours to depend on.
 *
 * Returning null must leave the caller's existing error handling untouched: anything that is not
 * provably this tool's own input validation is still an ordinary runtime failure.
 */
export function describeServerValidationFailure(
  err: unknown,
  payload: Record<string, unknown>,
  schema: JsonSchema | undefined
): ValidationReport | null {
  const parsed = serverIssueList(err);
  if (parsed === null) return null;

  const properties = schema?.properties ?? {};
  // Every issue must address either a field this tool declares, or the payload as a whole (an
  // empty path, which a rule spanning several fields produces). A tool that validates something
  // other than its input — a device's response, say — and lets that error escape names fields
  // that are not flags, and must keep its existing handling rather than be dressed up as user error.
  const addressesThisTool = (issue: ValidationIssue) =>
    issue.path.length === 0 ||
    (typeof issue.path[0] === "string" && Object.hasOwn(properties, issue.path[0]));
  if (!parsed.every(addressesThisTool)) return null;

  const required = new Set(schema?.required ?? []);
  const missing: string[] = [];
  const invalid: InvalidField[] = [];
  for (const issue of parsed) {
    const head = issue.path[0];
    // Only a required field with nothing supplied reads as "you forgot this". A rule that fires
    // on an optional field would otherwise be reported as a missing required flag, contradicting
    // the help block printed underneath, which marks no such field required.
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
 * The message shown for a rejected invocation. The single renderer for both the locally detected
 * and the server-reported case, so the two read identically.
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

/** Flag names for a report's missing fields — what a `--json` caller echoes back to its user. */
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
  // An empty path means the rule spans the whole payload rather than one field, so there is no
  // flag to name — the tool's own explanation is the whole message.
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
