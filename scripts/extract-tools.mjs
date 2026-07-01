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

    // Search forward from this `id:` for the tool's own `description:` value,
    // matched together WITH its closing delimiter. No fixed-size window, so a
    // long multi-line template-literal description — whose closing delimiter can
    // sit thousands of chars past the `id:` (run-sequence's is ~3000) — is still
    // captured in full. Anchoring on the closing delimiter also means an `id:`
    // token that appears INSIDE the description text (e.g. a structured example
    // such as `{ id: "menu-item" }`) can't truncate the capture; a fixed window
    // or a "stop at the next `id:`" bound would drop the tool and silently skip
    // it from the downstream `spidershield` security scan.
    const afterId = src.slice(idMatch.index + idMatch[0].length);

    // Template literal description first. Allow escaped backticks (\`) inside the
    // literal so inline code like `adb pull` doesn't truncate the captured
    // description. The class matches either an escape sequence (\\.) or any char
    // that isn't ` or \. Then fall back to double- and single-quoted forms.
    let descMatch = afterId.match(/\bdescription:\s*`((?:\\.|[^`\\])*)`/);
    if (!descMatch) {
      // Double-quoted description
      descMatch = afterId.match(/\bdescription:\s*"((?:[^"\\]|\\.)*)"/);
    }
    if (!descMatch) {
      // Single-quoted description
      descMatch = afterId.match(/\bdescription:\s*'((?:[^'\\]|\\.)*)'/);
    }

    // Guard against borrowing a LATER tool's description: if another tool `id:`
    // declaration sits between this `id:` and the matched `description:`, this
    // tool has no description of its own — a description-less tool must not
    // inherit the next tool's.
    if (descMatch && /\bid:\s*["'][^"']+["']/.test(afterId.slice(0, descMatch.index))) {
      descMatch = null;
    }

    if (descMatch) {
      // Unescape template-literal escapes (\` \$ \\) so the description reads
      // as the rendered string, not the source form.
      const description = descMatch[1].replace(/\\([`$\\])/g, "$1").trim();
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
