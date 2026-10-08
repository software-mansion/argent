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
 * sends the run's baselines as members of the flow's file input, keeps them on
 * its own "disk", and writes back the baselines the result returns. Only the
 * device edges are stubbed: the settle, and the `screenshot` tool the step
 * registry serves.
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

let workDir = "";
let capture: string;
let captureBytes: Buffer;
let restoreTmpdir: () => void = () => {};
let handle: HttpAppHandle | undefined = undefined;
let server: http.Server | undefined = undefined;

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

interface Directive {
  __argentClientFile: true;
  path: string;
  content: string;
  encoding?: string;
}

/**
 * The client's side, over a map of its files: `links` maps a spelled root
 * flow to its real file, `refused` turns a baseline into a refused member.
 */
function fakeClient(opts: { links?: Record<string, string>; refused?: Record<string, string> }) {
  const disk = new Map<string, Buffer>();
  /** The baselines a call sends: every file in the run's directory, by name or with bytes. */
  const members = (dir: string, update: boolean) =>
    [...disk.keys()]
      .filter((file) => path.posix.dirname(file) === dir && file.endsWith(".png"))
      .map((file) => {
        const refusal = opts.refused?.[file];
        const base = { role: "baseline", key: file, path: file };
        if (refusal !== undefined) return { ...base, state: "refused", error: refusal };
        if (update) return { ...base, state: "listed" };
        const bytes = disk.get(file)!;
        return { ...base, size: bytes.length, mtimeMs: 1, content: bytes.toString("base64") };
      });
  /** Writes what the result returns, as the argent client does. */
  const writeBack = (data: unknown): Directive[] => {
    const writes = ((data as { baselineWrites?: Directive[] }).baselineWrites ?? []).filter(
      (d) => d.encoding === "base64"
    );
    for (const d of writes) disk.set(d.path, Buffer.from(d.content, "base64"));
    return writes;
  };
  return { disk, links: opts.links ?? {}, members, writeBack };
}

/**
 * One flow-execute call over the stream, as the argent client makes it for an
 * uploaded flow: the flow's file input carries its real path and the run's
 * baselines (`members: false` sends none, as an older client does). Resolves
 * with the terminal line, after writing back the baselines it returned.
 */
async function runOverLink(
  base: string,
  client: ReturnType<typeof fakeClient>,
  opts: { clientPath?: string; updateBaselines?: boolean; members?: false } = {}
): Promise<{ terminal: Record<string, unknown>; written: Directive[] }> {
  const clientPath = opts.clientPath ?? ROOT_FLOW;
  const canonical = client.links[clientPath] ?? clientPath;
  const dir = path.posix.join(
    path.posix.dirname(canonical),
    "__baselines__",
    path.posix.basename(canonical, ".yaml")
  );
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
        ...(opts.members === false
          ? {}
          : {
              canonical,
              spelling: { state: "listed" },
              members: client.members(dir, opts.updateBaselines === true),
            }),
      },
      ...(opts.updateBaselines ? { updateBaselines: true } : {}),
    }),
  });
  expect(res.headers.get("content-type")).toContain("application/x-ndjson");

  let terminal: Record<string, unknown> | undefined;
  for await (const line of ndjsonLines(res.body!)) {
    expect(line.event).not.toBe("client-request");
    if (line.event === "result" || line.event === "error") terminal = line;
  }
  const written = terminal?.event === "result" ? client.writeBack(terminal.data) : [];
  return { terminal: terminal!, written };
}

/** The server's tmpdir as listed at the call's cleanup (see the file-inputs mock). */
async function serverFilesAtCleanup(): Promise<string[]> {
  await vi.waitFor(() => expect(h.listings).toHaveLength(1));
  return h.listings[0]!;
}

