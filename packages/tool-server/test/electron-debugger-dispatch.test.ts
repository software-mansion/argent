import { describe, it, expect } from "vitest";
import {
  DEBUGGER_TOOL_CAPABILITY,
  RN_ONLY_TOOL_CAPABILITY,
  debuggerServiceRef,
} from "../src/tools/debugger/debugger-service-ref";
import { ELECTRON_JS_RUNTIME_DEBUGGER_NAMESPACE } from "../src/blueprints/electron-js-runtime-debugger";
import { assertSupported, UnsupportedOperationError } from "../src/utils/capability";
import { resolveDevice } from "../src/utils/device-info";

const ELECTRON_ID = "electron-cdp-19222";
const IOS_ID = "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA";
const ANDROID_ID = "emulator-5554";

describe("debuggerServiceRef — platform dispatch", () => {
  it("routes an Electron device id to the ElectronJsRuntimeDebugger blueprint", () => {
    const ref = debuggerServiceRef({ port: 8081, device_id: ELECTRON_ID });
    expect(ref).toMatchObject({
      urn: `${ELECTRON_JS_RUNTIME_DEBUGGER_NAMESPACE}:${ELECTRON_ID}`,
      options: { device: resolveDevice(ELECTRON_ID) },
    });
  });

  it("routes an iOS UDID to the Metro-driven JsRuntimeDebugger blueprint", () => {
    const ref = debuggerServiceRef({ port: 8081, device_id: IOS_ID });
    expect(ref).toBe(`JsRuntimeDebugger:8081:${IOS_ID}`);
  });

  it("routes an Android serial to the Metro-driven JsRuntimeDebugger blueprint", () => {
    const ref = debuggerServiceRef({ port: 8082, device_id: ANDROID_ID });
    expect(ref).toBe(`JsRuntimeDebugger:8082:${ANDROID_ID}`);
  });

  it("tolerates a missing device_id — falls back to Metro URN so existing callers don't crash", () => {
    // Mirrors the original template-literal behavior: `JsRuntimeDebugger:8081:undefined`
    // is ugly but doesn't blow up at the dispatch site. Pre-electron tests
    // hit this path and relied on it.
    const ref = debuggerServiceRef({ port: 8081 });
    expect(typeof ref).toBe("string");
    expect(ref as string).toMatch(/^JsRuntimeDebugger:8081:/);
  });
});

describe("debugger tool capability gating — electron", () => {
  const electronDevice = resolveDevice(ELECTRON_ID);
  const iosDevice = resolveDevice(IOS_ID);

  it("DEBUGGER_TOOL_CAPABILITY admits an Electron device (ported tools)", () => {
    expect(() =>
      assertSupported("debugger-evaluate", DEBUGGER_TOOL_CAPABILITY, electronDevice)
    ).not.toThrow();
  });

  it("DEBUGGER_TOOL_CAPABILITY still admits iOS — port did not regress mobile support", () => {
    expect(() =>
      assertSupported("debugger-evaluate", DEBUGGER_TOOL_CAPABILITY, iosDevice)
    ).not.toThrow();
  });

  it("RN_ONLY_TOOL_CAPABILITY rejects an Electron device (locked-out tools)", () => {
    expect(() =>
      assertSupported("debugger-component-tree", RN_ONLY_TOOL_CAPABILITY, electronDevice)
    ).toThrow(UnsupportedOperationError);
  });

  it("RN_ONLY_TOOL_CAPABILITY's rejection message names the tool and platform", () => {
    try {
      assertSupported("react-profiler-renders", RN_ONLY_TOOL_CAPABILITY, electronDevice);
      throw new Error("expected throw");
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain("react-profiler-renders");
      expect(msg).toContain("electron");
      expect(msg).toContain("app");
    }
  });
});
