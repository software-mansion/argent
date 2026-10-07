import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import * as fs from "node:fs/promises";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { redirectHomeTo } from "./helpers/home-redirect.js";

// link-config.ts captures ~/.argent/link.json at module load; an isolated HOME
// keeps a developer's real link out of the "routing is local" case.
let createToolsClient: typeof import("../src/tools-client.js").createToolsClient;
let TEST_HOME: string;
let restoreHome: () => void;

beforeAll(async () => {
  TEST_HOME = mkdtempSync(path.join(tmpdir(), "argent-client-services-wire-"));
  restoreHome = redirectHomeTo(TEST_HOME);
  vi.resetModules();
  ({ createToolsClient } = await import("../src/tools-client.js"));
});

afterAll(() => {
  restoreHome();
  rmSync(TEST_HOME, { recursive: true, force: true });
});

interface Recorded {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: unknown;
}

const ADVERT = { ops: ["resolve-file"] };

let server: Server;
let url: string;
let requests: Recorded[];
let projectDir: string;
let flowsDir: string;
/** Per test: how POST /tools/flow-execute answers, given the parsed body. */
let onInvoke: (body: unknown, res: ServerResponse) => void | Promise<void>;
/** Per test: the statuses of successive answer POSTs; 200 once the list is used up. */
let answerStatuses: number[];
/** Per test: the answer route reads the POST and never answers it. */
let answerHangs: boolean;
/** Resolves once per posted answer, so the invoke stub can wait for it. */
let answerPosted: () => void;
let nextAnswer: Promise<void>;
let listing: unknown[];

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      resolve(raw ? JSON.parse(raw) : undefined);
    });
  });
}

function armAnswer(): void {
  nextAnswer = new Promise<void>((resolve) => {
    answerPosted = resolve;
  });
}

beforeEach(async () => {
  requests = [];
  answerStatuses = [];
  answerHangs = false;
  listing = [
    { name: "flow-execute", description: "", inputSchema: {}, clientServices: ADVERT },
    { name: "plain", description: "", inputSchema: {} },
  ];
  onInvoke = (_body, res) => {
    res.writeHead(200, { "Content-Type": "application/x-ndjson" });
    res.end(`${JSON.stringify({ event: "result", data: { ok: true } })}\n`);
  };
  armAnswer();

  projectDir = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "client-services-wire-")));
  flowsDir = path.join(projectDir, ".argent", "flows");
  await fs.mkdir(flowsDir, { recursive: true });
  await fs.writeFile(path.join(flowsDir, "root.yaml"), "steps:\n  - run: frag.yaml\n");
  await fs.writeFile(path.join(flowsDir, "frag.yaml"), "steps:\n  - echo: hi\n");

  server = createServer(async (req, res) => {
    const body = await readJson(req);
    requests.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
    if (req.method === "GET" && req.url === "/tools") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ tools: listing }));
      return;
    }
    if (req.method === "POST" && req.url === "/tools/flow-execute") {
      await onInvoke(body, res);
      return;
    }
    if (req.method === "POST" && req.url === "/tools/plain") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: { plain: true } }));
      return;
    }
    if (req.method === "POST" && /^\/invocations\/[^/]+\/client-responses$/.test(req.url ?? "")) {
      if (answerHangs) return;
      const status = answerStatuses.shift() ?? 200;
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(status === 200 ? { accepted: true } : { error: "nope" }));
      answerPosted();
      return;
    }
    res.writeHead(404);
    res.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await fs.rm(projectDir, { recursive: true, force: true });
});

function invokeRequest(): Recorded {
  const found = requests.find((r) => r.url === "/tools/flow-execute");
  if (!found) throw new Error("no invoke request recorded");
  return found;
}

function answerRequests(): Recorded[] {
  return requests.filter((r) => r.url.startsWith("/invocations/"));
}

