import { EventEmitter } from "node:events";
import { describe, it, expect } from "vitest";
import { Registry, TypedEventEmitter } from "@argent/registry";
import { jsCapturesOn, networkInspectorBlueprint } from "../../src/blueprints/network-inspector";
import {
  NETWORK_INTERCEPTOR_SCRIPT,
  makeNetworkCaptureControlScript,
} from "../../src/utils/debugger/scripts/network-interceptor";
import { createRegistry } from "../../src/utils/setup-registry";
import { assertSupported, UnsupportedOperationError } from "../../src/utils/capability";
import { resolveDevice } from "../../src/utils/device-info";
import {
  DEBUGGER_TOOL_CAPABILITY,
  RN_ONLY_TOOL_CAPABILITY,
} from "../../src/tools/debugger/debugger-service-ref";

// Import the real ToolDefinitions rather than hand-pairing a tool name with a
// capability constant: the HTTP gate does `assertSupported(def.id, def.capability,
// device)` (src/http.ts), so the definition's own `capability` field is the only
// thing that decides. Asserting against it means a tool that imports the WRONG
// constant breaks this test instead of shipping.
import { debuggerConnectTool } from "../../src/tools/debugger/debugger-connect";
import { createDebuggerStatusTool } from "../../src/tools/debugger/debugger-status";
import { debuggerEvaluateTool } from "../../src/tools/debugger/debugger-evaluate";
import { createDebuggerLogRegistryTool } from "../../src/tools/debugger/debugger-log-registry";
import { createDebuggerComponentTreeTool } from "../../src/tools/debugger/debugger-component-tree";
import { debuggerInspectElementTool } from "../../src/tools/debugger/debugger-inspect-element";
import { debuggerReloadMetroTool } from "../../src/tools/debugger/debugger-reload-metro";
import { networkLogsTool } from "../../src/tools/network/network-logs";
import { networkRequestTool } from "../../src/tools/network/network-request";
import { createReactProfilerStartTool } from "../../src/tools/profiler/react/react-profiler-start";
import { createReactProfilerStopTool } from "../../src/tools/profiler/react/react-profiler-stop";
import { createReactProfilerStatusTool } from "../../src/tools/profiler/react/react-profiler-status";
import { reactProfilerRendersTool } from "../../src/tools/profiler/react/react-profiler-renders";
import { reactProfilerFiberTreeTool } from "../../src/tools/profiler/react/react-profiler-fiber-tree";
import { reactProfilerAnalyzeTool } from "../../src/tools/profiler/react/react-profiler-analyze";
import { reactProfilerCpuSummaryTool } from "../../src/tools/profiler/react/react-profiler-cpu-summary";
import { reactProfilerComponentSourceTool } from "../../src/tools/profiler/react/react-profiler-component-source";
import { profilerLoadTool } from "../../src/tools/profiler/query/profiler-load";
import { profilerCpuQueryTool } from "../../src/tools/profiler/query/profiler-cpu-query";
import { profilerCommitQueryTool } from "../../src/tools/profiler/query/profiler-commit-query";

// `vega device list` reports VVD serials as `amazon-<id>`. Go through the real
// resolveDevice() instead of hand-building a DeviceInfo: if the `amazon-`
// classification regresses, the serial falls through to "android" and every
// assertion below silently changes meaning (the gated tools support Android, so
// they would stop throwing) — the explicit classification test pins that.
const VEGA_VVD_ID = "amazon-6b8a76bae9485138";
const IOS_SIM_ID = "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA";
const ANDROID_EMU_ID = "emulator-5554";

const vegaVvd = resolveDevice(VEGA_VVD_ID);

// react-profiler-{start,stop,status} and debugger-{status,log-registry,component-tree} are
// factory-built (they close over the registry to reach their services), so they
// can only be inspected by constructing them the way setup-registry.ts does.
// Their capability does not depend on the registry instance.
const registry = new Registry();

/**
 * Enabled on a Vega VVD. Vega's React Native is a fork of RN 0.72, so it serves
 * the legacy Hermes inspector, which speaks Runtime + Debugger. Everything here
 * needs nothing beyond `Runtime.evaluate` — including the network inspector,
 * which patches `XMLHttpRequest` over `Runtime.evaluate` rather than using the
 * CDP `Network` domain. All six verified working on a live VVD.
 */
