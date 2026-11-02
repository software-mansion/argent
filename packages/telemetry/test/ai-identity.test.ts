import { describe, expect, it } from "vitest";
import { canonicalizeAiClient } from "../src/ai-identity.js";

describe("canonicalizeAiClient", () => {
  describe("runtime MCP clientInfo.name (verified from each tool's source)", () => {
    const RUNTIME_NAMES: Array<[string, string]> = [
      ["codex-mcp-client", "codex"],
      ["claude-code", "claude_code"],
      ["cursor-vscode", "cursor"],
      ["gemini-cli-mcp-client", "gemini"],
      ["gemini-cli-mcp-client-myserver", "gemini"], // older suffixed form
      ["Visual Studio Code", "vscode"],
      ["Visual Studio Code - Insiders", "vscode"],
      ["Code - OSS", "vscode"],
      ["windsurf", "windsurf"],
      ["Zed", "zed"],
      ["opencode", "opencode"],
      ["github-copilot-developer", "copilot"], // observed in real Copilot MCP logs
    ];

    it.each(RUNTIME_NAMES)("maps %s → %s", (name, slug) => {
      expect(canonicalizeAiClient(name)).toBe(slug);
    });

    it("does not mistake Codex's server-mode identity for the client", () => {
      // We are always the server; we only ever receive `codex-mcp-client`. The
      // server-mode string must not be matched by the client patterns.
      expect(canonicalizeAiClient("codex-mcp-server")).toBeUndefined();
    });
  });

  describe("Devin Desktop (renamed Windsurf)", () => {
    // Its bundled Devin agent sends rmcp's default clientInfo.name; the extension
    // host's WINDSURF_IDE_TYPE is the only thing that marks it as Windsurf.
    it("maps rmcp → windsurf when spawned by Devin Desktop", () => {
      expect(canonicalizeAiClient("rmcp", { WINDSURF_IDE_TYPE: "windsurf" })).toBe("windsurf");
    });

    it("leaves rmcp without the Devin Desktop env unmapped (standalone Devin CLI)", () => {
      expect(canonicalizeAiClient("rmcp")).toBeUndefined();
      expect(canonicalizeAiClient("rmcp", {})).toBeUndefined();
    });

    it("never lets the Windsurf env override a recognized client name", () => {
      expect(canonicalizeAiClient("claude-code", { WINDSURF_IDE_TYPE: "windsurf" })).toBe(
        "claude_code"
      );
    });
  });

  it("returns undefined for unrecognized clients (caller decides on `other`)", () => {
    // `other` is a caller decision (raw clientInfo.name we couldn't map), not a
    // value canonicalize should ever produce from an unknown string.
    expect(canonicalizeAiClient("other")).toBeUndefined();
    expect(canonicalizeAiClient("some-unknown-mcp-client")).toBeUndefined();
    // Hermes sends a generic name and is no longer specially attributed.
    expect(canonicalizeAiClient("mcp")).toBeUndefined();
  });

  it("returns undefined for empty / non-string input", () => {
    expect(canonicalizeAiClient(undefined)).toBeUndefined();
    expect(canonicalizeAiClient(null)).toBeUndefined();
    expect(canonicalizeAiClient("")).toBeUndefined();
    expect(canonicalizeAiClient("   ")).toBeUndefined();
  });

  it("tolerates surrounding whitespace", () => {
    expect(canonicalizeAiClient("  codex-mcp-client  ")).toBe("codex");
  });
});
