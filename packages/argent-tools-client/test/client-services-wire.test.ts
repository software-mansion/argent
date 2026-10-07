import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import * as fs from "node:fs/promises";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { redirectHomeTo } from "./helpers/home-redirect.js";

// The client's give-up time for a request's local read, short where a test
// waits it out.
const timing = vi.hoisted(() => ({ fileOpTimeoutMs: 30_000 }));
vi.mock("@argent/registry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@argent/registry")>()),
  get CLIENT_FILE_OP_TIMEOUT_MS() {
    return timing.fileOpTimeoutMs;
  },
}));

// A local read that never settles, as on an unresponsive network mount: only
// readFile, only a file named hang.yaml.
const hang = vi.hoisted(() => ({ reads: [] as string[] }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const readFile = ((file: unknown, ...rest: unknown[]) => {
    if (String(file).endsWith("hang.yaml")) {
      hang.reads.push(String(file));
      return new Promise(() => {});
    }
    return (actual.readFile as (...args: unknown[]) => unknown)(file, ...rest);
  }) as typeof actual.readFile;
  return { ...actual, readFile, default: { ...actual, readFile } };
});

// link-config.ts captures ~/.argent/link.json at module load; an isolated HOME
// keeps a developer's real link out of the "routing is local" case.
let createToolsClient: typeof import("../src/tools-client.js").createToolsClient;
let ToolInvocationError: typeof import("../src/tools-client.js").ToolInvocationError;
let TEST_HOME: string;
let restoreHome: () => void;

