import * as zlib from "node:zlib";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  findAndroidNativeRecord,
  type AndroidNativeRecord,
  type AndroidNetworkBody,
  type AndroidNetworkInspectorApi,
} from "../../src/blueprints/android-network-inspector";
import { networkRequestTool } from "../../src/tools/network/network-request";

/**
 * The record store is the inspector's; these tests cover how
 * view-network-request-details routes an android- ID and renders the record
 * and the bodies the agent holds.
 */
vi.mock("../../src/blueprints/android-network-inspector", () => ({
  ANDROID_NATIVE_REQUEST_ID: /^android-[0-9a-f]{4}-\d+$/,
  findAndroidNativeRecord: vi.fn(),
}));

const ID = "android-1a2b-7";
const SERIAL = "emulator-5554";
const MIB = 1024 * 1024;

const responseBody = vi.fn<(id: string) => Promise<AndroidNetworkBody>>();
const requestPostData = vi.fn<(id: string) => Promise<AndroidNetworkBody>>();
const inspector = { responseBody, requestPostData } as unknown as AndroidNetworkInspectorApi;

interface Details {
  requestId: string;
  encodedDataLength?: number;
  request: {
    url: string;
    headers: Record<string, string>;
    headersNote?: string;
    postData?: string;
  };
  redirects?: Array<{
    url: string;
    method: string;
    status: number;
    statusText: string;
    requestHeaders?: Record<string, string>;
    responseHeaders?: Record<string, string>;
  }>;
  response: {
    url?: string;
    status: number;
    headers: Record<string, string>;
    fromCache?: boolean;
    body?: string;
  };
}

function record(
  over: Omit<Partial<AndroidNativeRecord>, "request" | "response"> & {
    request?: Partial<AndroidNativeRecord["request"]>;
    response?: Partial<NonNullable<AndroidNativeRecord["response"]>>;
  } = {}
): AndroidNativeRecord {
  const { request, response, ...rest } = over;
  return {
    id: ID,
    state: "complete",
    timing: { startedAt: 1000, durationMs: 12 },
    resourceType: "XHR",
    ...rest,
    request: { url: "http://localhost:9091/ja", method: "GET", headers: {}, ...request },
    response: {
      url: "http://localhost:9091/ja",
      status: 200,
      statusText: "OK",
      headers: { "content-type": "application/json; charset=utf-8" },
      mimeType: "application/json",
      ...response,
    },
  } as AndroidNativeRecord;
}

function heldBody(bytes: Buffer, truncated = false): AndroidNetworkBody {
  return { available: true, body: bytes.toString("base64"), base64Encoded: true, truncated };
}

function serve(rec: AndroidNativeRecord): void {
  vi.mocked(findAndroidNativeRecord).mockImplementation((id: string) =>
    id === rec.id ? { inspector, record: rec } : undefined
  );
}

async function details(deviceId = SERIAL, requestId = ID): Promise<Details> {
  const out = await networkRequestTool.execute!(
    {},
    { device_id: deviceId, requestId, includeBody: true }
  );
  expect(typeof out).toBe("object");
  return out as Details;
}

/**
 * A catalogue response of 2,579,461 bytes of Japanese JSON: its 1 MiB cut
 * ends on the lead byte of a character.
 */
function japaneseCatalogue(): Buffer {
  const names = [
    "抹茶ラテ 大サイズ",
    "東京限定 チョコレート",
    "北海道産 牛乳プリン",
    "京都の緑茶セット",
  ];
  const items = [];
  let len = 0;
  for (let i = 0; len < 1_500_000; i++) {
    const item = {
      id: i,
      name: names[i % 4],
      price: 10 + (i % 90),
      desc: names[(i + 1) % 4] + " " + names[(i + 2) % 4],
    };
    items.push(item);
    len += JSON.stringify(item).length + 1;
  }
  return Buffer.from(JSON.stringify({ items }));
}

beforeEach(() => {
  vi.mocked(findAndroidNativeRecord).mockReset();
  responseBody.mockReset().mockResolvedValue(heldBody(Buffer.from("{}")));
  requestPostData.mockReset();
});

