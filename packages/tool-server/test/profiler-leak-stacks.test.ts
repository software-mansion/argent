/**
 * `leak_stacks` query rendering — attributed-first ordering under the top-N slice.
 *
 * `aggregateLeaks` hands leaks over attributed-first, but renderLeakStacksIos
 * re-sorts before slicing to `top_n`. Under `xctrace --attach` the unattributed
 * system noise is both far more numerous and individually larger than a real app
 * leak, so a size-only sort + slice would truncate the one attributed leak out of
 * the table entirely. These tests pin that the attributed leak always survives.
 */
import { describe, it, expect } from "vitest";
import { renderLeakStacksIos } from "../src/tools/profiler/query/profiler-stack-query";
import { UNATTRIBUTED_WITHOUT_MALLOC_LOGGING } from "../src/utils/ios-profiler/render";
import type { MemoryLeak } from "../src/utils/profiler-shared/types";

function leak(partial: Partial<MemoryLeak> & Pick<MemoryLeak, "objectType">): MemoryLeak {
  const attributed = partial.attributed ?? false;
  return {
    type: "memory_leak",
    platform: "ios",
    objectType: partial.objectType,
    totalSizeBytes: partial.totalSizeBytes ?? 16,
    count: partial.count ?? 1,
    responsibleFrame: partial.responsibleFrame ?? "<Call stack limit reached>",
    responsibleLibrary: partial.responsibleLibrary ?? "",
    attributed,
    ...(partial.systemLibrary ? { systemLibrary: true } : {}),
    severity: partial.severity ?? (attributed ? "RED" : "YELLOW"),
  };
}

const ATTRIBUTED_SMALL = leak({
  objectType: "MyModel",
  totalSizeBytes: 128,
  count: 1,
  responsibleFrame: "-[MyViewController loadData]",
  responsibleLibrary: "MyApp",
  attributed: true,
  severity: "RED",
});

// Bigger-than-the-real-leak unattributed system noise — the kind of rows that
// dominate an `--attach` capture and would otherwise crowd the table.
function noise(i: number): MemoryLeak {
  return leak({
    objectType: `Malloc ${512 + i} Bytes`,
    totalSizeBytes: 100_000 + i,
    count: 5,
  });
}

describe("renderLeakStacksIos — attributed-first ordering", () => {
  it("keeps a small attributed leak in the table even when larger unattributed noise exceeds top_n", () => {
    // Attributed leak handed in last (smallest), 20 larger unattributed groups.
    const leaks = [...Array.from({ length: 20 }, (_, i) => noise(i)), ATTRIBUTED_SMALL];

    const out = renderLeakStacksIos(leaks, undefined, 10);

    // The real attributed leak must not be sliced out by larger system noise.
    expect(out).toContain("`MyModel`");
    expect(out).toContain("-[MyViewController loadData]");
  });

  it("renders the attributed leak as the first table row", () => {
    const leaks = [noise(0), noise(1), ATTRIBUTED_SMALL];

    const rows = renderLeakStacksIos(leaks, undefined, 10)
      .split("\n")
      .filter((l) => l.startsWith("| `"));

    expect(rows[0]).toContain("`MyModel`");
  });

  it("orders by size within the attributed and unattributed groups", () => {
    const bigAttributed = leak({
      objectType: "BigModel",
      totalSizeBytes: 4096,
      responsibleFrame: "-[Other thing]",
      responsibleLibrary: "MyApp",
      attributed: true,
      severity: "RED",
    });
    const leaks = [ATTRIBUTED_SMALL, bigAttributed, noise(0)];

    const rows = renderLeakStacksIos(leaks, undefined, 10)
      .split("\n")
      .filter((l) => l.startsWith("| `"));

    // Both attributed leaks come before the noise, larger one first.
    expect(rows[0]).toContain("`BigModel`");
    expect(rows[1]).toContain("`MyModel`");
    expect(rows[2]).toContain("Malloc");
  });
});

