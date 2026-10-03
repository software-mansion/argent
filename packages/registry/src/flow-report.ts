/**
 * How a flow report prints device text it may cut. The tool-server quotes an
 * element's own text in a step's hint, and the CLI and the MCP client print
 * the text a step found on its `actual:` line. Both cut here, so a hint that
 * quotes device text reads the way the `actual:` line beside it does.
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
