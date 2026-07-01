#!/usr/bin/env node
/**
 * Extracts tool id + description from all ToolDefinition objects in
 * packages/tool-server/src/tools/**\/*.ts and outputs MCP tools/list JSON
 * suitable for `spidershield scan . --tools-json <file>`.
 *
 * Usage:
 *   node scripts/extract-tools.mjs > tools.json
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, extname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname } from "node:path";
import { argv as processArgv } from "node:process";

const __filename = fileURLToPath(import.meta.url);
const __dir = dirname(__filename);
const toolsRoot = join(__dir, "..", "packages", "tool-server", "src", "tools");

function walk(dir) {
  const entries = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      entries.push(...walk(full));
    } else if (extname(name) === ".ts" && !name.endsWith(".d.ts")) {
      entries.push(full);
    }
  }
  return entries;
}

/**
 * Extract `{ name, description }` for every string-literal `id:` tool definition
 * in a single source string. Kept as a pure function (I/O separated) so the
 * parsing rules can be unit-tested against crafted fixtures.
 *
 * @param {string} src       source text
 * @param {string} filePath  label used in warnings
 * @returns {{name: string, description: string}[]}
 */
export function extractToolsFromSource(src, filePath = "<source>") {
  const tools = [];

  // Iterate over every string-literal `id:` occurrence in the file.
  const idPattern = /\bid:\s*["']([^"']+)["']/g;
  let idMatch;
  while ((idMatch = idPattern.exec(src)) !== null) {
    const id = idMatch[1];

    // Find the tool's own `description:` by POSITION — the nearest `description:`
    // after this `id:`, parsed with its actual closing delimiter. Position (not
    // delimiter-form priority) matters when tools in one file use different
    // description forms: a form-priority scan (template, then double, then single)
    // could grab a LATER tool's template literal ahead of THIS tool's nearer
    // double-quoted one, then reject it as belonging to a later id and drop this
    // tool. Matching to the closing delimiter also means an `id:`/`description:`
    // token appearing INSIDE the description text (e.g. a structured example
    // `{ id: "menu-item" }`) can't truncate the capture — a fixed window or a
    // "stop at the next `id:`" bound would silently drop the tool from the
    // downstream `spidershield` security scan.
    const afterId = src.slice(idMatch.index + idMatch[0].length);
    const descKeyword = afterId.match(/\bdescription:\s*/);

    let description = null;
    if (
      descKeyword &&
      // No other tool `id:` between this `id:` and its `description:` ⇒ the
      // description is this tool's own, not a later tool's borrowed one.
      !/\bid:\s*["'][^"']+["']/.test(afterId.slice(0, descKeyword.index))
    ) {
      const value = afterId.slice(descKeyword.index + descKeyword[0].length);
      const delim = value[0];
      // Template literal allows escaped backticks (\`) so inline code like
      // `adb pull` doesn't truncate; the quoted forms allow the standard escapes.
      const valueMatch =
        delim === "`"
          ? value.match(/^`((?:\\.|[^`\\])*)`/)
          : delim === '"'
            ? value.match(/^"((?:[^"\\]|\\.)*)"/)
            : delim === "'"
              ? value.match(/^'((?:[^'\\]|\\.)*)'/)
              : null;
      if (valueMatch) {
        // Unescape template-literal escapes (\` \$ \\) so the description reads
        // as the rendered string, not the source form.
        description = valueMatch[1].replace(/\\([`$\\])/g, "$1").trim();
      }
    }

    if (description !== null) {
      tools.push({
        name: id,
        description,
      });
    } else {
      // A tool definition has an `id` but no parseable `description`. Don't drop
      // it silently (that bug hid run-sequence from the scanner) — warn on
      // stderr so the failure is visible, while keeping stdout valid JSON for
      // the downstream `spidershield scan --tools-json` consumer.
      console.error(
        `extract-tools: WARNING: tool "${id}" in ${filePath} has an id but no parseable description; skipping.`
      );
    }
  }

  return tools;
}

function extractFromFile(filePath) {
  return extractToolsFromSource(readFileSync(filePath, "utf8"), filePath);
}

export function extractAllTools() {
  const files = walk(toolsRoot);
  const tools = [];
  for (const f of files) {
    tools.push(...extractFromFile(f));
  }

  // Deduplicate by name (take first occurrence)
  const seen = new Set();
  return tools.filter((t) => {
    if (seen.has(t.name)) return false;
    seen.add(t.name);
    return true;
  });
}

function main() {
  // MCP tools/list format
  console.log(JSON.stringify({ tools: extractAllTools() }, null, 2));
}

// Run only when invoked directly, not when imported by the test.
if (processArgv[1] && import.meta.url === pathToFileURL(processArgv[1]).href) {
  main();
}
