#!/usr/bin/env node
/**
 * Extracts tool id + description from all ToolDefinition objects in
 * packages/tool-server/src/tools/**\/*.ts and outputs MCP tools/list JSON
 * suitable for `spidershield scan . --tools-json <file>`.
 *
 * Must stay dependency-free (node: builtins only): the tool-description-quality
 * workflow runs it on a bare checkout without `npm ci`. The unit suite
 * (extract-tools.test.mjs) independently parses the same tree with the real
 * TypeScript parser and asserts this extractor's output matches it exactly, so
 * any lexing gap on a shape that actually enters the tree fails CI loudly.
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

// Single-character escapes with a non-identity meaning. Everything else
// follows full JS semantics in unescapeJsString: \xNN / \uNNNN / \u{...} decode
// to their code point, a backslash-newline is a line continuation (empty), and
// any other escaped character is an identity escape (the backslash drops).
const UNESCAPE_MAP = { n: "\n", r: "\r", t: "\t", v: "\v", b: "\b", f: "\f", 0: "\0" };

// Sticky matcher for the `description:` key, anchored per candidate position so
// resolving it costs no per-character substring allocation (see findOwnDescriptionValue).
const DESCRIPTION_KEY = /description:\s*/y;

// Sticky matcher for an `id: "..."` string/template literal with a matching
// closing delimiter, anchored at a known code-context position (see
// findIdLiteralsInCode). A template id is only static without interpolation;
// the caller rejects a captured `${`.
const ID_LITERAL = /id:\s*(["'`])([^"'`]+)\1/y;

// Characters after which a `/` starts a regex literal rather than division:
// an operator, an opening bracket, or a separator — never an identifier, a
// number, a closing paren/bracket, or a string (where `/` means division).
// `+`, `-`, and `!` are absent on purpose: isRegexPosition disambiguates them
// (postfix `++`/`--`/non-null `!` vs their prefix forms) before consulting
// this set, so entries for them here could never be reached.
const REGEX_PREV_CHARS = new Set("(,=:[&|?{};*%<>~^");

// Keywords a regex literal can directly follow even though they end in an
// identifier character (`return /["']/` is ordinary code in helper functions
// that share a file with tool definitions).
const REGEX_PREV_KEYWORDS = new Set([
  "return",
  "typeof",
  "case",
  "in",
  "of",
  "delete",
  "void",
  "throw",
  "new",
  "do",
  "else",
  "yield",
  "await",
  "instanceof",
]);

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

// --- Lexical skip helpers ----------------------------------------------------
// One shared set of rules for everything that is NOT code: comments, string and
// template literals (with `${...}` interpolations skipped opaquely), and regex
// literals. Every scanner routes candidate characters through the single
// `skipNonCode` dispatcher below, so the scanners' notion of "code context"
// cannot drift apart.

/** @returns {number} index just past the newline ending a `//` comment */
function skipLineComment(src, i) {
  const nl = src.indexOf("\n", i + 2);
  return nl === -1 ? src.length : nl + 1;
}

/** @returns {number} index just past the `*` + `/` ending a block comment */
function skipBlockComment(src, i) {
  const end = src.indexOf("*/", i + 2);
  return end === -1 ? src.length : end + 2;
}

/** src[i] is `'` or `"`. @returns {number} index just past the closing delimiter */
function skipStringLiteral(src, i) {
  const delim = src[i];
  for (let j = i + 1; j < src.length; j++) {
    if (src[j] === "\\") j++;
    else if (src[j] === delim) return j + 1;
  }
  return src.length;
}

/**
 * src[i] is a backtick. Skips the whole template literal, INCLUDING `${...}`
 * interpolations: the code inside an interpolation is not a tool-definition
 * site, but its strings, nested templates, comments, regexes, and braces must
 * be tracked so the template's real closing backtick is found. Without this, a
 * nested template's opening backtick "closes" the outer one and everything
 * after is mis-lexed (a fake `description:` inside an interpolation could even
 * be emitted as a tool's real description).
 *
 * @returns {number} index just past the closing backtick
 */
function skipTemplateLiteral(src, i) {
  for (let j = i + 1; j < src.length; j++) {
    const ch = src[j];
    if (ch === "\\") j++;
    else if (ch === "$" && src[j + 1] === "{") j = skipInterpolation(src, j + 1) - 1;
    else if (ch === "`") return j + 1;
  }
  return src.length;
}

/**
 * If src[i] starts something that is NOT code — a `//` or `/*` comment, a
 * string or template literal, or a regex literal — skip it whole and return
 * the scan state just past it; return null when src[i] is ordinary code.
 *
 * @param {string} src
 * @param {number} i   index of the candidate character
 * @param {string | null} prevSig  last significant code char, or null
 * @param {number} prevSigIdx      index of prevSig in src (-1 when null)
 * @returns {{ i: number, prevSig: string | null, prevSigIdx: number } | null}
 *   the returned `i` sits ON the last skipped character, ready for the
 *   caller's loop increment; comments leave prevSig untouched (they are
 *   invisible to code context), a skipped literal becomes the new prevSig.
 */
function skipNonCode(src, i, prevSig, prevSigIdx) {
  const ch = src[i];
  if (ch === "/" && src[i + 1] === "/") {
    return { i: skipLineComment(src, i) - 1, prevSig, prevSigIdx };
  }
  if (ch === "/" && src[i + 1] === "*") {
    return { i: skipBlockComment(src, i) - 1, prevSig, prevSigIdx };
  }
  if (ch === "/") {
    const end = skipRegexLiteral(src, i, prevSig, prevSigIdx);
    // a value just ended; a following `/` is division
    if (end > i) return { i: end - 1, prevSig: ")", prevSigIdx: end - 1 };
    return null;
  }
  if (ch === '"' || ch === "'") {
    const end = skipStringLiteral(src, i) - 1;
    return { i: end, prevSig: ch, prevSigIdx: end };
  }
  if (ch === "`") {
    const end = skipTemplateLiteral(src, i) - 1;
    return { i: end, prevSig: "`", prevSigIdx: end };
  }
  return null;
}

/** src[i] is the `{` of a `${`. @returns {number} index just past the matching `}` */
function skipInterpolation(src, i) {
  let depth = 1;
  let prevSig = null;
  let prevSigIdx = -1;
  for (let j = i + 1; j < src.length; j++) {
    const ch = src[j];
    const skipped = skipNonCode(src, j, prevSig, prevSigIdx);
    if (skipped) {
      ({ i: j, prevSig, prevSigIdx } = skipped);
      continue;
    }
    if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      if (--depth === 0) return j + 1;
    }
    if (!/\s/.test(ch)) {
      prevSig = ch;
      prevSigIdx = j;
    }
  }
  return src.length;
}

/**
 * True when a `/` may start a regex literal here: after an operator/separator
 * character, after a regex-permitting keyword (`return`, `typeof`, ...), or at
 * the start of the input. After an identifier, number, closing paren/bracket,
 * or string, `/` is division.
 *
 * @param {string} src
 * @param {string | null} prevSig  last significant code char, or null
 * @param {number} prevSigIdx      index of prevSig in src (-1 when null)
 */
function isRegexPosition(src, prevSig, prevSigIdx) {
  if (prevSig === null) return true;
  if (prevSig === "+" || prevSig === "-") {
    // Postfix `++`/`--` ends a value, so a following `/` is division; a lone
    // `+`/`-` is a binary/unary operator, after which `/` starts a regex.
    return src[prevSigIdx - 1] !== prevSig;
  }
  if (prevSig === "!") {
    // `!` is either a prefix logical-NOT (`!/re/.test(x)` - a regex follows) or a
    // TS postfix non-null assertion (`x!` - division follows). A prefix `!` sits
    // where a value is expected and leaves that context unchanged; a postfix `!`
    // follows a value and inherits its context. Either way, whether a `/` here is
    // a regex equals whether a `/` would be a regex at the position just before
    // the `!` - so recurse on the significant char preceding it. This keeps
    // `return !/re/` / `= !/re/` (regex) apart from `x! / y` / `foo()! / y`
    // (division), including keyword-preceded and chained-`!` forms.
    // (`!=`/`!==` never reach here: their `=` is the last significant char.)
    let before = prevSigIdx - 1;
    while (before >= 0 && /\s/.test(src[before])) before--;
    return isRegexPosition(src, before < 0 ? null : src[before], before);
  }
  if (REGEX_PREV_CHARS.has(prevSig)) return true;
  if (/[A-Za-z0-9_$]/.test(prevSig)) {
    let start = prevSigIdx;
    while (start > 0 && /[A-Za-z0-9_$]/.test(src[start - 1])) start--;
    if (!REGEX_PREV_KEYWORDS.has(src.slice(start, prevSigIdx + 1))) return false;
    // A keyword-NAMED property access (`counts.in`, `obj?.new`) is a value,
    // not a keyword: the `/` after it is division.
    let before = start - 1;
    while (before >= 0 && /\s/.test(src[before])) before--;
    return src[before] !== ".";
  }
  return false;
}

/**
 * If a regex literal starts at src[i] (given the last significant code
 * character before it), return the index just past its closing `/` and flags;
 * otherwise return i (the `/` is division or invalid - treat it as a plain
 * character). Handles `[...]` character classes (where `/` does not terminate)
 * and `\` escapes. A newline before the closing `/` means it was not a regex
 * literal.
 *
 * @param {string} src
 * @param {number} i        index of the opening `/`
 * @param {string | null} prevSig  last significant code char before i, or null
 * @param {number} prevSigIdx      index of prevSig in src (-1 when null)
 * @returns {number}
 */
function skipRegexLiteral(src, i, prevSig, prevSigIdx) {
  if (!isRegexPosition(src, prevSig, prevSigIdx)) return i;
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

/**
 * Render a captured string/template-literal body as its runtime (cooked) text,
 * following JS escape semantics: named escapes (\n, \t, ...), \xNN, \uNNNN,
 * \u{...}, line continuations (backslash-newline vanish), and identity escapes
 * (the backslash drops). An out-of-range \u{...} is left as source text - such
 * a file would not compile anyway.
 *
 * @param {string} raw
 * @returns {string}
 */
function unescapeJsString(raw) {
  return raw.replace(
    /\\(?:u\{([0-9A-Fa-f]+)\}|u([0-9A-Fa-f]{4})|x([0-9A-Fa-f]{2})|(\r\n|[\s\S]))/g,
    (whole, uBrace, u4, x2, single) => {
      if (uBrace !== undefined) {
        const cp = parseInt(uBrace, 16);
        return cp <= 0x10ffff ? String.fromCodePoint(cp) : whole;
      }
      if (u4 !== undefined) return String.fromCharCode(parseInt(u4, 16));
      if (x2 !== undefined) return String.fromCharCode(parseInt(x2, 16));
      // Line continuations: backslash + any LineTerminatorSequence (LF, CRLF,
      // CR, U+2028, U+2029) vanishes.
      if (single === "\r\n" || /^[\n\r\u2028\u2029]$/.test(single)) return "";
      return UNESCAPE_MAP[single] ?? single;
    }
  );
}

/**
 * From the source that immediately follows a tool's `id: "..."`, return the text
 * of that tool's own `description:` value (starting at its opening delimiter), or
 * null when the `id:` has no sibling `description:`.
 *
 * Scans forward tracking object-literal brace depth, with comments, string and
 * template literals (interpolations included), and regex literals skipped whole
 * so nothing inside them can open a fake string, shift the depth, or match as a
 * `description:` token:
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
  let prevSig = null; // last significant code char (regex-vs-division context)
  let prevSigIdx = -1;
  for (let i = 0; i < afterId.length; i++) {
    const ch = afterId[i];
    const skipped = skipNonCode(afterId, i, prevSig, prevSigIdx);
    if (skipped) {
      ({ i, prevSig, prevSigIdx } = skipped);
      continue;
    }
    if (ch === "{") {
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
    if (!/\s/.test(ch)) {
      prevSig = ch;
      prevSigIdx = i;
    }
  }
  return null;
}

/**
 * Find every static `id:` string/template literal that occurs in CODE - never
 * one inside a string, template literal (interpolations included), comment, or
 * regex literal.
 *
 * A raw global regex over the source matched `id:` tokens anywhere, so an `id:`
 * appearing in a comment (e.g. a `// see id: "screenshot"` cross-reference) or in
 * another tool's description text became a tool candidate. `findOwnDescriptionValue`
 * then read the enclosing object's real `description:` and, via first-wins dedup,
 * that spurious entry could silently overwrite a real tool's description in the
 * downstream security scan. Lexing to code context first removes that whole class,
 * and also skips non-id keys like `$id:` (the `$` fails the word-boundary check).
 *
 * A template-literal id (`` id: `x` ``) counts only without `${...}`
 * interpolation; an interpolated id is dynamic, like a const-reference id, and
 * is out of scope for this static extractor.
 *
 * @param {string} src
 * @returns {{ id: string, end: number }[]}  end = index just past the matched literal
 */
function findIdLiteralsInCode(src) {
  const out = [];
  let prevSig = null; // last significant code char (regex-vs-division context)
  let prevSigIdx = -1;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    const skipped = skipNonCode(src, i, prevSig, prevSigIdx);
    if (skipped) {
      ({ i, prevSig, prevSigIdx } = skipped);
      continue;
    }
    // A code-context `id:` token. The word-boundary check before it means
    // `grid:`, `$id:`, `androidId:`, etc. are not mistaken for a tool id.
    if (ch === "i" && !/[A-Za-z0-9_$]/.test(src[i - 1] ?? "")) {
      ID_LITERAL.lastIndex = i;
      const m = ID_LITERAL.exec(src);
      if (m) {
        // A template id containing `${` is interpolated - dynamic, not a static
        // tool id (same class as a const-reference id; out of scope by design).
        if (!(m[1] === "`" && m[2].includes("${"))) {
          // Cook the id like any literal - an id written "esc\u002Dtool"
          // names the tool "esc-tool" at runtime, and the scan must see the
          // runtime name.
          out.push({ id: unescapeJsString(m[2]), end: ID_LITERAL.lastIndex });
        }
        i = ID_LITERAL.lastIndex - 1; // resume just past the value (loop's i++ advances)
        prevSig = m[1]; // the id literal's closing delimiter
        prevSigIdx = i;
        continue;
      }
    }
    if (!/\s/.test(ch)) {
      prevSig = ch;
      prevSigIdx = i;
    }
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
      // Match the whole literal to its true closing delimiter. `\\[\s\S]`
      // (not `\\.`) lets an escaped line terminator - a line continuation -
      // stay part of one legal literal.
      const valueMatch =
        delim === "`"
          ? value.match(/^`((?:\\[\s\S]|[^`\\])*)`/)
          : delim === '"'
            ? value.match(/^"((?:[^"\\]|\\[\s\S])*)"/)
            : delim === "'"
              ? value.match(/^'((?:[^'\\]|\\[\s\S])*)'/)
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
        // The interpolation probe replaces escape pairs with a placeholder
        // (never deletes them) so `$` + escape + `{` cannot glue into a fake
        // `${`, and an escaped `\${` or `$\{` stays the literal text it renders as.
        const rest = value.slice(valueMatch[0].length);
        const hasInterpolation =
          delim === "`" && /\$\{/.test(valueMatch[1].replace(/\\[\s\S]/g, " "));
        if (literalIsWholeValue(rest) && !hasInterpolation) {
          // Render the runtime (cooked) text: template literals first normalize
          // line terminators (`\r\n` / `\r` cook to `\n` per spec - relevant on
          // a CRLF checkout), then JS escape semantics apply.
          const text = delim === "`" ? valueMatch[1].replace(/\r\n?/g, "\n") : valueMatch[1];
          description = unescapeJsString(text).trim();
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
      // `description?` is optional in ToolDefinition) also lands here - as does
      // one whose `description:` is written BEFORE its `id:` (this scan is
      // forward-only) - and would be silently omitted from the downstream
      // security scan. The cases aren't locally distinguishable, so warn on
      // stderr (stdout stays valid JSON) to make a real drop loud instead of
      // only a cryptic count mismatch in CI.
      console.error(
        `extract-tools: WARNING: id "${id}" in ${filePath} has no sibling description at its object scope; skipping (nested object key, a tool missing its description, or a description written before the id).`
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

function extractAllTools() {
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
