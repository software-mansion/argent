import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import type { Registry } from "@argent/registry";
import { createPreviewRouter } from "../src/preview";
import { variantProposalStore } from "../src/utils/variant-proposals";

// Minimal SSE frame parse for the test (mirrors the CLI's parseSseBuffer).
function parseFrames(buf: string): Array<{ event: string; data: string }> {
  const out: Array<{ event: string; data: string }> = [];
  for (const frame of buf.split("\n\n")) {
    let event = "message";
    const data: string[] = [];
    for (const line of frame.split("\n")) {
      if (line.startsWith(":") || line === "") continue;
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
    }
    if (data.length) out.push({ event, data: data.join("\n") });
  }
  return out;
}

let server: http.Server | null = null;

afterEach(async () => {
  // Reset shared store state so the next test starts clean.
  variantProposalStore.setCliSession(false);
  if (server) {
    await new Promise<void>((r) => server!.close(() => r()));
    server = null;
  }
});

async function startServer(): Promise<string> {
  const registry = { invokeTool: async () => ({ devices: [] }) } as unknown as Registry;
  const app = express();
  app.use(express.json());
  app.use("/preview", createPreviewRouter(registry));
  server = http.createServer(app);
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  const { port } = server!.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

/**
 * Connect to the SSE stream and collect frames until `predicate` is satisfied
 * or the timeout elapses, then abort. Runs `onConnected` once the stream is
 * open so the caller can trigger store events that should be pushed.
 */
async function collectFrames(
  base: string,
  onConnected: () => void,
  predicate: (frames: Array<{ event: string; data: string }>) => boolean,
  timeoutMs = 2_000
): Promise<Array<{ event: string; data: string }>> {
  const ac = new AbortController();
  const res = await fetch(`${base}/preview/lens-stream`, { signal: ac.signal });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let connectedFired = false;
  const deadline = Date.now() + timeoutMs;
  try {
    // Fire the trigger on the next tick so the subscription is fully wired.
    setTimeout(() => {
      connectedFired = true;
      onConnected();
    }, 20);
    while (Date.now() < deadline) {
      const readPromise = reader.read();
      const timed = await Promise.race([
        readPromise,
        new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 200)),
      ]);
      if (timed === "timeout") {
        if (connectedFired && predicate(parseFrames(buf))) break;
        continue;
      }
      const { value, done } = timed;
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      if (connectedFired && predicate(parseFrames(buf))) break;
    }
  } finally {
    ac.abort();
    try {
      reader.releaseLock();
    } catch {
      /* ignore */
    }
  }
  return parseFrames(buf);
}

describe("GET /preview/lens-stream (SSE push)", () => {
  it("pushes an agent-choice frame when the human picks", async () => {
    const base = await startServer();
    variantProposalStore.setCliSession(true, [{ id: "claude", name: "Claude Code" }]);

    const frames = await collectFrames(
      base,
      () => variantProposalStore.setLensAgentChoice("claude"),
      (f) => f.some((x) => x.event === "agent-choice")
    );

    const choice = frames.find((f) => f.event === "agent-choice");
    expect(choice).toBeDefined();
    expect(JSON.parse(choice!.data)).toEqual({ id: "claude", remember: false });
  });

  it("carries the remember flag when the human ticks 'Remember this choice'", async () => {
    const base = await startServer();
    variantProposalStore.setCliSession(true, [{ id: "claude", name: "Claude Code" }]);

    const frames = await collectFrames(
      base,
      () => variantProposalStore.setLensAgentChoice("claude", true),
      (f) => f.some((x) => x.event === "agent-choice")
    );

    const choice = frames.find((f) => f.event === "agent-choice");
    expect(JSON.parse(choice!.data)).toEqual({ id: "claude", remember: true });
  });

  it("pushes an outcome frame when a round is submitted", async () => {
    const base = await startServer();
    variantProposalStore.setCliSession(true);
    variantProposalStore.proposeVariant({
      element: "Foo",
      variant: { name: "Bold", summary: "bold" },
    });

    const frames = await collectFrames(
      base,
      () =>
        variantProposalStore.submitSelection({
          selections: [],
          annotations: [
            { target: "Foo", match: { by: "text", value: "Foo" }, comment: "make it pop" },
          ],
        }),
      (f) => f.some((x) => x.event === "outcome")
    );

    const outcome = frames.find((f) => f.event === "outcome");
    expect(outcome).toBeDefined();
    const parsed = JSON.parse(outcome!.data);
    expect(parsed.status).toBe("completed");
    expect(parsed.annotations[0].comment).toBe("make it pop");
    expect(typeof parsed.completedAt).toBe("number");
  });

  it("replays the existing agent choice to a late subscriber", async () => {
    const base = await startServer();
    variantProposalStore.setCliSession(true, [{ id: "codex", name: "Codex CLI" }]);
    variantProposalStore.setLensAgentChoice("codex"); // picked BEFORE we connect

    const frames = await collectFrames(
      base,
      () => {
        /* nothing — the choice already happened */
      },
      (f) => f.some((x) => x.event === "agent-choice")
    );

    expect(JSON.parse(frames.find((f) => f.event === "agent-choice")!.data)).toEqual({
      id: "codex",
      remember: false,
    });
  });

  it("pushes session-end when the CLI session closes", async () => {
    const base = await startServer();
    variantProposalStore.setCliSession(true);

    const frames = await collectFrames(
      base,
      () => variantProposalStore.setCliSession(false),
      (f) => f.some((x) => x.event === "session-end")
    );

    expect(frames.some((f) => f.event === "session-end")).toBe(true);
  });
});