describe("snapshot: steps over a link", () => {
  it("returns the baseline for the client to write under updateBaselines, and writes nothing on the server", async () => {
    const steps = stepRegistry();
    handle = createHttpApp(httpRegistry(steps));
    const base = await listen(handle.app);
    const client = fakeClient({});

    const { terminal, written } = await runOverLink(base, client, { updateBaselines: true });

    // The capture itself goes back to the client, a PNG of the device's size.
    expect(written.map((d) => d.path)).toEqual([BASELINE]);
    const bytes = client.disk.get(BASELINE)!;
    expect(bytes.equals(captureBytes)).toBe(true);
    expect(PNG.sync.read(bytes)).toMatchObject({ width: 30, height: 60 });

    expect(terminal.event).toBe("result");
    const data = terminal.data as {
      ok: boolean;
      steps: { kind: string; status: string; reason: string }[];
    };
    expect(data.ok).toBe(true);
    // The reason names the file the client writes; no artifact names a server
    // file as the baseline.
    expect(data.steps).toEqual([
      expect.objectContaining({
        kind: "snapshot",
        status: "pass",
        reason: `baseline written (${BASELINE})`,
      }),
    ]);
    expect(data.steps[0]).not.toHaveProperty("artifacts");
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

  it("says a baseline the client listed by name was updated", async () => {
    handle = createHttpApp(httpRegistry(stepRegistry()));
    const base = await listen(handle.app);
    const client = fakeClient({});
    client.disk.set(BASELINE, Buffer.from("old"));

    const { terminal, written } = await runOverLink(base, client, { updateBaselines: true });

    expect(written.map((d) => d.path)).toEqual([BASELINE]);
    expect(terminal.data).toMatchObject({
      ok: true,
      steps: [expect.objectContaining({ reason: `baseline updated (${BASELINE})` })],
    });
  });

  it("compares against the baseline the client stored in an earlier run", async () => {
    handle = createHttpApp(httpRegistry(stepRegistry()));
    const base = await listen(handle.app);
    const client = fakeClient({});

    await runOverLink(base, client, { updateBaselines: true });
    expect(client.disk.has(BASELINE)).toBe(true);
    const { terminal, written } = await runOverLink(base, client);

    // A plain run returns nothing to write.
    expect(written).toEqual([]);
    expect(terminal.event).toBe("result");
    const data = terminal.data as { ok: boolean; steps: { status: string; reason: string }[] };
    expect(data.ok).toBe(true);
    expect(data).not.toHaveProperty("baselineWrites");
    expect(data.steps).toEqual([
      expect.objectContaining({
        status: "pass",
        reason: "diff 0.00% ≤ 0.5% (title__ios-30x60.png)",
      }),
    ]);
  });

  it("fails a compare with no baseline, as a co-located run does", async () => {
    handle = createHttpApp(httpRegistry(stepRegistry()));
    const base = await listen(handle.app);

    const { terminal } = await runOverLink(base, fakeClient({}));

    const data = terminal.data as { ok: boolean; steps: { status: string; reason: string }[] };
    expect(data.ok).toBe(false);
    expect(data.steps[0]!.status).toBe("fail");
    expect(data.steps[0]!.reason).toContain("no baseline");
  });

  it("keys the baselines beside the root flow's real file when the client path is a symlink", async () => {
    handle = createHttpApp(httpRegistry(stepRegistry()));
    const base = await listen(handle.app);
    const real = "/client/real/withsnap.yaml";
    const client = fakeClient({ links: { "/client/flows/alias.yaml": real } });

    const { terminal, written } = await runOverLink(base, client, {
      clientPath: "/client/flows/alias.yaml",
      updateBaselines: true,
    });

    const realBaseline = "/client/real/__baselines__/withsnap/title__ios-30x60.png";
    expect(written.map((d) => d.path)).toEqual([realBaseline]);
    // The report keeps the name the caller used.
    expect(terminal.data).toMatchObject({
      flow: "alias",
      ok: true,
      steps: [expect.objectContaining({ reason: `baseline written (${realBaseline})` })],
    });
  });

  it.each([false, true])(
    "refuses a snapshot before step 1 for a client that sends no files with the flow (updateBaselines %s)",
    async (updateBaselines) => {
      const steps = stepRegistry();
      handle = createHttpApp(httpRegistry(steps));
      const base = await listen(handle.app);

      const { terminal } = await runOverLink(base, fakeClient({}), {
        members: false,
        updateBaselines,
      });

      expect(terminal).toMatchObject({
        event: "error",
        error_code: FAILURE_CODES.FLOW_FILE_INVALID,
      });
      expect(terminal.error).toContain("step 1: snapshot: title");
      expect(terminal.error).toContain(
        "This tool-server runs snapshot: steps for a client that sends their baselines with " +
          "the call. Update the argent CLI or MCP adapter on the client."
      );
      expect(vi.mocked(steps.invokeTool)).not.toHaveBeenCalled();
    }
  );

  it.each([
    ["empty", () => Buffer.alloc(0)],
    ["a truncated PNG", () => captureBytes.subarray(0, 64)],
    [
      "a Git LFS pointer",
      () =>
        Buffer.from(
          `version https://git-lfs.github.com/spec/v1\noid sha256:${"0".repeat(64)}\nsize 1819922\n`
        ),
    ],
  ])("names the client's baseline when it is %s", async (_what, bytes) => {
    handle = createHttpApp(httpRegistry(stepRegistry()));
    const base = await listen(handle.app);
    const client = fakeClient({});
    client.disk.set(BASELINE, bytes());

    const { terminal } = await runOverLink(base, client);

    const data = terminal.data as { ok: boolean; steps: { status: string; reason: string }[] };
    expect(data.ok).toBe(false);
    expect(data.steps).toHaveLength(1);
    expect(data.steps[0]!.status).toBe("error");
    // The client's file, not the server's copies of it.
    const prefix = `Could not read PNG at ${BASELINE}: `;
    expect(data.steps[0]!.reason.slice(0, prefix.length)).toBe(prefix);
    expect(data.steps[0]!.reason).not.toContain("argent-flow-baseline-");
    expect(data.steps[0]!.reason).not.toContain("argent-file-input-");
  });

  it.each([false, true])(
    "reports the step as an error with the client's text when the client refused the baseline (updateBaselines %s)",
    async (updateBaselines) => {
      handle = createHttpApp(httpRegistry(stepRegistry()));
      const base = await listen(handle.app);
      const client = fakeClient({
        refused: { [BASELINE]: `${BASELINE} links to a file that is not a PNG file` },
      });
      client.disk.set(BASELINE, Buffer.from("x"));

      const { terminal, written } = await runOverLink(base, client, { updateBaselines });

      const data = terminal.data as { ok: boolean; steps: { status: string; reason: string }[] };
      expect(data.ok).toBe(false);
      expect(data.steps).toHaveLength(1);
      expect(data.steps[0]!.status).toBe("error");
      expect(data.steps[0]!.reason).toBe(
        `the client refused to ${updateBaselines ? "write" : "send"} "${BASELINE}": ` +
          `${BASELINE} links to a file that is not a PNG file`
      );
      expect(written).toEqual([]);
    }
  );
});
