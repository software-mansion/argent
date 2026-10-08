import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import * as fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { flow } from "../src/flow.js";

// `argent flow run` over a link with the REAL tools client: a stub tool-server
// on ARGENT_TOOLS_URL lists flow-execute with its `collect: "flow"` file
// inputs, records each call, and answers a passing report. The client sends
// the flow's run: fragments with the call, as members of the flow_path wire.

const LISTING = [
  {
    name: "flow-execute",
    description: "",
    inputSchema: {},
    longRunning: true,
    // As flow-run.ts declares them.
    fileInputs: [
      {
        target: "flow_path",
        path: "${flow_path}",
        kind: "file",
        optional: true,
        unwrapWhenSet: "name",
        collect: "flow",
      },
      {
        target: "flow_file",
        path: "${project_root}/.argent/flows/${name}.yaml",
        kind: "file",
        skipWhenSet: "flow_path",
        collect: "flow",
      },
    ],
  },
];

const REPORT = {
  flow: "root",
  device: "SIM-1",
  executionPrerequisite: "",
  ok: true,
  passed: 1,
  failed: 0,
  skipped: 0,
  errored: 0,
  steps: [{ index: 0, kind: "echo", status: "pass", message: "ran" }],
};

interface RecordedCall {
  headers: IncomingMessage["headers"];
  body: Record<string, unknown>;
}

let server: Server;
let projectDir: string;
let flowsDir: string;
let previousCwd: string;
let stdout: string[];
let stderr: string[];
let calls: RecordedCall[];

function line(payload: unknown): string {
  return `${JSON.stringify(payload)}\n`;
}

