/**
 * Minimal Server-Sent-Events client for `argent lens`.
 *
 * The tool-server pushes `agent-choice` / `outcome` / `session-end` frames over
 * `GET /preview/lens-stream` the instant the underlying store event fires —
 * this replaces the old fixed-interval poll of `/preview/outcome`. Node has no
 * built-in `EventSource`, so we read the `fetch` response body (a web
 * `ReadableStream`) and parse the wire format ourselves. The framing parser is
 * split out as a pure function so it can be unit-tested without a socket.
 */

export interface SseEvent {
  /** The `event:` field (defaults to "message" per the SSE spec). */
  event: string;
  /** The joined `data:` field(s) — for our frames, a JSON string. */
  data: string;
}

/**
 * Parse as many COMPLETE SSE frames as `buffer` contains, returning them plus
 * the unconsumed remainder (a partial frame still arriving). Frames are
 * separated by a blank line; `:`-prefixed lines are comments (heartbeats) and
 * ignored. Only `event:` and `data:` fields are read; multiple `data:` lines
 * join with "\n" per the spec.
 */
export function parseSseBuffer(buffer: string): { events: SseEvent[]; rest: string } {
  // Normalise CRLF so the blank-line split is uniform.
  const normalised = buffer.replace(/\r\n/g, "\n");
  const events: SseEvent[] = [];
  let rest = normalised;

  for (;;) {
    const sep = rest.indexOf("\n\n");
    if (sep === -1) break;
    const rawFrame = rest.slice(0, sep);
    rest = rest.slice(sep + 2);

    let event = "message";
    const dataLines: string[] = [];
    for (const line of rawFrame.split("\n")) {
      if (line === "" || line.startsWith(":")) continue; // blank or comment
      const colon = line.indexOf(":");
      const field = colon === -1 ? line : line.slice(0, colon);
      // A single leading space after the colon is stripped per the SSE spec.
      let value = colon === -1 ? "" : line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "event") event = value;
      else if (field === "data") dataLines.push(value);
    }
    // A frame with no data field (e.g. a stray comment block) carries nothing.
    if (dataLines.length > 0) events.push({ event, data: dataLines.join("\n") });
  }
  return { events, rest };
}

/**
 * Subscribe to the Lens SSE stream, yielding each parsed event. Ends when the
 * server closes the stream or `signal` aborts. Throws on a non-OK response or a
 * mid-stream network error — the caller decides whether to reconnect.
 */
export async function* lensEvents(baseUrl: string, signal: AbortSignal): AsyncGenerator<SseEvent> {
  const res = await fetch(`${baseUrl}/preview/lens-stream`, {
    signal,
    headers: { Accept: "text/event-stream" },
  });
  if (!res.ok || !res.body) {
    throw new Error(`lens-stream: HTTP ${res.status}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buf += decoder.decode(value, { stream: true });
      const { events, rest } = parseSseBuffer(buf);
      buf = rest;
      for (const ev of events) yield ev;
    }
  } finally {
    // Releasing the lock lets the underlying connection be torn down when the
    // generator is disposed (break / abort), so we don't leak sockets.
    try {
      reader.releaseLock();
    } catch {
      /* already released */
    }
  }
}
