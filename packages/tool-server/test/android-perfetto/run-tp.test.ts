import { describe, it, expect } from "vitest";
import { parseTpCsvOutput } from "../../src/utils/android-profiler/pipeline/run-tp";

describe("parseTpCsvOutput", () => {
  it("parses a simple header + two rows of mixed string/number columns", () => {
    const stdout = `"thread_name","sample_count"\n"Main Thread",42\n"JS Hermes",17\n`;
    expect(parseTpCsvOutput(stdout)).toEqual([
      { thread_name: "Main Thread", sample_count: 42 },
      { thread_name: "JS Hermes", sample_count: 17 },
    ]);
  });

  it("preserves commas inside a quoted string cell", () => {
    const stdout = `"name","value"\n"hello, world",1\n`;
    expect(parseTpCsvOutput(stdout)).toEqual([{ name: "hello, world", value: 1 }]);
  });

  it("decodes RFC-4180 escaped double-quotes (\"\") inside a quoted cell", () => {
    const stdout = `"label","n"\n"with ""quotes"" inside",3\n`;
    expect(parseTpCsvOutput(stdout)).toEqual([
      { label: 'with "quotes" inside', n: 3 },
    ]);
  });

  it("preserves a literal newline inside a quoted cell (multi-physical-line row)", () => {
    // Proves the parser is a state machine, not a `split("\n")`. The cell
    // spans two physical lines, but it's one logical row.
    const stdout = `"callstack","sample_count"\n"frame_a\nframe_b\nframe_c",7\n`;
    const rows = parseTpCsvOutput(stdout);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      callstack: "frame_a\nframe_b\nframe_c",
      sample_count: 7,
    });
  });

  it("coerces bare [NULL] to null", () => {
    const stdout = `"reason","n"\n[NULL],5\n`;
    expect(parseTpCsvOutput(stdout)).toEqual([{ reason: null, n: 5 }]);
  });

  it("coerces quoted \"[NULL]\" to null (what the real binary actually emits)", () => {
    // Empirically `trace_processor_shell` v55.3 wraps NULL in quotes:
    // `"[NULL]"` rather than the bare token described in older docs.
    const stdout = `"reason","n"\n"[NULL]",5\n`;
    expect(parseTpCsvOutput(stdout)).toEqual([{ reason: null, n: 5 }]);
  });

  it("returns [] for header-only stdout (zero result rows)", () => {
    expect(parseTpCsvOutput(`"x","y"\n`)).toEqual([]);
  });

  it("returns [] for empty stdout", () => {
    expect(parseTpCsvOutput("")).toEqual([]);
  });
});