describe("view-network-request-details: a body the agent cut short", () => {
  it("decodes a body cut inside a multi-byte character, and gives the size the app received", async () => {
    const ja = japaneseCatalogue();
    expect(ja.length).toBe(2_579_461);
    const kept = ja.subarray(0, MIB);
    // The cut lands inside a character, so a strict decode of the kept bytes fails.
    expect(() => new TextDecoder("utf-8", { fatal: true }).decode(kept)).toThrow();
    responseBody.mockResolvedValue(heldBody(kept, true));
    serve(record({ encodedDataLength: ja.length }));

    const body = (await details()).response.body!;

    expect(body).toBe(
      `[TRUNCATED — original size: 2579461 bytes as the app received them; the agent kept only the first 1048576 bytes, MIME: application/json]\n${ja.toString("utf8").slice(0, 1000)}...`
    );
    expect(body).toContain("抹茶ラテ 大サイズ");
  });

  it.each([
    ["é", 1],
    ["抹", 1],
    ["抹", 2],
    ["😀", 1],
    ["😀", 2],
    ["😀", 3],
  ])("drops only the incomplete %s left by a cut after %i of its bytes", async (char, cut) => {
    const kept = Buffer.concat([Buffer.from("ok "), Buffer.from(char).subarray(0, cut)]);
    responseBody.mockResolvedValue(heldBody(kept, true));
    serve(record({ encodedDataLength: 5000 }));

    expect((await details()).response.body).toBe(
      "[TRUNCATED — original size: 5000 bytes as the app received them; the agent kept only the first " +
        `${kept.length} bytes, MIME: application/json]\nok `
    );
  });

  it.each([
    ["a byte that never starts a character", Buffer.from([0x6f, 0x6b, 0xff])],
    ["a continuation byte with no lead", Buffer.from([0x6f, 0x6b, 0x80])],
    ["a whole character with a stray continuation", Buffer.from([0x6f, 0xe6, 0x8a, 0xb9, 0xb9])],
  ])("still reads a cut body ending in %s as binary", async (_, kept) => {
    responseBody.mockResolvedValue(heldBody(kept, true));
    serve(record({ encodedDataLength: 5000 }));

    expect((await details()).response.body).toBe(
      `[binary, original size: 5000 bytes as the app received them; the agent kept only the first ${kept.length} bytes, MIME: application/json]`
    );
  });

  it("gives the size the app received for a cut ASCII body, never the cut's own size", async () => {
    const ascii = Buffer.from(JSON.stringify({ data: "a".repeat(3_000_000) }));
    expect(ascii.length).toBe(3_000_011);
    responseBody.mockResolvedValue(heldBody(ascii.subarray(0, MIB), true));
    serve(record({ encodedDataLength: ascii.length }));

    const body = (await details()).response.body!;

    expect(body).toBe(
      `[TRUNCATED — original size: 3000011 bytes as the app received them; the agent kept only the first 1048576 bytes, MIME: application/json]\n${ascii.toString().slice(0, 1000)}...`
    );
    expect(body).not.toContain("original size: 1048576");
  });

  it("says the original size is unknown when the record has no received length", async () => {
    responseBody.mockResolvedValue(heldBody(Buffer.from("x".repeat(2000)), true));
    serve(record());

    expect((await details()).response.body).toMatch(
      /^\[TRUNCATED — original size: unknown; the agent kept only the first 2000 bytes, MIME: application\/json\]\nx{1000}\.\.\.$/
    );
  });

  it("decodes what arrived of a gzip body the agent cut short", async () => {
    let text = "";
    for (let i = 0; text.length < 400_000; i++) text += `{"id":${i},"name":"東京 ${i * 7919}"},`;
    const gz = zlib.gzipSync(text);
    const kept = gz.subarray(0, gz.length >> 1);
    responseBody.mockResolvedValue(heldBody(kept, true));
    serve(
      record({
        encodedDataLength: gz.length,
        response: { headers: { "Content-Encoding": "gzip", "Content-Type": "application/json" } },
      })
    );

    const body = (await details()).response.body!;

    expect(
      body.startsWith(
        `[TRUNCATED — original size: ${gz.length} bytes as the app received them; the agent kept only the first ${kept.length} bytes, MIME: application/json]\n${text.slice(0, 1000)}...`
      )
    ).toBe(true);
  });

  it("gives the Content-Length the app sent for a request body the agent cut short", async () => {
    const sent = Buffer.from("名前=".repeat(400_000));
    requestPostData.mockResolvedValue(heldBody(sent.subarray(0, MIB), true));
    serve(
      record({
        request: {
          method: "POST",
          hasPostData: true,
          headers: { "Content-Type": "text/plain" },
          wireHeaders: { "Content-Type": "text/plain", "Content-Length": String(sent.length) },
        },
      })
    );

    expect((await details()).request.postData).toBe(
      `[TRUNCATED — original size: ${sent.length} bytes as the app sent them; the agent kept only the first 1048576 bytes, MIME: text/plain]\n${"名前=".repeat(400).slice(0, 1000)}...`
    );
  });
});

