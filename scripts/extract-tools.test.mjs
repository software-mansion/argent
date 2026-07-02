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

// Independently discover every string-literal `id: "..."` in the source tree,
// using the same shape the extractor keys off but WITHOUT its description step.
// This is a SUPERSET of the tool set the extractor emits: it also matches nested
// object keys (e.g. `defaultPayload: { id: "x" }`) and id:-like tokens the
// extractor deliberately skips. The "no silent drops" test below relies on that:
// every discovered id must be either emitted or loudly warned, never dropped in
// silence. Tools whose id is a const reference (e.g. await-ui-element's
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

test("run-sequence's long description is captured IN FULL, not truncated", () => {
  const { tools } = runExtractor();
  const runSequence = tools.find((t) => t.name === "run-sequence");
  assert.ok(
    runSequence,
    "run-sequence was dropped — the description lookahead regressed to a fixed window"
  );
  // Assert fullness, not just presence: the original bug truncated at a fixed
  // 2000-char window, so a re-truncation could still emit the tool with a
  // shortened description and pass a name-only check. The description is ~4285
  // chars; assert it runs well past the old window AND reaches its closing
  // backtick (the final sentence), so the capture is provably complete.
  assert.ok(
    runSequence.description.length > 3000,
    `run-sequence description truncated to ${runSequence.description.length} chars (past the old 2000-char window expected)`
  );
  assert.ok(
    runSequence.description.includes("returns partial results"),
    "run-sequence description does not reach its final sentence — captured value is truncated"
  );
});

test("gesture-tap is captured (control)", () => {
  const { tools } = runExtractor();
  const names = tools.map((t) => t.name);
  assert.ok(names.includes("gesture-tap"));
});

