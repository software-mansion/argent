import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as http from "node:http";
import * as fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, rm, writeFile, stat } from "node:fs/promises";
import { run, type RunCommandOptions } from "../src/run.js";
import { ARTIFACT_MARKER, artifactsRoot, type ArtifactHandle } from "@argent/tools-client";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x11, 0x22, 0x33]);

// A configurable in-process stand-in for the tool-server. Each test sets
// `state.screenshotData` to the `data` payload a screenshot call should return.
interface ServerState {
  screenshotData: unknown;
  artifactBytes: Buffer;
  artifactHits: number;
}

function startServer(state: ServerState): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const url = req.url ?? "";
    if (url === "/tools" && req.method === "GET") {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          tools: [
            {
              name: "screenshot",
              description: "",
              inputSchema: { type: "object", properties: {} },
              outputHint: "image",
            },
            {
              name: "list-devices",
              description: "",
              inputSchema: { type: "object", properties: {} },
            },
          ],
        })
      );
      return;
    }
    if (url.startsWith("/tools/screenshot") && req.method === "POST") {
      req.on("data", () => {});
      req.on("end", () => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ data: state.screenshotData }));
      });
      return;
    }
    if (url.startsWith("/tools/list-devices") && req.method === "POST") {
      req.on("data", () => {});
      req.on("end", () => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ data: { devices: [{ udid: "SIM-1" }] } }));
      });
      return;
    }
    if (url.startsWith("/artifacts/") && req.method === "GET") {
      state.artifactHits += 1;
      res.setHeader("content-type", "image/png");
      res.end(state.artifactBytes);
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

describe("CLI run — artifact materialization end-to-end", () => {
  let server: { url: string; close: () => Promise<void> };
  let state: ServerState;
  let artRoot: string; // ARGENT_ARTIFACTS_DIR (where downloads land)
  let hostDir: string; // stands in for the tool-server host's filesystem
  let outDir: string; // where --out writes
  let logs: string[];
  let errs: string[];
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  const opts: RunCommandOptions = { paths: {} as never }; // unused: ARGENT_TOOLS_URL is set

  beforeEach(async () => {
    state = { screenshotData: null, artifactBytes: PNG, artifactHits: 0 };
    server = await startServer(state);
    artRoot = await mkdtemp(join(tmpdir(), "cli-art-"));
    hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    outDir = await mkdtemp(join(tmpdir(), "cli-out-"));
    process.env.ARGENT_TOOLS_URL = server.url;
    process.env.ARGENT_ARTIFACTS_DIR = artRoot;

    logs = [];
    errs = [];
    logSpy = vi.spyOn(console, "log").mockImplementation((...a) => void logs.push(a.join(" ")));
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
    delete process.env.ARGENT_ARTIFACTS_DIR;
    await server.close();
    await rm(artRoot, { recursive: true, force: true });
    await rm(hostDir, { recursive: true, force: true });
    await rm(outDir, { recursive: true, force: true });
  });

  async function localScreenshotHandle(): Promise<ArtifactHandle> {
    const hostPath = join(hostDir, "shot.png");
    await writeFile(hostPath, PNG);
    const st = await stat(hostPath);
    return {
      [ARTIFACT_MARKER]: true,
      id: "loc-1",
      filename: "shot.png",
      mimeType: "image/png",
      size: st.size,
      hostPath,
      mtimeMs: st.mtimeMs,
    };
  }

  it("co-located: uses the local file, writes --out, never hits /artifacts", async () => {
    const handle = await localScreenshotHandle();
    state.screenshotData = { image: handle };
    const outPath = join(outDir, "saved.png");

    await run(["screenshot", "--args", '{"udid":"SIM-1"}', "--out", outPath], opts);

    // Gate hit: no download was made.
    expect(state.artifactHits).toBe(0);
    // --out got the real bytes.
    expect(fs.readFileSync(outPath)).toEqual(PNG);
    // Rendered the in-place host path and confirmed the write.
    const out = logs.join("\n");
    expect(out).toContain(`Saved screenshot: ${handle.hostPath}`);
    expect(out).toContain(`Wrote: ${outPath}`);
  });

  it("remote: downloads via /artifacts, writes --out from downloaded bytes", async () => {
    state.screenshotData = {
      image: {
        [ARTIFACT_MARKER]: true,
        id: "rem-1",
        filename: "shot.png",
        mimeType: "image/png",
        size: PNG.length,
        hostPath: join(hostDir, "not-here.png"), // absent → gate miss → download
        mtimeMs: 123,
      } satisfies ArtifactHandle,
    };
    const outPath = join(outDir, "saved.png");

    await run(["screenshot", "--args", '{"udid":"SIM-1"}', "--out", outPath], opts);

    expect(state.artifactHits).toBe(1);
    expect(fs.readFileSync(outPath)).toEqual(PNG);
    const out = logs.join("\n");
    // Saved path is the temp cache, not the (absent) host path.
    expect(out).toMatch(/Saved screenshot: .*shot\.png/);
    expect(out).toContain(artifactsRoot());
    expect(out).not.toContain("not-here.png");
  });

  it("legacy { url, path }: fetches the url for --out and renders the host path", async () => {
    state.screenshotData = { url: `${server.url}/artifacts/legacy`, path: "/host/legacy.png" };
    const outPath = join(outDir, "saved.png");

    await run(["screenshot", "--args", '{"udid":"SIM-1"}', "--out", outPath], opts);

    expect(state.artifactHits).toBe(1); // legacy fetch of result.url
    expect(fs.readFileSync(outPath)).toEqual(PNG);
    expect(logs.join("\n")).toContain("Saved screenshot: /host/legacy.png");
  });

  it("screenshot --json prints the materialized result with a local path, not a handle", async () => {
    const handle = await localScreenshotHandle();
    state.screenshotData = { image: handle };

    await run(["screenshot", "--args", '{"udid":"SIM-1"}', "--json"], opts);

    const out = logs.join("\n");
    expect(out).toContain(handle.hostPath); // resolved local path
    expect(out).not.toContain(ARTIFACT_MARKER); // no raw handle leaked
  });

  it("non-image tool: prints JSON unchanged with no artifact side effects", async () => {
    await run(["list-devices", "--json"], opts);
    expect(state.artifactHits).toBe(0);
    expect(JSON.parse(logs.join("\n"))).toEqual({ devices: [{ udid: "SIM-1" }] });
  });
});
