/**
 * Guards scripts/extract-tools.mjs against dropping or corrupting tool
 * definitions before they reach the downstream `spidershield scan --tools-json`
 * security scan. Motivating bug: the old extractor searched a fixed 2000-char
 * window after each `id:`, so run-sequence's long multi-line template-literal
 * description came back null and the tool was silently excluded.
 *
 * Ground truth: the real-tree tests parse every tool source file with the real
 * TypeScript parser and require the extractor's output to equal the AST -
 * names AND descriptions - so nothing depends on stderr warning formats and
 * `id:`-like text in comments or strings cannot cause a false red.
 *
 * The TypeScript package is test-only (a root devDependency, installed by
 * unit-tests.yml's `npm ci`): the extractor itself must stay dependency-free
 * because tool-description-quality.yml runs it on a bare checkout without
 * installing.
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
  return { tools: JSON.parse(res.stdout).tools };
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

// TypeScript-AST oracle
//
// Ground-truth tool set: every object literal with a static `id` (string or
// no-substitution template literal; `as const` / `satisfies` / parens
// unwrapped) whose `description` is a plain string / no-substitution template
// literal written AFTER the id. `.text` is the COOKED value, so it also
// oracles the extractor's unescaping.
//
// Anything else an id-bearing object does with `description` lands in a LOUD
// bucket instead of silently escaping the safety net:
//   - nonStatic: the rendered text cannot be read statically - a non-literal
//     initializer (concatenation, interpolation, method call, const reference,
//     `as const`), a shorthand / getter / method `description` member, a
//     spread written AFTER the description (it may override it at runtime; one
//     before it cannot), a spread with no explicit description at all (it may
//     carry one), or a getter/method `id` beside a description.
//   - misordered: a plain-literal description written BEFORE the id - the
//     extractor's scan is forward-only and cannot capture it.
// The real tree must keep both buckets empty.
//
// The buckets apply only to objects that could BE tool definitions: an object
// literal reached as (part of) another object literal's property value is data
// (a payload, example, or config fragment), so demanding a static description
// of it would be a false red. Equality still covers nested data - an
// id-then-plain-description data object is emitted by both sides alike. Ids
// with no description-ish member (nested payload keys, descriptionless tools)
// stay out of the emitted set by design (the extractor warn-skips them), and
// dynamic ids (const references, shorthand, interpolated templates) are out of
// scope on both sides.
function unwrapExpression(node) {
  while (
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isParenthesizedExpression(node)
  ) {
    node = node.expression;
  }
  return node;
}

function isStaticText(node) {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node);
}

// Null when the name cannot be known statically (a dynamic computed key).
// `["description"]: ...` resolves to "description" so a computed spelling
// can't slip past the net.
function memberName(prop) {
  if (!prop.name) return null;
  if (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name)) return prop.name.text;
  if (ts.isComputedPropertyName(prop.name)) {
    const expr = unwrapExpression(prop.name.expression);
    return isStaticText(expr) ? expr.text : null;
  }
  return null;
}

// An object literal reached as (part of) another object literal's property
// value - through array elements or as/satisfies/paren wrappers - is data, not
// a tool-definition site.
function isNestedDataValue(node) {
  let cur = node.parent;
  while (
    cur &&
    (ts.isArrayLiteralExpression(cur) ||
      ts.isAsExpression(cur) ||
      ts.isSatisfiesExpression(cur) ||
      ts.isParenthesizedExpression(cur))
  ) {
    cur = cur.parent;
  }
  return cur !== undefined && ts.isPropertyAssignment(cur);
}

function oracleFromSource(src, fileName = "oracle.ts") {
  const sourceFile = ts.createSourceFile(fileName, src, ts.ScriptTarget.Latest, true);
  const tools = [];
  const nonStatic = [];
  const misordered = [];
  const visit = (node) => {
    if (ts.isObjectLiteralExpression(node)) {
      let id = null;
      let idIndex = -1;
      let hasDynamicIdMember = false;
      let descIndex = -1;
      let descValue = null;
      let descIsPlain = false;
      let hasDescMember = false;
      let lastSpreadIndex = -1;
      node.properties.forEach((prop, index) => {
        if (ts.isSpreadAssignment(prop)) {
          lastSpreadIndex = index;
          return;
        }
        const name = memberName(prop);
        if (name === "id") {
          if (ts.isPropertyAssignment(prop)) {
            const init = unwrapExpression(prop.initializer);
            if (isStaticText(init)) {
              id = init.text;
              idIndex = index;
            }
          } else if (ts.isGetAccessorDeclaration(prop) || ts.isMethodDeclaration(prop)) {
            // An id the lexical extractor can never see; beside a
            // description it would be a fully silent scan bypass.
            hasDynamicIdMember = true;
          }
        }
        if (name === "description") {
          hasDescMember = true;
          descIndex = index;
          // Deliberately NOT unwrapped: `description: "x" as const` is not
          // a shape the extractor can capture, so it must stay non-static.
          if (ts.isPropertyAssignment(prop) && isStaticText(prop.initializer)) {
            descIsPlain = true;
            descValue = prop.initializer.text.trim();
          }
        }
      });
      const nested = isNestedDataValue(node);
      if (id !== null && hasDescMember) {
        if (descIsPlain && descIndex >= idIndex) {
          // Mirrors the extractor, nested data included.
          tools.push({ name: id, description: descValue });
          if (!nested && lastSpreadIndex > descIndex) {
            // Only a spread AFTER the description can override it at runtime.
            nonStatic.push({ id, file: fileName });
          }
        } else if (!nested) {
          if (descIsPlain) {
            misordered.push({ id, file: fileName });
          } else {
            nonStatic.push({ id, file: fileName });
          }
        }
      } else if (!nested && id !== null && lastSpreadIndex >= 0) {
        // No explicit description, but the spread may carry one the extractor
        // (and this oracle) can't see - force it to be written explicitly.
        nonStatic.push({ id, file: fileName });
      } else if (!nested && id === null && hasDynamicIdMember && hasDescMember) {
        nonStatic.push({ id: "<dynamic id>", file: fileName });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return { tools, nonStatic, misordered };
}

function oracleFromTree() {
  const tools = [];
  const nonStatic = [];
  const misordered = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (extname(name) === ".ts" && !name.endsWith(".d.ts")) {
        const fromFile = oracleFromSource(readFileSync(full, "utf8"), full);
        tools.push(...fromFile.tools);
        nonStatic.push(...fromFile.nonStatic);
        misordered.push(...fromFile.misordered);
      }
    }
  };
  walk(toolsRoot);
  return { tools, nonStatic, misordered };
}

const flagList = (entries) => entries.map((e) => `${e.id} (${e.file})`).join(", ");

const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

// Real-tree ground-truth tests

test("extractor output equals the TypeScript-AST ground truth exactly", () => {
  const { tools } = runExtractor();
  const oracle = oracleFromTree();

  // Sanity floor: an oracle bug that empties BOTH sides would make the
  // equality below pass vacuously.
  assert.ok(
    oracle.tools.length >= 60,
    `oracle found only ${oracle.tools.length} tools - oracle or tree layout broke`
  );

  // A same-name collision would mean one tool's description silently replaces
  // another's in the scan.
  const names = oracle.tools.map((t) => t.name);
  const dupes = names.filter((n, i) => names.indexOf(n) !== i);
  assert.deepEqual(dupes, [], `duplicate tool ids in the source tree: ${dupes.join(", ")}`);

  // Name-level diffs first for a readable failure; the deep equality then
  // compares every description byte-for-byte.
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
    `these tools' descriptions cannot be read statically (non-literal value, ` +
      `shorthand/getter/computed member, or a spread that may carry/override it), ` +
      `so they would drop out of the spidershield scan: ${flagList(oracle.nonStatic)}. ` +
      `Write each as a plain string/template literal property.`
  );
  assert.deepEqual(
    oracle.misordered,
    [],
    `these descriptions are written BEFORE their id: - the extractor's scan is ` +
      `forward-only, so they would drop out of the spidershield scan: ` +
      `${flagList(oracle.misordered)}. Move each description: after its id:.`
  );
});

test("run-sequence and describe (the two originally dropped tools) and gesture-tap (control) are present", () => {
  // Presence-only: wording is covered byte-for-byte by the AST-equality test,
  // so rewording a description cannot fail this while capture stays complete.
  const { tools } = runExtractor();
  const names = new Set(tools.map((t) => t.name));
  for (const expected of ["run-sequence", "describe", "gesture-tap"]) {
    assert.ok(names.has(expected), `${expected} missing from extractor output`);
  }
});

// Boundary-parsing rules (pure, fixture-driven)

test("a >4000-char multi-line description is captured in full (the original regression)", () => {
  // Pins the fixed-window bug class independently of any real tool's current
  // wording or length: the old extractor cut its search at 2000 chars.
  const sentence = "Runs one scripted step against the target device and reports the outcome. ";
  const longDescription = sentence.repeat(60).trim();
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
  // The description must run to its closing delimiter, not stop at an `id:`
  // appearing INSIDE the text (e.g. a structured example) - the old
  // "stop at the next id:" bound dropped such a tool.
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
  // Matching is position-based, not delimiter-form-priority: a form-priority
  // scan would grab the later tool's template ahead of the nearer
  // double-quoted one and drop the earlier tool.
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
  // A template-literal `\n` must cook to a real newline, not survive as a
  // stray backslash-n. Real descriptions come and go from this shape, so a
  // fixture pins it rather than any live tool.
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
  // regex (`/["']/`) must not open a fake string. Either hides the sibling
  // description: and drops the tool from the security scan.
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
  // A quote-bearing regex before the id: must not open a fake string that
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

test("a TS postfix non-null assertion before a division is not read as a regex opener", () => {
  // `a!` is a postfix non-null assertion that ENDS a value, so the following
  // `/` is division; read as a regex, the quote in the divisor (`"x/y"`) opens
  // a fake string that hides this description: and swallows the next tool. A
  // PREFIX `!` (`=> !/re/`, `return !/re/`) is the opposite case and must stay
  // a regex, even though the char before it is an identifier char.
  const src = `
    export const helpers = {
      needsQuote: (x) => { return !/["']/.test(x); },
    };
    export const first = defineTool({
      id: "bang-division-tool",
      w: a! / "x/y".length,
      description: "First: postfix ! then division.",
      handler: async () => {},
    });
    export const second = defineTool({
      id: "tool-after-bang",
      check: (x) => !/["']/.test(x),
      description: "Second: survives, and its prefix-! regex is not division.",
      handler: async () => {},
    });
  `;
  const { result: tools } = captureWarnings(() => extractToolsFromSource(src, "fixture.ts"));
  const byId = Object.fromEntries(tools.map((t) => [t.name, t.description]));
  assert.equal(
    byId["bang-division-tool"],
    "First: postfix ! then division.",
    "a postfix non-null assertion was mis-lexed as a regex position, hiding the description"
  );
  assert.equal(
    byId["tool-after-bang"],
    "Second: survives, and its prefix-! regex is not division.",
    "a return-! or operator-! prefix regex was read as division, dropping a later tool"
  );
});

test("a non-static description (concatenation / interpolation / method suffix) is dropped loudly, not emitted wrong", () => {
  // The captured literal is the description only if nothing extends it: a `+`
  // concatenation, a `${...}` interpolation or a method/operator suffix makes
  // the rendered text differ from the leading literal, so emitting that
  // literal would feed silently wrong text into the security scan.
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
  // An escaped `\${...}` renders as the literal text "${...}", not runtime
  // interpolation, so the tool must still be captured.
  const src =
    'defineTool({ id: "escaped-dollar", description: `price is \\${amount} today`, handler() {} });';
  const tools = extractToolsFromSource(src, "fixture.ts");
  assert.equal(
    tools.find((t) => t.name === "escaped-dollar")?.description,
    "price is ${amount} today"
  );
});

test("an id: key inside a nested object value is not mistaken for a tool", () => {
  // A structured value between a tool's id: and its description: can itself
  // contain an `id:` key, which must neither be emitted as a spurious tool nor
  // drop the real one. Matching the description by brace scope rather than raw
  // position is what prevents both.
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
  // Mirrors the real `capability: { apple: { ... } }` shape, with an inner id:
  // key at depth 2 - the deepest footgun form.
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

test("a *description: sibling (subdescription:) before the real description: is not captured", () => {
  // findOwnDescriptionValue matches `description:` only on a word boundary, so
  // a sibling key merely ENDING in `description` must not be read as the
  // tool's own and feed the wrong text into the security scan.
  const src = `
    export const t = defineTool({
      id: "subdescription-tool",
      subdescription: "WRONG - a sibling ending in 'description'.",
      description: "RIGHT - the tool's own description.",
      handler: async () => {},
    });
  `;
  const tools = extractToolsFromSource(src, "fixture.ts");
  assert.equal(
    tools.find((t) => t.name === "subdescription-tool")?.description,
    "RIGHT - the tool's own description.",
    "a `subdescription:` sibling was captured instead of the real description"
  );
  assert.equal(tools.length, 1);
});

test("a *id: sibling (uuid:, grid:) is not mistaken for a tool id", () => {
  // findIdLiteralsInCode matches `id:` only on a word boundary, so sibling keys
  // merely ENDING in `id` must not be discovered as tool ids and fabricate
  // spurious tools into the scan.
  const src = `
    export const t = defineTool({
      uuid: "11111111-2222-3333-4444-555555555555",
      grid: "10x10",
      id: "real-id-tool",
      description: "The only real tool here.",
      handler: async () => {},
    });
  `;
  const tools = extractToolsFromSource(src, "fixture.ts");
  const names = tools.map((t) => t.name);
  assert.deepEqual(
    names,
    ["real-id-tool"],
    `spurious tools fabricated from *id: siblings: ${names}`
  );
});

test("a line comment with an apostrophe between id: and description: keeps the tool", () => {
  // An apostrophe in a `//` comment must not open a fake string that swallows
  // the source up to the next quote, hiding the real description: and silently
  // dropping the tool from the scan.
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
  // An `id: "..."` in a COMMENT (a common cross-reference to another tool)
  // must not become a tool candidate: it would read the enclosing object's
  // real description and, via first-wins dedup, overwrite the referenced
  // tool's description in the security scan.
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
  // `description` is optional in ToolDefinition, so a real tool can legally
  // omit it. Such a tool cannot be extracted, but the drop must warn on stderr
  // rather than surface only as a cryptic count mismatch in CI.
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

// Lexer soundness: regex positions, templates, id forms

test("a keyword-position regex (return /[\"']/) before a tool does not swallow it", () => {
  // `/` after `return` is a regex, not division; without keyword awareness the
  // quotes inside it open a fake string and every later tool in the file is
  // silently dropped. Helper functions with return-regexes do share files with
  // tool definitions in the real tree.
  const src = `
    function isQuote(c) { return /["']/.test(c); }
    export const t = defineTool({
      id: "after-keyword-regex-tool",
      description: "Real description after a keyword-position regex.",
      handler: async () => {},
    });
  `;
  const { result: tools, warnings } = captureWarnings(() =>
    extractToolsFromSource(src, "fixture.ts")
  );
  assert.equal(
    tools.find((t) => t.name === "after-keyword-regex-tool")?.description,
    "Real description after a keyword-position regex."
  );
  assert.deepEqual(warnings, []);
});

test("a keyword-NAMED property access before a slash is division, not a regex opener", () => {
  // `counts.in / 2` and `i++ / 2` end in values; without the property-access
  // and postfix checks the following `/` opens a fake regex that, with a
  // second slash on the same line, desynchronizes string lexing and could
  // silently steal description text.
  const src = `
    export const t = defineTool({
      id: "division-after-member-tool",
      ratio: counts.in / total, path: "per/sec",
      tally: i++ / 2, unit: "x/y",
      description: "Real description after member and postfix division.",
      handler: async () => {},
    });
  `;
  const { result: tools, warnings } = captureWarnings(() =>
    extractToolsFromSource(src, "fixture.ts")
  );
  assert.equal(
    tools.find((t) => t.name === "division-after-member-tool")?.description,
    "Real description after member and postfix division."
  );
  assert.deepEqual(warnings, []);
});

test("a nested template literal before a tool is skipped whole (interpolation included)", () => {
  // Without `\${...}` tracking, the inner template's opening backtick "closes"
  // the outer one, the apostrophe in it opens a fake string, and the following
  // tool silently vanishes. Nested templates are common in the real tree.
  const src = `
    const msg = \`status: \${ready ? \`it's ready\` : "pending"}\`;
    export const t = defineTool({
      id: "after-nested-template-tool",
      description: "Real description after a nested template.",
      handler: async () => {},
    });
  `;
  const { result: tools, warnings } = captureWarnings(() =>
    extractToolsFromSource(src, "fixture.ts")
  );
  assert.equal(
    tools.find((t) => t.name === "after-nested-template-tool")?.description,
    "Real description after a nested template."
  );
  assert.deepEqual(warnings, []);
});

test("a quote-bearing regex inside a template interpolation is skipped whole", () => {
  // The real tree has this shape (open-url's android.ts shell quoting) but
  // never yet beside an id:, so only this fixture pins it. Without lexing the
  // regex whole, the apostrophes in /'/g open a fake string inside the
  // interpolation and the following tool vanishes with no warning at all.
  const src = `
    const quoted = \`'\${params.url.replace(/'/g, "'\\\\''")}'\`;
    export const t = defineTool({
      id: "after-interp-regex-tool",
      description: "Real description after an interpolation regex.",
      handler: async () => {},
    });
  `;
  const { result: tools, warnings } = captureWarnings(() =>
    extractToolsFromSource(src, "fixture.ts")
  );
  assert.equal(
    tools.find((t) => t.name === "after-interp-regex-tool")?.description,
    "Real description after an interpolation regex."
  );
  assert.deepEqual(warnings, []);
});

test("a fake description: inside a template interpolation cannot be stolen as the tool's", () => {
  // The interpolation's content is not code at the tool's object level; a
  // `description: "..."` string inside it must not be matched ahead of the
  // tool's real description.
  const src = `
    export const t = defineTool({
      id: "victim-tool",
      note: \`\${\`description: "stolen text",\`} tail\`,
      description: "The real description of victim-tool.",
      handler: async () => {},
    });
  `;
  const tools = extractToolsFromSource(src, "fixture.ts");
  assert.equal(
    tools.find((t) => t.name === "victim-tool")?.description,
    "The real description of victim-tool."
  );
  assert.equal(tools.length, 1);
});

test("a no-substitution template-literal id is captured, and the AST oracle agrees", () => {
  // `id: \`x\`` is runtime-identical to `id: "x"`. Both the extractor and the
  // oracle must see it - if either side skipped it, a real tool would leave
  // the scan with the equality test still green.
  const src =
    'export const t = defineTool({ id: `template-id-tool`, description: "Real description T.", handler() {} });';
  const tools = extractToolsFromSource(src, "fixture.ts");
  assert.equal(
    tools.find((t) => t.name === "template-id-tool")?.description,
    "Real description T."
  );
  assert.deepEqual(oracleFromSource(src).tools, [
    { name: "template-id-tool", description: "Real description T." },
  ]);
});

test("an interpolated template id is out of scope on both sides (dynamic, like a const-ref id)", () => {
  const src = 'export const t = defineTool({ id: `dyn-${x}`, description: "D.", handler() {} });';
  const { result: tools } = captureWarnings(() => extractToolsFromSource(src, "fixture.ts"));
  const oracle = oracleFromSource(src);
  assert.deepEqual(tools, []);
  assert.deepEqual(oracle.tools, []);
  assert.deepEqual(oracle.nonStatic, []);
});

test('an `id: "x" as const` tool is captured, and the AST oracle agrees', () => {
  // The extractor's id matcher reads through the suffix; the oracle unwraps
  // as/satisfies/parens. Without the unwrap this correct extraction would be
  // reported as a fabrication.
  const src =
    'export const t = defineTool({ id: "as-const-tool" as const, description: "Real.", handler() {} });';
  const tools = extractToolsFromSource(src, "fixture.ts");
  assert.equal(tools.find((t) => t.name === "as-const-tool")?.description, "Real.");
  assert.deepEqual(oracleFromSource(src).tools, [{ name: "as-const-tool", description: "Real." }]);
});

// Cooked-text fidelity

test("full JS escape semantics: \\xNN, \\uNNNN, \\u{...}, identity escapes, line continuations", () => {
  const src = `
    export const t = defineTool({
      id: "escape-suite-tool",
      description: "AB: \\x41 \\u0042 \\u{1F600}|\\v|\\b|\\f| \\qidentity and a \\\ncontinuation",
      handler: async () => {},
    });
  `;
  const tools = extractToolsFromSource(src, "fixture.ts");
  assert.equal(
    tools.find((t) => t.name === "escape-suite-tool")?.description,
    "AB: A B \u{1F600}|\v|\b|\f| qidentity and a continuation"
  );
});

test("template-literal line terminators are cooked: CRLF becomes LF", () => {
  // Per spec, `\r\n` and lone `\r` inside a template literal cook to `\n`.
  // Relevant on a CRLF (autocrlf) checkout, where raw bytes would otherwise
  // leak \r into the scanned text.
  const src =
    'defineTool({ id: "crlf-tool", description: `line one\r\nline two\rline three`, handler() {} });';
  const tools = extractToolsFromSource(src, "fixture.ts");
  assert.equal(
    tools.find((t) => t.name === "crlf-tool")?.description,
    "line one\nline two\nline three"
  );
});

test("$ + escape + { does not fabricate interpolation ($\\d{2} stays captured)", () => {
  // The interpolation probe must not glue `$` to `{` across a removed escape
  // pair: `$\d{2}` renders as the literal "$d{2}" and is NOT interpolation.
  const src =
    'defineTool({ id: "dollar-escape-tool", description: `pattern $\\d{2} end`, handler() {} });';
  const { result: tools, warnings } = captureWarnings(() =>
    extractToolsFromSource(src, "fixture.ts")
  );
  assert.equal(
    tools.find((t) => t.name === "dollar-escape-tool")?.description,
    "pattern $d{2} end"
  );
  assert.deepEqual(warnings, []);
});

test("surrounding whitespace in a description literal is trimmed", () => {
  const src = 'defineTool({ id: "padded-tool", description: "   padded text   ", handler() {} });';
  const tools = extractToolsFromSource(src, "fixture.ts");
  assert.equal(tools.find((t) => t.name === "padded-tool")?.description, "padded text");
});

// Search-scope rules

test(">2000 chars of properties between id: and description: are scanned through", () => {
  // The other axis of the fixed-window class: not the description LENGTH but
  // the id->description search DISTANCE must be unbounded too.
  const filler = Array.from({ length: 60 }, (_, k) => `      prop${k}: "${"x".repeat(40)}",`).join(
    "\n"
  );
  const src = `
    export const t = defineTool({
      id: "far-description-tool",
${filler}
      description: "Found beyond 2000 chars of siblings.",
      handler: async () => {},
    });
  `;
  const tools = extractToolsFromSource(src, "fixture.ts");
  assert.equal(
    tools.find((t) => t.name === "far-description-tool")?.description,
    "Found beyond 2000 chars of siblings."
  );
});

test("a nested description: key between id: and the real description is not matched", () => {
  // The depth anchor must hold: a `description:` inside a nested value (e.g. a
  // schema fragment) is not the tool's description.
  const src = `
    export const t = defineTool({
      id: "outer-tool",
      schema: { description: "inner schema description, not the tool's" },
      description: "The real outer description.",
      handler: async () => {},
    });
  `;
  const tools = extractToolsFromSource(src, "fixture.ts");
  assert.equal(
    tools.find((t) => t.name === "outer-tool")?.description,
    "The real outer description."
  );
  assert.equal(tools.length, 1);
});

test("a plain description written before its id: is skipped loudly and flagged by the oracle", () => {
  // The extractor scans forward from the id, so it cannot capture this shape;
  // it must warn, and the oracle's `misordered` bucket must name it so the
  // real-tree test forces the property order to be fixed.
  const src =
    'defineTool({ description: "Written above the id.", id: "desc-first-tool", handler() {} });';
  const { result: tools, warnings } = captureWarnings(() =>
    extractToolsFromSource(src, "fixture.ts")
  );
  assert.deepEqual(tools, []);
  assert.ok(
    warnings.some((w) => /WARNING/.test(w) && w.includes("desc-first-tool")),
    `expected a stderr WARNING naming desc-first-tool; got: ${JSON.stringify(warnings)}`
  );
  assert.deepEqual(
    oracleFromSource(src).misordered.map((e) => e.id),
    ["desc-first-tool"]
  );
});

// Oracle safety net for member kinds

test("the oracle flags description members it cannot read statically (shorthand, getter, computed, spread)", () => {
  // These shapes are invisible to the lexical extractor; each must land in the
  // nonStatic bucket so the real-tree test turns red instead of the tool
  // silently leaving the scan with CI green.
  for (const [label, src] of [
    ["shorthand", 'defineTool({ id: "sh-tool", description, handler() {} });'],
    ["getter", 'defineTool({ id: "get-tool", get description() { return "x"; }, handler() {} });'],
    ["method", 'defineTool({ id: "m-tool", description() { return "x"; }, handler() {} });'],
    [
      "computed key with non-literal value",
      'defineTool({ id: "computed-tool", ["description"]: makeDesc(), handler() {} });',
    ],
    [
      "spread with no explicit description",
      'defineTool({ id: "spread-tool", ...common, handler() {} });',
    ],
    [
      "spread AFTER a plain description (may override it)",
      'defineTool({ id: "spread2-tool", description: "explicit", ...common, handler() {} });',
    ],
  ]) {
    const oracle = oracleFromSource(src);
    assert.ok(
      oracle.nonStatic.length >= 1,
      `${label}: expected the oracle to flag the shape as non-static`
    );
  }
});

test("a defaults-spread BEFORE the description is fine (it cannot override a later property)", () => {
  // `{ ...commonDefaults, id, description }` is idiomatic; at runtime a
  // preceding spread never overrides a later explicit property, so the tool is
  // fully extractable and must NOT be flagged.
  const src =
    'defineTool({ ...commonDefaults, id: "defaults-tool", description: "Explicit and final.", handler() {} });';
  const tools = extractToolsFromSource(src, "fixture.ts");
  assert.equal(tools.find((t) => t.name === "defaults-tool")?.description, "Explicit and final.");
  const oracle = oracleFromSource(src);
  assert.deepEqual(oracle.nonStatic, [], "a preceding spread must not be flagged");
  assert.deepEqual(oracle.tools, [{ name: "defaults-tool", description: "Explicit and final." }]);
});

test("nested data objects never trigger the policy buckets", () => {
  // An object that is another object's property value is data (a payload,
  // example, defaults fragment), not a tool definition - the policy tests must
  // not demand anything of it, whatever its shape.
  const src = `
    export const host = defineTool({
      id: "host-tool",
      examplePayload: { description: "sample item", id: "item-1" },
      defaults: { id: "default-profile", ...baseProfile },
      description: "Host tool description.",
      handler: async () => {},
    });
  `;
  const oracle = oracleFromSource(src);
  assert.deepEqual(oracle.misordered, [], "a nested example payload must not demand reordering");
  assert.deepEqual(oracle.nonStatic, [], "a nested defaults fragment must not be flagged");
  assert.deepEqual(oracle.tools, [{ name: "host-tool", description: "Host tool description." }]);
  const { result: tools } = captureWarnings(() => extractToolsFromSource(src, "fixture.ts"));
  assert.deepEqual(tools, [{ name: "host-tool", description: "Host tool description." }]);
});

test("a getter or method id beside a description is flagged, never silently green", () => {
  // The lexical extractor can never see a getter/method id, and such an object
  // IS a runtime-real tool - without this flag it would bypass the scan with
  // zero signal on any channel.
  for (const [label, src] of [
    [
      "getter id",
      'defineTool({ get id() { return "getter-id-tool"; }, description: "Real.", handler() {} });',
    ],
    [
      "method id",
      'defineTool({ id() { return "method-id-tool"; }, description: "Real.", handler() {} });',
    ],
  ]) {
    const oracle = oracleFromSource(src);
    assert.equal(oracle.nonStatic.length, 1, `${label}: expected a nonStatic flag`);
  }
});

test("an escaped id literal is cooked to its runtime name on both sides", () => {
  // An id written with an escape (\\u002D is "-") names the tool by its COOKED
  // text at runtime; the scan must see that name, and the oracle and extractor
  // must agree on it.
  const src = 'defineTool({ id: "esc\\u002Dtool", description: "Escaped id.", handler() {} });';
  const tools = extractToolsFromSource(src, "fixture.ts");
  assert.equal(tools.find((t) => t.name === "esc-tool")?.description, "Escaped id.");
  assert.deepEqual(oracleFromSource(src).tools, [{ name: "esc-tool", description: "Escaped id." }]);
});

test("U+2028/U+2029 line continuations cook to nothing, like backslash-newline", () => {
  // Written with `\u2028` / `\u2029` escapes so no raw LS/PS bytes live in
  // this file: the fixture string holds backslash + U+2028 (and + U+2029),
  // each a legal LineTerminatorSequence continuation that cooks to nothing.
  const src =
    'defineTool({ id: "ls-tool", description: "before \\\u2028after \\\u2029end", handler() {} });';
  const tools = extractToolsFromSource(src, "fixture.ts");
  assert.equal(tools.find((t) => t.name === "ls-tool")?.description, "before after end");
  assert.deepEqual(oracleFromSource(src).tools, [
    { name: "ls-tool", description: "before after end" },
  ]);
});

test('a computed ["description"] key with a literal value surfaces as an extractor-vs-oracle mismatch', () => {
  // The oracle can read `["description"]: "x"` (it IS the runtime description)
  // but the lexical extractor cannot see the `description:` token. The oracle
  // must claim the tool so the real-tree equality test goes red and forces a
  // plain key - never a silent green.
  const src =
    'defineTool({ id: "computed-desc-tool", ["description"]: "Real text.", handler() {} });';
  const { result: tools } = captureWarnings(() => extractToolsFromSource(src, "fixture.ts"));
  assert.deepEqual(tools, []);
  assert.deepEqual(oracleFromSource(src).tools, [
    { name: "computed-desc-tool", description: "Real text." },
  ]);
});
