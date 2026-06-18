/**
 * Best-effort demangler for native (Itanium C++ ABI) symbol names that appear
 * in Perfetto/perf stacks. Perf stores frame names mangled, so a drill-down
 * stack reads like `_ZN16GrDrawingManager5flushE6SkSpan...` — accurate but hard
 * to read. We turn the common forms into `GrDrawingManager::flush` while
 * staying conservative: anything we cannot confidently parse is returned
 * unchanged, so we never corrupt a name (kernel C symbols, JIT frames, template
 * soup all pass through verbatim).
 *
 * This deliberately handles only the subset that dominates real stacks
 * (nested-names and plain function names, with the argument list dropped). It
 * is NOT a full Itanium demangler — substitutions, templates, and special
 * names bail out to the raw string rather than risk a wrong answer.
 */

/**
 * Trailing compiler-internal suffixes hung off a symbol by LLVM/GCC, e.g.
 * `...trampolinePv.__uniq.2640...290.c303f2d2` or `.llvm.123` or `.cold`.
 * They carry no user-facing meaning and bloat the stack lines.
 */
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

/** Read a `<decimal-length><identifier>` source-name. Returns null if malformed. */
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
    // A non-source-name component (template `I`, substitution `S`, operator,
    // ctor/dtor `C`/`D`, …) — bail rather than guess.
    if (name === null) return null;
    parts.push(name);
  }
  if (c.s[c.i] !== "E") return null;
  return parts.join("::");
}

/**
 * Demangle a single symbol. Returns the readable name, or the original string
 * (sans internal suffix when it was clearly one) if it is not a mangled name we
 * understand.
 */
export function demangleSymbol(name: string): string {
  if (!name) return name;
  const stripped = stripInternalSuffix(name);
  if (!stripped.startsWith("_Z")) {
    // Plain C / kernel symbol — return as-is (keep the original, suffix and all,
    // since for non-mangled names the "suffix" may be meaningful).
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
  if (!parsed) return name; // couldn't parse confidently — leave it raw
  return parsed;
}

/**
 * Demangle every frame in a ` <- `-joined callstack string (the format produced
 * by function-callers.sql / hang-main-thread-samples.sql). Separator and order
 * are preserved.
 */
export function demangleCallstackText(text: string): string {
  return text
    .split(" <- ")
    .map((frame) => demangleSymbol(frame.trim()))
    .join(" <- ");
}
