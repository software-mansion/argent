import { describe, it, expect } from "vitest";
import { parseSseBuffer } from "../src/lens-stream.js";

describe("parseSseBuffer", () => {
  it("parses a single complete frame and leaves no remainder", () => {
    const { events, rest } = parseSseBuffer('event: outcome\ndata: {"a":1}\n\n');
    expect(events).toEqual([{ event: "outcome", data: '{"a":1}' }]);
    expect(rest).toBe("");
  });

  it("defaults the event name to 'message' when only data is present", () => {
    const { events } = parseSseBuffer("data: hello\n\n");
    expect(events).toEqual([{ event: "message", data: "hello" }]);
  });

  it("keeps an incomplete trailing frame in `rest`", () => {
    const { events, rest } = parseSseBuffer(
      'event: outcome\ndata: {"a":1}\n\nevent: agent-choice\ndata: "clau'
    );
    expect(events).toEqual([{ event: "outcome", data: '{"a":1}' }]);
    expect(rest).toBe('event: agent-choice\ndata: "clau');
  });

  it("ignores comment (heartbeat) lines", () => {
    const { events } = parseSseBuffer(": ping\n\nevent: x\ndata: y\n\n");
    expect(events).toEqual([{ event: "x", data: "y" }]);
  });

  it("strips exactly one leading space after the colon", () => {
    const { events } = parseSseBuffer("data:  two-spaces\n\n");
    // First space is the SSE delimiter; the second is real content.
    expect(events[0]!.data).toBe(" two-spaces");
  });

  it("joins multiple data lines with newline", () => {
    const { events } = parseSseBuffer("data: line1\ndata: line2\n\n");
    expect(events[0]!.data).toBe("line1\nline2");
  });

  it("normalises CRLF line endings", () => {
    const { events, rest } = parseSseBuffer("event: x\r\ndata: y\r\n\r\n");
    expect(events).toEqual([{ event: "x", data: "y" }]);
    expect(rest).toBe("");
  });

  it("parses several frames in one buffer", () => {
    const { events } = parseSseBuffer(
      'event: agent-choice\ndata: "claude"\n\nevent: outcome\ndata: {"completedAt":5}\n\n'
    );
    expect(events).toEqual([
      { event: "agent-choice", data: '"claude"' },
      { event: "outcome", data: '{"completedAt":5}' },
    ]);
  });

  it("drops a frame that carries no data field", () => {
    const { events } = parseSseBuffer("event: only-event\n\n");
    expect(events).toEqual([]);
  });
});
