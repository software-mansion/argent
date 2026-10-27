/**
 * How a flow report prints device text. The CLI prints the text a step found
 * on its `actual:` line, cut here. The MCP client prints the whole found text,
 * as its result holds no report. The CLI, the MCP client and the recorder's
 * re-probe warning escape invisible characters here, so a found text never
 * prints as the twin of the text it was compared with.
 */

const MAX_PRINTED_CHARS = 300;

/**
 * `text` passed through `print`, cut to its first 300 characters. The count of
 * the rest follows outside what `print` returns, so the cut never reads as
 * device text. Counted in code points, so the cut never splits a surrogate
 * pair.
 */
export function printCapped(text: string, print: (text: string) => string): string {
  const chars = Array.from(text);
  if (chars.length <= MAX_PRINTED_CHARS) return print(text);
  const rest = (chars.length - MAX_PRINTED_CHARS).toLocaleString("en-US");
  return `${print(chars.slice(0, MAX_PRINTED_CHARS).join(""))} … (${rest} more characters)`;
}

/**
 * Characters that print as nothing, or as a plain space: control characters
 * (C0, DEL, C1), format characters (zero-width, bidi), line and paragraph
 * separators, and each space that is not U+0020 (for example NBSP, or the
 * U+202F in iOS's `10:30 AM`). A value that differs from another only by one of
 * these must not print as its twin.
 */
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]|(?! )\p{Zs}/gu;

/**
 * Escape only the invisible characters of a value, each in its JSON spelling
 * (`\n`, `\t`, `\u0007`, `\u00a0`). Everything else — a backslash above all —
 * stays as it is.
 *
 * U+0008 is the exception: it is spelled `\u0008`, not JSON's `\b`. Between the
 * slashes of a pattern, `\b` reads as a word boundary, so a pattern that holds
 * a backspace would print as the pattern with word boundaries.
 */
export function escapeInvisible(v: string): string {
  return v.replace(INVISIBLE, (c) => {
    const json = JSON.stringify(c).slice(1, -1);
    if (json !== c && c !== "\u0008") return json;
    let escaped = "";
    for (let i = 0; i < c.length; i++) {
      escaped += `\\u${c.charCodeAt(i).toString(16).padStart(4, "0")}`;
    }
    return escaped;
  });
}
