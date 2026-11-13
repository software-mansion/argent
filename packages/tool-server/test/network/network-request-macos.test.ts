import { beforeEach, describe, expect, it, vi } from "vitest";
import { findMacosNativeRecord, hasMacosNetworkCapture } from "../../src/blueprints/macos-app";
import type { IosNetworkRecords } from "../../src/blueprints/ios-network-records";
import type { NativeNetworkBody, NativeNetworkRecord } from "../../src/utils/native-network-record";
import { networkRequestTool } from "../../src/tools/network/network-request";

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

  it("needs no service for a macos- ID, nor for any ID under a Mac app id", () => {
    expect(
      networkRequestTool.services!({ device_id: "chromium-cdp-9222", requestId: ID } as never)
    ).toEqual({});
    expect(
      networkRequestTool.services!({ device_id: MAC, requestId: "rn-net-1" } as never)
    ).toEqual({});
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

  it("answers an ID that no native layer issued under a Mac app id without a debugger", async () => {
    expect(await details("rn-net-1")).toBe(
      "Request rn-net-1 not found. Use native-network-logs to list the requests the Mac app native layer recorded."
    );
  });
});
