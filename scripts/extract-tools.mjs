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
    const afterId = src.slice(idMatch.index);

    // Look for description within the next N chars (handles multi-line; some tools
    // have long descriptions before the closing backtick, e.g. run-sequence)
    const descWindow = afterId.slice(0, 3000);

    // Template literal description
    let descMatch = descWindow.match(/\bdescription:\s*`([\s\S]*?)`/);
    if (!descMatch) {
      // Double-quoted description
      descMatch = descWindow.match(/\bdescription:\s*"((?:[^"\\]|\\.)*)"/);
    }
    if (!descMatch) {
      // Single-quoted description
      descMatch = descWindow.match(/\bdescription:\s*'((?:[^'\\]|\\.)*)'/);
    }

    if (descMatch) {
      tools.push({
        name: id,
        description: descMatch[1].trim(),
      });
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
