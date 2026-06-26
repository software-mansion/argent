import { describe, expect, it } from "vitest";
import { CLOUD_AGENT_SLUGS, detectCloudAgent } from "../src/cloud-agent-detect.js";

// detectCloudAgent takes env explicitly, so every case is hermetic regardless of
// whatever environment the test suite itself runs under. The default no-file stub
// keeps the Devin/Jules filesystem markers from leaking real state into env cases.
const noFile = { fileExists: () => false };

describe("cloud-agent-detect", () => {
  it("returns null when no cloud-agent signal is present", () => {
    expect(detectCloudAgent({}, noFile)).toBeNull();
  });

  describe("Claude Code (remote/cloud)", () => {
    it.each(["byoc", "anthropic_cloud"])("detects environment kind %s", (kind) => {
      expect(detectCloudAgent({ CLAUDE_CODE_ENVIRONMENT_KIND: kind }, noFile)).toBe("claude_code");
    });

    it.each([
      "remote",
      "remote_baku",
      "remote_cowork",
      "remote_desktop",
      "remote_mobile",
      "claude-in-teams",
    ])("detects remote entrypoint %s", (entrypoint) => {
      expect(detectCloudAgent({ CLAUDE_CODE_ENTRYPOINT: entrypoint }, noFile)).toBe("claude_code");
    });

    it("detects a remote session id", () => {
      expect(detectCloudAgent({ CLAUDE_CODE_REMOTE_SESSION_ID: "rs_1" }, noFile)).toBe("claude_code");
    });

    it.each(["cli", "claude-vscode", "sdk-cli"])(
      "does NOT treat local entrypoint %s as cloud",
      (entrypoint) => {
        expect(detectCloudAgent({ CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: entrypoint }, noFile)).toBeNull();
      }
    );

    it("does NOT treat an unknown environment kind as cloud", () => {
      expect(detectCloudAgent({ CLAUDE_CODE_ENVIRONMENT_KIND: "local" }, noFile)).toBeNull();
    });
  });

  describe("Cursor (worker/cloud)", () => {
    it("detects a worker id", () => {
      expect(detectCloudAgent({ CURSOR_AGENT_WORKER_ID: "w-1" }, noFile)).toBe("cursor");
    });

    it("detects a worker pool name", () => {
      expect(detectCloudAgent({ CURSOR_WORKER_POOL_NAME: "lab" }, noFile)).toBe("cursor");
    });

    it("does NOT treat the local Cursor CLI as cloud", () => {
      expect(detectCloudAgent({ CURSOR_AGENT: "1", CURSOR_AGENT_CLI_LOCAL_MODE: "true" }, noFile)).toBeNull();
    });
  });

  describe("GitHub Copilot coding agent", () => {
    it("detects the copilot-swe-agent actor inside Actions", () => {
      expect(
        detectCloudAgent({ GITHUB_ACTIONS: "true", GITHUB_ACTOR: "copilot-swe-agent[bot]" }, noFile)
      ).toBe("copilot");
    });

    it("detects via the workflow ref", () => {
      expect(
        detectCloudAgent(
          { GITHUB_ACTIONS: "true", GITHUB_WORKFLOW_REF: "owner/repo/.github/workflows/copilot-swe-agent/copilot" },
          noFile
        )
      ).toBe("copilot");
    });

    it("does NOT treat a normal CI run as a copilot agent", () => {
      expect(detectCloudAgent({ GITHUB_ACTIONS: "true", GITHUB_ACTOR: "octocat" }, noFile)).toBeNull();
    });

    it("does NOT match a copilot actor outside Actions", () => {
      expect(detectCloudAgent({ GITHUB_ACTOR: "copilot" }, noFile)).toBeNull();
    });
  });

  describe("Replit Agent", () => {
    it("detects REPLIT_AGENT", () => {
      expect(detectCloudAgent({ REPLIT_AGENT: "1" }, noFile)).toBe("replit");
    });

    it("does NOT treat a plain Repl workspace (REPL_ID only) as an agent", () => {
      expect(detectCloudAgent({ REPL_ID: "abc", REPL_SLUG: "my-repl" }, noFile)).toBeNull();
    });
  });

  describe("filesystem-marker agents", () => {
    it("detects Devin from /opt/.devin", () => {
      expect(detectCloudAgent({}, { fileExists: (p) => p === "/opt/.devin" })).toBe("devin");
    });

    it("detects Jules from /opt/environment_summary.sh", () => {
      expect(detectCloudAgent({}, { fileExists: (p) => p === "/opt/environment_summary.sh" })).toBe(
        "jules"
      );
    });

    it("never throws if the filesystem check fails", () => {
      const fileExists = () => {
        throw new Error("EACCES");
      };
      expect(detectCloudAgent({}, { fileExists })).toBeNull();
    });
  });

  it("ignores explicitly-empty signal env vars", () => {
    expect(detectCloudAgent({ REPLIT_AGENT: "", CURSOR_AGENT_WORKER_ID: "" }, noFile)).toBeNull();
  });

  it("prefers an env signal over the filesystem markers", () => {
    expect(detectCloudAgent({ REPLIT_AGENT: "1" }, { fileExists: () => true })).toBe("replit");
  });

  it("only ever emits slugs from the published allowlist", () => {
    const result = detectCloudAgent({ CLAUDE_CODE_ENVIRONMENT_KIND: "byoc" }, noFile);
    expect(result !== null && (CLOUD_AGENT_SLUGS as readonly string[]).includes(result)).toBe(true);
  });
});