beforeAll(async () => {
  TEST_HOME = mkdtempSync(path.join(tmpdir(), "argent-client-services-wire-"));
  restoreHome = redirectHomeTo(TEST_HOME);
  vi.resetModules();
  ({ createToolsClient, ToolInvocationError } = await import("../src/tools-client.js"));
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
/** A root flow with a run: step: only such a flow is offered client services. */
const COMPOSING = "steps:\n  - run: frag.yaml\n";
/** A root flow with a snapshot step: offered client services when they serve baselines. */
const SNAPSHOTTING = "steps:\n  - snapshot: home\n";

let server: Server;
let url: string;
let requests: Recorded[];
let projectDir: string;
let flowsDir: string;
/** Per test: how POST /tools/flow-execute answers, given the parsed body. */
let onInvoke: (body: unknown, res: ServerResponse) => void | Promise<void>;
/**
 * Per test: how POST /invocations/:id/client-responses answers. A string body
 * goes out as HTML, as a proxy's own error page would.
 */
let answerReply: { status: number; body: unknown };
/** Per test: the replies to the first answer POSTs, in order; `answerReply` answers the rest. */
let answerReplies: { status: number; body: unknown }[];
/** Per test: the answer route reads the POST and never answers it. */
let answerHangs: boolean;
/** Per test: the answer route drops the connection without a reply. */
let answerDrops: boolean;
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

/** The listing of a tool-server that also reads and writes snapshot baselines. */
function advertiseBaselines(): void {
  listing[0] = {
    name: "flow-execute",
    description: "",
    inputSchema: {},
    clientServices: { ops: ["resolve-file", "read-file", "write-file"] },
  };
}

beforeEach(async () => {
  requests = [];
  timing.fileOpTimeoutMs = 30_000;
  hang.reads = [];
  answerReply = { status: 200, body: { accepted: true } };
  answerReplies = [];
  answerHangs = false;
  answerDrops = false;
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
  await fs.writeFile(
    path.join(flowsDir, "root.yaml"),
    "steps:\n  - run: frag.yaml\n  - run: hang.yaml\n"
  );
  await fs.writeFile(path.join(flowsDir, "frag.yaml"), "steps:\n  - echo: hi\n");
  await fs.writeFile(path.join(flowsDir, "hang.yaml"), "steps:\n  - echo: never\n");

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
      if (answerDrops) {
        req.socket.destroy();
        return;
      }
      const reply = answerReplies.shift() ?? answerReply;
      const html = typeof reply.body === "string";
      res.writeHead(reply.status, {
        "Content-Type": html ? "text/html" : "application/json",
      });
      res.end(html ? (reply.body as string) : JSON.stringify(reply.body));
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

/** Rejects when `promise` is still pending after `ms`. */
function settlesWithin<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`still pending after ${ms} ms`)), ms);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

async function readHangs(): Promise<void> {
  while (hang.reads.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
}

/** A request line for hang.yaml, whose read never settles. */
function hangRequestLine(): string {
  return `${JSON.stringify({
    event: "client-request",
    invocation: "inv-1",
    id: "req-h",
    op: "resolve-file",
    args: { anchorDir: flowsDir, target: "hang.yaml", kind: "flow" },
  })}\n`;
}

const FRAG_REQUEST = {
  id: "req-3",
  op: "resolve-file",
  args: { kind: "flow", target: "frag.yaml" },
};

/**
 * A request line, then the stream stays open as the tool-server keeps it while
 * the request waits: until the client hangs up, or until the stub's stand-in
 * for the server's timeout ends it with FLOW_CLIENT_NOT_ANSWERING.
 */
function streamUntilHangUp(): { hungUp: () => boolean } {
  let hungUp = false;
  onInvoke = async (_body, res) => {
    res.writeHead(200, { "Content-Type": "application/x-ndjson" });
    res.write(
      `${JSON.stringify({
        event: "client-request",
        invocation: "inv-1",
        ...FRAG_REQUEST,
        args: { ...FRAG_REQUEST.args, anchorDir: flowsDir },
      })}\n`
    );
    await new Promise<void>((resolve) => {
      res.once("close", () => {
        hungUp = !res.writableFinished;
        resolve();
      });
      setTimeout(resolve, 2_000).unref();
    });
    if (!res.writableEnded) {
      res.end(
        `${JSON.stringify({
          event: "error",
          error: "the client did not answer the resolve-file request",
          error_code: "FLOW_CLIENT_NOT_ANSWERING",
          error_kind: "timeout",
        })}\n`
      );
    }
  };
  return { hungUp: () => hungUp };
}

/** What a call fails with, and how long it took to fail. */
async function failureOf(call: Promise<unknown>): Promise<{ err: unknown; ms: number }> {
  const started = Date.now();
  const err = await call.then(
    () => undefined,
    (thrown: unknown) => thrown
  );
  return { err, ms: Date.now() - started };
}

/**
 * A request line the stub server writes, followed by the result once `answers`
 * answer POSTs have arrived.
 */
function streamOneRequest(line: Record<string, unknown>, answers = 1) {
  onInvoke = async (_body, res) => {
    res.writeHead(200, { "Content-Type": "application/x-ndjson" });
    res.write(`${JSON.stringify({ event: "progress", data: { index: 0 } })}\n`);
    res.write(`${JSON.stringify({ event: "client-request", invocation: "inv-1", ...line })}\n`);
    for (let posted = 0; posted < answers; posted++) {
      await nextAnswer;
      armAnswer();
    }
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
    await fs.writeFile(outsideFlow, COMPOSING);
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
    await fs.writeFile(path.join(vault, "root.yaml"), COMPOSING);
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
    await fs.writeFile(path.join(vault, "linked.yaml"), COMPOSING);
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
    // The linked file composes, so with its directory as a root the call would
    // carry client services; without it, the root flow lies outside every root
    // and the call goes out without them.
    vi.stubEnv("ARGENT_TOOLS_URL", url);
    const elsewhere = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "argent-elsewhere-")));
    await fs.writeFile(path.join(elsewhere, "notes.txt"), COMPOSING);
    await fs.symlink(path.join(elsewhere, "notes.txt"), path.join(flowsDir, "text.yaml"));
    await fs.symlink(elsewhere, path.join(flowsDir, "dir.yaml"));
    const { callTool } = createToolsClient();

    for (const name of ["text", "dir"]) {
      requests.length = 0;
      await callTool("flow-execute", { project_root: projectDir, name });
      expect(invokeRequest().body).toEqual({ project_root: projectDir, name });
    }
    await fs.rm(elsewhere, { recursive: true, force: true });
  });

  it("offers write-file only for a call that updates baselines", async () => {
    vi.stubEnv("ARGENT_TOOLS_URL", url);
    advertiseBaselines();
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

  it("offers client services for a root flow that only takes a snapshot when the tool-server serves baselines", async () => {
    // A snapshot step reads or writes its baseline through the client, so a
    // flow that composes nothing still asks for files, but only of a
    // tool-server that serves baselines over the link.
    vi.stubEnv("ARGENT_TOOLS_URL", url);
    await fs.writeFile(path.join(flowsDir, "shot.yaml"), SNAPSHOTTING);
    const { callTool } = createToolsClient();

    await callTool("flow-execute", { project_root: projectDir, name: "shot" });
    const resolveOnly = invokeRequest().body;
    advertiseBaselines();
    requests.length = 0;
    await callTool("flow-execute", { project_root: projectDir, name: "shot" });

    expect(resolveOnly).toEqual({ project_root: projectDir, name: "shot" });
    expect(invokeRequest().body).toEqual({
      project_root: projectDir,
      name: "shot",
      client_services: { ops: ["resolve-file", "read-file"], roots: [projectDir] },
    });
  });

  it("sends a flow that composes nothing without client_services, so a proxy that rewrites Accept passes it", async () => {
    vi.stubEnv("ARGENT_TOOLS_URL", url);
    await fs.writeFile(path.join(flowsDir, "echo.yaml"), "steps:\n  - echo: hi\n");
    // The tool-server refuses client_services on a call that cannot stream.
    onInvoke = (body, res) => {
      const accept = String(invokeRequest().headers.accept ?? "");
      if ((body as { client_services?: unknown }).client_services && !accept.includes("ndjson")) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "client_services requires an NDJSON request" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: { ok: true } }));
    };
    const { callTool } = createToolsClient({
      fetchImpl: (target, init) =>
        fetch(target, {
          ...init,
          headers: { ...(init.headers as Record<string, string>), Accept: "application/json" },
        }),
    });

    const result = await callTool("flow-execute", { project_root: projectDir, name: "echo" });

    expect(result.data).toEqual({ ok: true });
    expect(invokeRequest().body).toEqual({ project_root: projectDir, name: "echo" });

    // A flow that composes still asks for the stream, and that proxy breaks it.
    requests.length = 0;
    await expect(
      callTool("flow-execute", { project_root: projectDir, name: "root" })
    ).rejects.toThrow("client_services requires an NDJSON request");
    expect(invokeRequest().body).toMatchObject({ client_services: { ops: ["resolve-file"] } });
  });

  it("serves a fragment of the flow's own project when the CLI runs from a subdirectory", async () => {
    // The CLI sends its working directory as project_root.
    vi.stubEnv("ARGENT_TOOLS_URL", url);
    const repo = path.join(projectDir, "repo");
    const repoFlows = path.join(repo, ".argent", "flows");
    await fs.mkdir(repoFlows, { recursive: true });
    await fs.mkdir(path.join(repo, "shared"));
    await fs.mkdir(path.join(repo, "apps", "mobile"), { recursive: true });
    await fs.writeFile(
      path.join(repoFlows, "root.yaml"),
      "steps:\n  - run: ../../shared/frag.yaml\n"
    );
    await fs.writeFile(path.join(repo, "shared", "frag.yaml"), "steps:\n  - echo: hi\n");
    // As the runner asks: the root where it is spelled, then the fragment
    // beside the root's canonical path.
    onInvoke = async (_body, res) => {
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      for (const [id, anchorDir, target] of [
        ["req-root", repoFlows, "root.yaml"],
        ["req-frag", repoFlows, "../../shared/frag.yaml"],
      ]) {
        const args = { anchorDir, target, kind: "flow" };
        res.write(
          `${JSON.stringify({ event: "client-request", invocation: "inv-1", id, op: "resolve-file", args })}\n`
        );
        await nextAnswer;
        armAnswer();
      }
      res.end(`${JSON.stringify({ event: "result", data: { ran: true } })}\n`);
    };
    const { callTool } = createToolsClient();

    await callTool("flow-execute", {
      project_root: path.join(repo, "apps", "mobile"),
      flow_path: path.join(repoFlows, "root.yaml"),
    });

    expect(answerRequests().map((r) => r.body)).toEqual([
      expect.objectContaining({ id: "req-root", ok: true, exists: true }),
      expect.objectContaining({
        id: "req-frag",
        ok: true,
        exists: true,
        canonical: path.join(repo, "shared", "frag.yaml"),
      }),
    ]);
  });

  it("adds the project of a root flow whose real file is saved in another project", async () => {
    vi.stubEnv("ARGENT_TOOLS_URL", url);
    const repo = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "argent-other-repo-")));
    const repoFlows = path.join(repo, ".argent", "flows");
    await fs.mkdir(repoFlows, { recursive: true });
    await fs.writeFile(path.join(repoFlows, "root.yaml"), COMPOSING);
    await fs.symlink(path.join(repoFlows, "root.yaml"), path.join(projectDir, "linked.yaml"));
    const { callTool } = createToolsClient();

    await callTool("flow-execute", {
      project_root: projectDir,
      flow_path: path.join(projectDir, "linked.yaml"),
    });

    expect(
      (invokeRequest().body as { client_services: { roots: string[] } }).client_services.roots
    ).toEqual([projectDir, repo]);
    await fs.rm(repo, { recursive: true, force: true });
  });

  it("sends no client_services for arguments the tool-server refuses before it asks anything", async () => {
    vi.stubEnv("ARGENT_TOOLS_URL", url);
    await fs.writeFile(path.join(flowsDir, "root.yml"), COMPOSING);
    onInvoke = (_body, res) => {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "refused" }));
    };
    const { callTool } = createToolsClient();
    const rootFlow = path.join(flowsDir, "root.yaml");

    for (const args of [
      { project_root: ".", flow_path: rootFlow },
      { project_root: `${projectDir}/x/..`, name: "root" },
      { project_root: projectDir, name: "../../.argent/flows/root" },
      { project_root: projectDir, name: "../../../../../../../x" },
      { project_root: projectDir, flow_path: "root.yaml" },
      { project_root: projectDir, flow_path: `${flowsDir}/../flows/root.yaml` },
      { project_root: projectDir, flow_path: path.join(flowsDir, "root.yml") },
      { project_root: projectDir, flow_path: rootFlow, name: "root" },
    ]) {
      requests.length = 0;
      await expect(callTool("flow-execute", args)).rejects.toThrow("refused");
      expect(invokeRequest().body).not.toHaveProperty("client_services");
    }
  });

  describe("the baseline directory of the run", () => {
    /** The answer the client posts to one read-file request for `file` in a call with `args`. */
    async function readFileAnswer(args: Record<string, unknown>, file: string): Promise<unknown> {
      vi.stubEnv("ARGENT_TOOLS_URL", url);
      advertiseBaselines();
      requests.length = 0;
      armAnswer();
      streamOneRequest({ id: "req-b", op: "read-file", args: { path: file } });
      await createToolsClient().callTool("flow-execute", args);
      return answerRequests()[0]?.body;
    }
    const missing = { id: "req-b", ok: true, exists: false };
    const notOfRun = (file: string, dir: string) => ({
      id: "req-b",
      ok: false,
      error: `${file} is not a baseline of this run (${dir}/<name>.png)`,
    });

    let vault: string;
    beforeEach(async () => {
      vault = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "argent-vault-baselines-")));
    });
    afterEach(async () => {
      await fs.rm(vault, { recursive: true, force: true });
    });

    it("serves the baselines of the root flow only, by name and by path alike", async () => {
      const own = path.join(flowsDir, "__baselines__", "root");
      const other = path.join(flowsDir, "__baselines__", "frag", "home.png");
      const byName = { project_root: projectDir, name: "root" };
      const byPath = { project_root: projectDir, flow_path: path.join(flowsDir, "root.yaml") };

      for (const args of [byName, byPath]) {
        expect(await readFileAnswer(args, path.join(own, "home.png"))).toEqual(missing);
        expect(await readFileAnswer(args, other)).toEqual(notOfRun(other, own));
      }
    });

    it("keys the baselines of a flow_path outside the project beside that file", async () => {
      await fs.writeFile(path.join(vault, "x.yaml"), SNAPSHOTTING);
      const own = path.join(vault, "__baselines__", "x");
      const args = { project_root: projectDir, flow_path: path.join(vault, "x.yaml") };
      const project = path.join(flowsDir, "__baselines__", "x", "home.png");

      expect(await readFileAnswer(args, path.join(own, "home.png"))).toEqual(missing);
      expect(await readFileAnswer(args, project)).toEqual(notOfRun(project, own));
    });

    it("keys the baselines of a symlinked root flow by its real file", async () => {
      await fs.writeFile(path.join(vault, "real-name.yaml"), SNAPSHOTTING);
      await fs.symlink(path.join(vault, "real-name.yaml"), path.join(flowsDir, "linked.yaml"));
      const own = path.join(vault, "__baselines__", "real-name");
      const beside = path.join(flowsDir, "__baselines__", "linked", "home.png");

      for (const args of [
        { project_root: projectDir, name: "linked" },
        { project_root: projectDir, flow_path: path.join(flowsDir, "linked.yaml") },
      ]) {
        expect(await readFileAnswer(args, path.join(own, "home.png"))).toEqual(missing);
        expect(await readFileAnswer(args, beside)).toEqual(notOfRun(beside, own));
      }
    });

    it("keys by the flow name when the real file's stem is not a flow name", async () => {
      // A `.yml` or `.YAML` file keeps its extension in the stem, and a space
      // is not in a flow name.
      for (const [link, real] of [
        ["alias", "real.yml"],
        ["upper", "Upper.YAML"],
        ["spaced", "my flow.yaml"],
      ] as const) {
        await fs.writeFile(path.join(vault, real), SNAPSHOTTING);
        await fs.symlink(path.join(vault, real), path.join(flowsDir, `${link}.yaml`));
        const own = path.join(vault, "__baselines__", link);
        const beside = path.join(flowsDir, "__baselines__", link, "home.png");
        for (const args of [
          { project_root: projectDir, name: link },
          { project_root: projectDir, flow_path: path.join(flowsDir, `${link}.yaml`) },
        ]) {
          expect(await readFileAnswer(args, path.join(own, "home.png"))).toEqual(missing);
          expect(await readFileAnswer(args, beside)).toEqual(notOfRun(beside, own));
        }
      }
    });

    it("serves no baseline when the root flow is not a YAML file", async () => {
      // The linked file lies inside the roots and takes a snapshot, so the call
      // has client services, but the run has no baseline directory.
      await fs.writeFile(path.join(flowsDir, "notes.txt"), SNAPSHOTTING);
      await fs.symlink(path.join(flowsDir, "notes.txt"), path.join(flowsDir, "text.yaml"));
      const file = path.join(flowsDir, "__baselines__", "text", "home.png");

      expect(await readFileAnswer({ project_root: projectDir, name: "text" }, file)).toEqual({
        id: "req-b",
        ok: false,
        error: `${file} is not a baseline of this run; this run has no baseline directory on this client`,
      });
    });
  });

  it("sends no client_services when the listing has no clientServices", async () => {
    vi.stubEnv("ARGENT_TOOLS_URL", url);
    listing = [{ name: "flow-execute", description: "", inputSchema: {} }];
    onInvoke = (_body, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: { ok: true } }));
    };
    const { callTool } = createToolsClient();

    const result = await callTool("flow-execute", { project_root: projectDir, name: "root" });

    const invoke = invokeRequest();
    expect(invoke.body).toEqual({ project_root: projectDir, name: "root" });
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

    await callTool("flow-execute", { project_root: projectDir, name: "root" });

    const invoke = invokeRequest();
    expect(invoke.body).toEqual({ project_root: projectDir, name: "root" });
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

    const result = await callTool("flow-execute", { project_root: projectDir, name: "root" });

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

  it("fails the call at once and hangs up when a proxy answers for the tool-server", async () => {
    vi.stubEnv("ARGENT_TOOLS_URL", url);
    answerReply = { status: 502, body: "<html>Bad Gateway</html>" };
    const stream = streamUntilHangUp();
    const { callTool } = createToolsClient({ onDiagnostic: () => {} });

    const { err, ms } = await failureOf(
      callTool("flow-execute", { project_root: projectDir, name: "root" })
    );

    expect(ms).toBeLessThan(1_000);
    expect(err).toBeInstanceOf(ToolInvocationError);
    expect(err).toMatchObject({
      errorCode: "FLOW_CLIENT_NOT_ANSWERING",
      errorKind: "network",
      message:
        `The answer to the resolve-file request for "frag.yaml" did not reach the tool-server: ` +
        `POST ${url}/invocations/inv-1/client-responses answered 502 Bad Gateway. The call was ` +
        `stopped. A reverse proxy between the client and the tool-server must forward that ` +
        `route while the call's stream is open.`,
    });
    // The server learns of it from the hang-up and stops the run.
    await vi.waitFor(() => expect(stream.hungUp()).toBe(true));
  });

  it("posts a refusal for the same id when a proxy refuses the answer with 413, and the call goes on", async () => {
    // A proxy with a request-body limit refuses an answer that carries a large
    // baseline. The tool-server never sees that answer, so the client tells it
    // why in a short one: the waiting step fails at once instead of after 30 s,
    // and the run goes on.
    vi.stubEnv("ARGENT_TOOLS_URL", url);
    advertiseBaselines();
    await fs.writeFile(path.join(flowsDir, "shot.yaml"), SNAPSHOTTING);
    const baseline = path.join(flowsDir, "__baselines__", "shot", "home.png");
    await fs.mkdir(path.dirname(baseline), { recursive: true });
    await fs.writeFile(baseline, "baseline bytes");
    answerReplies = [{ status: 413, body: "<html>413 Request Entity Too Large</html>" }];
    streamOneRequest({ id: "req-10", op: "read-file", args: { path: baseline } }, 2);
    const diagnostics: string[] = [];
    const { callTool } = createToolsClient({
      onDiagnostic: (message) => diagnostics.push(message),
    });

    const result = await callTool("flow-execute", { project_root: projectDir, name: "shot" });

    expect(result).toEqual({ data: { ran: true }, note: "done" });
    const [answer, refusal] = answerRequests();
    expect(answer!.body).toMatchObject({
      id: "req-10",
      ok: true,
      exists: true,
      content: Buffer.from("baseline bytes").toString("base64"),
    });
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
    await vi.waitFor(() =>
      expect(diagnostics).toEqual([
        `[client-services] a proxy refused the answer to the read-file request for ` +
          `"${baseline}" (413 Payload Too Large); the request was refused instead`,
      ])
    );
  });

  it("fails the call at once when the refusal that follows a proxy's 413 does not reach the tool-server either", async () => {
    vi.stubEnv("ARGENT_TOOLS_URL", url);
    answerReplies = [
      { status: 413, body: "<html>413 Request Entity Too Large</html>" },
      { status: 500, body: "<html>Internal Server Error</html>" },
    ];
    const stream = streamUntilHangUp();
    const diagnostics: string[] = [];
    const { callTool } = createToolsClient({
      onDiagnostic: (message) => diagnostics.push(message),
    });

    const { err, ms } = await failureOf(
      callTool("flow-execute", { project_root: projectDir, name: "root" })
    );

    expect(ms).toBeLessThan(1_000);
    expect(err).toBeInstanceOf(ToolInvocationError);
    expect(err).toMatchObject({
      errorCode: "FLOW_CLIENT_NOT_ANSWERING",
      errorKind: "network",
      message:
        `The answer to the resolve-file request for "frag.yaml" did not reach the tool-server: ` +
        `POST ${url}/invocations/inv-1/client-responses answered 413 Payload Too Large. The ` +
        `call was stopped. A reverse proxy between the client and the tool-server must forward ` +
        `that route while the call's stream is open.`,
    });
    expect(answerRequests().map((r) => r.body)).toEqual([
      expect.objectContaining({ id: "req-3", ok: true }),
      expect.objectContaining({ id: "req-3", ok: false }),
    ]);
    expect(diagnostics).toEqual([]);
    await vi.waitFor(() => expect(stream.hungUp()).toBe(true));
  });

  it("fails the call at once when the answer POST loses its connection", async () => {
    vi.stubEnv("ARGENT_TOOLS_URL", url);
    answerDrops = true;
    const stream = streamUntilHangUp();
    const { callTool } = createToolsClient({ onDiagnostic: () => {} });

    const { err, ms } = await failureOf(
      callTool("flow-execute", { project_root: projectDir, name: "root" })
    );

    expect(ms).toBeLessThan(1_000);
    expect(err).toMatchObject({ errorCode: "FLOW_CLIENT_NOT_ANSWERING", errorKind: "network" });
    expect((err as Error).message).toMatch(
      /^The answer to the resolve-file request for "frag\.yaml" did not reach the tool-server: POST http:\/\/127\.0\.0\.1:\d+\/invocations\/inv-1\/client-responses failed: fetch failed \(.+\)\. The call was stopped\./
    );
    await vi.waitFor(() => expect(stream.hungUp()).toBe(true));
  });

  it("fails the call at once when a proxy answers 404 for the answer route", async () => {
    // A 404 from the tool-server itself carries a JSON error; a proxy's does not.
    vi.stubEnv("ARGENT_TOOLS_URL", url);
    answerReply = { status: 404, body: "not forwarded" };
    streamUntilHangUp();
    const { callTool } = createToolsClient({ onDiagnostic: () => {} });

    const { err, ms } = await failureOf(
      callTool("flow-execute", { project_root: projectDir, name: "root" })
    );

    expect(ms).toBeLessThan(1_000);
    expect((err as Error).message).toContain("client-responses answered 404 Not Found.");
  });

  it.each([
    [400, "the body must carry a boolean ok"],
    [404, "unknown or expired request id"],
    [409, "the request already has an answer"],
    [413, "the answer's content decodes to more than 32 MiB"],
  ])("keeps the call going when the tool-server's own route answers %i", async (status, error) => {
    // The route was reached and the server settles the request on its side;
    // the report that follows says what became of it. No refusal follows,
    // not even after the tool-server's own 413: it would change nothing.
    vi.stubEnv("ARGENT_TOOLS_URL", url);
    answerReply = { status, body: { error } };
    streamOneRequest({ ...FRAG_REQUEST, args: { ...FRAG_REQUEST.args, anchorDir: flowsDir } });
    const diagnostics: string[] = [];
    const { callTool } = createToolsClient({
      onDiagnostic: (message) => diagnostics.push(message),
    });

    const result = await callTool("flow-execute", { project_root: projectDir, name: "root" });

    expect(result).toEqual({ data: { ran: true }, note: "done" });
    await vi.waitFor(() =>
      expect(diagnostics).toEqual([
        `[client-services] the tool-server did not take the answer to the resolve-file ` +
          `request for "frag.yaml": ${status} ${error}`,
      ])
    );
    expect(answerRequests()).toHaveLength(1);
  });

  it("settles with the stream's result while the local read of a request still hangs", async () => {
    // The tool-server stops waiting for an answer after its timeout and sends
    // its result; nothing the client could post after that settles anything.
    vi.stubEnv("ARGENT_TOOLS_URL", url);
    onInvoke = async (_body, res) => {
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      res.write(hangRequestLine());
      await readHangs();
      res.end(`${JSON.stringify({ event: "result", data: { ran: false } })}\n`);
    };
    const { callTool } = createToolsClient({ onDiagnostic: () => {} });

    const result = await settlesWithin(
      callTool("flow-execute", { project_root: projectDir, name: "root" }),
      2_000
    );

    expect(result.data).toEqual({ ran: false });
    expect(hang.reads).toEqual([path.join(flowsDir, "hang.yaml")]);
    expect(answerRequests()).toHaveLength(0);
  });

  it("surfaces the stream's error line while the local read of a request still hangs", async () => {
    vi.stubEnv("ARGENT_TOOLS_URL", url);
    onInvoke = async (_body, res) => {
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      res.write(hangRequestLine());
      await readHangs();
      res.end(`${JSON.stringify({ event: "error", error: "kaput" })}\n`);
    };
    const { callTool } = createToolsClient({ onDiagnostic: () => {} });

    await expect(
      settlesWithin(callTool("flow-execute", { project_root: projectDir, name: "root" }), 2_000)
    ).rejects.toThrow("kaput");
    expect(answerRequests()).toHaveLength(0);
  });

  it("gives up a request whose local read does not finish in time, and posts nothing", async () => {
    // A tool-server that keeps the stream open past the give-up time still
    // gets no answer: it has stopped waiting for one.
    timing.fileOpTimeoutMs = 1_000;
    vi.stubEnv("ARGENT_TOOLS_URL", url);
    const diagnostics: string[] = [];
    let diagnosed!: () => void;
    const gaveUp = new Promise<void>((resolve) => (diagnosed = resolve));
    onInvoke = async (_body, res) => {
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      res.write(hangRequestLine());
      await gaveUp;
      res.end(`${JSON.stringify({ event: "result", data: { ran: false } })}\n`);
    };
    const { callTool } = createToolsClient({
      onDiagnostic: (message) => {
        diagnostics.push(message);
        diagnosed();
      },
    });

    const result = await settlesWithin(
      callTool("flow-execute", { project_root: projectDir, name: "root" }),
      3_000
    );

    expect(result.data).toEqual({ ran: false });
    expect(diagnostics).toEqual([
      '[client-services] the resolve-file request for "hang.yaml" did not finish on this ' +
        "client within 1 s, the time the tool-server waits for it; no answer was sent",
    ]);
    expect(answerRequests()).toHaveLength(0);
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
    onInvoke = async (_body, res) => {
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      for (const line of [
        { id: { toString: 1 }, op: "resolve-file", args: {} },
        { id: "req-7", op: { toString: 1 }, args: {} },
      ]) {
        res.write(`${JSON.stringify({ event: "client-request", invocation: "inv-1", ...line })}\n`);
      }
      await nextAnswer;
      res.end(`${JSON.stringify({ event: "result", data: { ran: true } })}\n`);
    };
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const { callTool } = createToolsClient();

    const result = await callTool("flow-execute", { project_root: projectDir, name: "root" });

    expect(result.data).toEqual({ ran: true });
    expect(write.mock.calls.map((c) => String(c[0]))).toContain(
      "[client-services] ignored a request line without a string id\n"
    );
    expect(answerRequests().map((r) => r.body)).toEqual([
      { id: "req-7", ok: false, error: "op (not a string) is not served by this client" },
    ]);
  });

  it("sends its diagnostics to onDiagnostic instead of stderr", async () => {
    vi.stubEnv("ARGENT_TOOLS_URL", url);
    onInvoke = (_body, res) => {
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      res.write(
        `${JSON.stringify({ event: "client-request", invocation: "inv-1", id: 7, op: "resolve-file", args: {} })}\n`
      );
      res.end(`${JSON.stringify({ event: "result", data: { ran: true } })}\n`);
    };
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const diagnostics: string[] = [];
    const { callTool } = createToolsClient({
      onDiagnostic: (message) => diagnostics.push(message),
    });

    const result = await callTool("flow-execute", { project_root: projectDir, name: "root" });

    expect(result.data).toEqual({ ran: true });
    expect(diagnostics).toEqual(["[client-services] ignored a request line without a string id"]);
    expect(write).not.toHaveBeenCalled();
  });

  it("sends the request log to onDiagnostic instead of stderr", async () => {
    vi.stubEnv("ARGENT_TOOLS_URL", url);
    vi.stubEnv("ARGENT_CLIENT_SERVICES_LOG", "1");
    streamOneRequest({ ...FRAG_REQUEST, args: { ...FRAG_REQUEST.args, anchorDir: flowsDir } });
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const diagnostics: string[] = [];
    const { callTool } = createToolsClient({
      onDiagnostic: (message) => diagnostics.push(message),
    });

    await callTool("flow-execute", { project_root: projectDir, name: "root" });

    expect(diagnostics).toEqual([
      `[client-services] resolve-file ${path.join(flowsDir, "frag.yaml")}: served`,
    ]);
    expect(write).not.toHaveBeenCalled();
  });

  it("fails the call once its answer POST gets no reply in the time the tool-server waits", async () => {
    vi.stubEnv("ARGENT_TOOLS_URL", url);
    answerHangs = true;
    const giveUp = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(giveUp.signal);
    streamUntilHangUp();
    const { callTool } = createToolsClient({ onDiagnostic: () => {} });

    const failed = failureOf(callTool("flow-execute", { project_root: projectDir, name: "root" }));
    await vi.waitFor(() => expect(answerRequests()).toHaveLength(1));
    expect(timeout).toHaveBeenCalledWith(30_000);
    giveUp.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
    const { err } = await failed;

    expect(err).toMatchObject({ errorCode: "FLOW_CLIENT_NOT_ANSWERING", errorKind: "network" });
    expect((err as Error).message).toContain(
      `POST ${url}/invocations/inv-1/client-responses got no reply within 30 s.`
    );
  });

  it("keeps the result of a call whose answer fails after the stream delivered it", async () => {
    vi.stubEnv("ARGENT_TOOLS_URL", url);
    answerHangs = true;
    const giveUp = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(giveUp.signal);
    onInvoke = (_body, res) => {
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      res.write(
        `${JSON.stringify({
          event: "client-request",
          invocation: "inv-1",
          ...FRAG_REQUEST,
          args: { ...FRAG_REQUEST.args, anchorDir: flowsDir },
        })}\n`
      );
      res.end(`${JSON.stringify({ event: "result", data: { ran: true } })}\n`);
    };
    const diagnostics: string[] = [];
    const { callTool } = createToolsClient({
      onDiagnostic: (message) => diagnostics.push(message),
    });

    const pending = callTool("flow-execute", { project_root: projectDir, name: "root" });
    await vi.waitFor(() => expect(answerRequests()).toHaveLength(1));
    expect((await pending).data).toEqual({ ran: true });
    giveUp.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(diagnostics).toEqual([]);
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
      callTool("flow-execute", { project_root: projectDir, name: "root" }, { onProgress: () => {} })
    ).rejects.toThrow(
      /^The connection to the tool-server closed before flow-execute finished \(.+\)\. 1 progress update had arrived, so the tool ran at least in part; check its effect before you run it again\.$/
    );

    onInvoke = (_body, res) => {
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      res.end();
    };
    await expect(
      callTool("flow-execute", { project_root: projectDir, name: "root" })
    ).rejects.toThrow(
      "The connection to the tool-server closed before flow-execute finished (the stream ended without a result). The tool may have run; check its effect before you run it again."
    );
  });
});
