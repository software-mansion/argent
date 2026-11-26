/**
 * The MCP `clientInfo.name` of the clients that pass an image block to their model: Claude
 * Code, Codex, cursor-agent (`Cursor`) and Cursor IDE (`cursor-vscode`), opencode, Gemini
 * CLI, Zed, VS Code (`Visual Studio Code`, and `copilot-cli` for its agent host), Kiro IDE
 * and Kiro CLI's v3 engine (`kiro`). On a model without image input, the client's
 * file-read tool refuses the PNG too, so the path is no use there either.
 *
 * Kiro CLI v1/v2 (`Q DEV CLI`) is left out: it sends the image as base64 text, so the path
 * is all its model can use.
 */
const SHOWS_IMAGES = [
  /^claude-code\b/,
  /^codex-mcp-client\b/,
  /^cursor\b/,
  /^opencode\b/,
  /^gemini-cli-mcp-client\b/,
  /^zed\b/,
  /^visual studio code\b/,
  /^copilot-cli\b/,
  /^kiro\b/,
];

/**
 * True when the client named in the MCP handshake passes image blocks to its model, so an
 * auto-screenshot needs no `Saved:` path. A `screenshot` call keeps the path: skills pass
 * it to `screenshot-diff` and argent-lens.
 */
export function showsImages(clientName: string | undefined): boolean {
  const name = clientName?.trim().toLowerCase() ?? "";
  return SHOWS_IMAGES.some((pattern) => pattern.test(name));
}
