import type { AiClient } from "@argent/telemetry";
import type { ScreenshotForm } from "../content.js";

/**
 * What the MCP server does differently for one client, picked by the `clientInfo.name` the
 * client sends in the MCP handshake. README.md in this folder has the matrix and the reasons.
 */
export interface ClientProfile {
  /** Id of the matched row, or `default` for an unnamed or unknown client. */
  id: string;
  /**
   * Form of a screenshot the agent asked for (the `screenshot` tool) and of the images in
   * `e2e-execute` and `screenshot-diff` results. Never `image`: the agent may want to open
   * the file again later.
   */
  screenshot: Exclude<ScreenshotForm, "image">;
  /** Form of the screenshot the server appends after an interaction. */
  autoScreenshot: ScreenshotForm;
  /**
   * Copy the facts that only schema keywords state into the param descriptions
   * (`withKeywordFacts`), for a client that may drop the keywords.
   */
  keywordFacts: boolean;
}

/**
 * One known client. Every field is required, so a new row needs a decision on every
 * behaviour, and on telemetry too.
 */
export interface KnownClient extends ClientProfile {
  /** Prefix patterns, tested against the trimmed, lower-cased `clientInfo.name`. */
  names: RegExp[];
  /** Handshake names the client was seen to send, or that its source ships. Tests use them. */
  seen: string[];
  /**
   * What `canonicalizeAiClient` in `@argent/telemetry` makes of these names. The server
   * does not use it; a test checks that the two lists agree.
   */
  telemetry: AiClient;
}

/**
 * Unnamed and unknown clients. Keeps more information rather than less: the image and its
 * path, and the keyword facts.
 */
export const DEFAULT_PROFILE: ClientProfile = {
  id: "default",
  screenshot: "image-and-path",
  autoScreenshot: "image-and-path",
  keywordFacts: true,
};

/**
 * Each row's comment gives what was checked, on which version, and how:
 * - live: a real model read a code that appears only inside the image.
 * - captured: the request the client sent to a model, or to a stand-in for one, was saved.
 * - self-report: the model quoted the schema it was given.
 * - source: the client's source code or shipped bundle was read.
 *
 * "Shown" means the model gets an image block from a tool result, so the `Saved: <path>`
 * line after an auto-screenshot tells it nothing new. A model without image input gets a
 * placeholder, an error, or nothing at all (VS Code's agent host). The client's file-read
 * tool does not show it the PNG, but a shell tool can still open it, so such a model has to
 * call `screenshot` to learn a path.
 */
