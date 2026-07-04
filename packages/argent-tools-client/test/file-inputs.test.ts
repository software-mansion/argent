import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  prepareFileInputs,
  applyClientFileDirectives,
  FILE_INPUT_MARKER,
  CLIENT_FILE_MARKER,
  type FileInputSpec,
  type FileInputWire,
} from "../src/file-inputs.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "client-file-inputs-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("prepareFileInputs", () => {
  it("returns args unchanged when no specs apply", async () => {
    const args = { udid: "ABC" };
    const out = await prepareFileInputs(undefined, args, { includeContent: false });
    expect(out).toBe(args);
  });

  it("wraps a file param with stat info, without content when local", async () => {
    const filePath = path.join(tmpDir, "baseline.png");
    await fs.writeFile(filePath, "png");
    const st = await fs.stat(filePath);

    const specs: FileInputSpec[] = [
      { target: "baselinePath", path: "${baselinePath}", kind: "file", optional: true },
    ];
    const out = (await prepareFileInputs(
      specs,
      { baselinePath: filePath, udid: "X" },
      { includeContent: false }
    )) as Record<string, unknown>;

    expect(out.udid).toBe("X");
    expect(out.baselinePath).toEqual({
      [FILE_INPUT_MARKER]: true,
      path: filePath,
      size: st.size,
      mtimeMs: st.mtimeMs,
    });
  });

  it("inlines base64 content when routed to a remote server", async () => {
    const filePath = path.join(tmpDir, "baseline.png");
    await fs.writeFile(filePath, "png-bytes");

    const specs: FileInputSpec[] = [
      { target: "baselinePath", path: "${baselinePath}", kind: "file" },
    ];
    const out = (await prepareFileInputs(
      specs,
      { baselinePath: filePath },
      { includeContent: true }
    )) as Record<string, FileInputWire>;

    expect(Buffer.from(out.baselinePath!.content!, "base64").toString()).toBe("png-bytes");
  });

  it("marks oversize content as omitted instead of silently skipping it", async () => {
    const filePath = path.join(tmpDir, "huge.bin");
    await fs.writeFile(filePath, Buffer.alloc(32 * 1024 * 1024 + 1));
    const st = await fs.stat(filePath);

    const specs: FileInputSpec[] = [
      { target: "baselinePath", path: "${baselinePath}", kind: "file" },
    ];
    const out = (await prepareFileInputs(
      specs,
      { baselinePath: filePath },
      { includeContent: true }
    )) as Record<string, FileInputWire>;

    // Stat survives so a co-located copy still resolves in place; only the
    // bytes are withheld, with the reason on the wire.
    expect(out.baselinePath).toEqual({
      [FILE_INPUT_MARKER]: true,
      path: filePath,
      size: st.size,
      mtimeMs: st.mtimeMs,
      contentOmitted: "size-limit",
    });
  });

  it("derives a new target param from a multi-param template (flow_file)", async () => {
    const flowsDir = path.join(tmpDir, ".argent", "flows");
    await fs.mkdir(flowsDir, { recursive: true });
    const flowPath = path.join(flowsDir, "my-flow.yaml");
    await fs.writeFile(flowPath, "steps: []\n");

    const specs: FileInputSpec[] = [
      { target: "flow_file", path: "${project_root}/.argent/flows/${name}.yaml", kind: "file" },
    ];
    const out = (await prepareFileInputs(
      specs,
      { name: "my-flow", project_root: tmpDir },
      { includeContent: true }
    )) as Record<string, unknown>;

    // Source params stay strings; the derived target carries the wrapper.
    expect(out.project_root).toBe(tmpDir);
    expect(out.name).toBe("my-flow");
    expect(out.flow_file).toMatchObject({ [FILE_INPUT_MARKER]: true, path: flowPath });
    expect((out.flow_file as FileInputWire).content).toBeDefined();
  });

  it("skips a spec whose referenced params are absent (live-capture mode)", async () => {
    const specs: FileInputSpec[] = [
      { target: "baselinePath", path: "${baselinePath}", kind: "file", optional: true },
    ];
    const args = { captureBaseline: true, udid: "X" };
    const out = await prepareFileInputs(specs, args, { includeContent: true });
    expect(out).toBe(args);
  });

  it("respects an explicitly set derived target (server-side override)", async () => {
    const specs: FileInputSpec[] = [
      { target: "flow_file", path: "${project_root}/.argent/flows/${name}.yaml", kind: "file" },
    ];
    const out = (await prepareFileInputs(
      specs,
      { name: "f", project_root: tmpDir, flow_file: "/server/side/flow.yaml" },
      { includeContent: true }
    )) as Record<string, unknown>;
    expect(out.flow_file).toBe("/server/side/flow.yaml");
  });

  it("still sends a path-only wrapper for an unreadable file", async () => {
    const specs: FileInputSpec[] = [{ target: "p", path: "${p}", kind: "file" }];
    const ghost = path.join(tmpDir, "ghost.png");
    const out = (await prepareFileInputs(specs, { p: ghost }, { includeContent: true })) as Record<
      string,
      unknown
    >;
    expect(out.p).toEqual({ [FILE_INPUT_MARKER]: true, path: ghost });
  });
});

