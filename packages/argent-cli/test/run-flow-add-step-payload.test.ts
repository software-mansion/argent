import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as http from "node:http";
import { run, type RunCommandOptions } from "../src/run.js";

// End-to-end regression guard for issue #452 at the `run()` layer.
//
// The documented per-flag form
//   argent run flow-add-step --command gesture-tap --args '{"udid":...}'
// must reach the tool-server with BOTH `command` AND the tool's own `args`
// field in the payload. The bug shadowed the `args` field with the
// whole-payload escape hatch, so `args` was consumed as the entire payload and
// the field arrived `undefined` (with udid/x/y hoisted to the top level).
//
// `parseFlags` is unit-tested directly, and `--help` suppression is covered in
// run-help.test.ts. Neither drives the whole `run()` path through to the wire.
// This does: a real in-process tool-server captures the exact POST body the
// CLI sends, so a future change that reconnected flag parsing to the payload
// builder incorrectly would fail here even with the parser unit tests green.

interface Captured {
  path: string | null;
  body: string | null;
}

function startServer(cap: Captured): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const url = req.url ?? "";
    if (url === "/tools" && req.method === "GET") {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          tools: [
            {
              name: "flow-add-step",
              description: "Add a step to the active flow recording",
              inputSchema: {
                type: "object",
                properties: {
                  command: { type: "string" },
                  args: { type: "string" },
                  delayMs: { type: "integer" },
                },
                required: ["command"],
              },
            },
          ],
        })
      );
      return;
    }
    if (url.startsWith("/tools/flow-add-step") && req.method === "POST") {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => {
        cap.path = url;
        cap.body = data;
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            data: { message: 'Step added to "t" flow', toolResult: { tapped: true } },
          })
        );
      });
      return;
    }
    res.statusCode = 404;
    res.end("not found");
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

describe("CLI run — flow-add-step --args reaches the payload (issue #452)", () => {
  let server: { url: string; close: () => Promise<void> };
  let cap: Captured;
  let errs: string[];
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  const opts: RunCommandOptions = { paths: {} as never }; // unused: ARGENT_TOOLS_URL is set

  beforeEach(async () => {
    cap = { path: null, body: null };
    server = await startServer(cap);
    process.env.ARGENT_TOOLS_URL = server.url;

    errs = [];
    logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    errSpy = vi.spyOn(console, "error").mockImplementation((...a) => void errs.push(a.join(" ")));
    exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code}) called: ${errs.join("; ")}`);
    }) as never);
  });

  afterEach(async () => {
    logSpy.mockRestore();
    errSpy.mockRestore();
    exitSpy.mockRestore();
    delete process.env.ARGENT_TOOLS_URL;
    await server.close();
  });

  it("per-flag form: --command X --args '<json>' sends BOTH fields verbatim to the server", async () => {
    const stepArgs = '{"udid":"SIM-1","x":0.5,"y":0.35}';

    await run(["flow-add-step", "--command", "gesture-tap", "--args", stepArgs], opts);

    expect(cap.path).toMatch(/^\/tools\/flow-add-step/);
    expect(cap.body).not.toBeNull();
    const payload = JSON.parse(cap.body!) as Record<string, unknown>;
    // The exact regression from #452: `args` survives as the tool's own string
    // field (the raw JSON passed through untouched), and its keys are NOT
    // hoisted to the top level as they were when `--args` was swallowed whole.
    expect(payload).toEqual({ command: "gesture-tap", args: stepArgs });
  });

  it("inline --args=<json> form also sends both fields", async () => {
    const stepArgs = '{"udid":"SIM-1","x":0.5,"y":0.35}';

    await run(["flow-add-step", "--command", "gesture-tap", `--args=${stepArgs}`], opts);

    const payload = JSON.parse(cap.body!) as Record<string, unknown>;
    expect(payload).toEqual({ command: "gesture-tap", args: stepArgs });
  });
});
