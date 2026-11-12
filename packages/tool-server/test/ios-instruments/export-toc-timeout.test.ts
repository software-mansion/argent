import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * A trace that holds next to no data (the app crashed or quit early) takes
 * xctrace minutes to export, table of contents included. When even the table
 * of contents runs out of time, the stop exports nothing more: each later
 * export would wait out its own timeout too.
 */
const behaviour = vi.hoisted(() => ({
  toc: "ok" as "ok" | "timeout" | "error",
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
    const stdout = args.includes("--toc") ? '<table schema="time-profile"/>' : "";
    cb?.(null, { stdout, stderr: "" });
    return undefined;
  },
}));

import { exportIosTraceData } from "../../src/utils/ios-profiler/export";

const TRACE = "/tmp/native-profiler-20260101-000000.trace";

beforeEach(() => {
  behaviour.calls.length = 0;
});

describe("exportIosTraceData when the table of contents export", () => {
  it("times out, exports nothing more and says why for every table", async () => {
    behaviour.toc = "timeout";
    const { files, diagnostics } = await exportIosTraceData(TRACE);

    expect(behaviour.calls).toHaveLength(1);
    expect(behaviour.calls[0]).toContain("--toc");
    expect(files).toEqual({ cpu: null, hangs: null, leaks: null });
    for (const key of ["cpu", "hangs", "leaks"]) {
      expect(diagnostics.errors[key]).toContain("could not list the trace's tables within 60 s");
    }
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
