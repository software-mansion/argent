import { describe, it, expect, vi, beforeEach } from "vitest";

// Same mock harness as the other android-perfetto pipeline tests: runTpQuery is
// stubbed to pop planned responses in order, and we record the (query,
// substitutions) of each call so we can assert how `thread` is resolved.
const queryResponses: Array<{ name: string; rows: unknown[] }> = [];
const calls: Array<{ query: string; substitutions: Record<string, string> }> = [];

vi.mock("@argent/native-devtools-android", () => {
  const path = require("node:path");
  return {
    ensureTraceProcessorReady: vi.fn(async () => {}),
    traceProcessorQueriesDir: () =>
      path.resolve(__dirname, "../../../native-devtools-android/assets/queries"),
  };
});
vi.mock("../../src/utils/android-profiler/pipeline/run-tp", async (importActual) => ({
  ...(await importActual<typeof import("../../src/utils/android-profiler/pipeline/run-tp")>()),
  runTpQuery: vi.fn(async (opts: { query: string; substitutions: Record<string, string> }) => {
    calls.push({ query: opts.query, substitutions: opts.substitutions });
    const next = queryResponses.shift();
    if (!next) throw new Error(`runTpQuery called for "${opts.query}" with no queued response`);
    if (next.name !== opts.query) {
      throw new Error(`runTpQuery expected "${next.name}" but got "${opts.query}"`);
    }
    return next.rows;
  }),
  runTpInline: vi.fn(async () => []),
  parseTpJsonOutput: vi.fn(),
}));

import { runAndroidStackQuery } from "../../src/utils/android-profiler/pipeline/index";

const PKG = "com.example.app";

function callerRow(
  thread_name: string,
  is_main_thread: 0 | 1,
  callstack_text: string,
  occurrences: number,
  matched_function = "uncompressLZW",
  is_exact: 0 | 1 = 1
) {
  return { thread_name, is_main_thread, matched_function, is_exact, callstack_text, occurrences };
}

function query(thread: string | undefined, rows: unknown[]) {
  queryResponses.push({ name: "function-callers.sql", rows });
  return runAndroidStackQuery({
    tracePath: "/fake.pftrace",
    mode: "function_callers",
    appPackage: PKG,
    functionName: "uncompressLZW",
    thread,
    topN: 15,
  });
}

