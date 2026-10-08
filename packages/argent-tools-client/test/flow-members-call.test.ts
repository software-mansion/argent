import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createToolsClient } from "../src/tools-client.js";
import type { FileInputWire } from "../src/file-inputs.js";

/** The listing entry of a flow tool, with the collect spec flow-execute declares. */
const FLOW_TOOL = {
  name: "flow-execute",
  description: "",
  inputSchema: { type: "object", properties: { name: { type: "string" } } },
  longRunning: true,
  fileInputs: [
    {
      target: "flow_file",
      path: "${project_root}/.argent/flows/${name}.yaml",
      kind: "file",
      skipWhenSet: "flow_path",
      collect: "flow",
    },
  ],
};

interface Seen {
  headers: IncomingMessage["headers"];
  body: Record<string, unknown>;
}

let server: Server | undefined;
let url: string;
let seen: Seen[];
let tmp: string;
let proj: string;
let flows: string;

/** A stub tool-server: answers a streamed call as a stream, any other as JSON, unless `onInvoke` says otherwise. */
async function startServer(
  onInvoke?: (req: IncomingMessage, res: ServerResponse) => void
): Promise<void> {
  server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/tools") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ tools: [FLOW_TOOL] }));
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      seen.push({
        headers: req.headers,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>,
      });
      if (onInvoke) {
        onInvoke(req, res);
        return;
      }
      if (req.headers.accept?.includes("application/x-ndjson")) {
        res.writeHead(200, { "Content-Type": "application/x-ndjson" });
        res.end(`${JSON.stringify({ event: "result", data: { ok: true } })}\n`);
        return;
      }
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ data: { ok: true } }));
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}

beforeEach(async () => {
  seen = [];
  tmp = await realpath(await mkdtemp(path.join(tmpdir(), "argent-members-call-")));
  proj = path.join(tmp, "proj");
  flows = path.join(proj, ".argent", "flows");
  await mkdir(flows, { recursive: true });
  await writeFile(path.join(flows, "frag.yaml"), "steps:\n  - echo: inside\n");
  await writeFile(path.join(flows, "withrun.yaml"), "steps:\n  - run: frag.yaml\n");
  await writeFile(path.join(flows, "plain.yaml"), "steps:\n  - echo: alone\n");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
  await rm(tmp, { recursive: true, force: true });
});

function client(remote: boolean, onDiagnostic?: (message: string) => void) {
  const metas: Array<{ url: string; longRunning: boolean; carriesUpload: boolean }> = [];
  const tools = createToolsClient({
    baseUrl: async () => ({ url, token: "", remote }),
    fetchImpl: (target, init, meta) => {
      metas.push({ url: target, ...meta });
      return fetch(target, init);
    },
    ...(onDiagnostic ? { onDiagnostic } : {}),
  });
  const callMeta = () => metas.find((m) => m.url.endsWith("/tools/flow-execute"));
  return { tools, callMeta };
}

const wireOf = (s: Seen) => s.body.flow_file as FileInputWire;

describe("callTool with a collect: flow spec", () => {
  it("sends the closure as members, streams without onProgress, and marks the call an upload", async () => {
    await startServer();
    const { tools, callMeta } = client(true);

    const result = await tools.callTool("flow-execute", { name: "withrun", project_root: proj });

    expect(result.data).toEqual({ ok: true });
    expect(seen).toHaveLength(1);
    const wire = wireOf(seen[0]!);
    expect(wire.members!.map((m) => m.key)).toEqual([`${flows}\0frag.yaml`]);
    expect(wire.canonical).toBe(path.join(flows, "withrun.yaml"));
    expect(seen[0]!.headers.accept).toContain("application/x-ndjson");
    expect(seen[0]!.headers["accept-encoding"]).toBe("identity");
    expect(callMeta()).toMatchObject({ longRunning: true, carriesUpload: true });
  });

  it("sends empty members for a flow with no run: step, without streaming or upload marking", async () => {
    await startServer();
    const { tools, callMeta } = client(true);

    await tools.callTool("flow-execute", { name: "plain", project_root: proj });

    const wire = wireOf(seen[0]!);
    expect(wire.members).toEqual([]);
    expect(wire.content).toBeDefined();
    expect(seen[0]!.headers.accept ?? "").not.toContain("application/x-ndjson");
    expect(callMeta()).toMatchObject({ carriesUpload: false });
  });

  it("sends no members and does not stream when the call is not routed", async () => {
    await startServer();
    const { tools, callMeta } = client(false);

    await tools.callTool("flow-execute", { name: "withrun", project_root: proj });

    const wire = wireOf(seen[0]!);
    expect(wire.members).toBeUndefined();
    expect(wire.canonical).toBeUndefined();
    expect(wire.content).toBeUndefined();
    expect(seen[0]!.headers.accept ?? "").not.toContain("application/x-ndjson");
    expect(callMeta()).toMatchObject({ carriesUpload: false });
  });

  it("sends the [flow-files] lines to onDiagnostic instead of stderr", async () => {
    vi.stubEnv("ARGENT_FLOW_FILES_LOG", "1");
    await startServer();
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const lines: string[] = [];
    const { tools } = client(true, (message) => lines.push(message));

    await tools.callTool("flow-execute", { name: "withrun", project_root: proj });

    expect(lines).toEqual([
      `[flow-files] flow ${path.join(flows, "frag.yaml")}: inline ${"steps:\n  - echo: inside\n".length}`,
    ]);
    expect(stderr.mock.calls.map(([chunk]) => String(chunk)).join("")).not.toContain(
      "[flow-files]"
    );
  });

  it("says the tool may have acted when the stream of a closure call ends without a result", async () => {
    await startServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      res.write(`${JSON.stringify({ event: "progress", data: { index: 0 } })}\n`);
      res.end();
    });
    const { tools } = client(true);

    const err: unknown = await tools
      .callTool("flow-execute", { name: "withrun", project_root: proj })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain(
      "The connection to the tool-server closed before flow-execute finished " +
        "(the stream ended without a result). 1 progress update had arrived"
    );
  });
});
