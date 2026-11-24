import { afterEach, describe, expect, it, vi } from "vitest";
import { networkLogsTool } from "../../src/tools/network/network-logs";
import { networkRequestTool } from "../../src/tools/network/network-request";
import {
  forgetJsCapturesOf,
  jsCapturePayload,
  setJsCapture,
} from "../../src/blueprints/network-inspector";
import {
  makeNetworkDetailReadScript,
  makeNetworkLogReadScript,
} from "../../src/utils/debugger/scripts/network-interceptor";

/**
 * A React Native Mac app's JS reads follow the iOS and Android model: a read never installs the
 * interceptor. Before network-capture-start it reaches nothing in the app and names the start;
 * after one it reads through the debugger that the start opened.
 */
const MAC = "macos-app-com.example.app";
const APP = "com.example.app";
const PAYLOAD = jsCapturePayload(8081, MAC);

const logsParams = { device_id: MAC, pageIndex: "latest" } as const;
const detailsParams = { device_id: MAC, requestId: "rn-net-1", includeBody: true } as const;

afterEach(() => {
  forgetJsCapturesOf();
});

describe("JS network reads on a Mac app", () => {
  it.each([
    ["view-network-logs", networkLogsTool, logsParams],
    ["view-network-request-details", networkRequestTool, detailsParams],
  ] as const)(
    "%s before network-capture-start resolves no service and says capture is not started",
    async (_, tool, params) => {
      expect(tool.services!(params as never)).toEqual({});
      expect(await tool.execute!({}, params as never)).toContain(
        "Network capture is not started for this app, so no requests are recorded. Call network-capture-start with udid and bundleId"
      );
    }
  );

  it("after a start, both reads resolve the start's debugger and read through it, installing nothing", async () => {
    setJsCapture(PAYLOAD, {
      bundleId: APP,
      intent: "started",
      mark: { install: null },
      installed: true,
      physicalDeviceId: MAC,
    });
    for (const [tool, params] of [
      [networkLogsTool, logsParams],
      [networkRequestTool, detailsParams],
    ] as const) {
      expect(tool.services!(params as never)).toEqual({
        debugger: { urn: `JsRuntimeDebugger:${PAYLOAD}`, options: { physicalDeviceId: MAC } },
      });
    }
    const entry = {
      requestId: "rn-net-1",
      state: "complete",
      request: { url: "https://api.test/a", method: "GET", headers: {} },
      response: { url: "https://api.test/a", status: 200, headers: {}, mimeType: "text/plain" },
    };
    const detailScript = makeNetworkDetailReadScript("rn-net-1");
    const evaluate = vi.fn(async (script: string) =>
      JSON.stringify(
        script === detailScript
          ? entry
          : { entries: [{ id: 1, ...entry }], total: 1, interceptorInstalled: true }
      )
    );
    const services = { debugger: { cdp: { evaluate }, runtimeApp: { appId: APP } } };

    expect(await networkLogsTool.execute!(services, logsParams as never)).toBe(
      '=== NETWORK LOGS (page 1/1, 1 total) ===\n\n{id: rn-net-1} "GET /a" 200 OK'
    );
    expect(await networkRequestTool.execute!(services, detailsParams as never)).toMatchObject({
      requestId: "rn-net-1",
      response: { status: 200 },
    });
    // Only the read scripts ran: neither read installed the interceptor.
    expect(evaluate.mock.calls.map(([script]) => script)).toEqual([
      makeNetworkLogReadScript(0, 0, 8081),
      makeNetworkLogReadScript(0, 50, 8081),
      detailScript,
    ]);
  });
});
