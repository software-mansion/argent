import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const skillsDir = fileURLToPath(new URL("../../skills/skills/", import.meta.url));

function markdownFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return markdownFiles(entryPath);
    return entry.isFile() && entry.name.endsWith(".md") ? [entryPath] : [];
  });
}

// A line is about the console log file when it says so itself, or when the
// heading chain it sits under does.
function logFileGuidanceLines(filePath: string): string[] {
  const headings: string[] = [];
  const offenders: string[] = [];

  fs.readFileSync(filePath, "utf8")
    .split("\n")
    .forEach((line, index) => {
      const heading = line.match(/^(#+)\s+(.*)$/);
      if (heading) {
        headings.length = heading[1].length - 1;
        headings[heading[1].length - 1] = heading[2];
        return;
      }
      const context = [...headings, line].join(" ");
      if (!/`Read`/.test(line) || /Never `Read`/.test(line)) return;
      if (!/log file|log-registry|Console Logs/i.test(context)) return;
      offenders.push(`${path.relative(skillsDir, filePath)}:${index + 1}: ${line.trim()}`);
    });

  return offenders;
}

describe("bundled skill guidance on the debugger console log file", () => {
  // The file `debugger-log-registry` returns holds up to 50 000 unbounded console
  // lines, so `Read` on it burns the agent's context window. A single skill line
  // offering it undoes the prohibition, because the tool tables and the numbered
  // workflow are read before the file-format tips that carry the rule.
  it("offers no tool but `Grep` for searching it", () => {
    const files = markdownFiles(skillsDir);
    expect(files.length).toBeGreaterThan(0);

    expect(files.flatMap(logFileGuidanceLines)).toEqual([]);
  });
});
