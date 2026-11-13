import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * A trace that holds next to no data (the Mac app crashed or quit early) takes
 * xctrace minutes to export, table of contents included. When even the table
 * of contents of such a trace runs out of time, the stop exports nothing more:
 * each later export would wait out its own timeout too. For any other trace
 * (every iOS one), a slow table of contents is no sign of slow tables.
 */
const behaviour = vi.hoisted(() => ({
  toc: "ok" as "ok" | "timeout" | "error",
  summary: "",
  calls: [] as string[][],
}));

vi.mock("child_process", () => ({
  execFile: (_file: string, args: string[], ...rest: unknown[]) => {
    behaviour.calls.push(args);
    const cb = rest.find((r) => typeof r === "function") as
      ((e: unknown, r?: { stdout: string; stderr: string }) => void) | undefined;
    if (args.includes("--toc") && behaviour.toc !== "ok") {
      // What execFile reports when its timeout kills the command, or for an
      // ordinary failure.
      const err = Object.assign(new Error("Command failed: xctrace export --toc"), {
        killed: behaviour.toc === "timeout",
        signal: behaviour.toc === "timeout" ? "SIGTERM" : null,
        code: behaviour.toc === "timeout" ? null : 1,
      });
      cb?.(err);
      return undefined;
    }
    const stdout = args.includes("--toc")
      ? `${behaviour.summary}<table schema="time-profile"/>`
      : "";
    cb?.(null, { stdout, stderr: "" });
    return undefined;
  },
}));

import { exportIosTraceData } from "../../src/utils/ios-profiler/export";

const TRACE = "/tmp/native-profiler-20260101-000000.trace";

beforeEach(() => {
  behaviour.calls.length = 0;
  behaviour.summary = "";
});

describe("exportIosTraceData reads the trace's start and length from the table of contents", () => {
  it("as ms since 1970 and ms", async () => {
    behaviour.toc = "ok";
    behaviour.summary =
      "<summary><start-date>2026-11-13T07:12:38.063+01:00</start-date>" +
      "<end-date>2026-11-13T07:12:46.980+01:00</end-date><duration>8.917049</duration></summary>";
    const { diagnostics } = await exportIosTraceData(TRACE);
    expect(diagnostics.traceStartMs).toBe(Date.UTC(2026, 10, 13, 6, 12, 38, 63));
    expect(diagnostics.traceDurationMs).toBeCloseTo(8917.049, 3);
  });

  it("leaves them out when the table of contents has none", async () => {
    behaviour.toc = "ok";
    const { diagnostics } = await exportIosTraceData(TRACE);
    expect(diagnostics.traceStartMs).toBeUndefined();
    expect(diagnostics.traceDurationMs).toBeUndefined();
  });
});

describe("exportIosTraceData when the table of contents export", () => {
  it("times out after the app ended, exports nothing more and says why for every table", async () => {
    behaviour.toc = "timeout";
    const { files, diagnostics } = await exportIosTraceData(TRACE, true);

    expect(behaviour.calls).toHaveLength(1);
    expect(behaviour.calls[0]).toContain("--toc");
    expect(files).toEqual({ cpu: null, hangs: null, leaks: null });
    for (const key of ["cpu", "hangs", "leaks"]) {
      expect(diagnostics.errors[key]).toContain("could not list the trace's tables within 60 s");
    }
    expect(diagnostics.errors.toc).toContain("Command failed");
  });

  it("times out while the app runs, still tries the CPU schemas and the other tables", async () => {
    behaviour.toc = "timeout";
    const { files, diagnostics } = await exportIosTraceData(TRACE);

    // As for any failed table of contents: the CPU schemas by brute force (the
    // first one exports here), hangs and leaks.
    expect(behaviour.calls).toHaveLength(4);
    expect(behaviour.calls[1]).toContain(
      '/trace-toc/run[@number="1"]/data/table[@schema="time-profile"]'
    );
    expect(files.cpu).not.toBeNull();
    expect(files.hangs).not.toBeNull();
    expect(files.leaks).not.toBeNull();
    expect(diagnostics.skipped).toBeUndefined();
    expect(diagnostics.errors.toc).toContain("Command failed");
  });

  it("fails for another reason, still tries the CPU schemas and the other tables", async () => {
    behaviour.toc = "error";
    const { files } = await exportIosTraceData(TRACE);

    // The table of contents, then the CPU schemas by brute force (the first
    // one exports here), hangs and leaks.
    expect(behaviour.calls).toHaveLength(4);
    expect(behaviour.calls[1]).toContain(
      '/trace-toc/run[@number="1"]/data/table[@schema="time-profile"]'
    );
    expect(files.cpu).not.toBeNull();
    expect(files.hangs).not.toBeNull();
    expect(files.leaks).not.toBeNull();
  });

  it("succeeds, exports the CPU table it names, hangs and leaks", async () => {
    behaviour.toc = "ok";
    const { files, diagnostics } = await exportIosTraceData(TRACE);

    expect(behaviour.calls).toHaveLength(4);
    expect(diagnostics.cpuSchemaUsed).toBe("time-profile");
    expect(files.cpu).toMatch(/_raw_cpu\.xml$/);
  });
});