describe("view-network-request-details: a body the agent kept whole", () => {
  it("reads as before: whole, cut by characters past 1000, or binary", async () => {
    serve(record({ encodedDataLength: 4 }));
    responseBody.mockResolvedValue(heldBody(Buffer.from('{"a":"東京"}')));
    expect((await details()).response.body).toBe('{"a":"東京"}');

    responseBody.mockResolvedValue(heldBody(Buffer.from("y".repeat(1500))));
    expect((await details()).response.body).toBe(
      `[TRUNCATED — original size: 1500 chars, MIME: application/json]\n${"y".repeat(1000)}...`
    );

    responseBody.mockResolvedValue(heldBody(Buffer.from([0x6f, 0x6b, 0xe6, 0x8a])));
    expect((await details()).response.body).toBe("[binary: 4 bytes, MIME: application/json]");
  });

  it("decodes an empty gzip body to an empty body", async () => {
    responseBody.mockResolvedValue(heldBody(zlib.gzipSync("")));
    serve(record({ response: { headers: { "content-encoding": "gzip" } } }));

    expect((await details()).response.body).toBe("");
  });
});

describe("view-network-request-details: request bodies and charsets", () => {
  const json = '{"upload":"東京","n":1}';

  it.each([
    ["gzip", { "Content-Encoding": "gzip" }, zlib.gzipSync(json)],
    ["gzip in any case", { "CONTENT-ENCODING": "GZIP" }, zlib.gzipSync(json)],
    [
      "stacked gzip, br",
      { "content-encoding": "gzip, br" },
      zlib.brotliCompressSync(zlib.gzipSync(json)),
    ],
  ])("decodes a request body by the request's Content-Encoding: %s", async (_, headers, sent) => {
    requestPostData.mockResolvedValue(heldBody(sent));
    serve(
      record({
        request: {
          method: "POST",
          hasPostData: true,
          headers: { "Content-Type": "application/json", ...headers },
        },
      })
    );

    expect((await details()).request.postData).toBe(json);
  });

  it("reads a request body whose stacked Content-Encoding has a coding it cannot undo as it came", async () => {
    const sent = zlib.gzipSync(json);
    requestPostData.mockResolvedValue(heldBody(sent));
    serve(
      record({
        request: {
          method: "POST",
          hasPostData: true,
          headers: { "Content-Type": "application/json", "Content-Encoding": "compress, gzip" },
        },
      })
    );

    expect((await details()).request.postData).toBe(
      `[binary: ${sent.length} bytes, MIME: application/json]`
    );
  });

  it.each([
    ["text/plain; charset=ISO-8859-1", Buffer.from([0x63, 0x61, 0x66, 0xe9]), "café"],
    ["text/plain;charset=latin1", Buffer.from([0x63, 0x61, 0x66, 0xe9]), "café"],
    ['text/html; Charset="Shift_JIS"', Buffer.from([0x93, 0x8c, 0x8b, 0x9e]), "東京"],
    ["text/plain; charset=windows-1252", Buffer.from([0x93, 0x68, 0x69, 0x94, 0x80]), "“hi”€"],
  ])(
    "decodes a response body in the charset its Content-Type names: %s",
    async (contentType, bytes, text) => {
      responseBody.mockResolvedValue(heldBody(bytes));
      serve(
        record({
          response: {
            headers: { "Content-Type": contentType },
            mimeType: contentType.split(";")[0],
          },
        })
      );

      expect((await details()).response.body).toBe(text);
    }
  );

  it("drops only the incomplete Shift_JIS character a cut leaves", async () => {
    const sjis = Buffer.from([0x93, 0x8c, 0x8b, 0x9e]); // 東京
    responseBody.mockResolvedValue(heldBody(sjis.subarray(0, 3), true));
    serve(
      record({
        encodedDataLength: 4000,
        response: {
          headers: { "content-type": "text/plain; charset=shift_jis" },
          mimeType: "text/plain",
        },
      })
    );

    expect((await details()).response.body).toBe(
      "[TRUNCATED — original size: 4000 bytes as the app received them; the agent kept only the first 3 bytes, MIME: text/plain]\n東"
    );
  });

  it("decodes a request body in the charset the wire Content-Type names when the app set none", async () => {
    requestPostData.mockResolvedValue(heldBody(Buffer.from([0x63, 0x61, 0x66, 0xe9])));
    serve(
      record({
        request: {
          method: "POST",
          hasPostData: true,
          headers: {},
          wireHeaders: { "Content-Type": "text/plain; charset=iso-8859-1" },
        },
      })
    );

    expect((await details()).request.postData).toBe("café");
  });

  /** A POST the server answered with a 303: the follow-up GET carries no body headers. */
  function postThen303(firstHopHeaders?: Record<string, string>): AndroidNativeRecord {
    return record({
      request: {
        url: "http://localhost:9090/upload",
        method: "POST",
        hasPostData: true,
        headers: {},
        wireHeaders: { "Host": "localhost:9090", "User-Agent": "okhttp/4.9.2" },
      },
      redirects: [
        {
          url: "http://localhost:9090/upload",
          method: "POST",
          status: 303,
          statusText: "See Other",
          headers: { Location: "/done" },
          ...(firstHopHeaders ? { requestHeaders: firstHopHeaders } : {}),
        },
      ],
      response: { url: "http://localhost:9090/done" },
    });
  }

  it("decodes a request body that a 303 followed by the headers of the hop that carried it", async () => {
    const form = Buffer.from("name=café&city=Zürich", "latin1");
    requestPostData.mockResolvedValue(heldBody(zlib.gzipSync(form)));
    serve(
      postThen303({
        "Content-Type": "application/x-www-form-urlencoded; charset=iso-8859-1",
        "Content-Encoding": "gzip",
        "Content-Length": "40",
        "Cookie": "sid=abc123",
        "Host": "localhost:9090",
      })
    );

    const result = await details();

    expect(result.request.postData).toBe("name=café&city=Zürich");
    expect(result.redirects).toEqual([
      {
        url: "http://localhost:9090/upload",
        method: "POST",
        status: 303,
        statusText: "See Other",
        requestHeaders: {
          "Content-Type": "application/x-www-form-urlencoded; charset=iso-8859-1",
          "Content-Encoding": "gzip",
          "Content-Length": "40",
          "Cookie": "[REDACTED]",
          "Host": "localhost:9090",
        },
        responseHeaders: { Location: "/done" },
      },
    ]);
  });

  it("gives the size and MIME type of a cut request body that a 303 followed from the hop that carried it", async () => {
    const sent = Buffer.from("x".repeat(3 * MIB));
    requestPostData.mockResolvedValue(heldBody(sent.subarray(0, MIB), true));
    serve(postThen303({ "Content-Type": "text/plain", "Content-Length": String(sent.length) }));

    expect((await details()).request.postData).toBe(
      `[TRUNCATED — original size: ${sent.length} bytes as the app sent them; the agent kept only the first 1048576 bytes, MIME: text/plain]\n${"x".repeat(1000)}...`
    );
  });

  it("falls back to the latest hop's headers when the hop that carried the body has none", async () => {
    requestPostData.mockResolvedValue(heldBody(Buffer.from('{"n":1}')));
    serve(postThen303());

    const result = await details();

    expect(result.request.postData).toBe('{"n":1}');
    expect(result.redirects![0]).not.toHaveProperty("requestHeaders");
  });

  it.each([
    ["charset='utf-8'"],
    ["charset=utf_8"],
    ["charset=latin-1"],
    ["charset=utf-8mb4"],
    ["charset=x-no-such-charset"],
  ])("reads a UTF-8 body as UTF-8 when its label is one Node does not know: %s", async (param) => {
    responseBody.mockResolvedValue(heldBody(Buffer.from('{"a":"東京"}')));
    serve(record({ response: { headers: { "content-type": `application/json; ${param}` } } }));

    expect((await details()).response.body).toBe('{"a":"東京"}');
  });

  it.each([
    ["text/plain; charset='iso-8859-1'", Buffer.from([0x63, 0x61, 0x66, 0xe9]), "café"],
    ['text/plain; charset="windows-1252"', Buffer.from([0x93, 0x68, 0x69, 0x94]), "“hi”"],
  ])("strips the quotes around a charset label: %s", async (contentType, bytes, text) => {
    responseBody.mockResolvedValue(heldBody(bytes));
    serve(
      record({ response: { headers: { "Content-Type": contentType }, mimeType: "text/plain" } })
    );

    expect((await details()).response.body).toBe(text);
  });

  it("reads a UTF-8 body that is not valid in the charset its Content-Type names as UTF-8", async () => {
    // An odd number of bytes is never UTF-16.
    const utf8 = Buffer.from('{"a":"東京!"}');
    expect(utf8.length % 2).toBe(1);
    responseBody.mockResolvedValue(heldBody(utf8));
    serve(record({ response: { headers: { "content-type": "text/plain; charset=utf-16le" } } }));

    expect((await details()).response.body).toBe('{"a":"東京!"}');
  });

  it.each([
    [
      "an unknown charset",
      "text/plain; charset=x-no-such-charset",
      Buffer.from([0x6f, 0x6b, 0xff]),
    ],
    ["bytes that are not that charset", "text/plain; charset=shift_jis", Buffer.from([0x93, 0x20])],
  ])("reads a body in %s that is not UTF-8 either as binary", async (_, contentType, bytes) => {
    responseBody.mockResolvedValue(heldBody(bytes));
    serve(
      record({ response: { headers: { "content-type": contentType }, mimeType: "text/plain" } })
    );

    expect((await details()).response.body).toBe(
      `[binary: ${bytes.length} bytes, MIME: text/plain]`
    );
  });
});

