import * as zlib from "node:zlib";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Registry, type ToolCapability } from "@argent/registry";
import { findAndroidNativeRecord } from "../../src/blueprints/android-network-inspector";
import {
  findIosNativeRecord,
  type IosNetworkRecords,
} from "../../src/blueprints/ios-network-records";
import {
  MAX_VALUE_CHARS,
  unavailable,
  type NativeNetworkBody,
  type NativeNetworkRecord,
} from "../../src/utils/native-network-record";
import { networkRequestTool } from "../../src/tools/network/network-request";
import { networkLogsTool } from "../../src/tools/network/network-logs";
import { createNativeNetworkLogsTool } from "../../src/tools/native-devtools/native-network-logs";
import { assertSupported } from "../../src/utils/capability";
import { resolveDevice } from "../../src/utils/device-info";

/**
 * The record store is the iOS native layer's; these tests cover how
 * view-network-request-details routes an ios- ID and renders the record and
 * the bodies the store answers with. The ID pattern stays the real one.
 */
vi.mock("../../src/blueprints/ios-network-records", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/blueprints/ios-network-records")>();
  return { ...actual, findIosNativeRecord: vi.fn() };
});

/** The Android lookup stays real, watched only to see which lookup an ID goes to. */
vi.mock("../../src/blueprints/android-network-inspector", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/blueprints/android-network-inspector")>();
  return { ...actual, findAndroidNativeRecord: vi.fn(actual.findAndroidNativeRecord) };
});

const ID = "ios-1a2b-7";
const UNKNOWN_ID = "ios-1a2b-99";
const UDID = "6F9619FF-8B86-D011-B42D-00C04FC964FF";
const MIB = 1024 * 1024;
const NOTE_APP_HEADERS =
  "These are the headers the app set. The headers sent on the wire (such as Cookie and User-Agent) were not reported for this request.";
const NOT_FOUND_NATIVE = (id: string) =>
  `Request ${id} not found. Use native-network-logs to list the requests the iOS native layer recorded.`;
const NOT_FOUND_ELSEWHERE = (id: string) =>
  `Request ${id} not found. An ios- ID comes from an iOS simulator. Use view-network-logs to list this device's requests.`;

const responseBody = vi.fn<(id: string) => Promise<NativeNetworkBody>>();
const requestPostData = vi.fn<(id: string) => Promise<NativeNetworkBody>>();
const store: IosNetworkRecords = {
  state: () => ({ armed: true }),
  records: () => [],
  record: () => undefined,
  clear: () => {},
  responseBody,
  requestPostData,
};

/** Services that fail the call on any read: the path under test needs none. */
const noServices = new Proxy({} as Record<string, unknown>, {
  get(_, key) {
    throw new Error(`read services.${String(key)}`);
  },
});

interface Details {
  requestId: string;
  state: string;
  encodedDataLength?: number;
  request: {
    url: string;
    method: string;
    headers: Record<string, string>;
    headersNote?: string;
    postData?: string;
  };
  redirects?: unknown;
  response: {
    url?: string;
    status: number;
    statusText: string;
    redirectedTo?: string;
    headers: Record<string, string>;
    mimeType: string;
    fromCache?: boolean;
    body?: string;
  };
}

function record(
  over: Omit<Partial<NativeNetworkRecord>, "request" | "response"> & {
    request?: Partial<NativeNetworkRecord["request"]>;
    response?: Partial<NonNullable<NativeNetworkRecord["response"]>>;
  } = {}
): NativeNetworkRecord {
  const { request, response, ...rest } = over;
  return {
    id: ID,
    layer: "ios-native",
    layerId: "42.1",
    connection: 3,
    state: "complete",
    timing: { startedAt: 1000, durationMs: 12 },
    resourceType: "Fetch",
    ...rest,
    request: { url: "http://localhost:9091/ja", method: "GET", headers: {}, ...request },
    response: {
      url: "http://localhost:9091/ja",
      status: 200,
      statusText: "OK",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      mimeType: "application/json",
      ...response,
    },
  };
}

/** A POST whose body the store reads; `headers` are the ones the app set. */
function post(headers: Record<string, string>): NativeNetworkRecord {
  return record({
    request: { url: "http://localhost:9091/upload", method: "POST", hasPostData: true, headers },
  });
}