const VEGA_ENABLED_TOOLS = [
  debuggerConnectTool,
  createDebuggerStatusTool(registry),
  debuggerEvaluateTool,
  createDebuggerLogRegistryTool(registry),
  networkLogsTool,
  networkRequestTool,
];

/**
 * Gated off on a Vega VVD, for two distinct reasons:
 *
 *   - `debugger-component-tree` and `debugger-inspect-element` are the only two
 *     callers of `cdp.evaluateWithBinding`, i.e. the only ones that need
 *     `Runtime.addBinding`. Legacy Hermes ACKs `Runtime.addBinding` but never
 *     installs it — verified on a live VVD: after connect, `typeof
 *     __argent_callback` is still "undefined" — so no `bindingCalled` ever fires
 *     and they would hang until timeout.
 *   - `debugger-reload-metro` (Page.reload + an HTTP /reload fallback) and the
 *     `react-profiler-*` / `profiler-*` tools (`Runtime.evaluate` + the CDP
 *     `Profiler` domain) do NOT use the binding. They are gated because they are
 *     unverified against the legacy inspector, not because of a missing binding.
 *
 * Either way the gate turns a hang or an unknown into an immediate 400.
 */
const VEGA_GATED_TOOLS = [
  createDebuggerComponentTreeTool(registry),
  debuggerInspectElementTool,
  debuggerReloadMetroTool,
  createReactProfilerStartTool(registry),
  createReactProfilerStopTool(registry),
  createReactProfilerStatusTool(registry),
  reactProfilerRendersTool,
  reactProfilerFiberTreeTool,
  reactProfilerAnalyzeTool,
  reactProfilerCpuSummaryTool,
  reactProfilerComponentSourceTool,
  profilerLoadTool,
  profilerCpuQueryTool,
  profilerCommitQueryTool,
];

describe("Vega (RN 0.72) debugger capability", () => {
  it("classifies an amazon- serial as a Vega VVD", () => {
    // A regression here would 400 every debugger tool on Vega (or, worse, route
    // the serial to Android and quietly admit the gated ones).
    expect(vegaVvd).toEqual({ id: VEGA_VVD_ID, platform: "vega", kind: "vvd" });
  });

  it.each(VEGA_ENABLED_TOOLS.map((t) => [t.id, t] as const))(
    "%s is allowed on a Vega VVD",
    (_id, tool) => {
      expect(tool.capability).toBeDefined();
      expect(() => assertSupported(tool.id, tool.capability, vegaVvd)).not.toThrow();
    }
  );

  it.each(VEGA_GATED_TOOLS.map((t) => [t.id, t] as const))(
    "%s is rejected on a Vega VVD",
    (_id, tool) => {
      expect(tool.capability).toBeDefined();
      expect(() => assertSupported(tool.id, tool.capability, vegaVvd)).toThrow(
        UnsupportedOperationError
      );
    }
  );

  it("keeps both lists exhaustive — every tool on either matrix is pinned above", () => {
    // Derived from the real registry, not a hardcoded count: a NEW debugger tool
    // that picks up DEBUGGER_TOOL_CAPABILITY lands on Vega the moment it ships,
    // and if it needs Runtime.addBinding it hangs there. It must be listed (and
    // therefore decided about) here.
    const pinned = new Set([...VEGA_ENABLED_TOOLS, ...VEGA_GATED_TOOLS].map((t) => t.id));
    const live = createRegistry();
    const drifted = live
      .getSnapshot()
      .tools.map((id) => live.getTool(id))
      .filter(
        (def) =>
          def &&
          (def.capability === DEBUGGER_TOOL_CAPABILITY ||
            def.capability === RN_ONLY_TOOL_CAPABILITY) &&
          !pinned.has(def.id)
      )
      .map((def) => def!.id);

    expect(drifted).toEqual([]);
  });

  it("does not regress the existing platforms — iOS and Android still get every tool", () => {
    const iosSim = resolveDevice(IOS_SIM_ID);
    const androidEmu = resolveDevice(ANDROID_EMU_ID);
    for (const device of [iosSim, androidEmu]) {
      for (const tool of [...VEGA_ENABLED_TOOLS, ...VEGA_GATED_TOOLS]) {
        expect(() => assertSupported(tool.id, tool.capability, device)).not.toThrow();
      }
    }
  });
});

