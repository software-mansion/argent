import { describe, it, expect } from "vitest";
import { autoScreenshotForm, screenshotForm } from "../src/client-images.js";

describe("screenshot form per MCP client", () => {
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
    "  Claude-Code  ",
  ])("drops the Saved line after an auto-screenshot for %s", (name) => {
    expect(autoScreenshotForm(name)).toBe("image");
    expect(screenshotForm(name)).toBe("image-and-path");
  });

  it.each(["Q DEV CLI", "q dev cli"])("sends %s the path instead of the image", (name) => {
    expect(autoScreenshotForm(name)).toBe("path");
    expect(screenshotForm(name)).toBe("path");
  });

  it.each([undefined, "", "mcp", "rmcp", "claude-codex", "kirox", "my-cursor"])(
    "keeps the image and the path for %j",
    (name) => {
      expect(autoScreenshotForm(name)).toBe("image-and-path");
      expect(screenshotForm(name)).toBe("image-and-path");
    }
  );
});