function textBody(text: string, truncated = false): NativeNetworkBody {
  return { available: true, body: text, base64Encoded: false, truncated };
}

function base64Body(bytes: Buffer, truncated = false): NativeNetworkBody {
  return { available: true, body: bytes.toString("base64"), base64Encoded: true, truncated };
}

/** A request body that came with the request: its kept start, and its whole length. */
function inlineBody(kept: string, wholeChars = kept.length): NativeNetworkBody {
  return {
    available: true,
    body: kept,
    base64Encoded: false,
    truncated: kept.length < wholeChars,
    inlineChars: wholeChars,
  };
}

function serve(rec: NativeNetworkRecord): void {
  vi.mocked(findIosNativeRecord).mockImplementation((id: string) =>
    id === rec.id ? { records: store, record: rec } : undefined
  );
}

async function details(
  { includeBody = true, deviceId = UDID }: { includeBody?: boolean; deviceId?: string } = {},
  requestId = ID
): Promise<Details> {
  const out = await networkRequestTool.execute!(noServices, {
    device_id: deviceId,
    requestId,
    includeBody,
  });
  expect(typeof out).toBe("object");
  return out as Details;
}

beforeEach(() => {
  vi.mocked(findIosNativeRecord).mockReset();
  vi.mocked(findAndroidNativeRecord).mockClear();
  responseBody.mockReset().mockResolvedValue(textBody('{"ok":true}'));
  requestPostData.mockReset();
});

describe("view-network-request-details: an iOS native record", () => {
  it("redacts the request and response headers and gives the final URL, the status text and the headers note", async () => {
    serve(
      record({
        request: {
          url: "https://api.example.test/start",
          headers: {
            "Authorization": "Bearer t0ken",
            "Cookie": "sid=abc123",
            "X-App": "probe",
          },
        },
        response: {
          url: "https://api.example.test/final",
          status: 201,
          statusText: "Created",
          headers: {
            "Set-Cookie": "sid=def456; Path=/",
            "Content-Type": "application/json",
            "X-Trace": "t-1",
          },
        },
      })
    );

    const result = await details();

    expect(result).toEqual({
      requestId: ID,
      state: "complete",
      resourceType: "Fetch",
      durationMs: 12,
      request: {
        url: "https://api.example.test/start",
        method: "GET",
        headers: { "Authorization": "[REDACTED]", "Cookie": "[REDACTED]", "X-App": "probe" },
        headersNote: NOTE_APP_HEADERS,
      },
      response: {
        url: "https://api.example.test/final",
        status: 201,
        statusText: "Created",
        headers: {
          "Set-Cookie": "[REDACTED]",
          "Content-Type": "application/json",
          "X-Trace": "t-1",
        },
        mimeType: "application/json",
        body: '{"ok":true}',
      },
    });
    expect(result).not.toHaveProperty("redirects");
    expect(result.response).not.toHaveProperty("fromCache");
    expect(result.response).not.toHaveProperty("redirectedTo");
    expect(responseBody).toHaveBeenCalledWith(ID);
  });
});

