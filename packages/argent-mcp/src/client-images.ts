import type { ScreenshotForm } from "./content.js";

/**
 * Per-client screenshot forms. Defaults and the full agent matrix: CLIENTS.md.
 *
 * The MCP `clientInfo.name` of the clients whose model gets an image block from a tool result:
 * Claude Code, Codex, cursor-agent (`Cursor`) and Cursor IDE (`cursor-vscode`), opencode,
 * Gemini CLI, Zed, VS Code (`Visual Studio Code`, and `copilot-cli` for its agent host), Kiro
 * IDE and Kiro CLI's v3 engine (`kiro`). A model without image input gets the client's
 * placeholder instead, and the client's file-read tool refuses a PNG for it as well. Either way
 * the `Saved: <path>` line after an auto-screenshot tells the model nothing new.
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
 * Kiro CLI's v1 and v2 engines (`Q DEV CLI`; v2 is the default) send the whole tool result to
 * the model as one JSON document. A screenshot arrives as about 80,000 tokens of base64 text
 * that no model can see, while the CLI's own file-read tool sends a PNG as an image.
 */
const IMAGES_AS_TEXT = [/^q dev cli\b/];

/** Every other client, an unnamed one included, keeps the image and the path (the default). */
function matches(patterns: RegExp[], clientName: string | undefined): boolean {
  const name = clientName?.trim().toLowerCase() ?? "";
  return patterns.some((pattern) => pattern.test(name));
}

/**
 * Form for a screenshot the agent asked for (the `screenshot` tool).
 * Default: `image-and-path`. Only `IMAGES_AS_TEXT` clients get `path`. Never returns `image`.
 */
export function screenshotForm(clientName: string | undefined): ScreenshotForm {
  return matches(IMAGES_AS_TEXT, clientName) ? "path" : "image-and-path";
}

/**
 * Form for the screenshot Argent appends after an interaction.
 * Default: same as `screenshotForm` (`image-and-path`). `SHOWS_IMAGES` clients get `image`.
 */
export function autoScreenshotForm(clientName: string | undefined): ScreenshotForm {
  if (matches(SHOWS_IMAGES, clientName)) return "image";
  return screenshotForm(clientName);
}
