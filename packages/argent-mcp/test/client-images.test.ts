import { describe, it, expect } from "vitest";
import { showsImages } from "../src/client-images.js";

describe("showsImages", () => {
  // The names each client sent in a captured handshake, or names in its shipped source.
  it.each([
    "claude-code",
    "codex-mcp-client",
    "Cursor",
    "cursor-vscode",
    "opencode",
    "gemini-cli-mcp-client",
    "Zed",
    "Visual Studio Code",
    "Visual Studio Code - Insiders",
    "copilot-cli",
    "kiro",
  ])("is true for %s", (name) => {
    expect(showsImages(name)).toBe(true);
  });

  it.each(["Q DEV CLI", "rmcp", "mcp", "some-new-client", "", undefined])(
    "is false for %s",
    (name) => {
      expect(showsImages(name)).toBe(false);
    }
  );
});
