import { describe, it, expect } from "vitest";
import { PassThrough } from "node:stream";
import type * as net from "node:net";
import { FAILURE_CODES, getFailureSignal } from "@argent/registry";
import { attachNdjsonReader, createNdjsonCdpRequester } from "../src/utils/ndjson-socket";

// A PassThrough stands in for the net.Socket: the reader only needs
// setEncoding / on("data") / on("end").
function harness(options?: { maxFrameChars?: number }) {
  const stream = new PassThrough();
  const messages: unknown[] = [];
  const dropped: { bytes: number; preview: string }[] = [];
  attachNdjsonReader(
    stream as unknown as net.Socket,
    {
      onMessage: (m) => messages.push(m),
      onDropped: (d) => dropped.push(d),
    },
    options
  );
  return { stream, messages, dropped };
}

const settle = () => new Promise((r) => setImmediate(r));

describe("attachNdjsonReader", () => {
  it("keeps U+2028 / U+2029 inside a string in one frame (the Element stall)", async () => {
    const { stream, messages, dropped } = harness();
    const label = "In reply to Dave\u2028Loving it so far\u2029next";
    stream.write(JSON.stringify({ id: 1, result: { label } }) + "\n");
    await settle();
    expect(messages).toEqual([{ id: 1, result: { label } }]);
    expect(dropped).toEqual([]);
  });

  it("reassembles a frame split across chunks, including mid multi-byte character", async () => {
    const { stream, messages } = harness();
    const bytes = Buffer.from(JSON.stringify({ id: 2, label: "café\u2028ünïcode" }) + "\n", "utf8");
    // Cut inside the 3-byte U+2028 sequence.
    const cut = bytes.indexOf(Buffer.from("\u2028", "utf8")) + 1;
    stream.write(bytes.subarray(0, cut));
    await settle();
    expect(messages).toEqual([]);
    stream.write(bytes.subarray(cut));
    await settle();
    expect(messages).toEqual([{ id: 2, label: "café\u2028ünïcode" }]);
  });

  it("delivers several frames arriving in one chunk, in order", async () => {
    const { stream, messages } = harness();
    stream.write('{"id":1}\n{"id":2}\n{"id":3}\n');
    await settle();
    expect(messages.map((m) => (m as { id: number }).id)).toEqual([1, 2, 3]);
  });

  it("skips empty lines and tolerates CRLF", async () => {
    const { stream, messages, dropped } = harness();
    stream.write('\n{"id":1}\r\n\r\n{"id":2}\n');
    await settle();
    expect(messages).toEqual([{ id: 1 }, { id: 2 }]);
    expect(dropped).toEqual([]);
  });

  it("reports an unparseable frame with byte length and a sanitised preview, then continues", async () => {
    const { stream, messages, dropped } = harness();
    // Multi-byte frame: 13 characters, 15 UTF-8 bytes. An ASCII frame makes the two
    // readings equal, so the reported count would pin neither.
    stream.write("garbage\there✓\n" + '{"id":9}\n');
    await settle();
    expect(messages).toEqual([{ id: 9 }]);
    expect(dropped).toHaveLength(1);
    expect(dropped[0]!.bytes).toBe(15);
    expect(dropped[0]!.preview).toBe("garbage·here✓");
  });

  it("drops a frame that grows past maxFrameChars without ending, and destroys the socket", async () => {
    const { stream, messages, dropped } = harness({ maxFrameChars: 16 });
    stream.write('{"id":1}\n' + "x".repeat(16));
    await settle();
    expect(stream.destroyed).toBe(false);

    stream.write("x");
    await settle();
    expect(messages).toEqual([{ id: 1 }]);
    expect(dropped).toEqual([{ bytes: 17, preview: "x".repeat(17) }]);
    expect(stream.destroyed).toBe(true);
  });

  it("delivers a trailing frame without newline when the stream ends", async () => {
    const { stream, messages } = harness();
    stream.write('{"id":7}');
    stream.end();
    await settle();
    expect(messages).toEqual([{ id: 7 }]);
  });
});

function captureFrames(stream: PassThrough): () => unknown[] {
  let written = "";
  stream.on("data", (chunk: Buffer) => {
    written += chunk.toString("utf8");
  });
  return () =>
    written
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as unknown);
}

