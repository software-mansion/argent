import { beforeEach, describe, expect, it, vi } from "vitest";
import { findMacosNativeRecord, hasMacosNetworkCapture } from "../../src/blueprints/macos-app";
import type { IosNetworkRecords } from "../../src/blueprints/ios-network-records";
import type { NativeNetworkBody, NativeNetworkRecord } from "../../src/utils/native-network-record";
import { networkRequestTool } from "../../src/tools/network/network-request";
import { canonicalDeviceId } from "../../src/utils/debugger/device-alias";
import {
  forgetJsCapturesOf,
  jsCapturePayload,
  setJsCapture,
} from "../../src/blueprints/network-inspector";

/**
 * How view-network-request-details routes a macos- ID and the IDs it gets under
 * a Mac app id. The records come from the Mac app services, which the lookup
 * stands in for; the ID pattern stays the real one.
 */
vi.mock("../../src/blueprints/macos-app", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/blueprints/macos-app")>();
  return {
    ...actual,
    findMacosNativeRecord: vi.fn(),
    hasMacosNetworkCapture: vi.fn(() => true),
  };
});

const ID = "macos-1a2b-7";
const MAC = "macos-app-com.example.app";

const responseBody = vi.fn<(id: string) => Promise<NativeNetworkBody>>();
const store: IosNetworkRecords = {
  state: () => ({ armed: true }),
  records: () => [],
  record: () => undefined,
  clear: () => {},
  responseBody,
  requestPostData: async () => ({
    available: false,
    body: "",
    base64Encoded: false,
    truncated: false,
  }),
};

/** Services that fail the call on any read: the path under test needs none. */
const noServices = new Proxy({} as Record<string, unknown>, {
  get(_, key) {
    throw new Error(`read services.${String(key)}`);
  },
});

function record(): NativeNetworkRecord {
  return {
    id: ID,
    layer: "macos-native",
    layerId: "fake-1",
    connection: 1,
    state: "complete",
    timing: { startedAt: 1000, durationMs: 12 },
    encodedDataLength: 30,
    request: {
      url: "https://example.com/ja",
      method: "GET",
      headers: { Authorization: "Bearer secret", Accept: "application/json" },
    },
    response: {
      url: "https://example.com/ja",
      status: 200,
      statusText: "OK",
      headers: { "Content-Encoding": "gzip", "Content-Type": "application/json" },
      mimeType: "application/json",
    },
  };
}

const details = (requestId: string, device_id = MAC): Promise<unknown> =>
  networkRequestTool.execute!(noServices, {
    device_id,
    requestId,
    includeBody: true,
  }) as Promise<unknown>;

describe("view-network-request-details: Mac app IDs", () => {
  beforeEach(() => {
    vi.mocked(findMacosNativeRecord).mockReset();
    vi.mocked(hasMacosNetworkCapture).mockReturnValue(true);
    responseBody.mockReset();
  });

  it("needs no service for a macos- ID, and reads a JS ID under a Mac app id from its JS runtime", () => {
    expect(
      networkRequestTool.services!({ device_id: "chromium-cdp-9222", requestId: ID } as never)
    ).toEqual({});
    setJsCapture(jsCapturePayload(8081, MAC), {
      bundleId: "com.example.app",
      intent: "started",
      installed: true,
    });
    try {
      expect(networkRequestTool.services!({ device_id: MAC, requestId: ID } as never)).toEqual({});
      expect(
        networkRequestTool.services!({ device_id: MAC, requestId: "rn-net-1" } as never)
      ).toEqual({ debugger: `JsRuntimeDebugger:${jsCapturePayload(8081, MAC)}` });
    } finally {
      forgetJsCapturesOf();
    }
  });

  it("renders a macos- record with secret headers redacted and its body as the app sent it", async () => {
    vi.mocked(findMacosNativeRecord).mockReturnValue({ records: store, record: record() });
    // The app reads a body decoded, so its Content-Encoding is not applied again.
    responseBody.mockResolvedValue({
      available: true,
      body: '{"ok":true}',
      base64Encoded: false,
      truncated: false,
    });

    expect(await details(ID)).toMatchObject({
      requestId: ID,
      request: { headers: { Authorization: "[REDACTED]", Accept: "application/json" } },
      response: { status: 200, body: '{"ok":true}' },
    });
    expect(findMacosNativeRecord).toHaveBeenCalledWith(ID);
  });

  it("says where a macos- ID comes from, and what to call when no capture recorded it", async () => {
    vi.mocked(findMacosNativeRecord).mockReturnValue(undefined);
    expect(await details(ID, "chromium-cdp-9222")).toBe(
      `Request ${ID} not found. A macos- ID comes from a Mac app. Use view-network-logs to list this device's requests.`
    );
    expect(await details(ID)).toBe(
      `Request ${ID} not found. Use native-network-logs to list the requests the Mac app native layer recorded.`
    );
    vi.mocked(hasMacosNetworkCapture).mockReturnValue(false);
    expect(await details(ID)).toBe(
      `Request ${ID} not found. Native network capture is not started, so no requests are recorded. Call network-capture-start with udid and bundleId, repeat the action, then list the requests with native-network-logs.`
    );
  });

  it("answers a malformed macos- ID under an iOS UDID from the native layer, not the JS layer", async () => {
    const UDID = "6F9619FF-8B86-D011-B42D-00C04FC964FF";
    // A JS capture on the device would give the JS layer's debugger to any other ID.
    setJsCapture(jsCapturePayload(8081, canonicalDeviceId(UDID)!), {
      bundleId: "com.example.demo",
      intent: "started",
      installed: true,
    });
    try {
      const params = { device_id: UDID, requestId: "macos-1a2b", includeBody: true } as never;
      expect(networkRequestTool.services!(params)).toEqual({});
      expect(await details("macos-1a2b", UDID)).toBe(
        "Request macos-1a2b not found. Use native-network-logs to list the requests the Mac app native layer recorded."
      );
    } finally {
      forgetJsCapturesOf();
    }
  });

  it("answers a malformed macos- ID under a Mac app id from the native layer, without a debugger", async () => {
    expect(
      networkRequestTool.services!({ device_id: MAC, requestId: "macos-1a2b" } as never)
    ).toEqual({});
    expect(await details("macos-1a2b")).toBe(
      "Request macos-1a2b not found. Use native-network-logs to list the requests the Mac app native layer recorded."
    );
  });
});
