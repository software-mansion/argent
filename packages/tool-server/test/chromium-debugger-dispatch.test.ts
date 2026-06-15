import { describe, it, expect } from "vitest";
import {
  DEBUGGER_TOOL_CAPABILITY,
  RN_ONLY_TOOL_CAPABILITY,
  debuggerServiceRef,
} from "../src/tools/debugger/debugger-service-ref";
import { CHROMIUM_JS_RUNTIME_DEBUGGER_NAMESPACE } from "../src/blueprints/chromium-js-runtime-debugger";
import { assertSupported, UnsupportedOperationError } from "../src/utils/capability";
import { resolveDevice } from "../src/utils/device-info";

// All tools that must reject Chromium at the HTTP capability gate. Pull the
// ToolDefinition directly so any future drift (someone re-adds an `chromium:`
// block on one of these) breaks this single test instead of slipping into a
// release. Kept exhaustive on purpose — a per-tool assertion is cheap and the
// list is the contract.
import { debuggerComponentTreeTool } from "../src/tools/debugger/debugger-component-tree";
import { debuggerReloadMetroTool } from "../src/tools/debugger/debugger-reload-metro";
import { debuggerInspectElementTool } from "../src/tools/debugger/debugger-inspect-element";
import { networkLogsTool } from "../src/tools/network/network-logs";
import { networkRequestTool } from "../src/tools/network/network-request";
import { reactProfilerAnalyzeTool } from "../src/tools/profiler/react/react-profiler-analyze";
import { reactProfilerComponentSourceTool } from "../src/tools/profiler/react/react-profiler-component-source";
import { reactProfilerCpuSummaryTool } from "../src/tools/profiler/react/react-profiler-cpu-summary";
import { reactProfilerFiberTreeTool } from "../src/tools/profiler/react/react-profiler-fiber-tree";
import { reactProfilerRendersTool } from "../src/tools/profiler/react/react-profiler-renders";
import { profilerCpuQueryTool } from "../src/tools/profiler/query/profiler-cpu-query";
import { profilerCommitQueryTool } from "../src/tools/profiler/query/profiler-commit-query";
import { profilerStackQueryTool } from "../src/tools/profiler/query/profiler-stack-query";
import { profilerLoadTool } from "../src/tools/profiler/query/profiler-load";
import { profilerCombinedReportTool } from "../src/tools/profiler/combined/profiler-combined-report";

const CHROMIUM_ID = "chromium-cdp-19222";
const IOS_ID = "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA";
const ANDROID_ID = "emulator-5554";

describe("debuggerServiceRef — platform dispatch", () => {
  it("routes an Chromium device id to the ChromiumJsRuntimeDebugger blueprint", () => {
    const ref = debuggerServiceRef({ port: 8081, device_id: CHROMIUM_ID });
    expect(ref).toMatchObject({
      urn: `${CHROMIUM_JS_RUNTIME_DEBUGGER_NAMESPACE}:${CHROMIUM_ID}`,
      options: { device: resolveDevice(CHROMIUM_ID) },
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
    // is ugly but doesn't blow up at the dispatch site. Pre-chromium tests
    // hit this path and relied on it.
    const ref = debuggerServiceRef({ port: 8081 });
    expect(typeof ref).toBe("string");
    expect(ref as string).toMatch(/^JsRuntimeDebugger:8081:/);
  });
});

describe("debugger tool capability gating — chromium", () => {
  const chromiumDevice = resolveDevice(CHROMIUM_ID);
  const iosDevice = resolveDevice(IOS_ID);

  it("DEBUGGER_TOOL_CAPABILITY admits an Chromium device (ported tools)", () => {
    expect(() =>
      assertSupported("debugger-evaluate", DEBUGGER_TOOL_CAPABILITY, chromiumDevice)
    ).not.toThrow();
  });

  it("DEBUGGER_TOOL_CAPABILITY still admits iOS — port did not regress mobile support", () => {
    expect(() =>
      assertSupported("debugger-evaluate", DEBUGGER_TOOL_CAPABILITY, iosDevice)
    ).not.toThrow();
  });

  it("RN_ONLY_TOOL_CAPABILITY rejects an Chromium device (locked-out tools)", () => {
    expect(() =>
      assertSupported("debugger-component-tree", RN_ONLY_TOOL_CAPABILITY, chromiumDevice)
    ).toThrow(UnsupportedOperationError);
  });

  it("RN_ONLY_TOOL_CAPABILITY's rejection message names the tool and platform", () => {
    try {
      assertSupported("react-profiler-renders", RN_ONLY_TOOL_CAPABILITY, chromiumDevice);
      throw new Error("expected throw");
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain("react-profiler-renders");
      expect(msg).toContain("chromium");
      expect(msg).toContain("app");
    }
  });
});

describe("RN-only tool registry — every locked tool actually rejects Chromium", () => {
  const chromiumDevice = resolveDevice("chromium-cdp-19222");

  // Source of truth for what must stay locked. If a tool is added/removed
  // here, the maintainer is making an explicit Chromium-support decision.
  const LOCKED_TOOLS = [
    debuggerComponentTreeTool,
    debuggerReloadMetroTool,
    debuggerInspectElementTool,
    networkLogsTool,
    networkRequestTool,
    reactProfilerAnalyzeTool,
    reactProfilerComponentSourceTool,
    reactProfilerCpuSummaryTool,
    reactProfilerFiberTreeTool,
    reactProfilerRendersTool,
    profilerCpuQueryTool,
    profilerCommitQueryTool,
    profilerStackQueryTool,
    profilerLoadTool,
    profilerCombinedReportTool,
  ];

  it.each(LOCKED_TOOLS.map((t) => [t.id, t] as const))(
    "%s declares a capability and rejects Chromium",
    (_id, tool) => {
      expect(tool.capability).toBeDefined();
      expect(() => assertSupported(tool.id, tool.capability!, chromiumDevice)).toThrow(
        UnsupportedOperationError
      );
    }
  );

  it("matches the spec count — exactly 15 device-bound RN/iOS tools are locked", () => {
    // Add to LOCKED_TOOLS above when locking a new tool; this guards against
    // silent omissions. react-profiler-{start,stop,status} are factory-built
    // and not exported as plain ToolDefinitions, so they're absent here even
    // though they're locked — counted separately in the PR description.
    expect(LOCKED_TOOLS).toHaveLength(15);
  });
});
