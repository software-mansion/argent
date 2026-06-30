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
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

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

function extractFromFile(filePath) {
  const src = readFileSync(filePath, "utf8");
  const tools = [];

  // Match: id: "...", followed anywhere by description: `...` or "..."
  // We iterate over all id: occurrences in the file.
  const idPattern = /\bid:\s*["']([^"']+)["']/g;
  let idMatch;
  while ((idMatch = idPattern.exec(src)) !== null) {
    const id = idMatch[1];

    // Bound the search to THIS tool's definition: from its `id:` up to the next
    // `id:` declaration in the file (or end of file). No fixed-size window, so a
    // long multi-line template-literal description — whose closing delimiter can
    // sit thousands of chars past the `id:` (run-sequence's is ~3000) — is still
    // captured in full. The old 2000-char window silently dropped such tools, so
    // they were never security-scanned by the downstream `spidershield` pass.
    const boundary = /\bid:\s*["'][^"']+["']/g;
    boundary.lastIndex = idMatch.index + idMatch[0].length;
    const next = boundary.exec(src);
    const descWindow = src.slice(idMatch.index, next ? next.index : src.length);

    // Template literal description.
    // Allow escaped backticks (\`) inside the literal so inline code like
    // `adb pull` doesn't truncate the captured description. The class matches
    // either an escape sequence (\\.) or any char that isn't ` or \.
    let descMatch = descWindow.match(/\bdescription:\s*`((?:\\.|[^`\\])*)`/);
    if (!descMatch) {
      // Double-quoted description
      descMatch = descWindow.match(/\bdescription:\s*"((?:[^"\\]|\\.)*)"/);
    }
    if (!descMatch) {
      // Single-quoted description
      descMatch = descWindow.match(/\bdescription:\s*'((?:[^'\\]|\\.)*)'/);
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

const files = walk(toolsRoot);
const tools = [];
for (const f of files) {
  tools.push(...extractFromFile(f));
}

// Deduplicate by name (take first occurrence)
const seen = new Set();
const unique = tools.filter((t) => {
  if (seen.has(t.name)) return false;
  seen.add(t.name);
  return true;
});

// MCP tools/list format
console.log(JSON.stringify({ tools: unique }, null, 2));
