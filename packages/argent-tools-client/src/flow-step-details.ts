/**
 * The detail lines of a flow step that did not pass, shared by both consumers
 * of the tool-server (the MCP server and the CLI) so the two print one
 * spelling of each value.
 */

import { escapeInvisible, printCapped } from "@argent/registry";

/**
 * What a step that did not pass found, wanted and advises, set by the
 * tool-server beside the step's reason rather than inside it. Wire data: each
 * field is checked before it is printed.
 */
export interface FlowStepDetails {
  hint?: string;
  expected?: string;
  actual?: string;
  /**
   * Set by the tool-server when `expected` holds a regex source rather than a
   * value to compare literally.
   */
  expectedKind?: "pattern";
  /** Set by the tool-server when the step could not read the UI tree to do its check. */
  indeterminate?: true;
}

/**
 * The `expected:`, `actual:`, `indeterminate:` and `hint:` lines of a step,
 * unindented: each renderer places them under its own step line. The
 * tool-server sets these fields only on a step that did not pass, so a passing
 * step prints none; the status itself is not checked here.
 *
 * An invisible character is ESCAPED, never replaced: these lines are the only
 * place the found text is printed, and a value that differs from the expected
 * one only by a line break, a tab or a no-break space has to look different
 * from it here. The escape also keeps each value on one line and keeps a raw
 * escape sequence out of the terminal.
 *
 * The `actual:` line cuts the found text at 300 characters and counts the
 * rest. The report keeps the whole text, so a caller whose output also gives
 * the report (the CLI's `--json`) keeps the cut. A caller whose output is only
 * these lines (the MCP result) passes `wholeActual` to print the whole text.
 */
export function renderFlowStepDetails(
  step: FlowStepDetails & { kind: string },
  options: { wholeActual?: boolean } = {}
): string[] {
  // A `hint:` and a snapshot value print unquoted, so only their invisible
  // characters are escaped. The tool-server relies on this: it keeps an inner
  // snapshot's values off a nested flow-execute step, which is not a snapshot
  // step and would print them quoted (see flow-nested-outcome.ts). A hint that quotes device text quotes it as JSON
  // already, so doubling its backslashes here would print a third spelling.
  // JSON quoting escapes only C0 controls, so a quoted value is escaped too.
  const value = (v: string): string =>
    escapeInvisible(step.kind === "snapshot" ? v : JSON.stringify(v));
  // A pattern prints as its source in slash delimiters — the spelling the step
  // line and the reason use. The text between the slashes is the `matches:`
  // value. JSON quoting would double each backslash, making `\d` a literal
  // backslash.
  const expected = (v: string): string =>
    step.expectedKind === "pattern" ? `/${escapeInvisible(v)}/` : value(v);
  const lines: string[] = [];
  if (typeof step.expected === "string") lines.push(`expected: ${expected(step.expected)}`);
  if (typeof step.actual === "string") {
    const actual = options.wholeActual ? value(step.actual) : printCapped(step.actual, value);
    lines.push(`actual:   ${actual}`);
  }
  // The JSON outputs carry the flag; without this line a reader of the text
  // can tell a check that never ran only from the prose of its reason.
  if (step.indeterminate === true) lines.push("indeterminate: the check did not run");
  if (typeof step.hint === "string") lines.push(`hint: ${escapeInvisible(step.hint)}`);
  return lines;
}
