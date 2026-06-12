import { describe, it, expect } from "vitest";
import { TraceProcessorUnavailableError } from "../src/errors.js";

describe("TraceProcessorUnavailableError", () => {
  it("wasm_load_failed describes the engine-load failure and embeds the cause", () => {
    const cause = new Error("LinkError: instantiate failed");
    const err = new TraceProcessorUnavailableError("wasm_load_failed", {
      version: "v55.3",
      cause,
    });
    expect(err.kind).toBe("wasm_load_failed");
    expect(err.version).toBe("v55.3");
    expect(err.cause).toBe(cause);
    expect(err.message).toContain("Perfetto v55.3");
    expect(err.message).toContain("WASM engine");
    // Surfaces the underlying cause message so the failure isn't opaque.
    expect(err.message).toContain("instantiate failed");
    // Points at the escape hatch instead of a download command.
    expect(err.message).toContain("ARGENT_TRACE_PROCESSOR_WASM");
  });

  it("wasm_path_invalid embeds the offending override path and stays instanceof", () => {
    const err = new TraceProcessorUnavailableError("wasm_path_invalid", {
      path: "/bad/path/trace_processor.wasm",
    });
    expect(err.kind).toBe("wasm_path_invalid");
    expect(err.path).toBe("/bad/path/trace_processor.wasm");
    expect(err.message).toContain("/bad/path/trace_processor.wasm");
    expect(err.message).toContain("ARGENT_TRACE_PROCESSOR_WASM");
    expect(err).toBeInstanceOf(TraceProcessorUnavailableError);
    expect(err).toBeInstanceOf(Error);
  });

  it("wasm_load_failed reads cleanly with no version and no cause", () => {
    const err = new TraceProcessorUnavailableError("wasm_load_failed");
    expect(err.message).toContain("WASM engine");
    expect(err.message).not.toContain("Perfetto undefined");
  });
});
