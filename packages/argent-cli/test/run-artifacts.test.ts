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
    // 200 with a body that is not an image, the way a captive proxy or an error
    // page answers a legacy media URL.
    if (url === "/not-an-image" && req.method === "GET") {
      res.setHeader("content-type", "text/html");
      res.end("<html>gateway error</html>");
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

  // `--out` is stripped before the schema parser, so the tool's own `out` property
  // is reachable only through `--args` / `--out-json`. Those spellings used to
  // travel to a tool that never reads them and write nothing, silently.
  it("honors the tool's own `out` property when it arrives through --args", async () => {
    const handle = await localScreenshotHandle();
    state.screenshotData = { image: handle };
    const outPath = join(outDir, "from-args.png");

    await run(["screenshot", "--args", JSON.stringify({ udid: "SIM-1", out: outPath })], opts);

    expect(fs.readFileSync(outPath)).toEqual(PNG);
    expect(logs.join("\n")).toContain(`Wrote: ${outPath}`);
  });

  it("honors the tool's own `out` property when it arrives through --out-json", async () => {
    const handle = await localScreenshotHandle();
    state.screenshotData = { image: handle };
    const outPath = join(outDir, "from-out-json.png");

    await run(
      ["screenshot", "--args", '{"udid":"SIM-1"}', "--out-json", JSON.stringify(outPath)],
      opts
    );

    expect(fs.readFileSync(outPath)).toEqual(PNG);
    expect(logs.join("\n")).toContain(`Wrote: ${outPath}`);
  });

  it("lets an explicit --out win over an `out` carried in the payload", async () => {
    const handle = await localScreenshotHandle();
    state.screenshotData = { image: handle };
    const flagPath = join(outDir, "flag.png");
    const payloadPath = join(outDir, "payload.png");

    await run(
      [
        "screenshot",
        "--args",
        JSON.stringify({ udid: "SIM-1", out: payloadPath }),
        "--out",
        flagPath,
      ],
      opts
    );

    expect(fs.readFileSync(flagPath)).toEqual(PNG);
    expect(fs.existsSync(payloadPath)).toBe(false);
    expect(logs.join("\n")).toContain(`Wrote: ${flagPath}`);
  });

  // An empty `--out` used to survive as "" and outrank the payload `out` it beats on
  // precedence, so neither destination was written and nothing said so.
  it("refuses an empty --out instead of letting it silence the payload `out`", async () => {
    const handle = await localScreenshotHandle();
    state.screenshotData = { image: handle };
    const payloadPath = join(outDir, "payload.png");

    await expect(
      run(
        ["screenshot", "--args", JSON.stringify({ udid: "SIM-1", out: payloadPath }), "--out="],
        opts
      )
    ).rejects.toThrow("process.exit(2)");

    expect(errs.join("\n")).toContain("--out requires a path");
    expect(fs.existsSync(payloadPath)).toBe(false);
  });

  // `path.resolve` reads a leading space as a relative path, so an untrimmed value
  // buried the PNG under a directory literally named " " and `Wrote:` named neither.
  it("trims --out so a padded path is not resolved as a relative one", async () => {
    const handle = await localScreenshotHandle();
    state.screenshotData = { image: handle };
    const outPath = join(outDir, "padded.png");

    await run(["screenshot", "--args", '{"udid":"SIM-1"}', "--out", ` ${outPath} `], opts);

    expect(fs.readFileSync(outPath)).toEqual(PNG);
    expect(fs.existsSync(join(process.cwd(), " "))).toBe(false);
    expect(logs.join("\n")).toContain(`Wrote: ${outPath}`);
  });

  // `out` reaches the payload only inside shell-quoted JSON, where no shell ever
  // expands `~` — so taking it literally makes a directory named `~` in the cwd.
  it("expands `~` in a payload `out`, like the MCP writer does", async () => {
    const handle = await localScreenshotHandle();
    state.screenshotData = { image: handle };
    const home = await mkdtemp(join(tmpdir(), "cli-home-"));
    // `os.homedir()` reads libuv's environ, which Node keeps in step with
    // `process.env` on the main thread — the same redirect temp-home.ts uses.
    const realHome = process.env.HOME;
    process.env.HOME = home;
    // A cwd the test owns, so "no directory named `~` was created" is an
    // assertion about this run and not about whatever else litters the package.
    const cwd = process.cwd();
    process.chdir(outDir);

    try {
      await run(
        ["screenshot", "--args", JSON.stringify({ udid: "SIM-1", out: "~/kept.png" })],
        opts
      );

      expect(fs.readFileSync(join(home, "kept.png"))).toEqual(PNG);
      expect(fs.readdirSync(process.cwd())).not.toContain("~");
      expect(logs.join("\n")).toContain(`Wrote: ${join(home, "kept.png")}`);
    } finally {
      process.chdir(cwd);
      if (realHome === undefined) delete process.env.HOME;
      else process.env.HOME = realHome;
      await rm(home, { recursive: true, force: true });
    }
  });

  // `path.resolve` drops the trailing separator, so this would have made a regular
  // file named `shots` and blocked every later write underneath it.
  it("refuses a directory-shaped `out` rather than making a file of that name", async () => {
    const handle = await localScreenshotHandle();
    state.screenshotData = { image: handle };
    const dirShaped = `${join(outDir, "shots")}/`;

    await expect(
      run(["screenshot", "--args", JSON.stringify({ udid: "SIM-1", out: dirShaped })], opts)
    ).rejects.toThrow("process.exit(1)");

    expect(errs.join("\n")).toContain("names the file to write, not a directory");
    expect(fs.existsSync(join(outDir, "shots"))).toBe(false);
  });

  it("reports the absolute path it wrote, not the relative spelling it was given", async () => {
    const handle = await localScreenshotHandle();
    state.screenshotData = { image: handle };
    const cwd = process.cwd();
    process.chdir(outDir);

    try {
      await run(["screenshot", "--args", '{"udid":"SIM-1"}', "--out", "./rel.png"], opts);
      // `/var` is a symlink on macOS, so anchor on the cwd the process actually has.
      expect(logs.join("\n")).toContain(`Wrote: ${join(process.cwd(), "rel.png")}`);
      expect(logs.join("\n")).not.toContain("Wrote: ./rel.png");
    } finally {
      process.chdir(cwd);
    }
  });

  // No handle and no legacy `url` — the destination cannot be written, so saying
  // `Wrote:` would hand back whatever an earlier run left there as this capture.
  it("fails the save when no image came back rather than reporting a write", async () => {
    state.screenshotData = { image: null };
    const outPath = join(outDir, "stale.png");
    await writeFile(outPath, Buffer.from("an earlier run's baseline"));

    await expect(
      run(["screenshot", "--args", '{"udid":"SIM-1"}', "--out", outPath], opts)
    ).rejects.toThrow("process.exit(1)");

    expect(errs.join("\n")).toContain(`Could not save to ${outPath}`);
    expect(errs.join("\n")).toContain("stale");
    expect(logs.join("\n")).not.toContain("Wrote:");
    expect(fs.readFileSync(outPath).toString()).toBe("an earlier run's baseline");
  });

  it("fails the same way when the destination came from the payload `out`", async () => {
    state.screenshotData = { image: null };
    const outPath = join(outDir, "stale-payload.png");

    await expect(
      run(["screenshot", "--args", JSON.stringify({ udid: "SIM-1", out: outPath })], opts)
    ).rejects.toThrow("process.exit(1)");

    expect(errs.join("\n")).toContain(`Could not save to ${outPath}`);
    expect(logs.join("\n")).not.toContain("Wrote:");
  });

  // The capture is the expensive half and it already succeeded; exiting without
  // naming it leaves the caller no way to reach the PNG sitting in the cache.
  it("still reports where the capture landed when the save fails", async () => {
    const handle = await localScreenshotHandle();
    state.screenshotData = { image: handle };
    // A regular file stands where the parent directory would have to be.
    const blocker = join(outDir, "blocker");
    await writeFile(blocker, "not a directory");

    await expect(
      run(["screenshot", "--args", '{"udid":"SIM-1"}', "--out", join(blocker, "shot.png")], opts)
    ).rejects.toThrow("process.exit(1)");

    expect(logs.join("\n")).toContain(`Saved screenshot: ${handle.hostPath}`);
    expect(errs.join("\n")).toContain("Could not save to");
    expect(logs.join("\n")).not.toContain("Wrote:");
  });

  // failInvocation's contract for every other rejected run: `--json | jq` on a
  // failure reads an empty stream and a non-zero status. A save failure printing
  // the result on stdout would hand jq a parse of a run that did not do what it
  // was asked.
  // A legacy media URL is plain HTTP: a proxy or an error page answers 200 with
  // HTML, and writing that under `out` hands screenshot-diff a non-image baseline.
  it("refuses to write legacy bytes that are not a PNG", async () => {
    state.screenshotData = { url: `${server.url}/not-an-image`, path: "/host/shot.png" };
    const out = join(outDir, "legacy.png");

    await expect(
      run(["screenshot", "--args", '{"udid":"SIM-1"}', "--out", out], opts)
    ).rejects.toThrow("process.exit(1)");

    expect(errs.join("\n")).toContain("not a PNG");
    expect(fs.existsSync(out)).toBe(false);
  });

  it("--json: a failed save leaves stdout empty and reports on stderr", async () => {
    const handle = await localScreenshotHandle();
    state.screenshotData = { image: handle };
    const blocker = join(outDir, "blocker");
    await writeFile(blocker, "not a directory");

    await expect(
      run(
        ["screenshot", "--args", '{"udid":"SIM-1"}', "--out", join(blocker, "shot.png"), "--json"],
        opts
      )
    ).rejects.toThrow("process.exit(1)");

    expect(logs).toEqual([]);
    const reported = JSON.parse(errs.join("\n"));
    expect(reported.error).toContain("Could not save to");
    // The capture succeeded, so the scratch path it left has to survive.
    expect(JSON.stringify(reported.result)).toContain(handle.hostPath);
  });

  // `out`'s describe tells the caller to pass on the absolute path it reports
  // rather than the relative spelling they typed, so `--json` has to name it
  // somewhere — stderr, since stdout is one parseable object.
  it("--json: stdout stays one object and the destination is named on stderr", async () => {
    const handle = await localScreenshotHandle();
    state.screenshotData = { image: handle };
    const out = join(outDir, "shot.png");

    await run(["screenshot", "--args", '{"udid":"SIM-1"}', "--out", out, "--json"], opts);

    expect(() => JSON.parse(logs.join("\n"))).not.toThrow();
    expect(logs.join("\n")).not.toContain("Wrote:");
    expect(errs.join("\n")).toContain(`Wrote: ${out}`);
    expect(fs.readFileSync(out)).toEqual(PNG);
  });

  it("reports the absolute destination under --json when `out` was relative", async () => {
    const handle = await localScreenshotHandle();
    state.screenshotData = { image: handle };
    const cwd = process.cwd();
    process.chdir(outDir);
    try {
      await run(
        ["screenshot", "--args", JSON.stringify({ udid: "SIM-1", out: "./rel.png" }), "--json"],
        opts
      );
      expect(errs.join("\n")).toContain(`Wrote: ${join(process.cwd(), "rel.png")}`);
    } finally {
      process.chdir(cwd);
    }
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
