import { describe, expect, it } from "vitest";
import { AGENT_ENV_SLUGS, detectAgentEnv } from "../src/agent-detect.js";

// detectAgentEnv takes env explicitly, so every case is hermetic and unaffected
// by whatever agent the test suite itself happens to run under.
const noFile = { fileExists: () => false };

describe("agent-detect", () => {
  it("returns null when no agent signal is present", () => {
    expect(detectAgentEnv({}, noFile)).toBeNull();
  });

  it.each([
    ["cursor", { CURSOR_AGENT: "1" }],
    ["cursor", { CURSOR_TRACE_ID: "abc" }],
    ["cursor", { CURSOR_EXTENSION_HOST_ROLE: "agent-exec" }],
    ["claude_code", { CLAUDECODE: "1" }],
    ["claude_code", { CLAUDE_CODE: "1" }],
    ["codex", { CODEX_SANDBOX: "seatbelt" }],
    ["codex", { CODEX_THREAD_ID: "t_123" }],
    ["codex", { CODEX_CI: "1" }],
    ["copilot", { COPILOT_MODEL: "gpt-5" }],
    ["copilot", { COPILOT_GITHUB_TOKEN: "x" }],
    ["gemini", { GEMINI_CLI: "1" }],
    ["replit", { REPL_ID: "r-123" }],
    ["antigravity", { ANTIGRAVITY_AGENT: "1" }],
    ["augment", { AUGMENT_AGENT: "1" }],
    ["opencode", { OPENCODE_CLIENT: "1" }],
  ] as const)("detects %s from vendor env vars", (expected, env) => {
    expect(detectAgentEnv(env, noFile)).toBe(expected);
  });

  it("ignores explicitly-empty vendor env vars", () => {
    expect(detectAgentEnv({ CURSOR_AGENT: "" }, noFile)).toBeNull();
  });

  it("does not treat a non-agent CURSOR_EXTENSION_HOST_ROLE as the agent", () => {
    expect(detectAgentEnv({ CURSOR_EXTENSION_HOST_ROLE: "renderer" }, noFile)).toBeNull();
  });

  describe("AI_AGENT cross-vendor fallback", () => {
    it.each([
      ["copilot", "github-copilot-cli"],
      ["copilot", "github-copilot"],
      ["claude_code", "claude-code_2-1-193_agent"],
      ["cursor", "cursor"],
      ["codex", "codex"],
      ["gemini", "gemini"],
      ["v0", "v0"],
    ] as const)("maps AI_AGENT=%s-ish to %s", (expected, value) => {
      expect(detectAgentEnv({ AI_AGENT: value }, noFile)).toBe(expected);
    });

    it("buckets an unrecognized AI_AGENT value to 'other' without leaking it", () => {
      expect(detectAgentEnv({ AI_AGENT: "some-private-internal-tool-v3" }, noFile)).toBe("other");
    });

    it("ignores an empty AI_AGENT", () => {
      expect(detectAgentEnv({ AI_AGENT: "" }, noFile)).toBeNull();
    });
  });

  it("prefers a specific vendor signal over the inheritable AI_AGENT var", () => {
    // The real-world leak this guards against: a parent Claude Code process sets
    // AI_AGENT=claude-code..., which is still present inside a spawned cursor-agent.
    // The specific CURSOR_AGENT signal must win for that child process.
    expect(
      detectAgentEnv({ CURSOR_AGENT: "1", AI_AGENT: "claude-code_2-1-193_agent" }, noFile)
    ).toBe("cursor");
  });

  it("detects Devin from the filesystem marker only", () => {
    expect(detectAgentEnv({}, { fileExists: (p) => p === "/opt/.devin" })).toBe("devin");
  });

  it("never throws if the Devin filesystem check fails", () => {
    const fileExists = () => {
      throw new Error("EACCES");
    };
    expect(detectAgentEnv({}, { fileExists })).toBeNull();
  });

  it("only ever emits slugs from the published allowlist", () => {
    const result = detectAgentEnv({ AI_AGENT: "anything-at-all" }, noFile);
    expect(result === null || (AGENT_ENV_SLUGS as readonly string[]).includes(result)).toBe(true);
  });
});