describe("renderLeakStacksIos — capture-mode-aware unattributed note", () => {
  // Same contract as the analyze/combined reports. A malloc_stack_logging capture
  // (flag threaded from the session) must not blame --attach for the unattributed
  // rest. Without malloc stack logging, Instruments records a backtrace for each
  // object allocated after the start, on a Mac app and on an iOS simulator app,
  // so no capture has "no malloc-stack history", and an attributed group does not
  // prove malloc stack logging.
  it("does not claim --attach for a malloc capture with zero attributed groups", () => {
    const out = renderLeakStacksIos([noise(0)], undefined, 10, true);
    expect(out).toContain("unattributed");
    expect(out).not.toContain("--attach");
    expect(out).toContain("malloc stack logging");
  });

  it("does not claim malloc stack logging from attributed groups when the capture mode is unknown", () => {
    const out = renderLeakStacksIos([ATTRIBUTED_SMALL, noise(0)], undefined, 10, null);
    expect(out).toContain(
      "> 🟡 **1 unattributed leak group(s)** (5 object(s), 97.7 KB): responsible frame " +
        "`<Call stack limit reached>`, no library. " +
        UNATTRIBUTED_WITHOUT_MALLOC_LOGGING
    );
    expect(out).not.toContain("malloc stack logging was active");
    expect(out).not.toContain("--attach");
  });

  it("reads attributed groups from the FULL capture, not the filtered slice", () => {
    // The filter matches only unattributed noise, but the capture DID attribute
    // MyModel, so --attach with "no malloc-stack history" must not be blamed.
    const out = renderLeakStacksIos([ATTRIBUTED_SMALL, noise(0)], "Malloc", 10, null);
    expect(out).toContain(UNATTRIBUTED_WITHOUT_MALLOC_LOGGING);
    expect(out).not.toContain("--attach");
  });

  it("names the malloc capture when malloc_stack_logging was on and some groups were attributed", () => {
    const out = renderLeakStacksIos([ATTRIBUTED_SMALL, noise(0)], undefined, 10, true);
    expect(out).toContain("malloc stack logging was active");
    expect(out).not.toContain(UNATTRIBUTED_WITHOUT_MALLOC_LOGGING);
  });

  it("does not claim malloc stack logging from attributed groups of an attach capture", () => {
    // An iOS simulator app recorded under `xctrace --attach` without
    // malloc_stack_logging (Xcode 27.2, iOS 27.0) had a responsible frame for
    // the objects it leaked during the recording. The note must not claim malloc
    // stack logging, nor "no malloc-stack history" right above such a row.
    const out = renderLeakStacksIos([ATTRIBUTED_SMALL, noise(0)], undefined, 10, false);
    expect(out).toContain(UNATTRIBUTED_WITHOUT_MALLOC_LOGGING);
    expect(out).not.toContain("malloc stack logging was active");
    expect(out).not.toContain("--attach");
  });

  it("escapes '|' in table cells so demangled operator frames can't break the row", () => {
    const pipeLeak = leak({
      objectType: "LeakySpan",
      totalSizeBytes: 3072,
      count: 3,
      responsibleFrame: "folly::operator|(folly::Range<char const*>, folly::Range<char const*>)",
      responsibleLibrary: "folly",
      attributed: true,
      severity: "RED",
    });
    const out = renderLeakStacksIos([pipeLeak], undefined, 10, true);
    const header = out.split("\n").find((l) => l.startsWith("| Object Type"));
    const row = out.split("\n").find((l) => l.includes("folly::operator"));
    expect(row).toBeDefined();
    expect(row).toContain("operator\\|");
    const unescapedPipes = (s: string) => s.split(/(?<!\\)\|/).length;
    expect(unescapedPipes(row!)).toBe(unescapedPipes(header!));
  });
});

