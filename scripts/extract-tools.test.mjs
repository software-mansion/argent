/**
 * Guards scripts/extract-tools.mjs against silently dropping tool definitions
 * with a long `description:` value. run-sequence's description is a multi-line
 * template literal whose closing backtick sits ~3000 chars past its `id:`; the
 * old extractor only scanned a fixed 2000-char window after each `id:`, so its
 * `descMatch` came back null and the tool was never emitted — and therefore
 * never security-scanned by the downstream `spidershield scan --tools-json`.
 *
 * Runs the REAL extractor against the REAL repo and asserts every discoverable
 * tool definition is captured.
 *
 * Run: node --test scripts/extract-tools.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const toolsRoot = join(repoRoot, "packages", "tool-server", "src", "tools");

function runExtractor() {
  const res = spawnSync(process.execPath, ["scripts/extract-tools.mjs"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  assert.equal(res.status, 0, `extractor exited with ${res.status}\n${res.stderr}`);
  return { tools: JSON.parse(res.stdout).tools, stderr: res.stderr ?? "" };
}

// Independently discover every string-literal tool id in the source tree, using
// the same `id: "..."` shape the extractor keys off but WITHOUT its (buggy)
// description step. This is the set the extractor must fully capture. Tools
// whose id is a const reference (e.g. await-ui-element's
// `id: AWAIT_UI_ELEMENT_TOOL_ID`) are not string literals and are not in scope
// for this extractor by design, so they are excluded here too.
function discoverIdLiterals() {
  const ids = new Set();
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (extname(name) === ".ts" && !name.endsWith(".d.ts")) {
        const src = readFileSync(full, "utf8");
        const re = /\bid:\s*["']([^"']+)["']/g;
        let m;
        while ((m = re.exec(src)) !== null) ids.add(m[1]);
      }
    }
  };
  walk(toolsRoot);
  return ids;
}

test("run-sequence (long multi-line description) is captured", () => {
  const { tools } = runExtractor();
  const names = tools.map((t) => t.name);
  assert.ok(
    names.includes("run-sequence"),
    "run-sequence was dropped — the description lookahead regressed to a fixed window"
  );
});

test("gesture-tap is captured (control)", () => {
  const { tools } = runExtractor();
  const names = tools.map((t) => t.name);
  assert.ok(names.includes("gesture-tap"));
});

test("every tool definition in the source is captured (no silent drops)", () => {
  const { tools, stderr } = runExtractor();
  const extracted = new Set(tools.map((t) => t.name));
  const discovered = discoverIdLiterals();

  const missing = [...discovered].filter((id) => !extracted.has(id));
  assert.deepEqual(missing, [], `tool definitions dropped by the extractor: ${missing.join(", ")}`);
  assert.equal(
    tools.length,
    discovered.size,
    "extracted tool count must equal the number of tool definitions in the source"
  );

  // A healthy tree emits no warnings; a future drop must be loud, never silent.
  assert.ok(!/WARNING/.test(stderr), `extractor emitted warnings:\n${stderr}`);
});