describe("view-network-request-details: headers, redirects and the final URL", () => {
  it("shows the headers sent on the wire, with Cookie redacted, and no note", async () => {
    serve(
      record({
        request: {
          url: "http://localhost:9092/check",
          headers: { "X-App": "probe" },
          wireHeaders: {
            "X-App": "probe",
            "Cookie": "sid=abc123",
            "User-Agent": "okhttp/4.9.2",
            "Accept-Encoding": "gzip",
            "Host": "localhost:9092",
          },
        },
      })
    );

    const { request } = await details();

    expect(request.headers).toEqual({
      "X-App": "probe",
      "Cookie": "[REDACTED]",
      "User-Agent": "okhttp/4.9.2",
      "Accept-Encoding": "gzip",
      "Host": "localhost:9092",
    });
    expect(request).not.toHaveProperty("headersNote");
  });

  it("says the headers are the app's when the wire headers were not reported", async () => {
    serve(record({ request: { headers: { "X-App": "probe", "Authorization": "Bearer t" } } }));

    const result = await details();

    expect(result.request.headers).toEqual({ "X-App": "probe", "Authorization": "[REDACTED]" });
    expect(result.request.headersNote).toBe(
      "These are the headers the app set. The headers sent on the wire (such as Cookie and User-Agent) were not reported for this request."
    );
    expect(result.response).not.toHaveProperty("fromCache");
  });

  it("says nothing went on the wire for a response served from the cache", async () => {
    serve(record({ request: { headers: { "X-App": "probe" } }, response: { fromCache: true } }));

    const result = await details();

    expect(result.request.headersNote).toBe(
      "These are the headers the app set. The response came from the cache, so no request went on the wire."
    );
    expect(result.response.fromCache).toBe(true);
  });

  it("shows the redirect hops with their response headers, Set-Cookie redacted, and the final URL", async () => {
    serve(
      record({
        request: {
          url: "http://localhost:9090/redirect",
          headers: {},
          wireHeaders: { "Host": "localhost:9090", "User-Agent": "okhttp/4.9.2" },
        },
        redirects: [
          {
            url: "http://localhost:9090/redirect",
            method: "GET",
            status: 302,
            statusText: "Found",
            headers: { "Location": "/moved", "Set-Cookie": "sid=abc123; Path=/" },
          },
          {
            url: "http://localhost:9090/moved",
            method: "GET",
            status: 307,
            statusText: "Temporary Redirect",
            headers: {},
          },
        ],
        response: { url: "http://localhost:9090/json" },
      })
    );
    responseBody.mockResolvedValue(heldBody(Buffer.from('{"json":true}')));

    const result = await details();

    expect(result.request.url).toBe("http://localhost:9090/redirect");
    expect(result.redirects).toEqual([
      {
        url: "http://localhost:9090/redirect",
        method: "GET",
        status: 302,
        statusText: "Found",
        responseHeaders: { "Location": "/moved", "Set-Cookie": "[REDACTED]" },
      },
      // A hop whose response had no headers shows none.
      {
        url: "http://localhost:9090/moved",
        method: "GET",
        status: 307,
        statusText: "Temporary Redirect",
      },
    ]);
    expect(result.response).toMatchObject({
      url: "http://localhost:9090/json",
      status: 200,
      body: '{"json":true}',
    });
    expect(result.request.headersNote).toBe(
      "These are the headers sent on the wire with the last request, after the hops in redirects."
    );
  });

  it("leaves redirects out when there were none", async () => {
    serve(record());

    const result = await details();

    expect(result).not.toHaveProperty("redirects");
    expect(result.response.url).toBe("http://localhost:9091/ja");
  });
});

