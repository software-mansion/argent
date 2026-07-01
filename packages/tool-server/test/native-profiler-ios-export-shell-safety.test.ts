import { describe, it, expect, vi } from "vitest";

// Records every child_process invocation the trace exporter makes so the test
// can assert how the trace-file path (which feeds the on-disk output path and
// is interpolated into every `xctrace export` invocation) is passed.
const rec = vi.hoisted(() => ({
  calls: [] as { fn: string; file: string; args: string[] }[],
}));

vi.mock("child_process", () => ({
  // export.ts shells out via promisify(execFile). The callback form is
  // (file, args, options?, cb) — record the argv and return canned stdout.
  execFile: (file: string, args: string[], ...rest: unknown[]) => {
    rec.calls.push({ fn: "execFile", file, args });
    const cb = rest.find((r) => typeof r === "function") as
      | ((e: unknown, r: { stdout: string; stderr: string }) => void)
      | undefined;
    // `--toc` discovery: advertise a known CPU schema so the cpu export runs
    // the TOC-resolved path (not just the brute-force fallback).
    const stdout = args.includes("--toc") ? 'data table schema="time-profile" /' : "";
    cb?.(null, { stdout, stderr: "" });
    return undefined;
  },
  // A regression back to shell interpolation would route the command (with the
  // trace path baked into the string) through exec / execSync — fail loudly.
  exec: (cmd: string, ...rest: unknown[]) => {
    rec.calls.push({ fn: "exec", file: String(cmd), args: [] });
    const cb = rest.find((r) => typeof r === "function") as ((e: unknown) => void) | undefined;
    cb?.(new Error(`exec must not be used here (shell-injection risk): ${cmd}`));
  },
  execSync: (cmd: string) => {
    rec.calls.push({ fn: "execSync", file: String(cmd), args: [] });
    throw new Error(`execSync must not be used here (shell-injection risk): ${cmd}`);
  },
  spawn: () => {
    throw new Error("spawn not expected in this test");
  },
}));

import { exportIosTraceData } from "../src/utils/ios-profiler/export";

describe("native iOS profiler: trace-export shell-injection guard", () => {
  it("passes a hostile trace path only as discrete argv elements (never via a shell)", async () => {
    rec.calls.length = 0;
    // A path loaded with shell metacharacters: if any export ever went through
    // /bin/sh, this would break out of the command. As an argv element it is inert.
    const hostileTrace = '/tmp/a b"; touch /tmp/argent-pwned #.trace';

    await exportIosTraceData(hostileTrace);

    // Nothing was routed through a shell.
    expect(rec.calls.every((c) => c.fn === "execFile")).toBe(true);
    expect(rec.calls.some((c) => c.fn === "exec" || c.fn === "execSync")).toBe(false);

    // Every xctrace invocation ran the real binary (not a shell) and carried the
    // hostile path as an exact, standalone argv element — never concatenated
    // into a string a shell could re-parse.
    expect(rec.calls.length).toBeGreaterThan(0);
    for (const c of rec.calls) {
      expect(c.file).toBe("xctrace");
    }
    const exportCalls = rec.calls.filter((c) => c.args.includes("--input"));
    expect(exportCalls.length).toBeGreaterThanOrEqual(1);
    for (const c of exportCalls) {
      // The verb is its own argv token and the path sits in its own --input
      // slot — never fused into one "export --input <path> …" string a shell
      // could re-parse. (The --output path is derived from the input basename,
      // so it legitimately carries the same characters; both are inert as argv.)
      expect(c.args[0]).toBe("export");
      const inputIdx = c.args.indexOf("--input");
      expect(c.args[inputIdx + 1]).toBe(hostileTrace);
    }
  });
});
