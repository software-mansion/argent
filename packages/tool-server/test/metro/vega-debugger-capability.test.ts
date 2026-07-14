import { describe, it, expect } from "vitest";
import { assertSupported, UnsupportedOperationError } from "../../src/utils/capability";
import {
  DEBUGGER_TOOL_CAPABILITY,
  RN_ONLY_TOOL_CAPABILITY,
} from "../../src/tools/debugger/debugger-service-ref";
import type { DeviceInfo } from "@argent/registry";

const vegaVvd: DeviceInfo = { id: "amazon-6b8a76bae9485138", platform: "vega", kind: "vvd" };

/**
 * Vega's React Native is a fork of RN 0.72, so it serves the *legacy* Hermes
 * inspector. That runtime supports Runtime.evaluate but silently no-ops
 * Runtime.addBinding (it ACKs the command, never installs the binding, and never
 * emits bindingCalled). The split below encodes exactly that.
 */
describe("Vega (RN 0.72) debugger capability", () => {
  it("allows the Runtime.evaluate-only debugger tools on a Vega VVD", () => {
    // debugger-connect / -status / -evaluate / -log-registry, view-network-logs,
    // view-network-request-details. The network inspector belongs here because it
    // monkey-patches fetch over Runtime.evaluate rather than using CDP Network.
    expect(() =>
      assertSupported("debugger-status", DEBUGGER_TOOL_CAPABILITY, vegaVvd)
    ).not.toThrow();
  });

  it("rejects the binding-dependent tools on a Vega VVD", () => {
    // debugger-component-tree / -inspect-element / -reload-metro, react-profiler-*.
    // These need Runtime.addBinding, which RN 0.72's Hermes never implements, so
    // they must fail fast rather than hang until the binding times out.
    expect(() =>
      assertSupported("debugger-component-tree", RN_ONLY_TOOL_CAPABILITY, vegaVvd)
    ).toThrow(UnsupportedOperationError);
  });

  it("does not regress the existing platforms", () => {
    const iosSim: DeviceInfo = { id: "x", platform: "ios", kind: "simulator" };
    const androidEmu: DeviceInfo = { id: "y", platform: "android", kind: "emulator" };
    for (const device of [iosSim, androidEmu]) {
      expect(() =>
        assertSupported("debugger-status", DEBUGGER_TOOL_CAPABILITY, device)
      ).not.toThrow();
      expect(() =>
        assertSupported("debugger-component-tree", RN_ONLY_TOOL_CAPABILITY, device)
      ).not.toThrow();
    }
  });
});
