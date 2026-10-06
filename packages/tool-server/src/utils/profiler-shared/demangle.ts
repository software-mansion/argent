/**
 * Best-effort demangler for Itanium C++ ABI symbols in Perfetto/perf stacks.
 * Not a full demangler: it handles nested-names and plain function names (with
 * the argument list dropped), and returns anything else — templates,
 * substitutions, special names, kernel C symbols — unchanged rather than risk
 * a wrong name.
 */

/** Trailing LLVM/GCC-internal suffixes (`.llvm.123`, `.cold`, …); noise to a reader. */
const INTERNAL_SUFFIX =
  /\.(?:__uniq\.[0-9]+(?:\.[0-9a-f]+)?|llvm\.[0-9]+|part\.[0-9]+|cold(?:\.[0-9]+)?|constprop\.[0-9]+|isra\.[0-9]+)$/;

function stripInternalSuffix(s: string): string {
  let out = s;
  // Suffixes can chain (`.part.0.cold`); strip until stable.
  for (let guard = 0; guard < 8; guard++) {
    const next = out.replace(INTERNAL_SUFFIX, "");
    if (next === out) break;
    out = next;
  }
  return out;
}

interface Cursor {
  s: string;
  i: number;
}

/** Read a `<decimal-length><identifier>` source-name; null if malformed. */
function readSourceName(c: Cursor): string | null {
  let len = 0;
  let digits = 0;
  while (c.i < c.s.length && c.s[c.i]! >= "0" && c.s[c.i]! <= "9") {
    len = len * 10 + (c.s.charCodeAt(c.i) - 48);
    c.i++;
    digits++;
  }
  if (digits === 0) return null;
  const start = c.i;
  const end = start + len;
  if (end > c.s.length) return null;
  c.i = end;
  return c.s.slice(start, end);
}

/** Parse a nested-name (`N` already consumed) up to the closing `E`. */
function readNestedName(c: Cursor): string | null {
  // CV / ref qualifiers that can precede the components.
  while (c.i < c.s.length && "rVKO".includes(c.s[c.i]!)) c.i++;
  const parts: string[] = [];
  while (c.i < c.s.length && c.s[c.i] !== "E") {
    if (c.s.startsWith("St", c.i)) {
      parts.push("std");
      c.i += 2;
      continue;
    }
    const name = readSourceName(c);
    // A non-source-name component (`I`, `S`, `C`/`D`, operator, …) — bail rather than guess.
    if (name === null) return null;
    parts.push(name);
  }
  if (c.s[c.i] !== "E") return null;
  return parts.join("::");
}

/** Demangle a single symbol, or return `name` verbatim if it cannot be parsed. */
export function demangleSymbol(name: string): string {
  if (!name) return name;
  const stripped = stripInternalSuffix(name);
  if (!stripped.startsWith("_Z")) {
    // Not mangled: return the original, suffix and all — here the "suffix" may be
    // part of the real name.
    return name;
  }
  const c: Cursor = { s: stripped, i: 2 };
  if (c.s[c.i] === "L") c.i++; // internal-linkage marker
  let parsed: string | null;
  if (c.s[c.i] === "N") {
    c.i++;
    parsed = readNestedName(c);
  } else {
    parsed = readSourceName(c);
  }
  if (!parsed) return name;
  return parsed;
}

/**
 * Demangle every frame of a ` <- `-joined callstack, the format produced by
 * function-callers.sql / hang-main-thread-samples.sql.
 */
export function demangleCallstackText(text: string): string {
  return text
    .split(" <- ")
    .map((frame) => demangleSymbol(frame.trim()))
    .join(" <- ");
}
