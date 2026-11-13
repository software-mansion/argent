import { describe, it, expect } from "vitest";
import {
  UNATTRIBUTED_WITHOUT_MALLOC_LOGGING,
  renderNativeProfilerReport,
} from "../../src/utils/ios-profiler/render";
import type { MemoryLeak, ProfilerPayload } from "../../src/utils/ios-profiler/types";

// traceFile: null → no report file is written (pure, side-effect-free render),
// so we can assert the markdown directly. Attribution is driven by the leak's
// `attributed` flag (set in the pipeline via isLeakAttributed): without malloc
// stack logging, an object allocated before the start has no allocation
// backtrace, so a leak with no resolved responsible frame comes back unattributed
// and is demoted to a low-confidence note rather than listed like a real app bug.

function leak(attributed: boolean, frame: string, library = ""): MemoryLeak {
  return {
    type: "memory_leak",
    platform: "ios",
    objectType: "Malloc 1008 Bytes",
    totalSizeBytes: 1008,
    count: 1,
    responsibleFrame: frame,
    responsibleLibrary: library,
    attributed,
    severity: attributed ? "RED" : "YELLOW",
  };
}

function payload(leaks: MemoryLeak[]): ProfilerPayload {
  return {
    metadata: { traceFile: null, platform: "iOS", timestamp: "2026-06-16T00:00:00Z" },
    bottlenecks: leaks,
  };
}

describe("leak attribution rendering", () => {
  it("collapses unattributed leaks into a low-confidence note pointing at malloc stack logging", async () => {
    const res = await renderNativeProfilerReport({
      payload: payload([leak(false, "<Call stack limit reached>")]),
      traceFile: null,
    });
    expect(res.report).toContain("unattributed leak group");
    expect(res.report).toContain(UNATTRIBUTED_WITHOUT_MALLOC_LOGGING);
  });

  it("does not claim malloc stack logging from attributed leaks", async () => {
    // An iOS simulator app recorded under `xctrace --attach` without
    // malloc_stack_logging (Xcode 27.2, iOS 27.0): the objects it leaked during
    // the recording had a responsible frame, and 34 other objects had none. The capture mode is
    // false after an attach, null after profiler-load and undefined when not given.
    for (const mallocStackLogging of [false, null, undefined]) {
      const res = await renderNativeProfilerReport({
        payload: payload([
          leak(true, "0x1c15dcf6f", "libswiftCore.dylib"),
          leak(false, "<Call stack limit reached>"),
        ]),
        traceFile: null,
        mallocStackLogging,
      });
      expect(res.report).toContain(
        "**1 unattributed leak group(s)** (1 object(s), 1008 B): responsible frame " +
          `\`<Call stack limit reached>\`, no library. ${UNATTRIBUTED_WITHOUT_MALLOC_LOGGING}`
      );
      expect(res.report).not.toContain("malloc stack logging was active");
      // An attributed table is above the note.
      expect(res.report).not.toContain("--attach");
    }
  });

  it("says malloc stack logging was active for a malloc capture that attributed some leaks", async () => {
    const res = await renderNativeProfilerReport({
      payload: payload([
        leak(true, "hermes::vm::JSTypedArrayBase::createBuffer(...)", "hermes"),
        leak(false, "<Call stack limit reached>"),
      ]),
      traceFile: null,
      mallocStackLogging: true,
    });
    expect(res.report).toContain("malloc stack logging was active");
    expect(res.report).not.toContain(UNATTRIBUTED_WITHOUT_MALLOC_LOGGING);
    expect(res.report).not.toContain("stack logging enabled at launch");
  });

  it("names the malloc capture — never --attach — when malloc_stack_logging was on but nothing attributed", async () => {
    // The one case the attributed-count inference gets wrong: a capture that ran
    // with malloc_stack_logging: true yet attributed nothing (short capture,
    // freed-region reuse, system-lib leaks). With the capture mode threaded in
    // explicitly, the note must not claim the capture used `--attach` and must
    // not advise enabling the flag the user just used.
    const res = await renderNativeProfilerReport({
      payload: payload([leak(false, "<Call stack limit reached>")]),
      traceFile: null,
      mallocStackLogging: true,
    });
    expect(res.report).toContain("unattributed leak group");
    expect(res.report).not.toContain("--attach");
    expect(res.report).not.toContain("stack logging enabled at launch");
    expect(res.report).toContain("ran with malloc stack logging enabled");
  });

  it("says only newer objects have a backtrace also when no leak is attributed", async () => {
    // Also with no attributed leak, an iOS simulator app gets a backtrace for each
    // object allocated after the start, so the note must not claim that the capture
    // has no malloc-stack history.
    for (const mallocStackLogging of [false, null, undefined]) {
      const res = await renderNativeProfilerReport({
        payload: payload([leak(false, "<Call stack limit reached>")]),
        traceFile: null,
        mallocStackLogging,
      });
      expect(res.report).toContain(
        "**1 unattributed leak group(s)** (1 object(s), 1008 B): responsible frame " +
          `\`<Call stack limit reached>\`, no library. ${UNATTRIBUTED_WITHOUT_MALLOC_LOGGING}`
      );
      expect(res.report).not.toContain("--attach");
      expect(res.report).not.toContain("enabled at launch");
    }
  });

  it("does not surface an unattributed leak as an attributed one", async () => {
    // Use a real classifier sentinel ("" → isLeakAttributed === false) so the
    // fixture's attributed:false matches what the pipeline would actually assign;
    // a non-sentinel frame like "(null)" classifies as attributed (RED).
    const res = await renderNativeProfilerReport({
      payload: payload([leak(false, "")]),
      traceFile: null,
    });
    expect(res.report).toContain("No attributed leaks");
  });

  it("escapes '|' in leak table cells so demangled operator frames can't break the row", async () => {
    // GFM splits table cells on unescaped pipes even inside code spans. A
    // demangled C++ frame like `operator|` was unreachable in argent's own
    // captures before malloc_stack_logging (attach mode never attributed), so
    // the leak table must escape it now that real frames are the headline.
    const frame = "folly::operator|(folly::Range<char const*>, folly::Range<char const*>)";
    const res = await renderNativeProfilerReport({
      payload: payload([leak(true, frame, "folly")]),
      traceFile: null,
    });
    const header = res.report.split("\n").find((l) => l.includes("| # | Object Type"));
    const row = res.report.split("\n").find((l) => l.includes("folly::operator"));
    expect(row).toBeDefined();
    expect(row).toContain("operator\\|");
    // Splitting on unescaped pipes yields the same cell count as the header —
    // the row's columns stay aligned.
    const unescapedPipes = (s: string) => s.split(/(?<!\\)\|/).length;
    expect(unescapedPipes(row!)).toBe(unescapedPipes(header!));
  });

  it("shows the real frame + library for an attributed leak", async () => {
    const frame = "hermes::vm::JSTypedArrayBase::createBuffer(...)";
    const res = await renderNativeProfilerReport({
      payload: payload([leak(true, frame, "hermes")]),
      traceFile: null,
    });
    expect(res.report).toContain(frame);
    expect(res.report).toContain("hermes");
    expect(res.report).not.toContain("unattributed leak group");
  });
});