describe("function_callers thread resolution", () => {
  beforeEach(() => {
    queryResponses.length = 0;
    calls.length = 0;
  });

  it("defaults to ALL threads (__ALL__) when thread is omitted, and tags each row", async () => {
    const out = await query(undefined, [
      callerRow(".blueskyweb.app", 1, "decode <- uncompressLZW", 12),
      callerRow("FrameDecoderExe", 0, "decode <- uncompressLZW", 5),
    ]);
    expect(calls[0]!.substitutions.THREAD_NAME).toBe("__ALL__");
    expect(out).toContain("on all threads");
    // Each callstack block is tagged with its owning thread (main flagged).
    expect(out).toContain("(12×) [.blueskyweb.app (main)]");
    expect(out).toContain("(5×) [FrameDecoderExe]");
  });

  it('maps the "main" alias to the __MAIN__ sentinel (is_main_thread match)', async () => {
    await query("main", [callerRow(".blueskyweb.app", 1, "decode <- uncompressLZW", 9)]);
    expect(calls[0]!.substitutions.THREAD_NAME).toBe("__MAIN__");
  });

  it('maps "Main Thread" (the normalised label) to __MAIN__ too', async () => {
    await query("Main Thread", [callerRow(".blueskyweb.app", 1, "x <- uncompressLZW", 3)]);
    expect(calls[0]!.substitutions.THREAD_NAME).toBe("__MAIN__");
  });

  it("passes an explicit raw thread name through verbatim (no tagging, exact match)", async () => {
    const out = await query("FrameDecoderExe", [
      callerRow("FrameDecoderExe", 0, "decode <- uncompressLZW", 7),
    ]);
    expect(calls[0]!.substitutions.THREAD_NAME).toBe("FrameDecoderExe");
    expect(out).toContain("on `FrameDecoderExe`");
    expect(out).not.toContain("[FrameDecoderExe]"); // single-thread mode → no tag
  });

  it("passes the function_name through verbatim for the substring SQL to match", async () => {
    await query("main", [callerRow(".blueskyweb.app", 1, "x <- uncompressLZW", 3)]);
    expect(calls[0]!.query).toBe("function-callers.sql");
    expect(calls[0]!.substitutions.FUNCTION_NAME).toBe("uncompressLZW");
  });

  it("spells out the matched leaf symbols (demangled) when the match was a substring", async () => {
    // Demangled query → SQL matched the mangled leaf; rows come back is_exact=0
    // with the real frame name in matched_function. The display demangles it for
    // readability (SQL matching upstream still uses the raw mangled name).
    const mangled = "_Z13uncompressLZWP7_JNIEnvP8_jobjectS2_P10_jintArrayiS4_iiihP11_jbyteArray";
    const out = await query(undefined, [
      callerRow("FrameDecoderExe", 0, `decode <- ${mangled}`, 8, mangled, 0),
    ]);
    expect(out).toContain("Substring match: `uncompressLZW` hit 1 leaf symbol(s):");
    expect(out).toContain("- `uncompressLZW`");
    expect(out).not.toContain(mangled); // raw mangled name no longer shown
    expect(out).toContain("(8×) [FrameDecoderExe]");
  });

  it("dedups overloaded leaves AFTER demangling (two overloads → one bullet, count of 1)", async () => {
    // Two distinct mangled overloads of foo::bar that demangle to the same name
    // once the argument list is dropped. The bullet list must show it once and
    // the count must agree (not say 2 while printing the same line twice).
    const barVoid = "_ZN3foo3barEv";
    const barInt = "_ZN3foo3barEi";
    const out = await query(undefined, [
      callerRow("WorkerA", 0, `caller <- ${barVoid}`, 4, barVoid, 0),
      callerRow("WorkerB", 0, `caller <- ${barInt}`, 3, barInt, 0),
    ]);
    // Count and bullets agree: one distinct leaf symbol after demangling.
    expect(out).toContain("hit 1 leaf symbol(s):");
    // Exactly one bullet for foo::bar (not two).
    const bullets = out.split("\n").filter((l) => l.trim() === "- `foo::bar`");
    expect(bullets).toHaveLength(1);
    // Raw mangled overloads never appear in the human-facing bullet list.
    expect(out).not.toContain(barVoid);
    expect(out).not.toContain(barInt);
  });

  it("does NOT add the substring note when the match was exact and singular", async () => {
    const out = await query("FrameDecoderExe", [
      callerRow("FrameDecoderExe", 0, "decode <- uncompressLZW", 7, "uncompressLZW", 1),
    ]);
    expect(out).not.toContain("Substring match");
  });

  it("on a miss, lists available threads from thread-breakdown.sql (Option D)", async () => {
    queryResponses.push(
      { name: "function-callers.sql", rows: [] },
      {
        name: "thread-breakdown.sql",
        rows: [
          { thread_name: ".blueskyweb.app", is_main_thread: 1, sample_count: 4200, pct_of_app: 70 },
          { thread_name: "FrameDecoderExe", is_main_thread: 0, sample_count: 800, pct_of_app: 13 },
        ],
      }
    );
    const out = await runAndroidStackQuery({
      tracePath: "/fake.pftrace",
      mode: "function_callers",
      appPackage: PKG,
      functionName: "noSuchFn",
      thread: "main",
      topN: 15,
    });
    expect(calls.map((c) => c.query)).toEqual(["function-callers.sql", "thread-breakdown.sql"]);
    expect(out).toContain("not found on main thread");
    expect(out).toContain("Available threads");
    expect(out).toContain("`.blueskyweb.app` (main) — 4200 samples");
    expect(out).toContain("`FrameDecoderExe` — 800 samples");
  });
});
