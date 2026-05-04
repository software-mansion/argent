import { describe, it, expect } from "vitest";
import { coerceBody } from "../../src/utils/debugger/scripts/network-interceptor";

/**
 * The network interceptor injects coerceBody into the runtime to capture
 * fetch() request bodies. Plain strings should pass through, URLSearchParams
 * should be stringified, and binary types should be tagged with a sentinel
 * so the agent at least knows the body existed instead of seeing nothing.
 */
describe("coerceBody", () => {
  it("returns undefined when body is missing", () => {
    expect(coerceBody(undefined)).toBeUndefined();
    expect(coerceBody(null)).toBeUndefined();
  });

  it("returns the raw string unchanged", () => {
    expect(coerceBody("raw string")).toBe("raw string");
  });

  it("leaves a JSON.stringify result unchanged", () => {
    const json = JSON.stringify({ hello: "world", n: 1 });
    expect(coerceBody(json)).toBe(json);
  });

  it("stringifies URLSearchParams to its form-urlencoded form", () => {
    const params = new URLSearchParams({ a: "1", b: "two" });
    expect(coerceBody(params)).toBe("a=1&b=two");
  });

  it("emits a [FormData] placeholder for FormData", () => {
    const fd = new FormData();
    fd.append("file", "value");
    const out = coerceBody(fd);
    expect(typeof out).toBe("string");
    expect(out!.startsWith("[FormData")).toBe(true);
  });

  it("emits a [Blob] placeholder for Blob", () => {
    const blob = new Blob(["hello"], { type: "text/plain" });
    const out = coerceBody(blob);
    expect(typeof out).toBe("string");
    expect(out!.startsWith("[Blob")).toBe(true);
  });

  it("emits an [ArrayBuffer] placeholder for ArrayBuffer", () => {
    const buf = new ArrayBuffer(8);
    const out = coerceBody(buf);
    expect(typeof out).toBe("string");
    expect(out!.startsWith("[ArrayBuffer")).toBe(true);
  });

  it("falls back to a generic placeholder for unknown body types", () => {
    // Plain object isn't a fetch-spec body type, but should not be silently dropped.
    const out = coerceBody({ unknown: true } as unknown);
    expect(typeof out).toBe("string");
    expect(out!.startsWith("[")).toBe(true);
  });
});

/**
 * The interceptor script is a string template injected into the runtime.
 * Verify the helper is wired up so the same coercion logic runs in-app.
 */
describe("NETWORK_INTERCEPTOR_SCRIPT", () => {
  it("inlines the coerceBody helper so binary bodies are not dropped", async () => {
    const { NETWORK_INTERCEPTOR_SCRIPT } =
      await import("../../src/utils/debugger/scripts/network-interceptor");
    // The script must call coerceBody (or equivalent) on init.body — not the
    // old `typeof init.body === 'string' ? init.body : undefined` shortcut.
    expect(NETWORK_INTERCEPTOR_SCRIPT).toContain("coerceBody");
    expect(NETWORK_INTERCEPTOR_SCRIPT).not.toContain(
      "typeof init.body === 'string') ? init.body : undefined"
    );
  });
});
