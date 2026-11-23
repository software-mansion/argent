import { describe, it, expect } from "vitest";
import { patchGlueForNode } from "../src/wasm-trace-processor.js";

// The two lines of Perfetto's v59 engine_bundle.js that patchGlueForNode edits.
const GLUE = ["this.useMemory64 = memory64Supported();", "var wasmBridge = new WasmBridge();"].join(
  "\n"
);

describe("patchGlueForNode", () => {
  it("forces memory32 and exposes the bridge", () => {
    const out = patchGlueForNode(GLUE);
    expect(out).toContain("this.useMemory64 = false;");
    expect(out).not.toContain("memory64Supported()");
    expect(out).toContain("globalThis.__TP_bridge = wasmBridge;");
  });

  it("throws when an anchor is missing, so glue drift fails loudly", () => {
    // The v55 glue shape.
    const old = "const wasmBridge = new wasm_bridge_1.WasmBridge();";
    expect(() => patchGlueForNode(old)).toThrow(/anchor not found/);
  });
});