describe("view-network-request-details: iOS response bodies", () => {
  it("shows a text body as it came, and cuts one past 1000 chars", async () => {
    serve(record());
    responseBody.mockResolvedValue(textBody('{"a":"東京"}'));
    expect((await details()).response.body).toBe('{"a":"東京"}');

    responseBody.mockResolvedValue(textBody("y".repeat(1500)));
    expect((await details()).response.body).toBe(
      `[TRUNCATED: first 1000 chars shown, full size: 1500 chars, MIME: application/json]\n${"y".repeat(1000)}...`
    );
  });

  it("decodes a base64 body that is UTF-8 text", async () => {
    serve(record());
    responseBody.mockResolvedValue(base64Body(Buffer.from('{"a":"東京"}')));

    expect((await details()).response.body).toBe('{"a":"東京"}');
  });

  it("omits a binary body and gives its size", async () => {
    const png = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
      0x52,
    ]);
    serve(
      record({
        encodedDataLength: png.length,
        response: { headers: { "Content-Type": "image/png" }, mimeType: "image/png" },
      })
    );
    responseBody.mockResolvedValue(base64Body(png));

    expect((await details()).response.body).toBe("[body omitted: binary image/png, 16 bytes]");
  });

  it("gives the size the app received and the bytes kept for a body the agent cut short", async () => {
    const whole = Buffer.from(JSON.stringify({ name: "東京", data: "a".repeat(3_000_000) }));
    const kept = whole.subarray(0, MIB);
    const keptText = kept.toString("utf8");
    // Two 3-byte characters: the kept chars are fewer than the kept bytes.
    expect(keptText.length).toBe(MIB - 4);
    serve(record({ encodedDataLength: whole.length }));
    responseBody.mockResolvedValue(textBody(keptText, true));

    expect((await details()).response.body).toBe(
      `[TRUNCATED: first 1000 chars shown, full size: ${whole.length} bytes as the app received them; the agent kept only the first ${MIB} bytes, MIME: application/json]\n${keptText.slice(0, 1000)}...`
    );
  });

  it("reads a body cut inside a multi-byte character as text, not binary", async () => {
    const kept = Buffer.concat([Buffer.from('{"a":"東'), Buffer.from("京").subarray(0, 2)]);
    expect(() => new TextDecoder("utf-8", { fatal: true }).decode(kept)).toThrow();
    serve(record({ encodedDataLength: 5000 }));
    responseBody.mockResolvedValue(base64Body(kept, true));

    expect((await details()).response.body).toBe(
      '[TRUNCATED: first 7 chars shown, full size: 5000 bytes as the app received them; the agent kept only the first 11 bytes, MIME: application/json]\n{"a":"東'
    );
  });
});

describe("view-network-request-details: iOS bodies and Content-Encoding", () => {
  it("shows a text response body under a gzip Content-Encoding as the agent sent it", async () => {
    serve(
      record({
        response: { headers: { "Content-Encoding": "gzip", "Content-Type": "application/json" } },
      })
    );
    responseBody.mockResolvedValue(textBody('{"decoded":true}'));

    expect((await details()).response.body).toBe('{"decoded":true}');
  });

  it("shows a response body that is itself gzip data as binary, never decoding it again", async () => {
    const gz = zlib.gzipSync('{"inner":"gzip"}');
    serve(
      record({
        response: {
          headers: { "Content-Encoding": "gzip", "Content-Type": "application/gzip" },
          mimeType: "application/gzip",
        },
      })
    );
    responseBody.mockResolvedValue(base64Body(gz));

    expect((await details()).response.body).toBe(
      `[body omitted: binary application/gzip, ${gz.length} bytes]`
    );
  });

  it("decodes a gzip request body by the request's Content-Encoding", async () => {
    const json = '{"upload":"東京","n":1}';
    serve(post({ "Content-Type": "application/json", "Content-Encoding": "gzip" }));
    requestPostData.mockResolvedValue(base64Body(zlib.gzipSync(json)));

    expect((await details()).request.postData).toBe(json);
    expect(requestPostData).toHaveBeenCalledWith(ID);
  });
});

