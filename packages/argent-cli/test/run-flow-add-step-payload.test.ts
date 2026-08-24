import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as http from "node:http";
import { run, type RunCommandOptions } from "../src/run.js";

// End-to-end regression guard for issue #452 at the `run()` layer.
//
// The documented per-flag form
//   argent run flow-add-step --name t --project_root /p --command gesture-tap \
//     --args '{"udid":...}'
// must reach the tool-server with the recording identity (`name` +
// `project_root`), the `command`, AND the tool's own `args` field in the
// payload. The bug shadowed the `args` field with the whole-payload escape
// hatch, so `args` was consumed as the entire payload and the field arrived
// `undefined` (with udid/x/y hoisted to the top level).
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
              // Leading sentence of the real tool description, verbatim.
              description:
                "Execute a tool call and record it as a step in the flow named by `name` + `project_root` (the recording must already be open — see flow-start-recording).",
              // Mirrors what the registry advertises for the real tool —
              // zodObjectToJsonSchema over the zod schema in
              // packages/tool-server/src/tools/flows/flow-add-step.ts. `name`
              // and `project_root` identify which open recording the step
              // belongs to and are required alongside `command`.
              //
              // Only `properties` is load-bearing here: `parseFlags` reads it
              // to decide whether `args` belongs to the tool, and reads
              // `required` nowhere (its one consumer is `formatSchemaUsage`,
              // the help renderer, which this file never invokes — that is
              // covered by run-help.test.ts). The array is kept faithful so the
              // fixture stays readable as the real schema, not because dropping
              // an entry would fail here.
              //
              // Hand-copied because `@argent/cli` does not depend on the
              // tool-server. The guard that catches drift lives where the schema
              // does — flow-tools.test.ts's "the flow-add-step schema the CLI
              // tests hand-copy"; if that fails, this is one of the fixtures it
              // is telling you to update.
              inputSchema: {
                type: "object",
                properties: {
                  name: { type: "string" },
                  project_root: { type: "string" },
                  command: { type: "string" },
                  args: { type: "string" },
                  delayMs: { type: "integer", minimum: 0, maximum: 9007199254740991 },
                },
                required: ["name", "project_root", "command"],
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

  const FLOW = "checkout-e2e";
  // A path with a space: the shell hands argv already split, so the value must
  // arrive verbatim rather than being re-split or truncated by the parser.
  const ROOT = "/Users/dev/My Projects/demo-app";

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

  it("per-flag form: every required field plus --args '<json>' reaches the server verbatim", async () => {
    const stepArgs = '{"udid":"SIM-1","x":0.5,"y":0.35}';

    await run(
      [
        "flow-add-step",
        "--name",
        FLOW,
        "--project_root",
        ROOT,
        "--command",
        "gesture-tap",
        "--args",
        stepArgs,
      ],
      opts
    );

    expect(cap.path).toMatch(/^\/tools\/flow-add-step/);
    expect(cap.body).not.toBeNull();
    const payload = JSON.parse(cap.body!) as Record<string, unknown>;
    // The exact regression from #452: `args` survives as the tool's own string
    // field (the raw JSON passed through untouched), and its keys are NOT
    // hoisted to the top level as they were when `--args` was swallowed whole.
    // The recording identity rides alongside it — without both `name` and
    // `project_root` the server cannot find the open recording, so a payload
    // missing either is a failed step, not a mislabelled one.
    expect(payload).toEqual({
      name: FLOW,
      project_root: ROOT,
      command: "gesture-tap",
      args: stepArgs,
    });
  });

  it("inline --field=<value> form sends the same payload", async () => {
    const stepArgs = '{"udid":"SIM-1","x":0.5,"y":0.35}';

    await run(
      [
        "flow-add-step",
        `--name=${FLOW}`,
        `--project_root=${ROOT}`,
        "--command",
        "gesture-tap",
        `--args=${stepArgs}`,
      ],
      opts
    );

    const payload = JSON.parse(cap.body!) as Record<string, unknown>;
    expect(payload).toEqual({
      name: FLOW,
      project_root: ROOT,
      command: "gesture-tap",
      args: stepArgs,
    });
  });

  it("coerces --delayMs by its declared integer type and omits absent optionals", async () => {
    // `delayMs` is the only non-string field in the schema, so it is the one
    // place the payload can arrive with the wrong JSON type: a string "250"
    // fails the server's zod validation. `args` is optional — omitting the flag
    // must leave the key out rather than sending null/"".
    await run(
      [
        "flow-add-step",
        "--name",
        FLOW,
        "--project_root",
        ROOT,
        "--command",
        "screenshot",
        "--delayMs",
        "250",
      ],
      opts
    );

    const payload = JSON.parse(cap.body!) as Record<string, unknown>;
    expect(payload).toEqual({
      name: FLOW,
      project_root: ROOT,
      command: "screenshot",
      delayMs: 250,
    });
    expect(payload).not.toHaveProperty("args");
  });
});
