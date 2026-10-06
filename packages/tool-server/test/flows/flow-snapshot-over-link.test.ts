import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { PNG } from "pngjs";
import { ArtifactStore, FAILURE_CODES, type Registry, type ToolContext } from "@argent/registry";
import { createHttpApp, type HttpAppHandle } from "../../src/http";
import { createRunFlowTool } from "../../src/tools/flows/flow-run";
import { serializeFlow } from "../../src/tools/flows/flow-utils";
import { redirectTmpdir } from "../helpers/tmpdir-env";

/**
 * A `snapshot:` step of a flow uploaded over a link, end to end through the
 * HTTP layer: the REAL flow-execute and runSnapshot, with a fake client that
 * reads the NDJSON stream and answers each client-request over the real answer
 * route, keeping the baselines on its own disk. Only the device edges are
 * stubbed: the settle, and the `screenshot` tool the step registry serves.
 */

vi.mock("../../src/utils/update-checker", () => ({
  getUpdateState: vi.fn(() => ({ updateInstallable: false, currentVersion: "1.0.0" })),
  isUpdateNoteSuppressed: vi.fn(() => true),
  suppressUpdateNote: vi.fn(),
}));

// The step registry serves no describe tree, so an unstubbed settle would poll
// to its own deadline before the capture.
vi.mock("../../src/tools/flows/flow-actions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/tools/flows/flow-actions")>()),
  settleTree: vi.fn(async () => ({})),
}));

// The upload's temp dir goes when the response closes, and with it any baseline
// a regression wrote beside it. So every file the server holds under its
// (redirected) tmpdir is listed just before that cleanup, while the run's files
// are all still there.
const h = vi.hoisted(() => ({ serverTmp: "", listings: [] as string[][] }));
vi.mock("../../src/file-inputs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/file-inputs")>();
  return {
    ...actual,
    resolveFileInputs: vi.fn(async (...args: Parameters<typeof actual.resolveFileInputs>) => {
      const resolved = await actual.resolveFileInputs(...args);
      return {
        ...resolved,
        cleanup: async () => {
          const { readdir } = await import("node:fs/promises");
          h.listings.push(await readdir(h.serverTmp, { recursive: true }));
          await resolved.cleanup();
        },
      };
    }),
  };
});

const DEVICE = "00000000-0000-0000-0000-0000000000ab";
const ROOT_FLOW = "/client/flows/withsnap.yaml";
const BASELINE = "/client/flows/__baselines__/withsnap/title__ios-30x60.png";
const FLOW_TEXT = serializeFlow({
  executionPrerequisite: "",
  steps: [{ kind: "snapshot", name: "title" }],
});
const ALL_OPS = ["resolve-file", "read-file", "write-file"];

let workDir: string;
let capture: string;
let captureBytes: Buffer;
let restoreTmpdir: () => void = () => {};
let handle: HttpAppHandle | undefined;
let server: http.Server | undefined;

beforeEach(async () => {
  workDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-snapshot-over-link-"));
  // A real PNG: the compare decodes it.
  const png = new PNG({ width: 30, height: 60 });
  png.data.fill(200);
  captureBytes = PNG.sync.write(png);
  capture = path.join(workDir, "capture.png");
  await fs.writeFile(capture, captureBytes);
  h.serverTmp = path.join(workDir, "server-tmp");
  await fs.mkdir(h.serverTmp);
  h.listings = [];
  restoreTmpdir = redirectTmpdir(h.serverTmp);
});

afterEach(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
  handle?.dispose();
  handle = undefined;
  restoreTmpdir();
  await fs.rm(workDir, { recursive: true, force: true });
});

/** The registry flow-execute dispatches its steps through: a device that only takes screenshots. */
function stepRegistry(): Registry {
  return {
    invokeTool: vi.fn(async (id: string) => {
      if (id === "screenshot") return { image: { hostPath: capture } };
      return { ok: true };
    }),
    getTool: vi.fn(() => ({ inputSchema: { properties: { udid: {} } } })),
  } as unknown as Registry;
}

function httpRegistry(steps: Registry): Registry {
  const flowExecute = createRunFlowTool(steps);
  return {
    getSnapshot: vi.fn(() => ({ services: new Map(), namespaces: [], tools: ["flow-execute"] })),
    getTool: vi.fn((id: string) => (id === "flow-execute" ? flowExecute : undefined)),
    invokeTool: vi.fn(async (_id: string, args: unknown, opts?: Partial<ToolContext>) =>
      flowExecute.execute({}, args as never, { artifacts: new ArtifactStore(), ...opts })
    ),
  } as unknown as Registry;
}

async function listen(app: HttpAppHandle["app"]): Promise<string> {
  server = http.createServer(app);
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function* ndjsonLines(
  body: ReadableStream<Uint8Array>
): AsyncGenerator<Record<string, unknown>> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffered += decoder.decode(value, { stream: true });
    let newline = buffered.indexOf("\n");
    while (newline >= 0) {
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      if (line.trim().length > 0) yield JSON.parse(line) as Record<string, unknown>;
      newline = buffered.indexOf("\n");
    }
  }
}

