import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * The blueprints (js-runtime-debugger, network-inspector, react-profiler-session)
 * all define an inline `warnOnError` closure with the same shape:
 *
 *   const warnOnError = (label: string) => (err: unknown) => {
 *     const msg = err instanceof Error ? err.message : String(err);
 *     process.stderr.write(`[Namespace:${port}] ${label} failed (non-fatal): ${msg}\n`);
 *   };
 *
 * Since invoking the real blueprint factories requires a live Metro/CDP connection,
 * we test the pattern directly by replicating the closure and capturing stderr.
 */

function createWarnOnError(namespace: string, port: number) {
  return (label: string) => (err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[${namespace}:${port}] ${label} failed (non-fatal): ${msg}\n`);
  };
}

let stderrSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(() => {
  stderrSpy.mockRestore();
});

describe("warnOnError pattern", () => {
  it("writes formatted warning to stderr for an Error object", () => {
    const warnOnError = createWarnOnError("JsRuntimeDebugger", 8081);
    warnOnError("DISABLE_LOGBOX_SCRIPT")(new Error("expression evaluation timed out"));

    expect(stderrSpy).toHaveBeenCalledOnce();
    const output = stderrSpy.mock.calls[0]![0] as string;
    expect(output).toBe(
      "[JsRuntimeDebugger:8081] DISABLE_LOGBOX_SCRIPT failed (non-fatal): expression evaluation timed out\n"
    );
  });

  it("coerces non-Error values to string", () => {
    const warnOnError = createWarnOnError("NetworkInspector", 8081);
    warnOnError("NETWORK_INTERCEPTOR_SCRIPT")("string error");

    const output = stderrSpy.mock.calls[0]![0] as string;
    expect(output).toBe(
      "[NetworkInspector:8081] NETWORK_INTERCEPTOR_SCRIPT failed (non-fatal): string error\n"
    );
  });

  it("handles undefined/null coercion", () => {
    const warnOnError = createWarnOnError("ReactProfilerSession", 3000);
    warnOnError("Profiler.enable")(undefined);

    const output = stderrSpy.mock.calls[0]![0] as string;
    expect(output).toContain("failed (non-fatal): undefined");
  });

  it("works as a .catch() handler (receives single argument)", async () => {
    const warnOnError = createWarnOnError("JsRuntimeDebugger", 8081);

    await Promise.reject(new Error("CDP not connected")).catch(warnOnError("Runtime.enable"));

    expect(stderrSpy).toHaveBeenCalledOnce();
    const output = stderrSpy.mock.calls[0]![0] as string;
    expect(output).toContain("[JsRuntimeDebugger:8081] Runtime.enable failed (non-fatal):");
    expect(output).toContain("CDP not connected");
  });

  it("ignore pattern swallows silently (no stderr output)", async () => {
    const ignore = () => {};
    await Promise.reject(new Error("not important")).catch(ignore);

    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it("matches the exact format used by each blueprint namespace", () => {
    const namespaces = [
      { ns: "JsRuntimeDebugger", label: "DISABLE_LOGBOX_SCRIPT" },
      { ns: "NetworkInspector", label: "NETWORK_INTERCEPTOR_SCRIPT" },
      { ns: "ReactProfilerSession", label: "FIBER_ROOT_TRACKER_SCRIPT" },
    ];

    for (const { ns, label } of namespaces) {
      stderrSpy.mockClear();
      const warnOnError = createWarnOnError(ns, 8081);
      warnOnError(label)(new Error("test"));

      const output = stderrSpy.mock.calls[0]![0] as string;
      const expected = `[${ns}:8081] ${label} failed (non-fatal): test\n`;
      expect(output).toBe(expected);
    }
  });
});
