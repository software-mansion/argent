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

// Standard JS string/template-literal escapes this extractor unescapes when
// rendering a captured description. Anything not listed here (e.g. \x41,
// é) is left as-is rather than guessed at.
const UNESCAPE_MAP = { n: "\n", r: "\r", t: "\t", 0: "\0" };

// Sticky matcher for the `description:` key, anchored per candidate position so
// resolving it costs no per-character substring allocation (see findOwnDescriptionValue).
const DESCRIPTION_KEY = /description:\s*/y;

// Sticky matcher for an `id: "..."` string literal, anchored at a known
// code-context position (see findIdLiteralsInCode).
const ID_LITERAL = /id:\s*["']([^"']+)["']/y;

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
 * From the source that immediately follows a tool's `id: "..."`, return the text
 * of that tool's own `description:` value (starting at its opening delimiter), or
 * null when the `id:` has no sibling `description:`.
 *
 * Scans forward tracking object-literal brace depth, ignoring braces and the
 * `description:` token whenever they occur inside a string / template literal:
 *   - the first `description:` seen at depth 0 (a sibling of the `id:`) is the
 *     tool's own description; a balanced nested object between the two (e.g.
 *     `capability: { apple: { simulator: true } }`, which 7 real tools already
 *     have) does not hide it, and
 *   - if a `}` drops the depth below 0 first, the `id:`'s enclosing object closed
 *     before any sibling `description:` - the `id:` is a key nested inside another
 *     object (e.g. `defaultPayload: { id: "example" }`), not a tool definition.
 *
 * This is what stops a nested `id:` key from either being emitted as a spurious
 * tool or silently dropping the real tool from the downstream `spidershield`
 * security scan.
 *
 * @param {string} afterId  source text starting just after the `id: "..."` match
 * @returns {string | null}
 */