interface ClientRequest {
  op: string;
  args: Record<string, unknown>;
}

/**
 * The client's side of the channel, over a map of its files: it resolves the
 * root flow (through `links`, as a symlinked spelling would), reads a baseline,
 * and stores what it is asked to write. `refuse` turns an op into a refusal.
 */
function fakeClient(opts: { links?: Record<string, string>; refuse?: Record<string, string> }) {
  const disk = new Map<string, Buffer>();
  const answer = (req: ClientRequest): Record<string, unknown> => {
    const refusal = opts.refuse?.[req.op];
    if (refusal !== undefined) return { ok: false, error: refusal };
    if (req.op === "resolve-file") {
      const spelled = path.posix.join(req.args.anchorDir as string, req.args.target as string);
      const canonical = opts.links?.[spelled] ?? spelled;
      const content = disk.get(canonical);
      return content === undefined
        ? { ok: true, canonical, spelling: { state: "absent" }, exists: false }
        : {
            ok: true,
            canonical,
            spelling: { state: "listed" },
            exists: true,
            content: content.toString("base64"),
          };
    }
    if (req.op === "read-file") {
      const content = disk.get(req.args.path as string);
      return content === undefined
        ? { ok: true, exists: false }
        : {
            ok: true,
            exists: true,
            size: content.length,
            mtimeMs: 1,
            content: content.toString("base64"),
          };
    }
    if (req.op === "write-file") {
      disk.set(req.args.path as string, Buffer.from(req.args.content as string, "base64"));
      return { ok: true, written: req.args.path };
    }
    return { ok: false, error: `no such op ${req.op}` };
  };
  return { disk, answer };
}

/**
 * One flow-execute call over the stream, as the argent client makes it for an
 * uploaded flow: every client-request line is answered over the real route.
 * Resolves with the requests in order and the terminal line.
 */
async function runOverLink(
  base: string,
  client: ReturnType<typeof fakeClient>,
  opts: { clientPath?: string; ops?: string[]; updateBaselines?: boolean } = {}
): Promise<{ requests: ClientRequest[]; terminal: Record<string, unknown> }> {
  const clientPath = opts.clientPath ?? ROOT_FLOW;
  const res = await fetch(`${base}/tools/flow-execute`, {
    method: "POST",
    headers: { "content-type": "application/json", "accept": "application/x-ndjson" },
    body: JSON.stringify({
      project_root: "/client",
      device: DEVICE,
      flow_path: {
        __argentFileInput: true,
        path: clientPath,
        size: Buffer.byteLength(FLOW_TEXT),
        mtimeMs: 1,
        content: Buffer.from(FLOW_TEXT).toString("base64"),
      },
      ...(opts.updateBaselines ? { updateBaselines: true } : {}),
      client_services: { ops: opts.ops ?? ALL_OPS, roots: ["/client"] },
    }),
  });
  expect(res.headers.get("content-type")).toContain("application/x-ndjson");

  const requests: ClientRequest[] = [];
  let terminal: Record<string, unknown> | undefined;
  for await (const line of ndjsonLines(res.body!)) {
    if (line.event === "client-request") {
      const req = { op: line.op as string, args: line.args as Record<string, unknown> };
      requests.push(req);
      const posted = await fetch(
        `${base}/invocations/${line.invocation as string}/client-responses`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: line.id, ...client.answer(req) }),
        }
      );
      expect(posted.status).toBe(200);
    } else if (line.event === "result" || line.event === "error") {
      terminal = line;
    }
  }
  return { requests, terminal: terminal! };
}

/** The server's tmpdir as listed at the call's cleanup (see the file-inputs mock). */
async function serverFilesAtCleanup(): Promise<string[]> {
  await vi.waitFor(() => expect(h.listings).toHaveLength(1));
  return h.listings[0]!;
}