describe("view-network-request-details: an iOS request body that came with the request", () => {
  it("shows a JSON body as it came", async () => {
    const json = '{"name":"東京","n":1}';
    serve(post({ "Content-Type": "application/json" }));
    requestPostData.mockResolvedValue(inlineBody(json));

    expect((await details()).request.postData).toBe(json);
  });

  it("shows a body of exactly 1000 chars whole, with no cut line", async () => {
    serve(post({ "Content-Type": "text/plain" }));
    requestPostData.mockResolvedValue(inlineBody("q".repeat(1000)));

    expect((await details()).request.postData).toBe("q".repeat(1000));
  });

  it("gives the whole length of a body longer than the start the host kept", async () => {
    const sent = "東京-".repeat(23_334).slice(0, 70_000);
    serve(post({ "Content-Type": "text/plain; charset=utf-8" }));
    requestPostData.mockResolvedValue(inlineBody(sent.slice(0, MAX_VALUE_CHARS), 70_000));

    expect((await details()).request.postData).toBe(
      `[TRUNCATED: first 1000 chars shown, full size: 70000 chars, MIME: text/plain]\n${sent.slice(0, 1000)}...`
    );
  });

  it("names no MIME type in the cut line of a body the app sent without a Content-Type", async () => {
    serve(post({}));
    requestPostData.mockResolvedValue(inlineBody("z".repeat(1500)));

    expect((await details()).request.postData).toBe(
      `[TRUNCATED: first 1000 chars shown, full size: 1500 chars]\n${"z".repeat(1000)}...`
    );
  });

  it("omits a body of a binary Content-Type and gives the Content-Length the app sent", async () => {
    serve(post({ "Content-Type": "application/octet-stream", "Content-Length": "5" }));
    requestPostData.mockResolvedValue(inlineBody(Buffer.from([0, 1, 2, 3, 4]).toString("base64")));

    expect((await details()).request.postData).toBe(
      "[body omitted: binary application/octet-stream, 5 bytes as the app sent them]"
    );
  });

  it("reads a binary Content-Type in any letter case", async () => {
    serve(post({ "Content-Type": "Application/OCTET-STREAM", "Content-Length": "3" }));
    requestPostData.mockResolvedValue(inlineBody(Buffer.from([0, 1, 2]).toString("base64")));

    expect((await details()).request.postData).toBe(
      "[body omitted: binary Application/OCTET-STREAM, 3 bytes as the app sent them]"
    );
  });

  it("says the size is unknown for a body of a binary Content-Type without a Content-Length", async () => {
    serve(post({ "Content-Type": "image/jpeg" }));
    requestPostData.mockResolvedValue(inlineBody("/9j/4AAQSkZJRgABAQ=="));

    expect((await details()).request.postData).toBe(
      "[body omitted: binary image/jpeg, size unknown]"
    );
  });
});

describe("view-network-request-details: iOS bodies that cannot be read", () => {
  it("shows the store's reason for a request body and a response body it cannot give", async () => {
    serve(post({ "Content-Type": "application/json" }));
    requestPostData.mockResolvedValue(
      unavailable("the app is still sending this request body; read it again later")
    );
    responseBody.mockResolvedValue(unavailable("the agent no longer holds this body"));

    const result = await details();

    expect(result.request.postData).toBe(
      "[unavailable: the app is still sending this request body; read it again later]"
    );
    expect(result.response.body).toBe("[unavailable: the agent no longer holds this body]");
  });

  it("reads the request body but not the response body without includeBody", async () => {
    serve(post({ "Content-Type": "application/json" }));
    requestPostData.mockResolvedValue(inlineBody('{"n":1}'));

    const result = await details({ includeBody: false });

    expect(responseBody).not.toHaveBeenCalled();
    expect(requestPostData).toHaveBeenCalledWith(ID);
    expect(result.request.postData).toBe('{"n":1}');
    expect(result.response).not.toHaveProperty("body");
    expect(result.response.status).toBe(200);
  });
});

