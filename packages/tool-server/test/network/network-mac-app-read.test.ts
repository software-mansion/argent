import { describe, expect, it, vi } from "vitest";
import { networkLogsTool } from "../../src/tools/network/network-logs";
import { networkRequestTool } from "../../src/tools/network/network-request";
import { jsCapturePayload } from "../../src/blueprints/network-inspector";
import { NETWORK_INTERCEPTOR_SCRIPT } from "../../src/utils/debugger/scripts/network-interceptor";

/**
 * A Mac app has no network-capture-start (its capability covers iOS simulators and Android), so
 * its reads install the JS interceptor themselves, as on Vega, rather than answering that capture
 * is not started.
 */
const MAC = "macos-app-com.example.app";

function fakeInspector(readReply: unknown) {
  const evaluate = vi.fn(async (script: string) =>
    script === NETWORK_INTERCEPTOR_SCRIPT ? undefined : JSON.stringify(readReply)
  );
  return { inspector: { cdp: { evaluate } }, evaluate };
}

describe("JS network reads on a Mac app", () => {
  it.each([
    ["view-network-logs", networkLogsTool, { device_id: MAC, pageIndex: "latest" }],
    [
      "view-network-request-details",
      networkRequestTool,
      { device_id: MAC, requestId: "rn-net-1", includeBody: true },
    ],
  ] as const)("%s resolves the network inspector of the Mac app", (_, tool, params) => {
    expect(tool.services!(params as never)).toEqual({
      inspector: `NetworkInspector:${jsCapturePayload(8081, MAC)}`,
    });
  });

  it("view-network-logs installs the interceptor and reads, without asking for network-capture-start", async () => {
    const { inspector, evaluate } = fakeInspector({ total: 0, interceptorInstalled: true });

    const out = await networkLogsTool.execute!(
      { inspector } as never,
      {
        device_id: MAC,
        pageIndex: "latest",
      } as never
    );

    expect(evaluate.mock.calls[0][0]).toBe(NETWORK_INTERCEPTOR_SCRIPT);
    expect(out).toContain("No network traffic captured.");
    expect(out).not.toContain("network-capture-start");
  });

  it("view-network-request-details installs the interceptor before it looks the request up", async () => {
    const { inspector, evaluate } = fakeInspector({ error: "not found" });

    const out = await networkRequestTool.execute!(
      { inspector } as never,
      {
        device_id: MAC,
        requestId: "rn-net-1",
        includeBody: true,
      } as never
    );

    expect(evaluate.mock.calls[0][0]).toBe(NETWORK_INTERCEPTOR_SCRIPT);
    expect(String(out)).not.toContain("network-capture-start");
  });
});