export const KNOWN_CLIENTS: readonly KnownClient[] = [
  {
    // Images: shown (live 2.1.316, captured 2.1.318). Keywords: kept (captured 2.1.318).
    id: "claude-code",
    names: [/^claude-code\b/],
    seen: ["claude-code"],
    screenshot: "image-and-path",
    autoScreenshot: "image",
    keywordFacts: false,
    telemetry: "claude_code",
  },
  {
    // Images: shown (captured 0.166). Keywords: drops default, minimum, maximum,
    // exclusiveMinimum, minLength, pattern, const and maxItems (captured 0.166).
    id: "codex",
    names: [/^codex-mcp-client\b/],
    seen: ["codex-mcp-client"],
    screenshot: "image-and-path",
    autoScreenshot: "image",
    keywordFacts: true,
    telemetry: "codex",
  },
  {
    // cursor-agent (`Cursor`) and Cursor IDE (`cursor-vscode`), which share their tool code.
    // Images: shown on 11 of 12 models, not on Kimi K3 (live, cursor-agent 2026.10.22; source,
    // IDE 3.27.22). Keywords: kept on the one model checked (self-report, cursor-agent
    // 2026.10.22), which is not enough to skip the copy.
    id: "cursor",
    names: [/^cursor\b/],
    seen: ["Cursor", "cursor-vscode"],
    screenshot: "image-and-path",
    autoScreenshot: "image",
    keywordFacts: true,
    telemetry: "cursor",
  },
  {
    // Images: shown, unless a local model does not list image input (captured 1.19.4; OpenAI
    // model again on 1.19.5). Keywords: dropped on OpenAI and Google models, kept on Anthropic
    // ones (captured 1.19.5). The server cannot tell which model it uses.
    id: "opencode",
    names: [/^opencode\b/],
    seen: ["opencode"],
    screenshot: "image-and-path",
    autoScreenshot: "image",
    keywordFacts: true,
    telemetry: "opencode",
  },
  {
    // Images: shown (captured 0.67). Keywords: kept (captured 0.67).
    id: "gemini-cli",
    names: [/^gemini-cli-mcp-client\b/],
    seen: ["gemini-cli-mcp-client"],
    screenshot: "image-and-path",
    autoScreenshot: "image",
    keywordFacts: false,
    telemetry: "gemini",
  },
  {
    // Images: shown on models that accept them (source, 1.25.3). Keywords: kept (captured
    // 1.25.3).
    id: "zed",
    names: [/^zed\b/],
    seen: ["Zed"],
    screenshot: "image-and-path",
    autoScreenshot: "image",
    keywordFacts: false,
    telemetry: "zed",
  },
  {
    // VS Code chat. Images: shown on models with vision (captured 1.143.1 with Copilot Chat
    // 0.71.0, bring-your-own-key stand-in; Copilot's own models not run). Keywords: dropped
    // on gpt-4 models (source, same versions).
    id: "vscode",
    names: [/^visual studio code\b/],
    seen: ["Visual Studio Code", "Visual Studio Code - Insiders"],
    screenshot: "image-and-path",
    autoScreenshot: "image",
    keywordFacts: true,
    telemetry: "vscode",
  },
  {
    // VS Code's agent host. Images: shown on models with vision, dropped silently otherwise
    // (captured 1.143.1, runtime 1.0.100-1, bring-your-own-key stand-in; Copilot's own models
    // not run). Keywords: moves most of them into the description itself (captured 1.143.1),
    // so the copy would only repeat a fact.
    id: "vscode-agent-host",
    names: [/^copilot-cli\b/],
    seen: ["copilot-cli"],
    screenshot: "image-and-path",
    autoScreenshot: "image",
    keywordFacts: false,
    telemetry: "other",
  },
  {
    // Kiro IDE and the v3 engine of Kiro CLI, which run the same agent code. Images: shown,
    // except on a few models (source, IDE 1.4.26; live, CLI 2.37.1 on v3). Keywords: kept
    // (captured, IDE 1.4.26). Not seen on v3: its first request has no Argent tools (2.37.1).
    id: "kiro",
    names: [/^kiro\b/],
    seen: ["kiro"],
    screenshot: "image-and-path",
    autoScreenshot: "image",
    keywordFacts: false,
    telemetry: "other",
  },
  {
    // Kiro CLI's v1 and v2 engines; v2 is the default. Keywords: kept (captured 2.37.1, both
    // engines). Images: v2 sends the whole tool result to the model as one JSON document, so
    // a screenshot arrives as about 80,000 tokens of base64 text that none of 8 models could
    // see (captured and live, 2.37.1). v1 is assumed to match: only the source of its
    // predecessor, Amazon Q CLI 1.19.7, was read. The CLI's own file-read tool sends a PNG as
    // an image on Claude models (live, v2), so the server sends the path and says to open it.
    id: "kiro-cli-v1-v2",
    names: [/^q dev cli\b/],
    seen: ["Q DEV CLI"],
    screenshot: "path",
    autoScreenshot: "path",
    keywordFacts: false,
    telemetry: "other",
  },
];

/** The profile for the client named in the MCP handshake. */
export function clientProfile(clientName: string | undefined): ClientProfile {
  const name = clientName?.trim().toLowerCase() ?? "";
  return (
    KNOWN_CLIENTS.find((client) => client.names.some((pattern) => pattern.test(name))) ??
    DEFAULT_PROFILE
  );
}
