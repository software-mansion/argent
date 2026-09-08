import { describe, it, expect } from "vitest";
import { PassThrough } from "node:stream";
import type * as net from "node:net";
import { attachNdjsonReader } from "../src/utils/ndjson-socket";

// A PassThrough stands in for the net.Socket: the reader only needs
// setEncoding / on("data") / on("end").
function harness() {
  const stream = new PassThrough();
  const messages: unknown[] = [];
  const dropped: { bytes: number; preview: string }[] = [];
  attachNdjsonReader(stream as unknown as net.Socket, {
    onMessage: (m) => messages.push(m),
    onDropped: (d) => dropped.push(d),
  });
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
    stream.write("garbage\there\n" + '{"id":9}\n');
    await settle();
    expect(messages).toEqual([{ id: 9 }]);
    expect(dropped).toHaveLength(1);
    expect(dropped[0]!.bytes).toBe(Buffer.byteLength("garbage\there"));
    expect(dropped[0]!.preview).toBe("garbage·here");
  });

  it("delivers a trailing frame without newline when the stream ends", async () => {
    const { stream, messages } = harness();
    stream.write('{"id":7}');
    stream.end();
    await settle();
    expect(messages).toEqual([{ id: 7 }]);
  });
});