describe("view-network-request-details: routing an ios- ID", () => {
  it.each([
    ["an iOS simulator UDID", UDID],
    ["a Metro logicalDeviceId from a shared Metro", "b1946ac92492d2347c6235b4d2611184"],
    ["a remote iOS simulator", `remote:${UDID}`],
    ["an Android serial", "emulator-5554"],
    ["a Chromium target", "chromium-cdp-9222"],
  ])("resolves through %s, with no service", async (_, deviceId) => {
    serve(record());
    const params = { device_id: deviceId, requestId: ID, includeBody: true };

    expect(networkRequestTool.services!(params)).toEqual({});
    const out = (await networkRequestTool.execute!(noServices, params)) as Details;
    expect(out.requestId).toBe(ID);
    expect(out.response.body).toBe('{"ok":true}');
    expect(findIosNativeRecord).toHaveBeenCalledWith(ID);
    expect(findAndroidNativeRecord).not.toHaveBeenCalled();
  });

  it("says an ios- ID with no record is not found and names native-network-logs", async () => {
    serve(record());

    expect(
      await networkRequestTool.execute!(noServices, {
        device_id: UDID,
        requestId: UNKNOWN_ID,
        includeBody: true,
      })
    ).toBe(NOT_FOUND_NATIVE(UNKNOWN_ID));
    expect(findIosNativeRecord).toHaveBeenCalledWith(UNKNOWN_ID);
  });

  it("says under a Chromium device_id that an ios- ID comes from an iOS simulator", async () => {
    serve(record());

    expect(
      await networkRequestTool.execute!(noServices, {
        device_id: "chromium-cdp-9222",
        requestId: UNKNOWN_ID,
        includeBody: true,
      })
    ).toBe(NOT_FOUND_ELSEWHERE(UNKNOWN_ID));
  });

  it.each([
    ["an iOS simulator UDID", UDID, "native-network-logs"],
    ["a Metro logicalDeviceId", "b1946ac92492d2347c6235b4d2611184", "native-network-logs"],
    ["a remote iOS simulator", `remote:${UDID}`, "native-network-logs"],
    ["a Chromium target", "chromium-cdp-9222", "view-network-logs"],
    ["a Vega device", "amazon-4a27df03c9777152", "view-network-logs"],
  ])(
    "answers an unknown ios- ID under %s with a tool that accepts it",
    async (_, deviceId, tool) => {
      const listingTools: Record<string, ToolCapability | undefined> = {
        "native-network-logs": createNativeNetworkLogsTool(new Registry()).capability,
        "view-network-logs": networkLogsTool.capability,
      };

      const answer = await networkRequestTool.execute!(noServices, {
        device_id: deviceId,
        requestId: UNKNOWN_ID,
        includeBody: true,
      });

      expect(answer).toBe(
        tool === "native-network-logs"
          ? NOT_FOUND_NATIVE(UNKNOWN_ID)
          : NOT_FOUND_ELSEWHERE(UNKNOWN_ID)
      );
      expect(() =>
        assertSupported(tool, listingTools[tool], resolveDevice(deviceId))
      ).not.toThrow();
    }
  );

  describe.each(["ios-xyz", "ios-", "ios-1a2b", "ios-1a2b-", "ios-1A2B-1"])(
    "the malformed ID %s",
    (requestId) => {
      it.each([
        ["an iOS simulator UDID", UDID],
        ["a Metro logicalDeviceId", "b1946ac92492d2347c6235b4d2611184"],
        ["an Android serial", "emulator-5554"],
      ])("is not found under %s, with no service and no lookup", async (_, deviceId) => {
        const params = { device_id: deviceId, requestId, includeBody: true };

        expect(networkRequestTool.services!(params)).toEqual({});
        expect(await networkRequestTool.execute!(noServices, params)).toBe(
          NOT_FOUND_NATIVE(requestId)
        );
        expect(findIosNativeRecord).not.toHaveBeenCalled();
      });

      it("stays Chromium's to answer, because a Chromium request ID is opaque", async () => {
        const params = { device_id: "chromium-cdp-9222", requestId, includeBody: false };

        expect(Object.keys(networkRequestTool.services!(params))).toEqual(["chromium"]);
        const get = vi.fn();
        expect(
          await networkRequestTool.execute!({ chromium: { server: { network: { get } } } }, params)
        ).toBe(`Request ${requestId} not found. Use view-network-logs to list available requests.`);
        expect(get).toHaveBeenCalledWith(requestId);
        expect(findIosNativeRecord).not.toHaveBeenCalled();
      });
    }
  );

  it.each(["Ios-1a2b-7", "ios", "rn-net-4"])(
    "keeps %s on the JS layer: it does not start with ios-",
    (requestId) => {
      expect(
        networkRequestTool.services!({ device_id: UDID, requestId, includeBody: true })
      ).toEqual({ inspector: `NetworkInspector:8081:${UDID}` });
    }
  );

  it("routes each ID by its own prefix: an android- ID goes to the Android lookup", async () => {
    serve(record());
    const androidId = "android-1a2b-7";
    const params = { device_id: UDID, requestId: androidId, includeBody: true };

    expect(networkRequestTool.services!(params)).toEqual({});
    expect(await networkRequestTool.execute!(noServices, params)).toBe(
      `Request ${androidId} not found. Use native-network-logs to list the requests the Android native layer recorded.`
    );
    expect(findAndroidNativeRecord).toHaveBeenCalledWith(androidId);
    expect(findIosNativeRecord).not.toHaveBeenCalled();
  });
});