describe("snapshot: steps over a link", () => {
  it("writes the baseline on the client under updateBaselines, and nothing on the server", async () => {
    const steps = stepRegistry();
    handle = createHttpApp(httpRegistry(steps));
    const base = await listen(handle.app);
    const client = fakeClient({});
    client.disk.set(ROOT_FLOW, Buffer.from(FLOW_TEXT));

    const { requests, terminal } = await runOverLink(base, client, { updateBaselines: true });

    expect(requests).toEqual([
      {
        op: "resolve-file",
        args: { anchorDir: "/client/flows", target: "withsnap.yaml", kind: "flow" },
      },
      { op: "read-file", args: { path: BASELINE } },
      { op: "write-file", args: { path: BASELINE, content: expect.any(String) } },
    ]);
    // The capture itself landed on the client, a PNG of the device's size.
    const written = client.disk.get(BASELINE)!;
    expect(written.equals(captureBytes)).toBe(true);
    expect(PNG.sync.read(written)).toMatchObject({ width: 30, height: 60 });

    expect(terminal.event).toBe("result");
    const data = terminal.data as {
      ok: boolean;
      steps: { kind: string; status: string; reason: string }[];
    };
    expect(data.ok).toBe(true);
    expect(data.steps).toEqual([
      expect.objectContaining({
        kind: "snapshot",
        status: "pass",
        reason: "baseline written (title__ios-30x60.png)",
      }),
    ]);
    expect(vi.mocked(steps.invokeTool)).toHaveBeenCalledWith(
      "screenshot",
      expect.objectContaining({ udid: DEVICE }),
      expect.anything()
    );

    // The listing is the server's whole tmpdir while the upload still exists,
    // so a baseline written beside the upload would show up here.
    const serverFiles = await serverFilesAtCleanup();
    expect(serverFiles.some((f) => f.endsWith("withsnap.yaml"))).toBe(true);
    expect(serverFiles.filter((f) => f.includes("__baselines__"))).toEqual([]);
  });

  it("compares against the baseline the client stored in an earlier run", async () => {
    handle = createHttpApp(httpRegistry(stepRegistry()));
    const base = await listen(handle.app);
    const client = fakeClient({});
    client.disk.set(ROOT_FLOW, Buffer.from(FLOW_TEXT));

    await runOverLink(base, client, { updateBaselines: true });
    expect(client.disk.has(BASELINE)).toBe(true);
    const { requests, terminal } = await runOverLink(base, client);

    // No write: a plain run only reads the baseline.
    expect(requests.map((r) => r.op)).toEqual(["resolve-file", "read-file"]);
    expect(requests[1]!.args).toEqual({ path: BASELINE });
    expect(terminal.event).toBe("result");
    const data = terminal.data as { ok: boolean; steps: { status: string; reason: string }[] };
    expect(data.ok).toBe(true);
    expect(data.steps).toEqual([
      expect.objectContaining({
        status: "pass",
        reason: "diff 0.00% ≤ 0.5% (title__ios-30x60.png)",
      }),
    ]);
  });

  it("keys the baselines beside the root flow's real file when the client path is a symlink", async () => {
    handle = createHttpApp(httpRegistry(stepRegistry()));
    const base = await listen(handle.app);
    const real = "/client/real/withsnap.yaml";
    const client = fakeClient({ links: { "/client/flows/alias.yaml": real } });
    client.disk.set(real, Buffer.from(FLOW_TEXT));

    const { requests, terminal } = await runOverLink(base, client, {
      clientPath: "/client/flows/alias.yaml",
      updateBaselines: true,
    });

    const realBaseline = "/client/real/__baselines__/withsnap/title__ios-30x60.png";
    expect(requests.map((r) => [r.op, r.args.path ?? r.args.target])).toEqual([
      ["resolve-file", "alias.yaml"],
      ["read-file", realBaseline],
      ["write-file", realBaseline],
    ]);
    // The report keeps the name the caller used.
    expect(terminal.data).toMatchObject({ flow: "alias", ok: true });
  });

  it.each([[["resolve-file"]], [["resolve-file", "read-file"]]])(
    "refuses the flow before step 1 for a client that offers only %j",
    async (ops) => {
      const steps = stepRegistry();
      handle = createHttpApp(httpRegistry(steps));
      const base = await listen(handle.app);
      const client = fakeClient({});
      client.disk.set(ROOT_FLOW, Buffer.from(FLOW_TEXT));

      const { requests, terminal } = await runOverLink(base, client, {
        ops,
        updateBaselines: true,
      });

      expect(requests).toEqual([]);
      expect(terminal).toMatchObject({
        event: "error",
        error_code: FAILURE_CODES.FLOW_FILE_INVALID,
      });
      expect(terminal.error).toContain("step 1: snapshot: title");
      expect(terminal.error).toContain(
        "This tool-server serves snapshot: steps for a client that offers the read-file and " +
          "write-file client services. Update the argent CLI or MCP adapter on the client."
      );
      expect(vi.mocked(steps.invokeTool)).not.toHaveBeenCalled();
    }
  );

  it("reports the step as an error with the client's text when the client refuses the read", async () => {
    handle = createHttpApp(httpRegistry(stepRegistry()));
    const base = await listen(handle.app);
    const client = fakeClient({ refuse: { "read-file": "the path is outside the served roots" } });
    client.disk.set(ROOT_FLOW, Buffer.from(FLOW_TEXT));

    const { requests, terminal } = await runOverLink(base, client, { updateBaselines: true });

    // Nothing is written once the read was refused.
    expect(requests.map((r) => r.op)).toEqual(["resolve-file", "read-file"]);
    expect(client.disk.has(BASELINE)).toBe(false);
    const data = terminal.data as { ok: boolean; steps: { status: string; reason: string }[] };
    expect(data.ok).toBe(false);
    expect(data.steps).toHaveLength(1);
    expect(data.steps[0]!.status).toBe("error");
    expect(data.steps[0]!.reason).toBe(
      `the client refused the read-file request for "${BASELINE}": ` +
        "the path is outside the served roots"
    );
  });
});
