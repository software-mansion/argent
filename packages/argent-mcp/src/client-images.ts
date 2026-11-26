/**
 * The MCP `clientInfo.name` of the clients that pass an image block to their model: Claude
 * Code, Codex, cursor-agent (`Cursor`) and Cursor IDE (`cursor-vscode`), opencode, Gemini
 * CLI, Zed, VS Code (`Visual Studio Code`, and `copilot-cli` for its agent host), Kiro IDE
 * and Kiro CLI's v3 engine (`kiro`). A model without image input gets the client's
 * placeholder instead, and the client's file-read tool refuses a PNG for it too.
 *
 * Every other client keeps the path, an unknown one included. Kiro CLI's v1 and v2 engines
 * (`Q DEV CLI`) send the image to the model as base64 text, so the path is all it can use.
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
 * auto-screenshot needs no `Saved:` path. A `screenshot` call keeps it: skills pass that
 * path on to `screenshot-diff` and argent-lens.
 */
export function showsImages(clientName: string | undefined): boolean {
  const name = clientName?.trim().toLowerCase() ?? "";
  return SHOWS_IMAGES.some((pattern) => pattern.test(name));
}