test("no tool definition is silently dropped (every id: is emitted or loudly warned)", () => {
  const { tools, stderr } = runExtractor();
  const extracted = new Set(tools.map((t) => t.name));
  const discovered = discoverIdLiterals();

  // No fabricated tools: every emitted name is a real id: literal in the source.
  const fabricated = [...extracted].filter((id) => !discovered.has(id));
  assert.deepEqual(
    fabricated,
    [],
    `extractor emitted names with no id: literal in the source: ${fabricated.join(", ")}`
  );

  // Completeness WITHOUT a false positive when a tool legitimately uses a shape
  // the extractor is designed to skip: an id: literal the extractor does not
  // emit — a nested object key (e.g. `defaultPayload: { id: "x" }`), a tool
  // whose description isn't a static string/template literal, or a
  // description-less tool — must be named in a stderr WARNING, i.e. skipped
  // LOUDLY. This is the exact invariant the PR restores (the old fixed-window
  // matcher dropped long-description tools SILENTLY): the check stays green when
  // a future tool uses one of those shapes (the extractor warns and the count
  // shifts) and fails only on a genuinely SILENT drop.
  const silentlyDropped = [...discovered].filter(
    (id) => !extracted.has(id) && !stderr.includes(`"${id}"`)
  );
  assert.deepEqual(
    silentlyDropped,
    [],
    `id: literals dropped by the extractor with no stderr warning: ${silentlyDropped.join(", ")}`
  );
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

test("tools with mixed description forms in one file are both captured", () => {
  // Position-based (not delimiter-form-priority) matching: an earlier tool's
  // double-quoted description must not be lost to a LATER tool's template
  // literal. A form-priority scan would grab the later template ahead of the
  // nearer double-quoted one, then drop the earlier tool.
  const src = `
    export const first = defineTool({
      id: "first-tool",
      description: "First tool, plain double-quoted description.",
      handler: async () => {},
    });
    export const second = defineTool({
      id: "second-tool",
      description: \`Second tool, a template-literal description with some length.\`,
      handler: async () => {},
    });
  `;
  const tools = extractToolsFromSource(src, "fixture.ts");
  const byName = Object.fromEntries(tools.map((t) => [t.name, t.description]));
  assert.equal(byName["first-tool"], "First tool, plain double-quoted description.");
  assert.equal(
    byName["second-tool"],
    "Second tool, a template-literal description with some length."
  );
});

test("standard escapes render as their actual characters, not literal backslash sequences", () => {
  // A template-literal description with a literal "\n" must become a real
  // newline in the extracted text — not survive as a stray backslash-n. Real,
  // currently-shipping example: flow-add-step.ts's description uses \n between
  // sentences.
  const src = `
    export const withEscapes = defineTool({
      id: "with-escapes",
      description: \`Line one.\\nLine two.\\tTabbed. Say \\\`hi\\\` and \\$done.\`,
      handler: async () => {},
    });
  `;
  const tools = extractToolsFromSource(src, "fixture.ts");
  const description = tools.find((t) => t.name === "with-escapes").description;
  assert.equal(description, "Line one.\nLine two.\tTabbed. Say `hi` and $done.");
});

test("a non-static description (concatenation / interpolation) is dropped loudly, not truncated silently", () => {
  // The captured literal is only the whole description if nothing extends it. A
  // `+` concatenation or a template `${...}` interpolation means the rendered
  // text is more than the leading literal; emitting just that literal would feed
  // a SILENTLY truncated string into the security scan — the same silent-partial
  // class this script exists to prevent. Both must warn on stderr and be skipped.
  for (const [label, src] of [
    [
      "concatenation",
      `defineTool({ id: "concat-tool", description: "part A " + "part B", handler() {} });`,
    ],
    [
      "interpolation",
      'defineTool({ id: "interp-tool", description: `hello ${world} rest`, handler() {} });',
    ],
  ]) {
    const warnings = [];
    const originalError = console.error;
    console.error = (...args) => warnings.push(args.join(" "));
    let tools;
    try {
      tools = extractToolsFromSource(src, "fixture.ts");
    } finally {
      console.error = originalError;
    }
    assert.equal(tools.length, 0, `${label}: a truncated description must not be emitted`);
    assert.ok(
      warnings.some(
        (w) =>
          /WARNING/.test(w) && w.includes(label === "concatenation" ? "concat-tool" : "interp-tool")
      ),
      `${label}: expected a stderr WARNING; got ${JSON.stringify(warnings)}`
    );
  }
});

test("an escaped \\${ in a template is a literal, not interpolation, and is captured", () => {
  // \\${...} is an escaped dollar-brace: it renders as the literal text "${...}"
  // and is NOT runtime interpolation, so the tool must be captured normally.
  const src =
    'defineTool({ id: "escaped-dollar", description: `price is \\${amount} today`, handler() {} });';
  const tools = extractToolsFromSource(src, "fixture.ts");
  assert.equal(
    tools.find((t) => t.name === "escaped-dollar")?.description,
    "price is ${amount} today"
  );
});

test("an id: key inside a nested object value is not mistaken for a tool", () => {
  // A structured value between a tool's id: and its description: (a
  // defaultPayload, example, etc.) can itself contain an `id:` key. That nested
  // id: must neither (a) be emitted as a spurious tool nor (b) drop the real
  // tool from the security scan. Matching the description by brace scope rather
  // than raw position is what prevents both.
  const src = `
    export const createThing = defineTool({
      id: "create-thing",
      defaultPayload: { id: "example-id", name: "x" },
      description: "Creates a thing.",
      handler: async () => {},
    });
  `;
  const tools = extractToolsFromSource(src, "fixture.ts");
  const byName = Object.fromEntries(tools.map((t) => [t.name, t.description]));
  assert.equal(byName["create-thing"], "Creates a thing.", "real tool dropped by a nested id: key");
  assert.ok(!("example-id" in byName), "a nested object's id: key was emitted as a spurious tool");
  assert.equal(tools.length, 1, "exactly the real tool should be emitted");
});

test("a balanced nested object (with a deep inner id:) between id: and description: keeps the tool", () => {
  // Mirrors the real `capability: { apple: { ... } }` shape 7 tools already
  // use, but with an inner id: key added at depth 2 - the deepest footgun form.
  // The tool must be captured in full and the inner id: must not leak out.
  const src = `
    export const t = defineTool({
      id: "native-thing",
      capability: { apple: { simulator: true, device: true }, meta: { id: "cap-1" } },
      description: \`Does a native thing.\`,
      handler: async () => {},
    });
  `;
  const tools = extractToolsFromSource(src, "fixture.ts");
  const byName = Object.fromEntries(tools.map((t) => [t.name, t.description]));
  assert.equal(byName["native-thing"], "Does a native thing.");
  assert.ok(!("cap-1" in byName), "a deeply nested id: key was emitted as a spurious tool");
  assert.equal(tools.length, 1);
});

test("a line comment with an apostrophe between id: and description: keeps the tool", () => {
  // A `//` comment is not code: an apostrophe inside it (e.g. `don't`) must not
  // open a fake string that swallows the source up to the next quote, which
  // would hide the real description: and silently drop the tool from the scan.
  const src = `
    export const t = defineTool({
      id: "line-commented-tool",
      // don't forget to update this description when behaviour changes
      description: "The real, comment-preceded description.",
      handler: async () => {},
    });
  `;
  const tools = extractToolsFromSource(src, "fixture.ts");
  const byName = Object.fromEntries(tools.map((t) => [t.name, t.description]));
  assert.equal(
    byName["line-commented-tool"],
    "The real, comment-preceded description.",
    "a line comment (with an apostrophe) between id: and description: dropped the tool"
  );
  assert.equal(tools.length, 1);
});

test("a block comment between id: and description: keeps the tool", () => {
  // A `/* ... */` block comment must be skipped whole: stray braces, an
  // apostrophe, and even a fake `description:` token inside it must not shift
  // the brace depth or be matched as the tool's real description.
  const src = `
    export const t = defineTool({
      id: "block-commented-tool",
      /* don't { do } this: description: "fake" - braces + apostrophe in a comment */
      description: "The real block-comment-preceded description.",
      handler: async () => {},
    });
  `;
  const tools = extractToolsFromSource(src, "fixture.ts");
  const byName = Object.fromEntries(tools.map((t) => [t.name, t.description]));
  assert.equal(
    byName["block-commented-tool"],
    "The real block-comment-preceded description.",
    "a block comment between id: and description: dropped the tool or matched the fake description"
  );
  assert.equal(tools.length, 1);
});

test("an id: literal inside a comment does not corrupt a real tool's description", () => {
  // id detection must be lexically aware: an `id: "..."` in a COMMENT (a common
  // cross-reference to another tool) must not be picked up as a tool candidate.
  // If it were, it would read the enclosing object's real description and, via
  // first-wins dedup, silently overwrite the referenced tool's description in the
  // security scan — a silent mis-capture, the exact class this script prevents.
  const src = `
    export const foo = defineTool({
      // Related to id: "screenshot"; call that first to capture the screen.
      id: "foo-tool",
      description: "Foo tool description.",
      handler: async () => {},
    });
    export const shot = defineTool({
      id: "screenshot",
      description: "Take a screenshot of the device.",
      handler: async () => {},
    });
  `;
  const tools = extractToolsFromSource(src, "fixture.ts");
  const byName = Object.fromEntries(tools.map((t) => [t.name, t.description]));
  assert.equal(
    byName["screenshot"],
    "Take a screenshot of the device.",
    "a commented id: cross-reference overwrote the real tool's description"
  );
  assert.equal(byName["foo-tool"], "Foo tool description.");
  assert.equal(tools.length, 2, "exactly the two real tools should be emitted");
});

test("a top-level tool with no description is dropped loudly (stderr warning)", () => {
  // `description?` is optional in ToolDefinition, so a real top-level tool can
  // legally omit it. It can't be extracted, but it must not vanish from the
  // security scan silently - it has to warn on stderr so the drop is diagnosed
  // rather than only surfacing as a cryptic count mismatch in CI.
  const src = `
    export const bare = defineTool({
      id: "no-description-real-tool",
      handler: async () => {},
    });
  `;
  const warnings = [];
  const originalError = console.error;
  console.error = (...args) => warnings.push(args.join(" "));
  let tools;
  try {
    tools = extractToolsFromSource(src, "fixture.ts");
  } finally {
    console.error = originalError;
  }
  assert.equal(tools.length, 0, "a description-less tool must not be emitted");
  assert.ok(
    warnings.some((w) => /WARNING/.test(w) && w.includes("no-description-real-tool")),
    `expected a stderr WARNING naming the dropped id; got: ${JSON.stringify(warnings)}`
  );
});