describe("leak attribution rendering on a Mac app", () => {
  function macPayload(leaks: MemoryLeak[]): ProfilerPayload {
    return { ...payload(leaks), metadata: { ...payload(leaks).metadata, platform: "macOS" } };
  }

  it("says only newer objects have a backtrace, and does not claim malloc stack logging", async () => {
    const attributed = leak(true, "swift::swift_slowAllocTyped(...)", "libswiftCore.dylib");
    // Also with no attributed leak: a Mac app is recorded with `--attach` too.
    for (const leaks of [[attributed], []])
      for (const mallocStackLogging of [false, null]) {
        const res = await renderNativeProfilerReport({
          payload: macPayload([...leaks, leak(false, "<Call stack limit reached>")]),
          traceFile: null,
          mallocStackLogging,
        });
        expect(res.report).toContain(UNATTRIBUTED_WITHOUT_MALLOC_LOGGING);
        expect(res.report).not.toContain("malloc stack logging was active");
        expect(res.report).not.toContain("--attach");
      }
  });

  it("keeps the malloc capture's note when malloc_stack_logging was on", async () => {
    const res = await renderNativeProfilerReport({
      payload: macPayload([leak(false, "<Call stack limit reached>")]),
      traceFile: null,
      mallocStackLogging: true,
    });
    expect(res.report).toContain("ran with malloc stack logging enabled");
    expect(res.report).not.toContain(UNATTRIBUTED_WITHOUT_MALLOC_LOGGING);
  });
});

