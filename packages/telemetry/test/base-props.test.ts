import { describe, expect, it } from "vitest";
import { getBaseProps, getSessionId, _resetSessionIdForTest } from "../src/base-props.js";
import { snapshotEnv } from "./helpers.js";
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("base-props", () => {
  it("returns the full base set with coarse CI telemetry", () => {
    const restore = snapshotEnv(["CI", "GITHUB_ACTIONS"]);
    try {
      process.env.CI = "false";
      delete process.env.GITHUB_ACTIONS;
      const props = getBaseProps("cli");
      expect(Object.keys(props).sort()).toEqual(
        [
          "$process_person_profile",
          "$session_id",
          "arch",
          "cli_version_major_minor",
          "is_ci",
          "is_tty",
          "node_version_major",
          "os",
          "runtime",
        ].sort()
      );
      expect(props.$process_person_profile).toBe(false);
      expect(typeof props.is_tty).toBe("boolean");
      expect(props.is_ci).toBe(false);
      expect(typeof props.node_version_major).toBe("string");
      expect(typeof props.arch).toBe("string");
      expect(props.runtime).toBe("cli");
      expect(typeof props.$session_id).toBe("string");
      expect(props.$session_id).toMatch(UUID_V4);
      expect(props).not.toHaveProperty("ci_provider");
      expect(props).not.toHaveProperty("is_container");
      expect(props).not.toHaveProperty("container_runtime");
    } finally {
      restore();
    }
  });

  it("sets is_ci when the process is running in CI", () => {
    const restore = snapshotEnv(["CI"]);
    try {
      process.env.CI = "1";
      expect(getBaseProps("cli").is_ci).toBe(true);
    } finally {
      restore();
    }
  });

  it("still does NOT carry full cli_version / full node_version", () => {
    const props = getBaseProps("tool_server") as unknown as Record<string, unknown>;
    expect(props).not.toHaveProperty("cli_version");
    expect(props).not.toHaveProperty("node_version");
  });

  it("arch matches process.arch verbatim (no transformation)", () => {
    const props = getBaseProps("cli");
    expect(props.arch).toBe(process.arch);
  });

  describe("$session_id", () => {
    it("is stable within a process across calls and across runtimes", () => {
      const a = getBaseProps("cli").$session_id;
      const b = getBaseProps("tool_server").$session_id;
      const c = getBaseProps("installer").$session_id;
      expect(a).toBe(b);
      expect(b).toBe(c);
      expect(a).toBe(getSessionId());
    });

    it("is a v4-shaped UUID", () => {
      expect(getSessionId()).toMatch(UUID_V4);
    });

    it("rotates after the test seam runs (asserts fresh-process behaviour)", () => {
      const before = getSessionId();
      _resetSessionIdForTest();
      const after = getSessionId();
      expect(after).not.toBe(before);
      expect(after).toMatch(UUID_V4);
      // Subsequent getBaseProps calls reflect the new id immediately.
      expect(getBaseProps("cli").$session_id).toBe(after);
    });
  });
});