describe("renderLeakStacksIos without malloc stack logging", () => {
  // Without malloc stack logging, Instruments still records a backtrace for each
  // object allocated after the start, on a Mac app and on an iOS simulator app.
  it("says only newer objects have a backtrace, and does not claim malloc stack logging", () => {
    // Also with no attributed group.
    for (const leaks of [[ATTRIBUTED_SMALL, noise(0)], [noise(0)]])
      for (const mallocStackLogging of [false, null]) {
        const out = renderLeakStacksIos(leaks, undefined, 10, mallocStackLogging, true);
        expect(out).toContain(
          "`<Call stack limit reached>`, no library. " + UNATTRIBUTED_WITHOUT_MALLOC_LOGGING
        );
        expect(out).toContain("`malloc_stack_logging: true`");
        expect(out).not.toContain("malloc stack logging was active");
        expect(out).not.toContain("--attach");
      }
  });

  it("keeps the malloc capture's note when malloc_stack_logging was on", () => {
    const out = renderLeakStacksIos([noise(0)], undefined, 10, true, true);
    expect(out).toContain("ran with malloc stack logging enabled");
    expect(out).not.toContain(UNATTRIBUTED_WITHOUT_MALLOC_LOGGING);
  });
});

describe("renderLeakStacksIos — leaks of system libraries", () => {
  it("lists the app's leaks before the larger ones of system libraries, and says what those are", () => {
    const system = (i: number) =>
      leak({
        objectType: `NSXPCInterface ${i}`,
        totalSizeBytes: 50_000 + i,
        responsibleFrame: "+[NSXPCInterface interfaceWithProtocol:]",
        responsibleLibrary: "Foundation",
        attributed: true,
        systemLibrary: true,
        severity: "YELLOW",
      });
    const out = renderLeakStacksIos([system(1), system(2), ATTRIBUTED_SMALL], undefined, 2);

    const rows = out.split("\n").filter((l) => l.startsWith("| `"));
    expect(rows[0]).toContain("`MyModel`");
    expect(rows).toHaveLength(2);
    expect(out).toContain("**1 leak group(s) from system libraries** (1 object(s); `Foundation`)");
  });
});

describe("renderLeakStacksIos — a template without the Allocations instrument", () => {
  it("says that the template has no Allocations instrument, not that malloc stack logging was off", () => {
    const nullLeak = (objectType: string) =>
      leak({ objectType, responsibleFrame: "(null)", responsibleLibrary: "(null)" });
    const out = renderLeakStacksIos(
      [nullLeak("ProfLeakNodeA"), nullLeak("NSSet")],
      undefined,
      10,
      null,
      true
    );
    expect(out).toContain(
      "**2 unattributed leak group(s)** (2 object(s), 32 B): responsible frame `(null)`, " +
        "no library. The template of this recording has no Allocations instrument"
    );
    expect(out).not.toContain("malloc_stack_logging");
    expect(out).not.toContain("xctrace --attach");
  });

  it("is not said for a recording with the bundled template", () => {
    const nullGroup = leak({
      objectType: "Malloc 32 Bytes",
      responsibleFrame: "(null)",
      responsibleLibrary: "(null)",
    });
    const bundled = renderLeakStacksIos([nullGroup], undefined, 10, true, true, false);
    expect(bundled).toContain("unattributed");
    expect(bundled).not.toContain("no Allocations instrument");
    expect(renderLeakStacksIos([nullGroup], undefined, 10, true, true, true)).toContain(
      "no Allocations instrument"
    );
  });

  it("is not said for a `(null)` group next to attributed groups", () => {
    const nullGroup = leak({
      objectType: "Malloc 32 Bytes",
      responsibleFrame: "(null)",
      responsibleLibrary: "(null)",
    });
    const out = renderLeakStacksIos([ATTRIBUTED_SMALL, nullGroup], undefined, 10, true, true);
    expect(out).toContain("unattributed");
    expect(out).not.toContain("no Allocations instrument");
    expect(out).not.toContain("<Call stack limit reached>");
  });
});
