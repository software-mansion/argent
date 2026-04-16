// Minimal repro: proves that a single EPIPE on stdout kills a Node child
// process (mimicking "argent mcp") and turns every subsequent request
// from the parent (mimicking Codex) into a "transport closed" scenario.
//
// Two variants:
//   1. No error handlers → child dies on EPIPE → parent sees transport die
//   2. With error handlers → child survives → parent can still send requests

import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";

// Minimal "MCP server" — reads newline-delimited JSON from stdin,
// echoes back a response on stdout.
const CHILD_WITHOUT_HANDLERS = `
process.stdin.setEncoding("utf8");
let buf = "";
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf("\\n")) !== -1) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    const msg = JSON.parse(line);
    const reply = JSON.stringify({ id: msg.id, result: "ok" }) + "\\n";
    process.stdout.write(reply);
  }
});
`;

const CHILD_WITH_HANDLERS = `
// Same as above, but with the stdout error handler from our fix.
process.stdout.on("error", (err) => {
  // Swallow EPIPE — the reader disconnected momentarily.
  if (err.code !== "EPIPE") {
    process.stderr.write("stdout error: " + err.message + "\\n");
  }
});
process.on("uncaughtException", (err) => {
  process.stderr.write("uncaught: " + err.message + "\\n");
});

process.stdin.setEncoding("utf8");
let buf = "";
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf("\\n")) !== -1) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    const msg = JSON.parse(line);
    const reply = JSON.stringify({ id: msg.id, result: "ok" }) + "\\n";
    try { process.stdout.write(reply); } catch {}
  }
});
`;

function send(child: ReturnType<typeof spawn>, id: number): void {
  child.stdin!.write(JSON.stringify({ id }) + "\n");
}

function collectResponses(child: ReturnType<typeof spawn>): object[] {
  const responses: object[] = [];
  let buf = "";
  child.stdout!.setEncoding("utf8");
  child.stdout!.on("data", (chunk: string) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (line) {
        try {
          responses.push(JSON.parse(line));
        } catch {}
      }
    }
  });
  return responses;
}

describe("EPIPE → Transport Closed repro", () => {
  it("WITHOUT handlers: child dies on EPIPE, parent loses the transport", async () => {
    const child = spawn("node", ["-e", CHILD_WITHOUT_HANDLERS], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    const responses = collectResponses(child);

    // Step 1: send a request, get a response — transport works.
    send(child, 1);
    await new Promise((r) => setTimeout(r, 200));
    expect(responses.find((r: any) => r.id === 1)).toBeDefined();

    // Step 2: destroy our read end of the child's stdout. This is what
    // happens from the OS perspective when Codex closes the pipe.
    child.stdout!.destroy();

    // Step 3: send another request. The child tries to write the reply
    // to a broken pipe → EPIPE → uncaught exception → process exits.
    send(child, 2);

    const exitCode = await new Promise<number | null>((resolve) => {
      child.on("exit", (code) => resolve(code));
      setTimeout(() => resolve(null), 3000);
    });

    // The child is DEAD. This is the root cause of "Transport Closed".
    expect(exitCode).not.toBeNull();

    // Step 4: any further writes from the parent fail — the transport
    // is gone. This is what Codex experiences.
    let writeFailed = false;
    try {
      child.stdin!.write(JSON.stringify({ id: 3 }) + "\n");
      // Give Node a tick to detect the broken pipe
      await new Promise((r) => setTimeout(r, 100));
      child.stdin!.write(JSON.stringify({ id: 4 }) + "\n");
    } catch {
      writeFailed = true;
    }
    // stdin write may or may not throw synchronously (depends on
    // buffering), but the child is dead so no response will ever come.
    child.kill("SIGKILL");
  }, 10_000);

  it("WITH handlers: child survives EPIPE, transport stays usable", async () => {
    const child = spawn("node", ["-e", CHILD_WITH_HANDLERS], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    const responses = collectResponses(child);

    // Step 1: transport works.
    send(child, 1);
    await new Promise((r) => setTimeout(r, 200));
    expect(responses.find((r: any) => r.id === 1)).toBeDefined();

    // Step 2: break stdout (simulate Codex closing the read end).
    child.stdout!.destroy();

    // Step 3: send a request — the child's write will EPIPE, but the
    // handler swallows it. The child stays alive.
    send(child, 2);
    await new Promise((r) => setTimeout(r, 500));

    // Step 4: verify the child is still alive.
    let alive = false;
    try {
      process.kill(child.pid!, 0); // signal 0 = existence check
      alive = true;
    } catch {
      alive = false;
    }
    expect(alive).toBe(true);

    // Step 5: re-attach a reader and confirm the child can still
    // process requests. We can't re-attach stdout, but we can verify
    // stdin is still writable (the child process hasn't exited).
    let stdinWritable = true;
    try {
      child.stdin!.write(JSON.stringify({ id: 5 }) + "\n");
    } catch {
      stdinWritable = false;
    }
    expect(stdinWritable).toBe(true);

    child.kill("SIGKILL");
  }, 10_000);
});
