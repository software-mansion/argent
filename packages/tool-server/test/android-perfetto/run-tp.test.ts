import { describe, it, expect } from "vitest";
import { renderSqlTemplate } from "../../src/utils/android-profiler/pipeline/run-tp";

describe("renderSqlTemplate", () => {
  it("resolves every {{TOKEN}} placeholder, repeated occurrences included", () => {
    const sql = renderSqlTemplate(
      "SELECT '{{TARGET_PROCESS}}' AS p WHERE name = (SELECT p) AND gap > {{BURST_GAP_NS}}",
      { TARGET_PROCESS: "com.example.app", BURST_GAP_NS: "12000000" }
    );
    expect(sql).toBe("SELECT 'com.example.app' AS p WHERE name = (SELECT p) AND gap > 12000000");
    expect(sql).not.toMatch(/\{\{|\}\}/);
  });

  it("throws naming the token when a placeholder has no substitution", () => {
    expect(() => renderSqlTemplate("WHERE p.name = '{{TARGET_PROCESS}}'", {})).toThrow(
      /\{\{TARGET_PROCESS\}\}.*no substitution/
    );
  });

  it("throws when a provided substitution is never referenced (stale/renamed token)", () => {
    expect(() => renderSqlTemplate("SELECT 1", { TARGET_PROCESS: "com.example.app" })).toThrow(
      /not referenced.*TARGET_PROCESS/
    );
  });

  it("is a no-op on a template with no placeholders and no substitutions", () => {
    expect(renderSqlTemplate("SELECT start_ts FROM trace_bounds;", {})).toBe(
      "SELECT start_ts FROM trace_bounds;"
    );
  });

  it("does not treat $-sequences in a value as String.replace specials", () => {
    // A function replacer means `$&`/`$1` in the value are inserted literally.
    expect(renderSqlTemplate("name = '{{FUNCTION_NAME}}'", { FUNCTION_NAME: "a$&b$1" })).toBe(
      "name = 'a$&b$1'"
    );
  });
});