/**
 * network-capture-start does not cover Vega, so its network reads install the interceptor
 * themselves, at every call, as before the start and stop tools.
 */
describe("Vega network reads", () => {
  /** A registry whose JS runtime answers the interceptor and the read scripts. */
  function vegaRegistry(options: { log: boolean }) {
    const scripts: string[] = [];
    const cdp = {
      events: new EventEmitter(),
      evaluate: async (script: string) => {
        scripts.push(script);
        if (script === NETWORK_INTERCEPTOR_SCRIPT) return JSON.stringify({ installed: true });
        if (script.includes("__argent_network_by_id")) {
          return JSON.stringify(
            options.log
              ? { error: "Request not found" }
              : { error: "Network interceptor not installed", installed: false }
          );
        }
        return JSON.stringify({ entries: [], total: 0, interceptorInstalled: options.log });
      },
    };
    const registry = new Registry();
    registry.registerBlueprint({
      namespace: "JsRuntimeDebugger",
      getURN: (payload: string) => `JsRuntimeDebugger:${payload}`,
      async factory() {
        return {
          api: { port: 8081, cdp },
          dispose: async () => {},
          events: new TypedEventEmitter(),
        };
      },
    });
    registry.registerBlueprint(networkInspectorBlueprint);
    registry.registerTool(networkLogsTool);
    registry.registerTool(networkRequestTool);
    const installs = () => scripts.filter((script) => script === NETWORK_INTERCEPTOR_SCRIPT).length;
    return { registry, scripts, installs };
  }

  it("view-network-logs names the NetworkInspector service", () => {
    expect(networkLogsTool.services({ device_id: VEGA_VVD_ID, pageIndex: "latest" })).toEqual({
      inspector: `NetworkInspector:8081:${VEGA_VVD_ID}`,
    });
  });

  it("view-network-request-details names the NetworkInspector service", () => {
    expect(
      networkRequestTool.services({
        device_id: VEGA_VVD_ID,
        requestId: "rn-net-1",
        includeBody: false,
      })
    ).toEqual({
      inspector: `NetworkInspector:8081:${VEGA_VVD_ID}`,
    });
  });

  it("view-network-logs installs the interceptor at each read, with no capture started", async () => {
    const { registry, scripts, installs } = vegaRegistry({ log: true });

    const first = await registry.invokeTool("view-network-logs", { device_id: VEGA_VVD_ID });
    // The service's factory installs, then the read.
    expect(installs()).toBe(2);
    await registry.invokeTool("view-network-logs", { device_id: VEGA_VVD_ID });
    expect(installs()).toBe(3);

    expect(first).toBe(
      "No network traffic captured. Make sure the app is running and making HTTP requests. Network interception is active: it records XMLHttpRequest (axios included), React Native's fetch, Expo's fetch, and a fetch library that sends through React Native's network module, but not requests sent before capture started (at the first network-tool call)."
    );
    // Vega has no pause to clear, and no capture entry.
    expect(scripts).not.toContain(makeNetworkCaptureControlScript(false));
    expect(jsCapturesOn(VEGA_VVD_ID)).toEqual([]);
    await registry.dispose();
  });

  it("view-network-logs says a reload removed the interceptor and the next read installs it", async () => {
    const { registry } = vegaRegistry({ log: false });

    expect(await registry.invokeTool("view-network-logs", { device_id: VEGA_VVD_ID })).toBe(
      "Network interceptor not installed: the app's JS runtime reloaded, which clears captured requests. Call view-network-logs again to reinstall it, then repeat the action that sends the requests."
    );
    await registry.dispose();
  });

  it("view-network-request-details installs the interceptor at the read", async () => {
    const { registry, installs } = vegaRegistry({ log: true });

    expect(
      await registry.invokeTool("view-network-request-details", {
        device_id: VEGA_VVD_ID,
        requestId: "rn-net-9",
      })
    ).toBe("Request not found. Use view-network-logs to list available requests.");
    expect(installs()).toBe(2);
    await registry.dispose();
  });
});
