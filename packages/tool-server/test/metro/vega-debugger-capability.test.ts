import { describe, it, expect } from "vitest";
import { Registry } from "@argent/registry";
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
import { debuggerStatusTool } from "../../src/tools/debugger/debugger-status";
import { debuggerEvaluateTool } from "../../src/tools/debugger/debugger-evaluate";
import { debuggerLogRegistryTool } from "../../src/tools/debugger/debugger-log-registry";
import { debuggerComponentTreeTool } from "../../src/tools/debugger/debugger-component-tree";
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

// react-profiler-{start,stop,status} are factory-built (they close over the
// registry to reach the profiler session), so they can only be inspected by
// constructing them the way setup-registry.ts does. Their capability does not
// depend on the registry instance.
const registry = new Registry();

/**
 * Enabled on a Vega VVD. Vega's React Native is a fork of RN 0.72, so it serves
 * the legacy Hermes inspector, which speaks Runtime + Debugger. Everything here
 * needs nothing beyond `Runtime.evaluate` — including the network inspector,
 * which monkey-patches `fetch` over `Runtime.evaluate` rather than using the CDP
 * `Network` domain. All six verified working on a live VVD.
 */
const VEGA_ENABLED_TOOLS = [
  debuggerConnectTool,
  debuggerStatusTool,
  debuggerEvaluateTool,
  debuggerLogRegistryTool,
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
  debuggerComponentTreeTool,
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
