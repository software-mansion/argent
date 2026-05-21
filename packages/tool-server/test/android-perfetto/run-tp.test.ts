import { describe, it, expect } from "vitest";
import { parseTpJsonOutput } from "../../src/utils/android-profiler/pipeline/run-tp";

describe("parseTpJsonOutput", () => {
  it("parses the legacy { columns, values } shape", () => {
    const stdout = JSON.stringify({
      columns: ["thread_name", "sample_count"],
      values: [
        ["Main Thread", 42],
        ["JS Hermes", 17],
      ],
    });
    const rows = parseTpJsonOutput(stdout);
    expect(rows).toEqual([
      { thread_name: "Main Thread", sample_count: 42 },
      { thread_name: "JS Hermes", sample_count: 17 },
    ]);
  });

  it("parses the modern row-object array shape", () => {
    const stdout = JSON.stringify([
      { thread_name: "Main Thread", sample_count: 42 },
      { thread_name: "JS Hermes", sample_count: 17 },
    ]);
    const rows = parseTpJsonOutput(stdout);
    expect(rows.length).toBe(2);
    expect(rows[0]).toMatchObject({ thread_name: "Main Thread" });
  });

  it("falls back to NDJSON when the top-level parse fails", () => {
    const stdout = `{ "thread_name": "T1", "sample_count": 1 }
{ "thread_name": "T2", "sample_count": 2 }`;
    const rows = parseTpJsonOutput(stdout);
    expect(rows.length).toBe(2);
  });

  it("returns the last result set when the output has a `query` wrapper (multi-statement script)", () => {
    const stdout = JSON.stringify({
      query: [
        // DROP VIEW result — nothing useful
        { columns: [], values: [] },
        // CREATE VIEW result — nothing useful
        { columns: [], values: [] },
        // The actual SELECT
        { columns: ["x"], values: [[1], [2]] },
      ],
    });
    const rows = parseTpJsonOutput(stdout);
    expect(rows).toEqual([{ x: 1 }, { x: 2 }]);
  });

  it("returns [] on empty stdout", () => {
    expect(parseTpJsonOutput("")).toEqual([]);
  });
});
