import { describe, it, expect } from "vitest";
import { dismissLogboxTool } from "../../src/tools/debugger/dismiss-logbox";

describe("dismiss-logbox tool definition", () => {
  it("has the expected id", () => {
    expect(dismissLogboxTool.id).toBe("dismiss-logbox");
  });

  it("is marked alwaysLoad", () => {
    expect(dismissLogboxTool.alwaysLoad).toBe(true);
  });

  it("defaults port to 8081", () => {
    const parsed = dismissLogboxTool.zodSchema.parse({ device_id: "abc-123" });
    expect(parsed.port).toBe(8081);
  });

  it("requires device_id", () => {
    expect(() => dismissLogboxTool.zodSchema.parse({})).toThrow();
  });

  it("resolves services to the JsRuntimeDebugger URN", () => {
    const services = dismissLogboxTool.services!({ port: 8081, device_id: "device-xyz" });
    expect(services).toEqual({
      debugger: "JsRuntimeDebugger:8081:device-xyz",
    });
  });

  it("uses the provided port when not default", () => {
    const services = dismissLogboxTool.services!({ port: 9090, device_id: "device-xyz" });
    expect(services).toEqual({
      debugger: "JsRuntimeDebugger:9090:device-xyz",
    });
  });
});