describe("view-network-request-details: routing an android- ID", () => {
  it.each([
    ["the adb serial", SERIAL],
    ["an ext: spelling", "ext:acme-3f2a9c:emulator-5554"],
    ["a Metro logicalDeviceId from a shared Metro", "b1946ac92492d2347c6235b4d2611184"],
    ["a logicalDeviceId shaped like an iOS UDID", "6F9619FF-8B86-D011-B42D-00C04FC964FF"],
  ])("resolves through %s, with no debugger service", async (_, deviceId) => {
    serve(record());

    expect(
      networkRequestTool.services!({ device_id: deviceId, requestId: ID, includeBody: true })
    ).toEqual({});
    expect((await details(deviceId)).requestId).toBe(ID);
    expect(findAndroidNativeRecord).toHaveBeenCalledWith(ID);
  });

  it("says an unknown android- ID is not found and names native-network-logs", async () => {
    serve(record());

    expect(
      await networkRequestTool.execute!(
        {},
        {
          device_id: "b1946ac92492d2347c6235b4d2611184",
          requestId: "android-1a2b-99",
          includeBody: true,
        }
      )
    ).toBe(
      "Request android-1a2b-99 not found. Use native-network-logs to list the requests the Android native layer recorded."
    );
  });

  it("keeps a Chromium device on Chromium and any other ID on the JS layer", () => {
    expect(
      Object.keys(
        networkRequestTool.services!({
          device_id: "chromium-cdp-9222",
          requestId: ID,
          includeBody: true,
        })
      )
    ).toEqual(["chromium"]);
    expect(
      networkRequestTool.services!({ device_id: SERIAL, requestId: "rn-net-4", includeBody: true })
    ).toEqual({ inspector: `NetworkInspector:8081:${SERIAL}` });
    expect(findAndroidNativeRecord).not.toHaveBeenCalled();
  });
});