/** A request line the stub server writes, followed by the result once answered. */
function streamOneRequest(line: Record<string, unknown>) {
  onInvoke = async (_body, res) => {
    res.writeHead(200, { "Content-Type": "application/x-ndjson" });
    res.write(`${JSON.stringify({ event: "progress", data: { index: 0 } })}\n`);
    res.write(`${JSON.stringify({ event: "client-request", invocation: "inv-1", ...line })}\n`);
    await nextAnswer;
    res.end(`${JSON.stringify({ event: "result", data: { ran: true }, note: "done" })}\n`);
  };
}

describe("callTool client services", () => {
  it("sends client_services and Accept ndjson when remote and the listing advertises clientServices", async () => {
    vi.stubEnv("ARGENT_TOOLS_URL", url);
    const { callTool } = createToolsClient();

    await callTool("flow-execute", { project_root: projectDir, name: "root" });

    const invoke = invokeRequest();
    expect(invoke.headers.accept).toContain("application/x-ndjson");
    expect(invoke.headers["accept-encoding"]).toBe("identity");
    expect(invoke.body).toEqual({
      project_root: projectDir,
      name: "root",
      client_services: { ops: ["resolve-file"], roots: [projectDir] },
    });
  });

  it("adds the directory of flow_path as a second root", async () => {
    vi.stubEnv("ARGENT_TOOLS_URL", url);
    const outsideFlow = path.join(projectDir, "..", "shared", "x.yaml");
    await fs.mkdir(path.dirname(outsideFlow), { recursive: true });
    await fs.writeFile(outsideFlow, "steps: []\n");
    const { callTool } = createToolsClient();

    await callTool("flow-execute", { project_root: projectDir, flow_path: outsideFlow });

    expect(
      (invokeRequest().body as { client_services: { roots: string[] } }).client_services.roots
    ).toEqual([projectDir, await fs.realpath(path.dirname(outsideFlow))]);
    await fs.rm(path.dirname(outsideFlow), { recursive: true, force: true });
  });

  it("adds the real location of a symlinked .argent/flows as a root, and no root inside another", async () => {
    // The project's flows directory may be a symlink to a tree outside the
    // project; the flows there are still the project's own, so the handler
    // serves that location. A flows directory inside the project is already
    // covered by the project root and is not sent twice.
    vi.stubEnv("ARGENT_TOOLS_URL", url);
    const linked = await fs.mkdtemp(path.join(tmpdir(), "argent-linked-proj-"));
    const vault = await fs.mkdtemp(path.join(tmpdir(), "argent-vault-flows-"));
    await fs.mkdir(path.join(linked, ".argent"), { recursive: true });
    await fs.symlink(vault, path.join(linked, ".argent", "flows"));
    await fs.writeFile(path.join(vault, "root.yaml"), "steps: []\n");
    const { callTool } = createToolsClient();

    await callTool("flow-execute", { project_root: linked, name: "root" });

    expect(
      (invokeRequest().body as { client_services: { roots: string[] } }).client_services.roots
    ).toEqual([await fs.realpath(linked), await fs.realpath(vault)]);
    await fs.rm(linked, { recursive: true, force: true });
    await fs.rm(vault, { recursive: true, force: true });
  });

  it("adds the real directory of a root flow that is a symlink as a root", async () => {
    // A run: target resolves beside the REAL file, so the fragments next to a
    // symlinked root's target must be reachable; by name and by path alike.
    vi.stubEnv("ARGENT_TOOLS_URL", url);
    const vault = await fs.mkdtemp(path.join(tmpdir(), "argent-vault-root-"));
    await fs.writeFile(path.join(vault, "linked.yaml"), "steps: []\n");
    await fs.symlink(path.join(vault, "linked.yaml"), path.join(flowsDir, "linked.yaml"));
    const { callTool } = createToolsClient();

    await callTool("flow-execute", { project_root: projectDir, name: "linked" });
    const byName = (invokeRequest().body as { client_services: { roots: string[] } })
      .client_services.roots;
    requests.length = 0;
    await callTool("flow-execute", {
      project_root: projectDir,
      flow_path: path.join(flowsDir, "linked.yaml"),
    });
    const byPath = (invokeRequest().body as { client_services: { roots: string[] } })
      .client_services.roots;

    const realVault = await fs.realpath(vault);
    expect(byName).toEqual([projectDir, realVault]);
    expect(byPath).toEqual([projectDir, realVault]);
    await fs.rm(vault, { recursive: true, force: true });
  });

  it("adds no root for a root flow that links to something other than a YAML file", async () => {
    // A committed link must not widen what the client serves: only the real
    // directory of a YAML flow file becomes a root, as resolve-file requires.
    vi.stubEnv("ARGENT_TOOLS_URL", url);
    const elsewhere = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "argent-elsewhere-")));
    await fs.writeFile(path.join(elsewhere, "notes.txt"), "not a flow\n");
    await fs.symlink(path.join(elsewhere, "notes.txt"), path.join(flowsDir, "text.yaml"));
    await fs.symlink(elsewhere, path.join(flowsDir, "dir.yaml"));
    const { callTool } = createToolsClient();
    const roots = () =>
      (invokeRequest().body as { client_services: { roots: string[] } }).client_services.roots;

    await callTool("flow-execute", { project_root: projectDir, name: "text" });
    const viaText = roots();
    requests.length = 0;
    await callTool("flow-execute", { project_root: projectDir, name: "dir" });

    expect(viaText).toEqual([projectDir]);
    expect(roots()).toEqual([projectDir]);
    await fs.rm(elsewhere, { recursive: true, force: true });
  });

  it("offers write-file only for a call that updates baselines", async () => {
    vi.stubEnv("ARGENT_TOOLS_URL", url);
    listing[0] = {
      name: "flow-execute",
      description: "",
      inputSchema: {},
      clientServices: { ops: ["resolve-file", "read-file", "write-file"] },
    };
    const { callTool } = createToolsClient();
    const offered = () =>
      (invokeRequest().body as { client_services: { ops: string[] } }).client_services.ops;

    await callTool("flow-execute", { project_root: projectDir, name: "root" });
    const comparing = offered();
    requests.length = 0;
    await callTool("flow-execute", {
      project_root: projectDir,
      name: "root",
      updateBaselines: true,
    });

    expect(comparing).toEqual(["resolve-file", "read-file"]);
    expect(offered()).toEqual(["resolve-file", "read-file", "write-file"]);
  });

  it("builds no root from a name that is not a flow name", async () => {
    // The tool-server refuses such a name, but the roots are offered first.
    vi.stubEnv("ARGENT_TOOLS_URL", url);
    const { callTool } = createToolsClient();

    await callTool("flow-execute", { project_root: projectDir, name: "../../../../../../../x" });

    expect(
      (invokeRequest().body as { client_services: { roots: string[] } }).client_services.roots
    ).toEqual([projectDir]);
  });

  it("sends no client_services when the listing has no clientServices", async () => {
    vi.stubEnv("ARGENT_TOOLS_URL", url);
    listing = [{ name: "flow-execute", description: "", inputSchema: {} }];
    onInvoke = (_body, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: { ok: true } }));
    };
    const { callTool } = createToolsClient();

    const result = await callTool("flow-execute", { project_root: projectDir });

    const invoke = invokeRequest();
    expect(invoke.body).toEqual({ project_root: projectDir });
    expect(invoke.headers.accept ?? "").not.toContain("application/x-ndjson");
    expect(result.data).toEqual({ ok: true });
  });

  it("sends no client_services when routing is local", async () => {
    onInvoke = (_body, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: { ok: true } }));
    };
    const { callTool } = createToolsClient({
      baseUrl: async () => ({ url, token: "", remote: false }),
    });

    await callTool("flow-execute", { project_root: projectDir });

    const invoke = invokeRequest();
    expect(invoke.body).toEqual({ project_root: projectDir });
    expect(invoke.headers.accept ?? "").not.toContain("application/x-ndjson");
  });

  it("sends no client_services when the arguments carry no string project_root", async () => {
    vi.stubEnv("ARGENT_TOOLS_URL", url);
    const { callTool } = createToolsClient();

    await callTool("flow-execute", { name: "root" });

    expect(invokeRequest().body).toEqual({ name: "root" });
  });

  it("answers client-request lines through the handler and posts to /invocations/:id/client-responses", async () => {
    vi.stubEnv("ARGENT_TOOLS_URL", url);
    vi.stubEnv("ARGENT_AUTH_TOKEN", "secret-token");
    streamOneRequest({
      id: "req-1",
      op: "resolve-file",
      args: { anchorDir: flowsDir, target: "frag.yaml", kind: "flow" },
    });
    const fragPath = path.join(flowsDir, "frag.yaml");
    const st = await fs.stat(fragPath);
    const events: unknown[] = [];
    const { callTool } = createToolsClient();

    const result = await callTool(
      "flow-execute",
      { project_root: projectDir, name: "root" },
      { onProgress: (e) => events.push(e) }
    );

    expect(result).toEqual({ data: { ran: true }, note: "done" });
    expect(events).toEqual([{ index: 0 }]);
    const [answer] = answerRequests();
    expect(answer).toBeDefined();
    expect(answer!.url).toBe("/invocations/inv-1/client-responses");
    expect(answer!.headers.authorization).toBe("Bearer secret-token");
    expect(answer!.headers["content-type"]).toBe("application/json");
    expect(answer!.body).toEqual({
      id: "req-1",
      ok: true,
      canonical: fragPath,
      spelling: { state: "listed" },
      exists: true,
      size: st.size,
      mtimeMs: st.mtimeMs,
      content: Buffer.from("steps:\n  - echo: hi\n").toString("base64"),
    });
    expect(invokeRequest().headers.authorization).toBe("Bearer secret-token");
  });

  it("posts a refusal when the handler declines a request", async () => {
    vi.stubEnv("ARGENT_TOOLS_URL", url);
    streamOneRequest({
      id: "req-9",
      op: "resolve-file",
      args: { anchorDir: tmpdir(), target: "x.yaml", kind: "flow" },
    });
    const { callTool } = createToolsClient();

    const result = await callTool("flow-execute", { project_root: projectDir });

    expect(result.data).toEqual({ ran: true });
    expect(answerRequests()[0]!.body).toMatchObject({
      id: "req-9",
      ok: false,
      error: expect.stringContaining("outside every root"),
    });
  });

  it("returns the result of a stream that carried client-request lines when the caller passed no onProgress", async () => {
    vi.stubEnv("ARGENT_TOOLS_URL", url);
    streamOneRequest({
      id: "req-2",
      op: "resolve-file",
      args: { anchorDir: flowsDir, target: "frag.yaml", kind: "flow" },
    });
    const { callTool } = createToolsClient();

    const result = await callTool("flow-execute", { project_root: projectDir, name: "root" });

    expect(result).toEqual({ data: { ran: true }, note: "done" });
    expect(answerRequests()).toHaveLength(1);
    expect(answerRequests()[0]!.body).toMatchObject({ id: "req-2", ok: true, exists: true });
  });

  it("logs a failed answer POST to stderr and still resolves with the result line", async () => {
    vi.stubEnv("ARGENT_TOOLS_URL", url);
    answerStatuses = [500];
    streamOneRequest({
      id: "req-3",
      op: "resolve-file",
      args: { anchorDir: flowsDir, target: "frag.yaml", kind: "flow" },
    });
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const { callTool } = createToolsClient();

    const result = await callTool("flow-execute", { project_root: projectDir });

    expect(result).toEqual({ data: { ran: true }, note: "done" });
    const lines = write.mock.calls.map((c) => String(c[0]));
    expect(lines).toEqual([
      "[client-services] answer to resolve-file request req-3 failed: 500 Internal Server Error\n",
    ]);
  });

  it("posts a refusal for the same id when a proxy refuses the answer with 413", async () => {
    // A proxy with a request-body limit refuses an answer that carries a large
    // baseline. The tool-server never sees that answer, so the client tells it
    // why, and the waiting step fails at once instead of after 30 s.
    vi.stubEnv("ARGENT_TOOLS_URL", url);
    answerStatuses = [413];
    streamOneRequest({
      id: "req-10",
      op: "resolve-file",
      args: { anchorDir: flowsDir, target: "frag.yaml", kind: "flow" },
    });
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const { callTool } = createToolsClient();

    const result = await callTool("flow-execute", { project_root: projectDir });

    expect(result.data).toEqual({ ran: true });
    const [answer, refusal] = answerRequests();
    expect(answer!.body).toMatchObject({ id: "req-10", ok: true, exists: true });
    expect(refusal!.url).toBe("/invocations/inv-1/client-responses");
    expect(refusal!.body).toEqual({
      id: "req-10",
      ok: false,
      error:
        "the answer did not reach the tool-server (413 Payload Too Large). A proxy between " +
        "the client and the tool-server limits the size of a request body. The proxy must " +
        "accept a body of up to 48 MB on POST /invocations/<invocation>/client-responses, " +
        "for example client_max_body_size 48m in nginx",
    });
    expect(answerRequests()).toHaveLength(2);
    expect(write.mock.calls.map((c) => String(c[0]))).toEqual([
      "[client-services] answer to resolve-file request req-10 failed: 413 Payload Too Large\n",
    ]);
  });

  it("posts a refusal that names any other error status of the answer POST", async () => {
    vi.stubEnv("ARGENT_TOOLS_URL", url);
    answerStatuses = [502];
    streamOneRequest({
      id: "req-11",
      op: "resolve-file",
      args: { anchorDir: flowsDir, target: "frag.yaml", kind: "flow" },
    });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const { callTool } = createToolsClient();

    await callTool("flow-execute", { project_root: projectDir });

    expect(answerRequests().map((r) => r.body)).toEqual([
      expect.objectContaining({ id: "req-11", ok: true }),
      {
        id: "req-11",
        ok: false,
        error: "the answer did not reach the tool-server (502 Bad Gateway)",
      },
    ]);
  });

  it.each([404, 409])("posts no refusal when the tool-server itself answers %i", async (status) => {
    // 404 (no request waits for the id) and 409 (the id already has an
    // answer) come from the tool-server: a refusal would change nothing.
    vi.stubEnv("ARGENT_TOOLS_URL", url);
    answerStatuses = [status];
    streamOneRequest({
      id: "req-12",
      op: "resolve-file",
      args: { anchorDir: flowsDir, target: "frag.yaml", kind: "flow" },
    });
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const { callTool } = createToolsClient();

    const result = await callTool("flow-execute", { project_root: projectDir });

    expect(result.data).toEqual({ ran: true });
    expect(answerRequests()).toHaveLength(1);
    expect(write.mock.calls).toHaveLength(1);
  });

  it("logs a failed refusal to stderr and posts nothing more", async () => {
    vi.stubEnv("ARGENT_TOOLS_URL", url);
    answerStatuses = [503, 500, 500];
    streamOneRequest({
      id: "req-13",
      op: "resolve-file",
      args: { anchorDir: flowsDir, target: "frag.yaml", kind: "flow" },
    });
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const { callTool } = createToolsClient();

    const result = await callTool("flow-execute", { project_root: projectDir });

    expect(result.data).toEqual({ ran: true });
    expect(answerRequests().map((r) => (r.body as { ok: boolean }).ok)).toEqual([true, false]);
    expect(write.mock.calls.map((c) => String(c[0]))).toEqual([
      "[client-services] answer to resolve-file request req-13 failed: 503 Service Unavailable\n",
      "[client-services] refusal of resolve-file request req-13 failed: 500 Internal Server Error\n",
    ]);
  });

  it("awaits a pending answer before surfacing the stream's terminal error", async () => {
    vi.stubEnv("ARGENT_TOOLS_URL", url);
    onInvoke = (_body, res) => {
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      res.write(
        `${JSON.stringify({
          event: "client-request",
          invocation: "inv-1",
          id: "req-4",
          op: "resolve-file",
          args: { anchorDir: flowsDir, target: "frag.yaml", kind: "flow" },
        })}\n`
      );
      res.end(`${JSON.stringify({ event: "error", error: "kaput" })}\n`);
    };
    const { callTool } = createToolsClient();

    await expect(callTool("flow-execute", { project_root: projectDir })).rejects.toThrow("kaput");

    // The answer was posted before the rejection reached the caller.
    expect(answerRequests()).toHaveLength(1);
  });

  it("ignores client-request lines when it offered no services", async () => {
    vi.stubEnv("ARGENT_TOOLS_URL", url);
    listing = [{ name: "flow-execute", description: "", inputSchema: {} }];
    onInvoke = (_body, res) => {
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      res.write(
        `${JSON.stringify({
          event: "client-request",
          invocation: "inv-1",
          id: "req-5",
          op: "resolve-file",
          args: { anchorDir: flowsDir, target: "frag.yaml", kind: "flow" },
        })}\n`
      );
      res.end(`${JSON.stringify({ event: "result", data: { ran: true } })}\n`);
    };
    const { callTool } = createToolsClient();

    const result = await callTool(
      "flow-execute",
      { project_root: projectDir },
      { onProgress: () => {} }
    );

    expect(result.data).toEqual({ ran: true });
    expect(answerRequests()).toHaveLength(0);
  });

  it("drops a request line whose id is not a string and answers the next one", async () => {
    vi.stubEnv("ARGENT_TOOLS_URL", url);
    onInvoke = (_body, res) => {
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      for (const line of [
        { id: { toString: 1 }, op: "resolve-file", args: {} },
        { id: "req-7", op: { toString: 1 }, args: {} },
      ]) {
        res.write(`${JSON.stringify({ event: "client-request", invocation: "inv-1", ...line })}\n`);
      }
      res.end(`${JSON.stringify({ event: "result", data: { ran: true } })}\n`);
    };
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const { callTool } = createToolsClient();

    const result = await callTool("flow-execute", { project_root: projectDir });

    expect(result.data).toEqual({ ran: true });
    expect(write.mock.calls.map((c) => String(c[0]))).toContain(
      "[client-services] ignored a request line without a string id\n"
    );
    expect(answerRequests().map((r) => r.body)).toEqual([
      { id: "req-7", ok: false, error: "op (not a string) is not served by this client" },
    ]);
  });

  it("gives up on an answer POST once the tool-server would have stopped waiting for it", async () => {
    vi.stubEnv("ARGENT_TOOLS_URL", url);
    answerHangs = true;
    const giveUp = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(giveUp.signal);
    onInvoke = (_body, res) => {
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      res.write(
        `${JSON.stringify({
          event: "client-request",
          invocation: "inv-1",
          id: "req-8",
          op: "resolve-file",
          args: { anchorDir: flowsDir, target: "frag.yaml", kind: "flow" },
        })}\n`
      );
      res.end(`${JSON.stringify({ event: "result", data: { ran: true } })}\n`);
    };
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const { callTool } = createToolsClient();

    const pending = callTool("flow-execute", { project_root: projectDir });
    await vi.waitFor(() => expect(answerRequests()).toHaveLength(1));
    expect(timeout).toHaveBeenCalledWith(30_000);
    giveUp.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError"));

    expect((await pending).data).toEqual({ ran: true });
    expect(write.mock.calls.map((c) => String(c[0]))).toEqual([
      "[client-services] answer to resolve-file request req-8 failed: The operation was aborted due to timeout\n",
    ]);
  });

  it("says the tool may already have acted when the stream breaks before the result", async () => {
    vi.stubEnv("ARGENT_TOOLS_URL", url);
    onInvoke = (_body, res) => {
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      res.write(`${JSON.stringify({ event: "progress", data: { index: 0 } })}\n`);
      setTimeout(() => res.socket?.destroy(), 20);
    };
    const { callTool } = createToolsClient();

    await expect(
      callTool("flow-execute", { project_root: projectDir }, { onProgress: () => {} })
    ).rejects.toThrow(
      /^The connection to the tool-server closed before flow-execute finished \(.+\)\. 1 progress update had arrived, so the tool ran at least in part; check its effect before you run it again\.$/
    );

    onInvoke = (_body, res) => {
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      res.end();
    };
    await expect(callTool("flow-execute", { project_root: projectDir })).rejects.toThrow(
      "The connection to the tool-server closed before flow-execute finished (the stream ended without a result). The tool may have run; check its effect before you run it again."
    );
  });
});
