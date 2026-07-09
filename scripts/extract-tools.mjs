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

// Characters after which a `/` starts a regex literal rather than division.
// The standard prefix heuristic: a regex can only follow an operator, an opening
// bracket, a separator, or the start of the input — never an identifier, a
// number, a closing paren/bracket, or a string (where `/` means division).
// Statement-keyword positions (`return /re/`) don't occur between an object's
// properties, so the character class is sufficient here.
const REGEX_PREV_CHARS = new Set("(,=:[!&|?{};+-*%<>~^");

/**
 * If a regex literal starts at src[i] (given the last significant code character
 * before it), return the index just past its closing `/` and flags; otherwise
 * return i (the `/` is division or invalid - treat it as a plain character).
 * Handles `[...]` character classes (where `/` does not terminate) and `\`
 * escapes. A newline before the closing `/` means it was not a regex literal.
 *
 * @param {string} src
 * @param {number} i        index of the opening `/`
 * @param {string | null} prevSig  last significant code char before i, or null
 * @returns {number}
 */
function skipRegexLiteral(src, i, prevSig) {
  if (prevSig !== null && !REGEX_PREV_CHARS.has(prevSig)) return i;
  let inClass = false;
  for (let j = i + 1; j < src.length; j++) {
    const ch = src[j];
    if (ch === "\\") {
      j++;
    } else if (ch === "\n") {
      return i; // regex literals are single-line; this `/` was not one
    } else if (inClass) {
      if (ch === "]") inClass = false;
    } else if (ch === "[") {
      inClass = true;
    } else if (ch === "/") {
      let end = j + 1;
      while (end < src.length && /[a-zA-Z]/.test(src[end])) end++; // flags
      return end;
    }
  }
  return i;
}

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
  let prevSig = null; // last significant code char (regex-vs-division context)
  for (let i = 0; i < afterId.length; i++) {
    const ch = afterId[i];
    if (quote !== null) {
      if (ch === "\\") {
        i++; // skip the escaped character
      } else if (ch === quote) {
        prevSig = ch; // a string value just ended; a following `/` is division
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
    // Skip regex literals whole: a quote inside one (e.g. `z.regex(/["']/)`)
    // must not open a fake string, and a brace (e.g. `match: /[{]/`) must not
    // shift the tracked depth - either would hide the real `description:` and
    // drop the tool from the downstream security scan.
    if (ch === "/") {
      const end = skipRegexLiteral(afterId, i, prevSig);
      if (end > i) {
        i = end - 1; // loop's i++ steps past the regex
        prevSig = ")"; // a value just ended; a following `/` is division
        continue;
      }
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
    if (!/\s/.test(ch)) prevSig = ch;
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
  let prevSig = null; // last significant code char (regex-vs-division context)
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quote !== null) {
      if (ch === "\\")
        i++; // skip the escaped character
      else if (ch === quote) {
        prevSig = ch; // a string value just ended; a following `/` is division
        quote = null;
      }
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
    // Skip regex literals whole: a quote inside one placed BEFORE an `id:`
    // (e.g. `s.replace(/"/g, "")`) would otherwise open a fake string that
    // swallows the id, dropping the tool from the scan without a trace.
    if (ch === "/") {
      const end = skipRegexLiteral(src, i, prevSig);
      if (end > i) {
        i = end - 1; // loop's i++ steps past the regex
        prevSig = ")"; // a value just ended; a following `/` is division
        continue;
      }
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
        prevSig = '"'; // the id literal's closing quote
        continue;
      }
    }
    if (!/\s/.test(ch)) prevSig = ch;
  }
  return out;
}

/**
 * True when nothing extends a captured description literal: after trailing
 * whitespace and comments, the property must end (`,` or `}`). Any other suffix
 * (`+` concatenation, a `.slice(...)`-style method call, `as const`, ...) means
 * the rendered description differs from the captured literal, so the caller
 * must warn-skip instead of emitting wrong text into the security scan.
 *
 * @param {string} rest  source text starting just past the literal's closing delimiter
 * @returns {boolean}
 */
function literalIsWholeValue(rest) {
  for (let i = 0; i < rest.length; i++) {
    const ch = rest[i];
    if (/\s/.test(ch)) continue;
    if (ch === "/" && rest[i + 1] === "/") {
      const nl = rest.indexOf("\n", i + 2);
      if (nl === -1) return false; // line comment to EOF - property never ends
      i = nl;
      continue;
    }
    if (ch === "/" && rest[i + 1] === "*") {
      const end = rest.indexOf("*/", i + 2);
      if (end === -1) return false; // unterminated block comment
      i = end + 1;
      continue;
    }
    return ch === "," || ch === "}";
  }
  return false; // EOF right after the literal - not a well-formed property
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
        // The literal is only the whole description if nothing extends it: after
        // it (and any whitespace/comments) the property must simply end with `,`
        // or `}`. A `+` (concatenation), a `.` (method suffix like
        // `".....".slice(0, 3)`), an `as const`, or any other suffix means the
        // rendered text differs from the captured literal; an unescaped `${...}`
        // in a template means runtime interpolation. Either way, leave
        // description null so it falls through to the loud warn-and-skip below
        // rather than emitting wrong text silently into the security scan.
        const rest = value.slice(valueMatch[0].length);
        const hasInterpolation = delim === "`" && /\$\{/.test(valueMatch[1].replace(/\\./g, ""));
        if (literalIsWholeValue(rest) && !hasInterpolation) {
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
        `extract-tools: WARNING: tool "${id}" in ${filePath} has a description that is not a single string/template literal (a concatenation, an interpolation, a method/operator suffix, or a non-literal value); skipping.`
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

/**
 * Deduplicate tools by name (first occurrence wins). A same-name collision means
 * a later tool's description never reaches the security scan; warn so that drop
 * is loud rather than a silent scan-bypass (tool ids are meant to be unique).
 * Exported so the warning path is unit-testable.
 *
 * @param {{name: string, description: string}[]} tools
 * @returns {{name: string, description: string}[]}
 */
export function dedupeToolsById(tools) {
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

export function extractAllTools() {
  const files = walk(toolsRoot);
  const tools = [];
  for (const f of files) {
    tools.push(...extractFromFile(f));
  }
  return dedupeToolsById(tools);
}

function main() {
  // MCP tools/list format
  console.log(JSON.stringify({ tools: extractAllTools() }, null, 2));
}

// Run only when invoked directly, not when imported by the test.
if (processArgv[1] && import.meta.url === pathToFileURL(processArgv[1]).href) {
  main();
}
