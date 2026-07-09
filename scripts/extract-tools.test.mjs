/**
 * Guards scripts/extract-tools.mjs against dropping or corrupting tool
 * definitions before they reach the downstream `spidershield scan --tools-json`
 * security scan. The motivating bug: the old extractor scanned a fixed
 * 2000-char window after each `id:`, so run-sequence's ~4285-char multi-line
 * template-literal description came back null and the tool was silently
 * excluded from the scan.
 *
 * Ground truth: the real-tree tests parse every tool source file with the
 * actual TypeScript parser and require the extractor's output to match the AST
 * exactly - names AND descriptions. Any drop (regex-literal lexing gap, window
 * regression, walk change), corruption (truncation, bad unescape), or
 * fabrication diverges from the AST and fails, with no reliance on stderr
 * warning formats and no false red from `id:`-like text in comments or strings.
 *
 * The TypeScript package is a test-only dependency (unit-tests.yml runs
 * `npm ci`): the extractor itself must stay dependency-free because
 * tool-description-quality.yml runs it on a bare checkout without installing.
 *
 * Run: node --test scripts/extract-tools.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { extractToolsFromSource, dedupeToolsById } from "./extract-tools.mjs";

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

function captureWarnings(fn) {
  const warnings = [];
  const originalError = console.error;
  console.error = (...args) => warnings.push(args.join(" "));
  try {
    return { result: fn(), warnings };
  } finally {
    console.error = originalError;
  }
}

// --- TypeScript-AST oracle --------------------------------------------------
// Computes the ground-truth tool set the extractor must emit: every object
// literal with an `id: "..."` string-literal property whose `description:` is a
// plain string / no-substitution template literal. `.text` is the COOKED value
// (escapes resolved), so it doubles as an oracle for the extractor's unescaping.
// Objects whose `description:` exists but is not a plain literal (concatenation,
// interpolation, method call, const reference) are collected as `nonStatic` -
// their rendered text cannot be extracted statically, so the scan would lose
// them; the real tree must not contain any. Ids with no description sibling
// (nested payload keys, descriptionless tools) are out of the emitted set by
// design and the extractor warn-skips them.
function oracleFromSource(src, fileName = "oracle.ts") {
  const sourceFile = ts.createSourceFile(fileName, src, ts.ScriptTarget.Latest, true);
  const tools = [];
  const nonStatic = [];
  const visit = (node) => {
    if (ts.isObjectLiteralExpression(node)) {
      let id = null;
      let descNode;
      for (const prop of node.properties) {
        if (!ts.isPropertyAssignment(prop)) continue;
        const name =
          ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name) ? prop.name.text : null;
        if (name === "id" && ts.isStringLiteral(prop.initializer)) id = prop.initializer.text;
        if (name === "description") descNode = prop.initializer;
      }
      if (id !== null && descNode !== undefined) {
        if (ts.isStringLiteral(descNode) || ts.isNoSubstitutionTemplateLiteral(descNode)) {
          tools.push({ name: id, description: descNode.text.trim() });
        } else {
          nonStatic.push(id);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return { tools, nonStatic };
}

function oracleFromTree() {
  const tools = [];
  const nonStatic = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (extname(name) === ".ts" && !name.endsWith(".d.ts")) {
        const fromFile = oracleFromSource(readFileSync(full, "utf8"), full);
        tools.push(...fromFile.tools);
        nonStatic.push(...fromFile.nonStatic);
      }
    }
  };
  walk(toolsRoot);
  return { tools, nonStatic };
}

const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

// --- Real-tree ground-truth tests -------------------------------------------

test("extractor output equals the TypeScript-AST ground truth exactly", () => {
  const { tools } = runExtractor();
  const oracle = oracleFromTree();

  // Sanity floor: an oracle bug that empties BOTH sides would make the
  // equality below pass vacuously; the real tree has ~72 tools.
  assert.ok(
    oracle.tools.length >= 60,
    `oracle found only ${oracle.tools.length} tools - oracle or tree layout broke`
  );

  // Unique ids: a same-name collision would mean one tool's description
  // silently replaces another's in the scan.
  const names = oracle.tools.map((t) => t.name);
  const dupes = names.filter((n, i) => names.indexOf(n) !== i);
  assert.deepEqual(dupes, [], `duplicate tool ids in the source tree: ${dupes.join(", ")}`);

  // The invariant: nothing dropped, nothing corrupted, nothing fabricated.
  // Name-level diffs first for a readable failure, then the full deep equality
  // (which also compares every description byte-for-byte).
  const extractedNames = new Set(tools.map((t) => t.name));
  const oracleNames = new Set(names);
  const dropped = [...oracleNames].filter((n) => !extractedNames.has(n));
  const fabricated = [...extractedNames].filter((n) => !oracleNames.has(n));
  assert.deepEqual(
    dropped,
    [],
    `tools in the AST but missing from the extractor: ${dropped.join(", ")}`
  );
  assert.deepEqual(
    fabricated,
    [],
    `extractor emitted tools the AST does not contain: ${fabricated.join(", ")}`
  );
  assert.deepEqual([...tools].sort(byName), [...oracle.tools].sort(byName));
});

test("every real tool description is a plain literal (statically extractable, so it gets scanned)", () => {
  const oracle = oracleFromTree();
  assert.deepEqual(
    oracle.nonStatic,
    [],
    `these tools' descriptions are not a single string/template literal, so the ` +
      `extractor cannot capture them and they would drop out of the spidershield ` +
      `scan: ${oracle.nonStatic.join(", ")}. Make each a plain literal.`
  );
});

test("run-sequence and describe (the two originally dropped tools) and gesture-tap (control) are present", () => {
  // Presence-only on purpose: fullness and exact wording are covered
  // byte-for-byte by the AST-equality test, so a legitimate rewrite of a
  // description cannot fail this suite while capture stays complete.
  const { tools } = runExtractor();
  const names = new Set(tools.map((t) => t.name));
  for (const expected of ["run-sequence", "describe", "gesture-tap"]) {
    assert.ok(names.has(expected), `${expected} missing from extractor output`);
  }
});

// --- Boundary-parsing rules (pure, fixture-driven) -------------------------

test("a >4000-char multi-line description is captured in full (the original regression)", () => {
  // Pins the fixed-window bug class forever, independent of any real tool's
  // current wording or length: the old extractor cut its search at 2000 chars.
  const sentence = "Runs one scripted step against the target device and reports the outcome. ";
  const longDescription = sentence.repeat(60).trim(); // ~4560 chars
  const src = `
    export const longTool = defineTool({
      id: "long-description-tool",
      description: \`${longDescription}\`,
      handler: async () => {},
    });
  `;
  const tools = extractToolsFromSource(src, "fixture.ts");
  assert.equal(tools.length, 1, "long-description tool was dropped");
  assert.equal(tools[0].description, longDescription, "long description was truncated");
});

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
  const byId = Object.fromEntries(tools.map((t) => [t.name, t.description]));
  assert.ok("menu-item-tool" in byId, "tool with an id: inside its description was dropped");
  assert.ok(
    byId["menu-item-tool"].includes("nested menu item"),
    "description was truncated at the inner id: instead of its closing backtick"
  );
  // The `id: "sub-thing"` inside the description text is not a real tool.
  assert.ok(!("sub-thing" in byId), "an id: inside a description was mistaken for a tool");
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
  const { result: tools } = captureWarnings(() => extractToolsFromSource(src, "fixture.ts"));
  const byId = Object.fromEntries(tools.map((t) => [t.name, t.description]));
  assert.equal(
    byId["has-description-tool"],
    "This description belongs to has-description-tool only."
  );
  assert.ok(
    !("no-description-tool" in byId),
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
  const byId = Object.fromEntries(tools.map((t) => [t.name, t.description]));
  assert.equal(byId["first-tool"], "First tool, plain double-quoted description.");
  assert.equal(
    byId["second-tool"],
    "Second tool, a template-literal description with some length."
  );
});

test("single-quoted id and description are captured (with escapes)", () => {
  const src = `
    export const sq = defineTool({
      id: 'single-quoted-tool',
      description: 'Types the user\\'s text into the focused field.',
      handler: async () => {},
    });
  `;
  const tools = extractToolsFromSource(src, "fixture.ts");
  assert.equal(
    tools.find((t) => t.name === "single-quoted-tool")?.description,
    "Types the user's text into the focused field."
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

test("a regex literal between id: and description: does not hide the description", () => {
  // The lexer must skip regex literals whole: a brace inside a character class
  // (`/[{]/`) must not shift the tracked object depth, and a quote inside a
  // regex (`/["']/`) must not open a fake string. Either would make the sibling
  // description: invisible and drop the tool from the security scan.
  for (const [label, field] of [
    ["brace class", "match: /[{]/,"],
    ["quote class", `schema: z.string().regex(/["']/),`],
    ["replace with a double-quote regex", `normalize: (s) => s.replace(/"/g, ""),`],
  ]) {
    const src = `
      export const t = defineTool({
        id: "regex-field-tool",
        ${field}
        description: "Real description of regex-field-tool.",
        handler: async () => {},
      });
    `;
    const { result: tools, warnings } = captureWarnings(() =>
      extractToolsFromSource(src, "fixture.ts")
    );
    assert.equal(
      tools.find((t) => t.name === "regex-field-tool")?.description,
      "Real description of regex-field-tool.",
      `${label}: regex literal between id: and description: dropped or corrupted the tool`
    );
    assert.deepEqual(warnings, [], `${label}: unexpected warnings`);
  }
});

test("a quote-bearing regex BEFORE the id: does not swallow the tool", () => {
  // A regex containing a quote that appears before the id: (an earlier
  // property, or earlier code in the file) must not open a fake string that
  // hides the id: token itself — that variant produced no warning at all.
  const src = `
    export const t = defineTool({
      normalize: (s) => s.replace(/"/g, ""),
      id: "after-regex-tool",
      description: "Description after a quote-bearing regex.",
      handler: async () => {},
    });
  `;
  const tools = extractToolsFromSource(src, "fixture.ts");
  assert.equal(
    tools.find((t) => t.name === "after-regex-tool")?.description,
    "Description after a quote-bearing regex."
  );
});

test("division is not mistaken for a regex literal", () => {
  // The other side of the regex heuristic: `/` after a value (identifier,
  // number, closing paren) is division and must be scanned through normally.
  const src = `
    export const t = defineTool({
      id: "division-tool",
      timeoutMs: 60000 / 2,
      budget: total / count,
      description: "Kept: the slashes above are division, not regex openers.",
      handler: async () => {},
    });
  `;
  const tools = extractToolsFromSource(src, "fixture.ts");
  assert.equal(
    tools.find((t) => t.name === "division-tool")?.description,
    "Kept: the slashes above are division, not regex openers."
  );
});

test("a non-static description (concatenation / interpolation / method suffix) is dropped loudly, not emitted wrong", () => {
  // The captured literal is only the description if nothing extends it. A `+`
  // concatenation, a template `${...}` interpolation, or a method/operator
  // suffix (`"...".slice(0, 3)`) means the rendered text differs from the
  // leading literal; emitting just that literal would feed silently wrong text
  // into the security scan. All must warn on stderr and be skipped.
  for (const [label, id, src] of [
    [
      "concatenation",
      "concat-tool",
      `defineTool({ id: "concat-tool", description: "part A " + "part B", handler() {} });`,
    ],
    [
      "interpolation",
      "interp-tool",
      'defineTool({ id: "interp-tool", description: `hello ${world} rest`, handler() {} });',
    ],
    [
      "slice suffix",
      "slice-tool",
      `defineTool({ id: "slice-tool", description: "abcdefghij".slice(0, 3), handler() {} });`,
    ],
    [
      "replace suffix",
      "replace-tool",
      `defineTool({ id: "replace-tool", description: "hello WORLD".replace("WORLD", "there"), handler() {} });`,
    ],
  ]) {
    const { result: tools, warnings } = captureWarnings(() =>
      extractToolsFromSource(src, "fixture.ts")
    );
    assert.equal(tools.length, 0, `${label}: a partial/wrong description must not be emitted`);
    assert.ok(
      warnings.some((w) => /WARNING/.test(w) && w.includes(id)),
      `${label}: expected a stderr WARNING naming ${id}; got ${JSON.stringify(warnings)}`
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
  const { result: tools } = captureWarnings(() => extractToolsFromSource(src, "fixture.ts"));
  const byId = Object.fromEntries(tools.map((t) => [t.name, t.description]));
  assert.equal(byId["create-thing"], "Creates a thing.", "real tool dropped by a nested id: key");
  assert.ok(!("example-id" in byId), "a nested object's id: key was emitted as a spurious tool");
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
  const { result: tools } = captureWarnings(() => extractToolsFromSource(src, "fixture.ts"));
  const byId = Object.fromEntries(tools.map((t) => [t.name, t.description]));
  assert.equal(byId["native-thing"], "Does a native thing.");
  assert.ok(!("cap-1" in byId), "a deeply nested id: key was emitted as a spurious tool");
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
  const byId = Object.fromEntries(tools.map((t) => [t.name, t.description]));
  assert.equal(
    byId["line-commented-tool"],
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
  const byId = Object.fromEntries(tools.map((t) => [t.name, t.description]));
  assert.equal(
    byId["block-commented-tool"],
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
  const byId = Object.fromEntries(tools.map((t) => [t.name, t.description]));
  assert.equal(
    byId["screenshot"],
    "Take a screenshot of the device.",
    "a commented id: cross-reference overwrote the real tool's description"
  );
  assert.equal(byId["foo-tool"], "Foo tool description.");
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
  const { result: tools, warnings } = captureWarnings(() =>
    extractToolsFromSource(src, "fixture.ts")
  );
  assert.equal(tools.length, 0, "a description-less tool must not be emitted");
  assert.ok(
    warnings.some((w) => /WARNING/.test(w) && w.includes("no-description-real-tool")),
    `expected a stderr WARNING naming the dropped id; got: ${JSON.stringify(warnings)}`
  );
});

test("duplicate tool ids keep the first occurrence and warn about the rest", () => {
  const duplicated = [
    { name: "dup-tool", description: "First definition - must survive." },
    { name: "unique-tool", description: "Unrelated tool." },
    { name: "dup-tool", description: "Second definition - must be skipped loudly." },
  ];
  const { result: deduped, warnings } = captureWarnings(() => dedupeToolsById(duplicated));
  assert.deepEqual(deduped, [
    { name: "dup-tool", description: "First definition - must survive." },
    { name: "unique-tool", description: "Unrelated tool." },
  ]);
  assert.ok(
    warnings.some((w) => /WARNING/.test(w) && w.includes("dup-tool")),
    `expected a duplicate-id WARNING naming dup-tool; got: ${JSON.stringify(warnings)}`
  );
});