function findOwnDescriptionValue(afterId) {
  let depth = 0;
  let quote = null; // active string/template delimiter, or null when in code
  for (let i = 0; i < afterId.length; i++) {
    const ch = afterId[i];
    if (quote !== null) {
      if (ch === "\\") {
        i++; // skip the escaped character
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    // Skip comments so an apostrophe (e.g. `// don't`), a brace, or a stray
    // `description:` token inside a comment between the `id:` and the real
    // `description:` can't open a fake string / shift the depth / match early.
    if (ch === "/" && afterId[i + 1] === "/") {
      const nl = afterId.indexOf("\n", i + 2);
      if (nl === -1) return null; // line comment runs to EOF; no description follows
      i = nl; // loop's i++ steps past the newline
      continue;
    }
    if (ch === "/" && afterId[i + 1] === "*") {
      const end = afterId.indexOf("*/", i + 2);
      if (end === -1) return null; // unterminated block comment; nothing parseable after
      i = end + 1; // land on the '/'; loop's i++ steps past it
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      if (--depth < 0) return null; // id's own object closed - not a tool
    } else if (
      depth === 0 &&
      ch === "d" &&
      // word boundary before the token so `...Xdescription:` doesn't match
      !/[A-Za-z0-9_$]/.test(afterId[i - 1] ?? "")
    ) {
      DESCRIPTION_KEY.lastIndex = i;
      if (DESCRIPTION_KEY.test(afterId)) return afterId.slice(DESCRIPTION_KEY.lastIndex);
    }
  }
  return null;
}

/**
 * Find every `id: "..."` string literal that occurs in CODE - never one inside a
 * string, template literal, or comment.
 *
 * A raw global regex over the source matched `id:` tokens anywhere, so an `id:`
 * appearing in a comment (e.g. a `// see id: "screenshot"` cross-reference) or in
 * another tool's description text became a tool candidate. `findOwnDescriptionValue`
 * then read the enclosing object's real `description:` and, via first-wins dedup,
 * that spurious entry could silently overwrite a real tool's description in the
 * downstream security scan. Lexing to code context first removes that whole class,
 * and also skips non-id keys like `$id:` (the `$` fails the word-boundary check).
 *
 * @param {string} src
 * @returns {{ id: string, end: number }[]}  end = index just past the matched literal
 */
function findIdLiteralsInCode(src) {
  const out = [];
  let quote = null; // active string/template delimiter, or null when in code
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quote !== null) {
      if (ch === "\\")
        i++; // skip the escaped character
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "/" && src[i + 1] === "/") {
      const nl = src.indexOf("\n", i + 2);
      if (nl === -1) break; // line comment runs to EOF
      i = nl;
      continue;
    }
    if (ch === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      if (end === -1) break; // unterminated block comment
      i = end + 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    // A code-context `id:` token. The word-boundary check before it means
    // `grid:`, `$id:`, `androidId:`, etc. are not mistaken for a tool id.
    if (ch === "i" && !/[A-Za-z0-9_$]/.test(src[i - 1] ?? "")) {
      ID_LITERAL.lastIndex = i;
      const m = ID_LITERAL.exec(src);
      if (m) {
        out.push({ id: m[1], end: ID_LITERAL.lastIndex });
        i = ID_LITERAL.lastIndex - 1; // resume just past the value (loop's i++ advances)
      }
    }
  }
  return out;
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

  for (const { id, end } of findIdLiteralsInCode(src)) {
    // Resolve this tool's own `description:` at the SAME object level as its
    // `id:` (see findOwnDescriptionValue). Matching by brace scope - rather than
    // grabbing the nearest `description:` by raw position - means:
    //   - an `id:`/`description:` token inside a nested value or inside the
    //     description text (e.g. a `{ id: "menu-item" }` example) can neither
    //     borrow a description nor drop the real tool, and
    //   - the value is parsed to its actual closing delimiter, so long multi-line
    //     template literals are captured in full.
    // A null result means this `id:` is a nested object key, not a tool.
    const value = findOwnDescriptionValue(src.slice(end));

    let description = null;
    if (value !== null) {
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
        // The literal is only the whole description if nothing extends it. A
        // trailing `+` (string concatenation) or an unescaped `${...}` in a
        // template (runtime interpolation) means the rendered text isn't the
        // captured literal alone - leave description null so it falls through to
        // the loud warn-and-skip below rather than emitting a truncated string
        // silently into the security scan.
        const rest = value.slice(valueMatch[0].length).replace(/^\s+/, "");
        const isConcatenation = rest.startsWith("+");
        const hasInterpolation = delim === "`" && /\$\{/.test(valueMatch[1].replace(/\\./g, ""));
        if (!isConcatenation && !hasInterpolation) {
          // Unescape the standard JS escapes so the description reads as the
          // rendered string, not the source form — e.g. a template literal's
          // literal "\n" must become an actual newline, not survive as a stray
          // backslash-n in the extracted (and downstream security-scanned) text.
          description = valueMatch[1]
            .replace(/\\([`$\\'"nrt0])/g, (_m, ch) => UNESCAPE_MAP[ch] ?? ch)
            .trim();
        }
      }
    }

    if (description !== null) {
      tools.push({
        name: id,
        description,
      });
    } else if (value !== null) {
      // A real tool: its `description:` was found at the right scope but the
      // value is not a single string/template literal (a concatenation, a
      // template with `${...}` interpolation, or a non-literal like a const
      // reference), so its rendered text can't be captured statically. Don't
      // drop it silently (that class of bug hid run-sequence from the scanner) -
      // warn on stderr so the failure is visible, while keeping stdout valid
      // JSON for the downstream `spidershield scan --tools-json` consumer.
      console.error(
        `extract-tools: WARNING: tool "${id}" in ${filePath} has a description that is not a single string/template literal (concatenation, interpolation, or a non-literal value); skipping.`
      );
    } else {
      // value === null: no sibling `description:` was found before this id's
      // enclosing object closed. Usually the `id:` is a nested object key (e.g.
      // `defaultPayload: { id: "example" }`), correctly not a tool. But a real
      // top-level tool with a missing/empty `description` (type-legal:
      // `description?` is optional in ToolDefinition) also lands here and would
      // be silently omitted from the downstream security scan. The two aren't
      // locally distinguishable, so warn on stderr (stdout stays valid JSON) to
      // make a real drop loud instead of only a cryptic count mismatch in CI.
      console.error(
        `extract-tools: WARNING: id "${id}" in ${filePath} has no sibling description at its object scope; skipping (nested object key, or a tool missing its description).`
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

  // Deduplicate by name (take first occurrence). A same-name collision means a
  // later tool's description never reaches the security scan; warn so that drop
  // is loud rather than a silent scan-bypass (tool ids are meant to be unique).
  const seen = new Set();
  return tools.filter((t) => {
    if (seen.has(t.name)) {
      console.error(
        `extract-tools: WARNING: duplicate tool id "${t.name}"; keeping the first occurrence and skipping the rest.`
      );
      return false;
    }
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