describe("createNdjsonCdpRequester", () => {
  it("writes { type: CDP, payload: { id, method, params } } and settles each request by its id", async () => {
    const stream = new PassThrough();
    const frames = captureFrames(stream);
    const cdp = createNdjsonCdpRequester(stream as unknown as net.Socket, { label: "test" });

    const enable = cdp.request("Network.enable");
    const body = cdp.request("Network.getResponseBody", { requestId: "android-1" });
    await settle();
    expect(frames()).toEqual([
      { type: "CDP", payload: { id: 1, method: "Network.enable", params: {} } },
      {
        type: "CDP",
        payload: { id: 2, method: "Network.getResponseBody", params: { requestId: "android-1" } },
      },
    ]);

    expect(cdp.handleResponse({ id: 2, result: { body: "b" } })).toBe(true);
    expect(cdp.handleResponse({ id: 1, result: {} })).toBe(true);
    await expect(enable).resolves.toEqual({});
    await expect(body).resolves.toEqual({ body: "b" });
  });

  it("leaves events to the caller: a payload with a method is no reply", () => {
    const cdp = createNdjsonCdpRequester(new PassThrough() as unknown as net.Socket, {
      label: "test",
    });
    expect(
      cdp.handleResponse({ method: "Network.requestWillBeSent", params: { requestId: "x" } })
    ).toBe(false);
    expect(cdp.handleResponse({ id: 1, method: "Network.enable", params: {} })).toBe(false);
    expect(cdp.handleResponse({ id: 1 })).toBe(false);
    expect(cdp.handleResponse(null)).toBe(false);
  });

  it("rejects on an error reply", async () => {
    const cdp = createNdjsonCdpRequester(new PassThrough() as unknown as net.Socket, {
      label: "test",
    });
    const post = cdp.request("Network.getRequestPostData", { requestId: "android-9" });
    cdp.handleResponse({ id: 1, error: { code: -32000, message: "no such request" } });

    const err = await post.catch((e: unknown) => e);
    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.NDJSON_CDP_REQUEST_FAILED);
    expect((err as Error).message).toBe("test: Network.getRequestPostData failed: no such request");
  });

  it("rejects on an error reply nested too deep to print, rather than throwing out of the reader", async () => {
    const cdp = createNdjsonCdpRequester(new PassThrough() as unknown as net.Socket, {
      label: "test",
    });
    const post = cdp.request("Network.getRequestPostData", { requestId: "android-9" });
    // JSON.stringify throws a RangeError at this depth on Node 20 to 24.
    const deep: unknown = JSON.parse(`${"[".repeat(1_000_000)}${"]".repeat(1_000_000)}`);

    expect(cdp.handleResponse({ id: 1, error: deep })).toBe(true);

    const err = await post.catch((e: unknown) => e);
    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.NDJSON_CDP_REQUEST_FAILED);
  });

  it("times a request out, then consumes and drops its late reply", async () => {
    const cdp = createNdjsonCdpRequester(new PassThrough() as unknown as net.Socket, {
      label: "test",
      timeoutMs: 20,
    });
    const err = await cdp.request("Network.getRequestPostData").catch((e: unknown) => e);
    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.NDJSON_CDP_REQUEST_TIMEOUT);
    expect(cdp.handleResponse({ id: 1, result: {} })).toBe(true);
  });

  it("rejects the requests in flight and every later one once closed, and when the socket cannot write", async () => {
    const cdp = createNdjsonCdpRequester(new PassThrough() as unknown as net.Socket, {
      label: "test",
    });
    const inFlight = cdp.request("Network.getResponseBody", { requestId: "android-1" });
    cdp.close();
    for (const pending of [inFlight, cdp.request("Network.enable")]) {
      const err = await pending.catch((e: unknown) => e);
      expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.NDJSON_CDP_CONNECTION_CLOSED);
    }

    const destroyed = new PassThrough();
    destroyed.destroy();
    const err = await createNdjsonCdpRequester(destroyed as unknown as net.Socket, {
      label: "test",
    })
      .request("Network.enable")
      .catch((e: unknown) => e);
    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.NDJSON_CDP_CONNECTION_CLOSED);
  });
});
