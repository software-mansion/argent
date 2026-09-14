import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { LogFileWriter } from "../../src/utils/debugger/log-file-writer";
import { scopeTempHome } from "../helpers/temp-home";

scopeTempHome("argent-log-level-docs-home-");

/**
 * The `<LEVEL>` tokens in the skill's flat-log table are what an agent greps
 * the log file with, so a token the writer never emits is a silent false
 * negative on the search. Pin the table to what LogFileWriter actually writes
 * for the levels CDP delivers.
 */
const SKILL = path.resolve(__dirname, "../../../skills/skills/argent-metro-debugger/SKILL.md");

/** `Runtime.consoleAPICalled.type`, the only levels that reach the writer. */
const CDP_CONSOLE_TYPES = [
  "log",
  "debug",
  "info",
  "error",
  "warning",
  "dir",
  "dirxml",
  "table",
  "trace",
  "clear",
  "startGroup",
  "startGroupCollapsed",
  "endGroup",
  "assert",
  "profile",
  "profileEnd",
  "count",
  "timeEnd",
];

let nextPort = 59240;

/** The level column the writer puts on disk for `level`, padding included. */
function displayFor(level: string): string {
  const writer = new LogFileWriter(nextPort++);
  try {
    writer.write({
      id: 0,
      timestamp: new Date(1710000000000).toISOString(),
      level,
      message: "x",
    });
    const head = readFileSync(writer.getFilePath(), "utf8").split(" | ")[0]!;
    const match = /^\[L:0\] \S+ (.*) -$/.exec(head);
    expect(match, `unexpected flat line: ${head}`).not.toBeNull();
    return match![1]!;
  } finally {
    writer.close();
  }
}

/** The backticked tokens in the values cell of the table's `<LEVEL>` row. */
function documentedTokens(): string[] {
  const row = readFileSync(SKILL, "utf8")
    .split("\n")
    .find((line) => line.startsWith("| `<LEVEL>`"));
  expect(row, "the flat-log table has no `<LEVEL>` row").toBeDefined();
  const values = row!.split("|")[2]!;
  return [...values.matchAll(/`([^`]+)`/g)].map((m) => m[1]!);
}

describe("metro-debugger flat-log level column", () => {
  it("documents the token console.warn produces", () => {
    expect(documentedTokens()).toContain(displayFor("warning"));
  });

  it("documents the token console.assert produces", () => {
    expect(documentedTokens()).toContain(displayFor("assert"));
  });

  it("documents no token a CDP level cannot produce", () => {
    const producible = CDP_CONSOLE_TYPES.map(displayFor);
    for (const token of documentedTokens()) {
      expect(producible, `\`${token}\` is documented but never written`).toContain(token);
    }
  });
});
