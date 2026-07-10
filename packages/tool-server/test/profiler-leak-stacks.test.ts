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
  // Same contract as the analyze/combined reports: the "captured under
  // `xctrace --attach`" framing is only apt when the capture actually attached.
  // A malloc_stack_logging capture (flag threaded from the session) or a
  // capture that attributed ANY group (a frame is only ever recorded under
  // malloc stack logging) must not blame --attach for the unattributed rest.
  it("does not claim --attach for a malloc capture with zero attributed groups", () => {
    const out = renderLeakStacksIos([noise(0)], undefined, 10, true);
    expect(out).toContain("unattributed");
    expect(out).not.toContain("--attach");
    expect(out).toContain("malloc stack logging");
  });

  it("infers malloc mode from attributed groups when the capture mode is unknown", () => {
    const out = renderLeakStacksIos([ATTRIBUTED_SMALL, noise(0)], undefined, 10, null);
    expect(out).not.toContain("--attach");
  });

  it("infers from the FULL capture, not the filtered slice", () => {
    // The filter matches only unattributed noise, but the capture DID attribute
    // MyModel — so malloc logging was on and --attach must not be blamed.
    const out = renderLeakStacksIos([ATTRIBUTED_SMALL, noise(0)], "Malloc", 10, null);
    expect(out).toContain("unattributed");
    expect(out).not.toContain("--attach");
  });

  it("keeps the --attach note for an attach capture", () => {
    const out = renderLeakStacksIos([noise(0)], undefined, 10, false);
    expect(out).toContain("xctrace --attach");
  });

  it("attribution evidence outranks an explicit attach flag", () => {
    // The flag says how ARGENT captured; a recorded frame proves the target
    // process itself ran under malloc stack logging (e.g. launched with the
    // Xcode scheme diagnostic, then attached to). The note must not claim "no
    // malloc-stack history" right above a row with a full responsible frame.
    const out = renderLeakStacksIos([ATTRIBUTED_SMALL, noise(0)], undefined, 10, false);
    expect(out).toContain("unattributed");
    expect(out).not.toContain("--attach");
  });
});
