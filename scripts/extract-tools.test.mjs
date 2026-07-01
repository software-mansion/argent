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
import { extractToolsFromSource } from "./extract-tools.mjs";

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

// --- Boundary-parsing rules (pure, fixture-driven) -------------------------

test("a description containing an id: token is still captured in full", () => {
  // The closing-delimiter-anchored search must not be truncated by an `id:`
  // that appears INSIDE the description text (e.g. a structured example). The
  // old "stop at the next id:" bound dropped such a tool — the exact class of
  // silent scan-bypass this script exists to prevent.
  const src = `
    export const menuTool = defineTool({
      id: "menu-item-tool",
      description: \`Opens a context menu at a point. Example payload the agent can send:
        { id: "sub-thing", label: "Open" } — a structured example inside the text.
        Use when you need to open a nested menu item on screen.\`,
      handler: async () => {},
    });
  `;
  const tools = extractToolsFromSource(src, "fixture.ts");
  const byName = Object.fromEntries(tools.map((t) => [t.name, t.description]));
  assert.ok("menu-item-tool" in byName, "tool with an id: inside its description was dropped");
  assert.ok(
    byName["menu-item-tool"].includes("nested menu item"),
    "description was truncated at the inner id: instead of its closing backtick"
  );
  // The `id: "sub-thing"` inside the description text is not a real tool.
  assert.ok(!("sub-thing" in byName), "an id: inside a description was mistaken for a tool");
});

test("a description-less tool does not borrow the next tool's description", () => {
  // If another tool's `id:` sits between this id: and the matched description:,
  // the description belongs to that later tool — don't inherit it.
  const src = `
    export const bare = defineTool({
      id: "no-description-tool",
      handler: async () => {},
    });
    export const next = defineTool({
      id: "has-description-tool",
      description: "This description belongs to has-description-tool only.",
      handler: async () => {},
    });
  `;
  const tools = extractToolsFromSource(src, "fixture.ts");
  const byName = Object.fromEntries(tools.map((t) => [t.name, t.description]));
  assert.equal(
    byName["has-description-tool"],
    "This description belongs to has-description-tool only."
  );
  assert.ok(
    !("no-description-tool" in byName),
    "a description-less tool borrowed the following tool's description"
  );
});
