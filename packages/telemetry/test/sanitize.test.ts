import { describe, expect, it } from "vitest";
import { sanitize, ALLOWED } from "../src/sanitize.js";
import { EVENT_NAMES } from "../src/events.js";

describe("sanitize", () => {
  describe("event allowlist", () => {
    it("returns empty object for an unknown event name", () => {
      expect(sanitize("attack:pwned", { foo: 1 })).toEqual({});
    });

    it("drops every unknown property key", () => {
      expect(
        sanitize("installation:cli_init_start", {
          package_manager: "npm",
          is_non_interactive: true,
          home_path: "/Users/alice", // not in allowlist
          ssn: "123-45-6789",
        })
      ).toEqual({ package_manager: "npm", is_non_interactive: true });
    });
  });

  describe("oneOf validator", () => {
    it("accepts canonical values", () => {
      expect(sanitize("installation:cli_init_start", { package_manager: "npm" })).toEqual({
        package_manager: "npm",
      });
    });

    it("drops a fork-derived path-leaking value", () => {
      expect(
        sanitize("installation:cli_init_start", {
          package_manager: "npm (/Users/alice/.nvm/versions/node/v20/bin/npm)",
        })
      ).toEqual({});
    });

    it("drops unknown enum values", () => {
      expect(sanitize("installation:cli_init_cancel", { step: "scope_typo" })).toEqual({});
    });

    it("drops the legacy unknown tool platform value", () => {
      expect(sanitize("tool:invoke", { tool: "list-devices", platform: "unknown" })).toEqual({
        tool: "list-devices",
      });
    });

    it("drops the legacy `from_tar` decision (developer-only path is off the books)", () => {
      expect(sanitize("installation:global_install_decision", { decision: "from_tar" })).toEqual(
        {}
      );
    });

    it("accepts the documented global_install_decision enum values", () => {
      for (const decision of ["install", "cancel", "already_installed"] as const) {
        expect(sanitize("installation:global_install_decision", { decision })).toEqual({
          decision,
        });
      }
    });
  });

  describe("matches validator", () => {
    it("accepts a tool id under 64 chars", () => {
      expect(sanitize("tool:invoke", { tool: "gesture-tap", platform: "ios" })).toEqual({
        tool: "gesture-tap",
        platform: "ios",
      });
    });

    it("rejects a tool id with uppercase / weird chars", () => {
      expect(sanitize("tool:invoke", { tool: "Gesture-Tap!", platform: "ios" })).toEqual({
        platform: "ios",
      });
    });

    it("rejects an oversize string even when shape matches", () => {
      const longButValid = "a".repeat(200);
      expect(sanitize("tool:invoke", { tool: longButValid, platform: "ios" })).toEqual({
        platform: "ios",
      });
    });

    it("drops error metadata fields from tool failures", () => {
      expect(
        sanitize("tool:fail", {
          tool: "gesture-tap",
          platform: "ios",
          duration_ms: 1,
          error_message: "ENOENT /Users/alice/.ssh/id_rsa",
        })
      ).toEqual({
        tool: "gesture-tap",
        platform: "ios",
        duration_ms: 1,
      });
    });
  });

  describe("number validator", () => {
    it.each([
      ["NaN", Number.NaN],
      ["+Infinity", Number.POSITIVE_INFINITY],
      ["-Infinity", Number.NEGATIVE_INFINITY],
      ["negative", -1],
      ["over 2^31", 2 ** 31 + 1],
    ])("drops poison number %s", (_label, value) => {
      expect(sanitize("tool:complete", { tool: "x", platform: "ios", duration_ms: value })).toEqual(
        { tool: "x", platform: "ios" }
      );
    });

    it("accepts a normal duration", () => {
      expect(sanitize("tool:complete", { tool: "x", platform: "ios", duration_ms: 42.5 })).toEqual({
        tool: "x",
        platform: "ios",
        duration_ms: 42.5,
      });
    });

    it("accepts valid tool invocation ids and drops invalid ones", () => {
      expect(
        sanitize("tool:complete", {
          tool: "x",
          tool_invocation_id: "11111111-1111-4111-8111-111111111111",
          platform: "ios",
          duration_ms: 42.5,
        })
      ).toEqual({
        tool: "x",
        tool_invocation_id: "11111111-1111-4111-8111-111111111111",
        platform: "ios",
        duration_ms: 42.5,
      });

      expect(
        sanitize("tool:complete", {
          tool: "x",
          tool_invocation_id: "/Users/alice/project",
          platform: "ios",
          duration_ms: 42.5,
        })
      ).toEqual({
        tool: "x",
        platform: "ios",
        duration_ms: 42.5,
      });
    });
  });

  describe("package action telemetry", () => {
    it("accepts the requested package-action enum set", () => {
      for (const action of [
        "fresh_install",
        "already_installed",
        "init_triggered_update",
        "no_update",
        "update_skipped",
        "update_failed",
        "standalone_update",
        "standalone_install",
        "mcp_update",
      ] as const) {
        expect(
          sanitize("installation:package_action", {
            trigger: action === "mcp_update" ? "mcp_update" : "init",
            action,
            is_success: true,
            duration_ms: 2,
          })
        ).toMatchObject({ action, duration_ms: 2 });
      }
    });
  });

  describe("arrayOf validator", () => {
    it("accepts a valid editors list", () => {
      expect(
        sanitize("installation:editors_select", {
          editors: ["cursor", "claude-code"],
          detected_editor_count: 2,
          scope: "local",
        })
      ).toEqual({
        editors: ["cursor", "claude-code"],
        detected_editor_count: 2,
        scope: "local",
      });
    });

    it("drops an array with a bad element (whole array discarded)", () => {
      expect(
        sanitize("installation:editors_select", {
          editors: ["cursor", "Bad Editor"],
          detected_editor_count: 2,
          scope: "local",
        })
      ).toEqual({ detected_editor_count: 2, scope: "local" });
    });

    it("drops an oversized array (>16 elements)", () => {
      const editors = Array.from({ length: 17 }, (_, i) => `editor-${i}`);
      expect(
        sanitize("installation:editors_select", {
          editors,
          detected_editor_count: 17,
          scope: "local",
        })
      ).toEqual({ detected_editor_count: 17, scope: "local" });
    });
  });

  describe("sensitive-arg drop tests", () => {
    it.each([
      ["keyboard.text", { text: "hunter2" }],
      ["paste.text", { text: "secret" }],
      ["open-url.url", { url: "https://internal.example/admin" }],
      ["flow-add-step.args", { args: '{"text":"private"}' }],
      ["flow-add-echo.message", { message: "personal data" }],
      ["customRoot", { customRoot: "/Users/alice/work" }],
      ["fromTar", { from: "/Users/alice/file.tgz" }],
      ["bundle_id_hash", { bundle_id_hash: "0123456789ab" }],
      ["device_id_hash", { device_id_hash: "0123456789ab" }],
    ])("drops %s when accidentally passed to a tool event", (_label, payload) => {
      const out = sanitize("tool:invoke", { tool: "x", platform: "ios", ...payload });
      expect(out).toEqual({ tool: "x", platform: "ios" });
    });

    it("drops accidental error metadata", () => {
      const out = sanitize("tool:fail", {
        tool: "x",
        platform: "ios",
        duration_ms: 1,
        error_message: "password=hunter2",
      });
      expect(out).toEqual({ tool: "x", platform: "ios", duration_ms: 1 });
    });
  });

  describe("ALLOWED ↔ EVENT_NAMES sync", () => {
    it("every declared event name has a sanitizer entry", () => {
      for (const name of EVENT_NAMES) {
        expect(ALLOWED[name]).toBeDefined();
      }
    });

    it("every sanitizer entry is a declared event name", () => {
      for (const name of Object.keys(ALLOWED)) {
        expect(EVENT_NAMES).toContain(name);
      }
    });
  });
});