beforeEach(async () => {
  calls = [];
  projectDir = await fsp.realpath(await fsp.mkdtemp(path.join(tmpdir(), "argent-cli-link-files-")));
  flowsDir = path.join(projectDir, ".argent", "flows");
  await fsp.mkdir(flowsDir, { recursive: true });
  await fsp.writeFile(
    path.join(flowsDir, "root.yaml"),
    "steps:\n  - run: frag.yaml\n  - run: gone.yaml\n"
  );
  await fsp.writeFile(path.join(flowsDir, "frag.yaml"), "steps:\n  - echo: in frag\n");

  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      if (req.method === "GET" && req.url === "/tools") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ tools: LISTING }));
        return;
      }
      if (req.method === "POST" && req.url === "/tools/flow-execute") {
        calls.push({
          headers: req.headers,
          body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>,
        });
        if (req.headers.accept?.includes("application/x-ndjson")) {
          res.writeHead(200, { "Content-Type": "application/x-ndjson" });
          res.end(line({ event: "result", data: REPORT }));
        } else {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ data: REPORT }));
        }
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  vi.stubEnv("ARGENT_TOOLS_URL", `http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  vi.stubEnv("ARGENT_AUTH_TOKEN", "");
  vi.stubEnv("ARGENT_FLOW_FILES_LOG", "");

  previousCwd = process.cwd();
  process.chdir(projectDir);
  stdout = [];
  stderr = [];
  vi.spyOn(console, "log").mockImplementation((...a) => void stdout.push(a.join(" ")));
  vi.spyOn(console, "error").mockImplementation((...a) => void stderr.push(a.join(" ")));
  // The CLI flushes stderr with an empty write before it exits, and waits for
  // that write's callback.
  vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown, ...rest: unknown[]) => {
    const text = String(chunk);
    if (text) stderr.push(...text.replace(/\n$/, "").split("\n"));
    const callback = rest.find((arg) => typeof arg === "function") as (() => void) | undefined;
    callback?.();
    return true;
  }) as typeof process.stderr.write);
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`process.exit:${code}`);
  }) as typeof process.exit);
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  process.chdir(previousCwd);
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await fsp.rm(projectDir, { recursive: true, force: true });
});

describe("argent flow run over a link: the run: fragments travel with the call", () => {
  it("sends each fragment as a member of the flow_path wire, a missing one marked missing", async () => {
    // --json asks for no progress: the members alone make the call stream.
    await expect(flow(["run", "root", "--json"], { paths: {} as never })).rejects.toThrow(
      "process.exit:0"
    );

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    // A call that carries members streams, uncompressed.
    expect(call.headers.accept).toContain("application/x-ndjson");
    expect(call.headers["accept-encoding"]).toBe("identity");
    const rootPath = path.join(flowsDir, "root.yaml");
    const fragText = "steps:\n  - echo: in frag\n";
    expect(call.body.flow_path).toMatchObject({
      __argentFileInput: true,
      path: rootPath,
      canonical: rootPath,
      spelling: { state: "listed" },
      members: [
        {
          role: "flow",
          key: `${flowsDir}\0frag.yaml`,
          path: `${flowsDir}${path.sep}frag.yaml`,
          canonical: path.join(flowsDir, "frag.yaml"),
          spelling: { state: "listed" },
          size: Buffer.byteLength(fragText),
          content: Buffer.from(fragText).toString("base64"),
        },
        {
          role: "flow",
          key: `${flowsDir}\0gone.yaml`,
          canonical: path.join(flowsDir, "gone.yaml"),
          state: "missing",
        },
      ],
    });
    const members = (call.body.flow_path as { members: Record<string, unknown>[] }).members;
    expect(members[1]).not.toHaveProperty("content");
    expect(call.body.project_root).toBe(projectDir);
  });

  it("sends a flow that composes nothing with no members and without a stream", async () => {
    // --json asks for no progress, so only members would make the call stream.
    await expect(flow(["run", "frag", "--json"], { paths: {} as never })).rejects.toThrow(
      "process.exit:0"
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]!.headers.accept ?? "").not.toContain("application/x-ndjson");
    expect(calls[0]!.body.flow_path).toMatchObject({ members: [] });
  });
});

describe("argent flow run over a link: the [flow-files] log", () => {
  const fragLine = () =>
    `[flow-files] flow ${path.join(flowsDir, "frag.yaml")}: inline ${Buffer.byteLength(
      "steps:\n  - echo: in frag\n"
    )}`;
  const goneLine = () => `[flow-files] flow ${path.join(flowsDir, "gone.yaml")}: missing`;

  it("writes each line as a warning record on stderr under --json", async () => {
    vi.stubEnv("ARGENT_FLOW_FILES_LOG", "1");

    await expect(flow(["run", "root", "--json"], { paths: {} as never })).rejects.toThrow(
      "process.exit:0"
    );

    expect(JSON.parse(stdout.join("\n"))).toMatchObject({ ok: true });
    // --json promises one JSON object per stderr line.
    expect(stderr.map((text) => JSON.parse(text))).toEqual([
      { event: "warning", warning: fragLine() },
      { event: "warning", warning: goneLine() },
    ]);
  });

  it("writes each flow's lines as warning records in a directory run under --json", async () => {
    vi.stubEnv("ARGENT_FLOW_FILES_LOG", "1");
    const suite = path.join(flowsDir, "suite");
    await fsp.mkdir(suite);
    await fsp.writeFile(path.join(suite, "a.yaml"), "steps:\n  - run: ../frag.yaml\n");
    await fsp.writeFile(path.join(suite, "b.yaml"), "steps:\n  - run: ../gone.yaml\n");

    await expect(flow(["run", suite, "--json"], { paths: {} as never })).rejects.toThrow(
      "process.exit:0"
    );

    expect(JSON.parse(stdout.join("\n"))).toMatchObject({ ok: true, total: 2, passed: 2 });
    expect(calls).toHaveLength(2);
    expect(stderr.map((text) => JSON.parse(text))).toEqual([
      { event: "warning", warning: fragLine() },
      { event: "warning", warning: goneLine() },
    ]);
  });

  it("writes plain lines on stderr in the default output", async () => {
    vi.stubEnv("ARGENT_FLOW_FILES_LOG", "1");

    await expect(flow(["run", "root"], { paths: {} as never })).rejects.toThrow("process.exit:0");

    expect(stderr.filter((text) => text.startsWith("[flow-files]"))).toEqual([
      fragLine(),
      goneLine(),
    ]);
  });

  it("writes nothing without ARGENT_FLOW_FILES_LOG=1", async () => {
    await expect(flow(["run", "root", "--json"], { paths: {} as never })).rejects.toThrow(
      "process.exit:0"
    );

    expect(calls).toHaveLength(1);
    expect(stderr).toEqual([]);
  });
});