describe("leaks of system libraries in the report", () => {
  it("rates them YELLOW with a note, and gives the retain-cycle advice for the app's leaks only", async () => {
    const appLeak: MemoryLeak = {
      ...leak(
        true,
        "swift::swift_slowAllocTyped(unsigned long, unsigned long, unsigned long long)",
        "libswiftCore.dylib"
      ),
      objectType: "ProfLeakNodeA",
    };
    const systemLeak: MemoryLeak = {
      ...leak(true, "-[NSXPCConnection initWithMachServiceName:options:]", "Foundation"),
      objectType: "xpc_connection_t",
      count: 3,
      systemLibrary: true,
      severity: "YELLOW",
    };
    const res = await renderNativeProfilerReport({
      payload: payload([appLeak, systemLeak]),
      traceFile: null,
    });

    expect(res.report).toContain("| Memory Leaks | 2 | 🔴 1  🟡 1 |");
    expect(res.report).toContain(
      "> 🟡 **1 leak group(s) from system libraries** (3 object(s); `Foundation`): the responsible " +
        "frame is in a library of the OS, not in the app's code."
    );
    const advice = res.report.slice(res.report.indexOf("### Memory Leaks"));
    expect(advice).toContain("`ProfLeakNodeA` x1");
    expect(advice).not.toContain("`xpc_connection_t`");
  });
});

describe("leaks of a template without the Allocations instrument in the report", () => {
  // Such a template gives `(null)` as the frame and the library of every leak.
  it("says that the template has no Allocations instrument, on a Mac app and on iOS", async () => {
    const leaks: MemoryLeak[] = [
      { ...leak(false, "(null)", "(null)"), objectType: "ProfLeakNodeA", count: 200 },
      { ...leak(false, "(null)", "(null)"), objectType: "NSSet", count: 138 },
    ];
    for (const platform of ["macOS", "iOS"]) {
      const res = await renderNativeProfilerReport({
        payload: {
          metadata: { traceFile: null, platform, timestamp: "2026-11-13T00:00:00Z" },
          bottlenecks: leaks,
        },
        traceFile: null,
      });
      expect(res.report).toContain("| Memory Leaks | 2 | 🟡 2 |");
      expect(res.report).toContain("> 🟡 **2 unattributed leak group(s)** (338 object(s), 2 KB)");
      expect(res.report).toContain(
        "responsible frame `(null)`, no library. The template of this recording has no " +
          "Allocations instrument"
      );
      expect(res.report).not.toContain("malloc_stack_logging: true");
      expect(res.report).not.toContain("Check for retain cycles");
    }
  });

  it("is not said for a `(null)` group next to attributed leaks", async () => {
    // An iOS malloc_stack_logging recording with the bundled template: one group of 1 object
    // had `(null)` as its frame, next to an attributed Foundation leak.
    const leaks: MemoryLeak[] = [
      { ...leak(true, "+[NSXPCInterface interfaceWithProtocol:]", "Foundation"), count: 3 },
      { ...leak(false, "(null)", "(null)"), objectType: "Malloc 32 Bytes", totalSizeBytes: 32 },
    ];
    const res = await renderNativeProfilerReport({
      payload: payload(leaks),
      traceFile: null,
      mallocStackLogging: true,
    });
    expect(res.report).toContain(
      "> 🟡 **1 unattributed leak group(s)** (1 object(s), 32 B): responsible frame `(null)`, " +
        "no library. Some leaks here were attributed"
    );
    expect(res.report).not.toContain("no Allocations instrument");
  });

  it("is said only when the recording used a template of the caller, or the template is unknown", async () => {
    // A malloc_stack_logging recording with the bundled template, which has the Allocations
    // instrument: its only unattributed group was a `(null)` "Malloc 32 Bytes".
    const leaks: MemoryLeak[] = [
      { ...leak(false, "(null)", "(null)"), objectType: "Malloc 32 Bytes", totalSizeBytes: 32 },
    ];
    const render = (customTemplate: boolean | null) =>
      renderNativeProfilerReport({
        payload: payload(leaks),
        traceFile: null,
        mallocStackLogging: true,
        customTemplate,
      });
    const bundled = (await render(false)).report;
    expect(bundled).toContain(
      "> 🟡 **1 unattributed leak group(s)** (1 object(s), 32 B): responsible frame `(null)`, " +
        "no library. This capture ran with malloc stack logging enabled"
    );
    expect(bundled).not.toContain("no Allocations instrument");
    expect(bundled).not.toContain("template_path");
    for (const customTemplate of [true, null]) {
      expect((await render(customTemplate)).report).toContain("no Allocations instrument");
    }
  });
});