describe("prepareFileInputs — tar-upload kind", () => {
  const specs: FileInputSpec[] = [{ target: "appPath", path: "${appPath}", kind: "tar-upload" }];

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("tars and uploads a local directory when routed to a remote server", async () => {
    const appDir = path.join(tmpDir, "MyApp.app");
    await fs.mkdir(appDir);
    await fs.writeFile(path.join(appDir, "Info.plist"), "<plist/>");

    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ uploadId: "upload-123" }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const out = (await prepareFileInputs(
      specs,
      { appPath: appDir },
      { includeContent: true, uploadEndpoint: { url: "https://sim.example", token: "tok" } }
    )) as Record<string, FileInputWire>;

    expect(out.appPath!.uploadId).toBe("upload-123");
    expect(out.appPath!.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(out.appPath!.size).toBeTypeOf("number");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://sim.example/upload",
      expect.objectContaining({ method: "POST" })
    );
  });

  it("tars and uploads a local file (e.g. an .apk) when routed to a remote server", async () => {
    const apk = path.join(tmpDir, "app.apk");
    await fs.writeFile(apk, "apk-bytes");

    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ uploadId: "upload-apk" }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const out = (await prepareFileInputs(
      specs,
      { appPath: apk },
      { includeContent: true, uploadEndpoint: { url: "https://sim.example", token: "tok" } }
    )) as Record<string, FileInputWire>;

    expect(out.appPath!.uploadId).toBe("upload-apk");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("propagates an upload failure", async () => {
    const appDir = path.join(tmpDir, "MyApp.app");
    await fs.mkdir(appDir);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 500, statusText: "Boom" }))
    );

    await expect(
      prepareFileInputs(
        specs,
        { appPath: appDir },
        { includeContent: true, uploadEndpoint: { url: "https://sim.example", token: "tok" } }
      )
    ).rejects.toThrow(/failed/i);
  });

  it("skips upload and sends a path-only wrapper when the path is not local", async () => {
    // A path that exists only on the remote host (e.g. pre-uploaded to the VM).
    const remotePath = path.join(tmpDir, "not", "on", "this", "machine", "MyApp.app");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const out = (await prepareFileInputs(
      specs,
      { appPath: remotePath },
      { includeContent: true, uploadEndpoint: { url: "https://sim.example", token: "tok" } }
    )) as Record<string, FileInputWire>;

    expect(out.appPath).toEqual({ [FILE_INPUT_MARKER]: true, path: remotePath });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not upload for a co-located session (no upload endpoint)", async () => {
    const appDir = path.join(tmpDir, "MyApp.app");
    await fs.mkdir(appDir);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const out = (await prepareFileInputs(
      specs,
      { appPath: appDir },
      { includeContent: false }
    )) as Record<string, FileInputWire>;

    expect(out.appPath).toMatchObject({
      [FILE_INPUT_MARKER]: true,
      path: appDir,
      size: expect.any(Number),
      mtimeMs: expect.any(Number),
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("applyClientFileDirectives", () => {
  function directive(p: string, content = "steps: []\n") {
    return { [CLIENT_FILE_MARKER]: true, path: p, content };
  }

  it("writes an allowed flow path and rewrites the directive to it", async () => {
    const flowPath = path.join(tmpDir, ".argent", "flows", "demo.yaml");
    const result = { message: "ok", savedTo: directive(flowPath) };

    const { result: rewritten, written } = await applyClientFileDirectives(result);

    expect(written).toEqual([flowPath]);
    expect((rewritten as { savedTo: string }).savedTo).toBe(flowPath);
    expect(await fs.readFile(flowPath, "utf8")).toBe("steps: []\n");
  });

  it("passes results without directives through untouched", async () => {
    const result = { a: 1, nested: { b: "x" } };
    const { result: rewritten, written } = await applyClientFileDirectives(result);
    expect(rewritten).toEqual(result);
    expect(written).toEqual([]);
  });

  it.each([
    ["relative path", path.join(".argent", "flows", "x.yaml")],
    ["outside .argent/flows", path.join(os.tmpdir(), "x.yaml")],
    // Built by concatenation: path.join would collapse the ".." segments
    // before the validator ever saw them.
    ["traversal", `${os.tmpdir()}/.argent/flows/../../evil.yaml`],
    ["bad extension", path.join(os.tmpdir(), ".argent", "flows", "x.sh")],
    ["bad name charset", path.join(os.tmpdir(), ".argent", "flows", "x y.yaml")],
  ])("refuses to write %s and resolves the directive to null", async (_label, p) => {
    const { result: rewritten, written } = await applyClientFileDirectives({
      savedTo: directive(p),
    });
    expect(written).toEqual([]);
    expect((rewritten as { savedTo: unknown }).savedTo).toBeNull();
  });
});
