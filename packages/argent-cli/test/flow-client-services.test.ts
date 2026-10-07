import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import * as fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { flow } from "../src/flow.js";

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

// `argent flow run` over a link with the REAL tools client: a stub tool-server
// on ARGENT_TOOLS_URL streams client-request lines, and the client answers them
// from the project on disk.

const LISTING = [
  {
    name: "flow-execute",
    description: "",
    inputSchema: {},
    clientServices: { ops: ["resolve-file"] },
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
  steps: [{ index: 0, kind: "run", status: "pass", flow: "frag.yaml" }],
};

let server: Server;
let projectDir: string;
let flowsDir: string;
let previousCwd: string;
let stdout: string[];
let stderr: string[];
/** Per test: how POST /tools/flow-execute answers. */
let onInvoke: (res: ServerResponse) => void | Promise<void>;

function line(payload: unknown): string {
  return `${JSON.stringify(payload)}\n`;
}

/** Rejects when `promise` is still pending after `ms`. */
function settlesWithin<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`still pending after ${ms} ms`)), ms);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

beforeEach(async () => {
  hang.reads = [];
  projectDir = await fsp.realpath(await fsp.mkdtemp(path.join(tmpdir(), "argent-cli-services-")));
  flowsDir = path.join(projectDir, ".argent", "flows");
  await fsp.mkdir(flowsDir, { recursive: true });
  await fsp.writeFile(path.join(flowsDir, "root.yaml"), "steps:\n  - run: frag.yaml\n");
  await fsp.writeFile(path.join(flowsDir, "frag.yaml"), "steps:\n  - echo: hi\n");

  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    req.resume();
    req.on("end", () => {
      if (req.method === "GET" && req.url === "/tools") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ tools: LISTING }));
        return;
      }
      if (req.method === "POST" && req.url === "/tools/flow-execute") {
        void onInvoke(res);
        return;
      }
      if (req.method === "POST" && req.url?.endsWith("/client-responses")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ accepted: true }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  vi.stubEnv("ARGENT_TOOLS_URL", `http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  vi.stubEnv("ARGENT_AUTH_TOKEN", "");

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

describe("argent flow run over a link: client-services diagnostics", () => {
  // A request line without a string id names no answer to post: the client
  // drops it with a diagnostic.
  beforeEach(() => {
    onInvoke = (res) => {
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      res.write(line({ event: "client-request", invocation: "inv-1", id: 7, op: "resolve-file" }));
      res.end(line({ event: "result", data: REPORT }));
    };
  });

  it("writes a diagnostic as a warning record on stderr under --json", async () => {
    await expect(flow(["run", "root", "--json"], { paths: {} as never })).rejects.toThrow(
      "process.exit:0"
    );

    expect(JSON.parse(stdout.join("\n"))).toMatchObject({ ok: true });
    // --json promises one JSON object per stderr line.
    expect(stderr.map((text) => JSON.parse(text))).toEqual([
      {
        event: "warning",
        warning: "[client-services] ignored a request line without a string id",
      },
    ]);
  });

  it("writes each flow's diagnostic as a warning record on stderr in a directory run under --json", async () => {
    await expect(flow(["run", flowsDir, "--json"], { paths: {} as never })).rejects.toThrow(
      "process.exit:0"
    );

    expect(JSON.parse(stdout.join("\n"))).toMatchObject({ ok: true, total: 2, passed: 2 });
    expect(stderr.map((text) => JSON.parse(text))).toEqual(
      Array(2).fill({
        event: "warning",
        warning: "[client-services] ignored a request line without a string id",
      })
    );
  });

  it("writes a diagnostic as a plain line on stderr in the default output", async () => {
    await expect(flow(["run", "root"], { paths: {} as never })).rejects.toThrow("process.exit:0");

    expect(stderr).toEqual(["[client-services] ignored a request line without a string id"]);
  });
});

describe("argent flow run over a link: a local read that never finishes", () => {
  it("exits once the tool-server reports the run, without waiting for the read", async () => {
    await fsp.writeFile(path.join(flowsDir, "hang.yaml"), "steps:\n  - echo: never\n");
    onInvoke = async (res) => {
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      res.write(
        line({
          event: "client-request",
          invocation: "inv-1",
          id: "req-1",
          op: "resolve-file",
          args: { anchorDir: flowsDir, target: "hang.yaml", kind: "flow" },
        })
      );
      while (hang.reads.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
      // The tool-server's own timeout fails the run: step, and the run ends.
      res.end(
        line({
          event: "result",
          data: {
            ...REPORT,
            ok: false,
            passed: 0,
            errored: 1,
            steps: [{ index: 0, kind: "run", status: "error", flow: "hang.yaml" }],
          },
        })
      );
    };

    await expect(
      settlesWithin(flow(["run", "root"], { paths: {} as never }), 3_000)
    ).rejects.toThrow("process.exit:1");
    expect(hang.reads).toEqual([path.join(flowsDir, "hang.yaml")]);
  });
});
