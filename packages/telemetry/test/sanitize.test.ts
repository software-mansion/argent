import { describe, expect, it } from "vitest";
import { FAILURE_CODES } from "@argent/registry";
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

    it("accepts a coarse AI client slug on tool events", () => {
      expect(
        sanitize("tool:invoke", {
          tool: "gesture-tap",
          tool_invocation_id: "11111111-1111-4111-8111-111111111111",
          ai_client: "codex",
        })
      ).toEqual({
        tool: "gesture-tap",
        tool_invocation_id: "11111111-1111-4111-8111-111111111111",
        ai_client: "codex",
      });
    });

    it("never carries the free-form ai_client_name — it is not an allowed key", () => {
      // The free-form name was dropped end-to-end; `other` is recorded as a bare
      // bucket so a client that names itself after the host/user can't leak it.
      expect(
        sanitize("tool:invoke", {
          tool: "gesture-tap",
          tool_invocation_id: "11111111-1111-4111-8111-111111111111",
          ai_client: "other",
          ai_client_name: "some-new-tool",
        })
      ).toEqual({
        tool: "gesture-tap",
        tool_invocation_id: "11111111-1111-4111-8111-111111111111",
        ai_client: "other",
      });
    });

    it("drops unregistered AI client slugs", () => {
      expect(
        sanitize("tool:invoke", {
          tool: "gesture-tap",
          tool_invocation_id: "11111111-1111-4111-8111-111111111111",
          ai_client: "my-private-client",
          ai_client_name: "/Users/alice/secret-client",
        })
      ).toEqual({
        tool: "gesture-tap",
        tool_invocation_id: "11111111-1111-4111-8111-111111111111",
      });
    });

    it("carries the coarse AI client on tool:fail alongside the failure signal", () => {
      const result = sanitize("tool:fail", {
        tool: "screenshot",
        tool_invocation_id: "11111111-1111-4111-8111-111111111111",
        duration_ms: 12,
        error_code: FAILURE_CODES.REGISTRY_TOOL_FAILURE_UNCLASSIFIED,
        ai_client: "other",
        ai_client_name: "some-new-tool",
      });
      expect(result).toMatchObject({
        ai_client: "other",
        error_code: FAILURE_CODES.REGISTRY_TOOL_FAILURE_UNCLASSIFIED,
      });
      expect(result).not.toHaveProperty("ai_client_name");
    });
  });

  describe("matches validator", () => {
    it("accepts a tool id under 64 chars", () => {
      expect(sanitize("tool:invoke", { tool: "gesture-tap", platform: "ios" })).toEqual({
        tool: "gesture-tap",
        platform: "ios",
      });
    });

    it("accepts a snake_case tool id (e.g. argent-lens tools)", () => {
      expect(sanitize("tool:invoke", { tool: "await_user_selection", platform: "ios" })).toEqual({
        tool: "await_user_selection",
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
          stack: "Error: ENOENT\n    at /Users/alice/project/app.ts:1",
        })
      ).toEqual({
        tool: "gesture-tap",
        platform: "ios",
        duration_ms: 1,
      });
    });

    it("allows static failure signal fields on tool failures", () => {
      expect(
        sanitize("tool:fail", {
          tool: "gesture-tap",
          platform: "ios",
          duration_ms: 1,
          error_code: "HTTP_ZOD_VALIDATION_FAILED",
          failure_stage: "http_zod_validation",
          failure_area: "http",
          error_kind: "validation",
        })
      ).toEqual({
        tool: "gesture-tap",
        platform: "ios",
        duration_ms: 1,
        error_code: "HTTP_ZOD_VALIDATION_FAILED",
        failure_stage: "http_zod_validation",
        failure_area: "http",
        error_kind: "validation",
      });
    });

    it("allows coarse subprocess and network failure metadata", () => {
      expect(
        sanitize("tool:fail", {
          tool: "gesture-tap",
          platform: "ios",
          duration_ms: 1,
          error_code: "ANDROID_ADB_COMMAND_FAILED",
          failure_stage: "android_adb_command",
          failure_area: "tool_server",
          error_kind: "subprocess",
          failure_command: "adb",
          failure_exit_code: 1,
          failure_signal: "SIGKILL",
          failure_spawn_code: "ENOENT",
          network_failure: "connection_refused",
        })
      ).toEqual({
        tool: "gesture-tap",
        platform: "ios",
        duration_ms: 1,
        error_code: "ANDROID_ADB_COMMAND_FAILED",
        failure_stage: "android_adb_command",
        failure_area: "tool_server",
        error_kind: "subprocess",
        failure_command: "adb",
        failure_exit_code: 1,
        failure_signal: "SIGKILL",
        failure_spawn_code: "ENOENT",
        network_failure: "connection_refused",
      });
    });

    it("rejects unsafe subprocess and network metadata", () => {
      expect(
        sanitize("tool:fail", {
          tool: "gesture-tap",
          platform: "ios",
          duration_ms: 1,
          failure_command: "adb -s /Users/alice/device shell secret",
          failure_exit_code: 999,
          failure_signal: "SIGUSR1",
          failure_spawn_code: "ESECRET",
          network_failure: "https://internal.example",
        })
      ).toEqual({
        tool: "gesture-tap",
        platform: "ios",
        duration_ms: 1,
      });
    });

    it("accepts every centrally registered failure code", () => {
      for (const errorCode of Object.values(FAILURE_CODES)) {
        expect(
          sanitize("tool:fail", {
            tool: "gesture-tap",
            platform: "ios",
            duration_ms: 1,
            error_code: errorCode,
          })
        ).toMatchObject({ error_code: errorCode });
      }
    });

    it("rejects non-static-looking failure signals", () => {
      expect(
        sanitize("tool:fail", {
          tool: "gesture-tap",
          platform: "ios",
          duration_ms: 1,
          error_code: "ENOENT /Users/alice/.ssh/id_rsa",
          failure_stage: "../secret",
          failure_area: "laptop",
          error_kind: "password",
        })
      ).toEqual({
        tool: "gesture-tap",
        platform: "ios",
        duration_ms: 1,
      });
    });

    it("rejects static-looking but unregistered failure codes", () => {
      expect(
        sanitize("tool:fail", {
          tool: "gesture-tap",
          platform: "ios",
          duration_ms: 1,
          error_code: "SOME_NEW_UNREGISTERED_FAILURE",
        })
      ).toEqual({
        tool: "gesture-tap",
        platform: "ios",
        duration_ms: 1,
      });
    });

    it("allows static failure signal fields on CLI run failures", () => {
      expect(
        sanitize("cli:run_fail", {
          tool: "gesture-tap",
          duration_ms: 1,
          error_code: "CLI_RUN_ARGS_JSON_INVALID",
          failure_stage: "cli_run_parse_raw_args",
          failure_area: "cli",
          error_kind: "validation",
        })
      ).toEqual({
        tool: "gesture-tap",
        duration_ms: 1,
        error_code: "CLI_RUN_ARGS_JSON_INVALID",
        failure_stage: "cli_run_parse_raw_args",
        failure_area: "cli",
        error_kind: "validation",
      });
    });

    it("drops server-only and unsafe fields from CLI run failures", () => {
      expect(
        sanitize("cli:run_fail", {
          tool: "Gesture-Tap!",
          duration_ms: 1,
          tool_invocation_id: "11111111-1111-4111-8111-111111111111",
          platform: "ios",
          error_message: "ENOENT /Users/alice/.ssh/id_rsa",
          stack: "Error: ENOENT\n    at /Users/alice/project/app.ts:1",
          error_code: "CLI_RUN_TOOL_CALL_FAILED",
        })
      ).toEqual({
        duration_ms: 1,
        error_code: "CLI_RUN_TOOL_CALL_FAILED",
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

  it("allows static failure signal fields on crash stop events", () => {
    expect(
      sanitize("toolserver:stop", {
        reason: "crash",
        uptime_ms: 10,
        total_tool_calls: 2,
        error_code: "TOOLSERVER_UNCAUGHT_EXCEPTION",
        failure_stage: "toolserver_uncaught_exception",
        failure_area: "tool_server",
        error_kind: "crash",
        stack: "Error: secret at /Users/alice/project/app.ts:1",
      })
    ).toEqual({
      reason: "crash",
      uptime_ms: 10,
      total_tool_calls: 2,
      error_code: "TOOLSERVER_UNCAUGHT_EXCEPTION",
      failure_stage: "toolserver_uncaught_exception",
      failure_area: "tool_server",
      error_kind: "crash",
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

  describe("lens telemetry events", () => {
    it("keeps the round_completed usage flags and drops leaked content", () => {
      const out = sanitize("lens:round_completed", {
        round: 2,
        element_count: 3,
        variant_count: 5,
        annotation_count: 1,
        element_comment_count: 2,
        skipped_comment_count: 1,
        has_global_comment: true,
        inspector_used: true,
        offscreen_revealed: false,
        is_cli_session: true,
        had_parked_await: false,
        round_duration_ms: 1234,
        platform: "ios",
        // Content that must never survive:
        element_name: "Checkout button",
        comment_text: "make it pop",
      });
      expect(out).toEqual({
        round: 2,
        element_count: 3,
        variant_count: 5,
        annotation_count: 1,
        element_comment_count: 2,
        skipped_comment_count: 1,
        has_global_comment: true,
        inspector_used: true,
        offscreen_revealed: false,
        is_cli_session: true,
        had_parked_await: false,
        round_duration_ms: 1234,
        platform: "ios",
      });
    });

    it("drops a non-boolean inspector_used / offscreen_revealed", () => {
      const out = sanitize("lens:round_completed", {
        round: 1,
        inspector_used: "yes",
        offscreen_revealed: 1,
      });
      // The bool validator rejects non-booleans, so both keys are removed.
      expect(out).toEqual({ round: 1 });
    });

    it("keeps agent_choice_count on cli_session_started and drops extras", () => {
      const out = sanitize("lens:cli_session_started", {
        agent_choice_count: 2,
        agent_names: ["claude", "cursor"], // must be dropped
      });
      expect(out).toEqual({ agent_choice_count: 2 });
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
