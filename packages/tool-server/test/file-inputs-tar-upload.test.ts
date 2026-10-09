import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { FILE_INPUT_MARKER, flowMemberKey, type FileInputSpec } from "@argent/registry";
import { resolveFileInputs, type UploadEntry } from "../src/file-inputs";
import { redirectTmpdir } from "./helpers/tmpdir-env";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});

const execFileAsync = promisify(execFile);

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "tar-dir-test-"));
});

// A tar upload extracts into its own temp dir, released only by the cleanup
// resolveFileInputs returns — the dispatcher's job in production, this list's
// here.
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function wire(overrides: Record<string, unknown>) {
  return { [FILE_INPUT_MARKER]: true, ...overrides };
}

async function wireWithStat(overrides: Record<string, unknown>) {
  const filePath = overrides.path as string;
  const st = await fs.stat(filePath);
  return wire({ ...overrides, size: st.size, mtimeMs: st.mtimeMs });
}

async function sha256File(filePath: string): Promise<string> {
  const data = await fs.readFile(filePath);
  return createHash("sha256").update(data).digest("hex");
}

async function uploadEntry(tarPath: string): Promise<UploadEntry> {
  return { tarPath, sha256: await sha256File(tarPath) };
}

function wireUpload(clientPath: string, uploadId: string, entry: UploadEntry) {
  return wire({ path: clientPath, uploadId, contentHash: entry.sha256 });
}

const TAR_UPLOAD_SPEC: FileInputSpec[] = [
  { target: "appPath", path: "${appPath}", kind: "tar-upload" },
];

async function makeFakeApp(name = "MyApp.app"): Promise<string> {
  const appDir = path.join(tmpDir, name);
  await fs.mkdir(appDir);
  await fs.writeFile(path.join(appDir, "Info.plist"), "<plist/>");
  await fs.writeFile(path.join(appDir, "MyApp"), "binary");
  return appDir;
}

async function makeFakeApk(name = "app.apk"): Promise<string> {
  const apkPath = path.join(tmpDir, name);
  await fs.writeFile(apkPath, "apk-bytes");
  return apkPath;
}

async function tarApp(source: string, extraMembers: string[] = []): Promise<string> {
  const tarPath = path.join(tmpDir, "upload.tar.gz");
  await execFileAsync("tar", [
    "-czf",
    tarPath,
    "-C",
    path.dirname(source),
    path.basename(source),
    ...extraMembers,
  ]);
  return tarPath;
}

describe("resolveFileInputs — tar-upload kind", () => {
  it("resolves in place when the directory exists on this host with matching stat", async () => {
    const appDir = await makeFakeApp();

    const { args, fileInputs } = await resolveFileInputs(
      { fileInputs: TAR_UPLOAD_SPEC },
      { appPath: await wireWithStat({ path: appDir }) }
    );

    expect(args.appPath).toBe(appDir);
    expect(fileInputs!.appPath).toMatchObject({ presentOnHost: true, viaUpload: false });
  });

  it("does not resolve in place when directory mtime does not match", async () => {
    const appDir = await makeFakeApp();
    const st = await fs.stat(appDir);

    await expect(
      resolveFileInputs(
        { fileInputs: TAR_UPLOAD_SPEC },
        { appPath: wire({ path: appDir, size: st.size, mtimeMs: 0 }) },
        () => undefined
      )
    ).rejects.toThrow(/no upload was provided\. Update argent/);
  });

  it("resolves a file in place when it exists on this host with matching stat", async () => {
    const apk = await makeFakeApk();

    const { args, fileInputs } = await resolveFileInputs(
      { fileInputs: TAR_UPLOAD_SPEC },
      { appPath: await wireWithStat({ path: apk }) }
    );

    expect(args.appPath).toBe(apk);
    expect(fileInputs!.appPath).toMatchObject({ presentOnHost: true, viaUpload: false });
  });

  it("prefers the upload over a same-path host copy when uploadId is set", async () => {
    const hostApp = await makeFakeApp("MyApp.app");
    await fs.writeFile(path.join(hostApp, "MyApp"), "host-bytes");

    const uploadSrc = path.join(tmpDir, "upload-src", "MyApp.app");
    await fs.mkdir(path.dirname(uploadSrc), { recursive: true });
    await fs.mkdir(uploadSrc);
    await fs.writeFile(path.join(uploadSrc, "MyApp"), "upload-bytes");
    const tarPath = await tarApp(uploadSrc);
    const uploadId = "prefer-upload";
    const entry = await uploadEntry(tarPath);

    const { args, cleanup } = await resolveFileInputs(
      { fileInputs: TAR_UPLOAD_SPEC },
      {
        appPath: wire({
          path: hostApp,
          uploadId,
          contentHash: entry.sha256,
          ...(await (async () => {
            const st = await fs.stat(hostApp);
            return { size: st.size, mtimeMs: st.mtimeMs };
          })()),
        }),
      },
      (id) => (id === uploadId ? entry : undefined)
    );
    cleanups.push(cleanup);

    expect(await fs.readFile(path.join(args.appPath as string, "MyApp"), "utf8")).toBe(
      "upload-bytes"
    );
  });

  it("extracts the uploaded archive and returns the app dir path", async () => {
    const appDir = await makeFakeApp("MyApp.app");
    const tarPath = await tarApp(appDir);
    const uploadId = "test-upload-id";
    const entry = await uploadEntry(tarPath);

    const { args, fileInputs, cleanup } = await resolveFileInputs(
      { fileInputs: TAR_UPLOAD_SPEC },
      { appPath: wireUpload("/client/MyApp.app", uploadId, entry) },
      (id) => (id === uploadId ? entry : undefined)
    );

    const resolvedPath = args.appPath as string;
    expect(path.basename(resolvedPath)).toBe("MyApp.app");
    expect(await fs.stat(resolvedPath)).toBeTruthy();
    expect(await fs.readFile(path.join(resolvedPath, "Info.plist"), "utf8")).toBe("<plist/>");
    expect(fileInputs!.appPath).toMatchObject({ viaUpload: true });

    await cleanup();
    await expect(fs.stat(resolvedPath)).rejects.toThrow();
  });

  it("extracts an uploaded single file (e.g. an .apk) and returns its path", async () => {
    const apk = await makeFakeApk("app.apk");
    const tarPath = await tarApp(apk);
    const uploadId = "test-upload-id-apk";
    const entry = await uploadEntry(tarPath);

    const { args, fileInputs, cleanup } = await resolveFileInputs(
      { fileInputs: TAR_UPLOAD_SPEC },
      { appPath: wireUpload("/client/app.apk", uploadId, entry) },
      (id) => (id === uploadId ? entry : undefined)
    );
    cleanups.push(cleanup);

    const resolvedPath = args.appPath as string;
    expect(path.basename(resolvedPath)).toBe("app.apk");
    expect(await fs.readFile(resolvedPath, "utf8")).toBe("apk-bytes");
    expect(fileInputs!.appPath).toMatchObject({ viaUpload: true });
  });

  it("picks the bundle over a macOS AppleDouble sidecar in the archive", async () => {
    const appDir = await makeFakeApp("MyApp.app");
    await fs.writeFile(path.join(tmpDir, "._MyApp.app"), "appledouble");
    const tarPath = await tarApp(appDir, ["._MyApp.app"]);
    const uploadId = "test-upload-id-sidecar";
    const entry = await uploadEntry(tarPath);

    const { args, cleanup } = await resolveFileInputs(
      { fileInputs: TAR_UPLOAD_SPEC },
      { appPath: wireUpload("/client/MyApp.app", uploadId, entry) },
      (id) => (id === uploadId ? entry : undefined)
    );
    cleanups.push(cleanup);

    const resolvedPath = args.appPath as string;
    expect(path.basename(resolvedPath)).toBe("MyApp.app");
    expect((await fs.stat(resolvedPath)).isDirectory()).toBe(true);
  });

  it("removes the original tar after extraction", async () => {
    const appDir = await makeFakeApp();
    const tarPath = await tarApp(appDir);
    const uploadId = "test-upload-id-2";
    const entry = await uploadEntry(tarPath);

    const { cleanup } = await resolveFileInputs(
      { fileInputs: TAR_UPLOAD_SPEC },
      { appPath: wireUpload("/client/MyApp.app", uploadId, entry) },
      (id) => (id === uploadId ? entry : undefined)
    );

    cleanups.push(cleanup);

    // tar should already be removed by resolveOne after extraction
    await expect(fs.stat(tarPath)).rejects.toThrow();
    await cleanup();
  });

  it("says a path the client sent no stat for was not found, without update advice", async () => {
    const ghost = path.join(tmpDir, "NotHere.app");

    const err = await resolveFileInputs(
      { fileInputs: TAR_UPLOAD_SPEC },
      { appPath: wire({ path: ghost }) },
      () => undefined
    ).catch((e: unknown) => e);

    expect((err as Error).message).toBe(
      `Path "${ghost}" was not found. The client sent no file for it, and the ` +
        `tool-server host has none at that path.`
    );
  });

  it("fails when uploadId is set without contentHash", async () => {
    const appDir = await makeFakeApp("MyApp.app");
    const tarPath = await tarApp(appDir);
    const uploadId = "no-hash";
    const entry = await uploadEntry(tarPath);

    await expect(
      resolveFileInputs(
        { fileInputs: TAR_UPLOAD_SPEC },
        { appPath: wire({ path: "/client/MyApp.app", uploadId }) },
        (id) => (id === uploadId ? entry : undefined)
      )
    ).rejects.toThrow(/missing a content hash/i);
  });

  it("fails clearly when the uploadId is not in the registry", async () => {
    await expect(
      resolveFileInputs(
        { fileInputs: TAR_UPLOAD_SPEC },
        {
          appPath: wire({
            path: "/client/MyApp.app",
            uploadId: "stale-id",
            contentHash: "0".repeat(64),
          }),
        },
        () => undefined
      )
    ).rejects.toThrow(/was not found on the tool-server/);
  });

  it("fails when the client content hash does not match the stored upload", async () => {
    const appDir = await makeFakeApp("MyApp.app");
    const tarPath = await tarApp(appDir);
    const uploadId = "hash-mismatch";
    const entry = await uploadEntry(tarPath);

    await expect(
      resolveFileInputs(
        { fileInputs: TAR_UPLOAD_SPEC },
        {
          appPath: wire({ path: "/client/MyApp.app", uploadId, contentHash: "0".repeat(64) }),
        },
        (id) => (id === uploadId ? entry : undefined)
      )
    ).rejects.toThrow(/content hash mismatch/i);
    // The upload tar must be reclaimed even though the failure is before extraction —
    // the registry entry is already gone, so nothing else would clean it up.
    await expect(fs.stat(tarPath)).rejects.toThrow();
  });

  it("refuses to extract archives with path-traversal members", async () => {
    const tarPath = path.join(tmpDir, "malicious.tar.gz");
    const innocent = path.join(tmpDir, "innocent.txt");
    await fs.writeFile(innocent, "pwned");
    // -P keeps the absolute member name (portable across GNU and bsd tar); an
    // absolute path escapes the extract dir and must be refused before extraction.
    await execFileAsync("tar", ["-c", "-z", "-P", "-f", tarPath, innocent]);
    const uploadId = "malicious";
    const entry = await uploadEntry(tarPath);

    await expect(
      resolveFileInputs(
        { fileInputs: TAR_UPLOAD_SPEC },
        { appPath: wireUpload("/client/MyApp.app", uploadId, entry) },
        (id) => (id === uploadId ? entry : undefined)
      )
    ).rejects.toThrow(/unsafe path/i);
  });

  it("removes the uploaded tar even when extraction fails", async () => {
    const corruptTar = path.join(tmpDir, "corrupt.tar.gz");
    await fs.writeFile(corruptTar, "not a real gzip archive");
    const uploadId = "test-upload-id-corrupt";
    const entry = { tarPath: corruptTar, sha256: await sha256File(corruptTar) };

    await expect(
      resolveFileInputs(
        { fileInputs: TAR_UPLOAD_SPEC },
        { appPath: wireUpload("/client/MyApp.app", uploadId, entry) },
        (id) => (id === uploadId ? entry : undefined)
      )
    ).rejects.toThrow();

    await expect(fs.stat(corruptTar)).rejects.toThrow(); // removed despite the failure
  });
});

describe("resolveFileInputs — flow members sent through POST /upload", () => {
  const FLOWS = "/client/proj/.argent/flows";
  const FLOW_SPEC: FileInputSpec[] = [
    { target: "flow_path", path: "${flow_path}", kind: "file", collect: "flow" },
  ];

  /** Hands each entry over once, as the upload store of the HTTP layer does. */
  function uploadStore(entries: Record<string, UploadEntry>) {
    const pending = new Map(Object.entries(entries));
    const lookup = (id: string): UploadEntry | undefined => {
      const entry = pending.get(id);
      pending.delete(id);
      return entry;
    };
    return { pending, lookup };
  }

  /** The client's tar of one fragment, as POST /upload stores it. */
  async function fragmentUpload(name: string, write: (file: string) => Promise<void>) {
    const dir = await fs.mkdtemp(path.join(tmpDir, "fragment-"));
    await write(path.join(dir, name));
    const tarPath = path.join(dir, `${name}.tar.gz`);
    await execFileAsync("tar", ["-czf", tarPath, "-C", dir, name]);
    return uploadEntry(tarPath);
  }

  function member(name: string, uploadId: string, entry: UploadEntry, extra = {}) {
    return {
      role: "flow",
      key: flowMemberKey(FLOWS, name),
      path: `${FLOWS}/${name}`,
      canonical: `${FLOWS}/${name}`,
      spelling: { state: "listed" },
      uploadId,
      contentHash: entry.sha256,
      ...extra,
    };
  }

  function flowWire(members: unknown[]) {
    const yaml = "steps:\n  - run: a.yaml\n";
    return wire({
      path: `${FLOWS}/root.yaml`,
      size: Buffer.byteLength(yaml),
      content: Buffer.from(yaml).toString("base64"),
      canonical: `${FLOWS}/root.yaml`,
      spelling: { state: "listed" },
      members,
    });
  }

  const FRAGMENT = "steps:\n  - echo: fragment\n";

  it("keeps the text of an uploaded member and removes its upload", async () => {
    const a = await fragmentUpload("a.yaml", (file) => fs.writeFile(file, FRAGMENT));
    const store = uploadStore({ a });

    const { fileInputs, cleanup } = await resolveFileInputs(
      { fileInputs: FLOW_SPEC },
      { flow_path: flowWire([member("a.yaml", "a", a, { size: Buffer.byteLength(FRAGMENT) })]) },
      store.lookup
    );
    cleanups.push(cleanup);

    expect(fileInputs!.flow_path!.members).toEqual({
      [flowMemberKey(FLOWS, "a.yaml")]: {
        role: "flow",
        state: "present",
        canonical: `${FLOWS}/a.yaml`,
        spelling: { state: "listed" },
        text: FRAGMENT,
      },
    });
    await expect(fs.stat(a.tarPath)).rejects.toThrow();
  });

  it("fails when the uploaded member disagrees with the size the client recorded", async () => {
    const a = await fragmentUpload("a.yaml", (file) => fs.writeFile(file, FRAGMENT));

    await expect(
      resolveFileInputs(
        { fileInputs: FLOW_SPEC },
        { flow_path: flowWire([member("a.yaml", "a", a, { size: 5 })]) },
        uploadStore({ a }).lookup
      )
    ).rejects.toThrow(`is ${Buffer.byteLength(FRAGMENT)} bytes but the client recorded 5`);
  });

  it("fails on an uploaded member over the limit without reading it", async () => {
    // Sparse, so the tar stays small while the file it holds is over the limit.
    const big = await fragmentUpload("big.yaml", async (file) => {
      await fs.writeFile(file, "");
      await fs.truncate(file, 32 * 1024 * 1024 + 1);
    });
    vi.mocked(fs.readFile).mockClear();

    await expect(
      resolveFileInputs(
        { fileInputs: FLOW_SPEC },
        { flow_path: flowWire([member("big.yaml", "big", big)]) },
        uploadStore({ big }).lookup
      )
    ).rejects.toThrow("exceeds the 33554432-byte file-input limit");
    const read = vi.mocked(fs.readFile).mock.calls.map(([file]) => String(file));
    expect(read.filter((file) => file.endsWith("big.yaml"))).toEqual([]);
  });

  it("fails once the uploaded members pass the limit together, without reading the rest", async () => {
    // Sparse, so each tar stays small while the members together pass the limit.
    const sparse = (bytes: number) => async (file: string) => {
      await fs.writeFile(file, "");
      await fs.truncate(file, bytes);
    };
    const [a, b, c] = await Promise.all([
      fragmentUpload("a.yaml", sparse(20 * 1024 * 1024)),
      fragmentUpload("b.yaml", sparse(20 * 1024 * 1024)),
      fragmentUpload("c.yaml", (file) => fs.writeFile(file, FRAGMENT)),
    ]);
    const store = uploadStore({ a: a!, b: b!, c: c! });
    // Extract dirs go to os.tmpdir(), so one that stays shows here.
    const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "argent-tar-upload-scan-"));
    const restoreTmpdir = redirectTmpdir(scratch);
    vi.mocked(fs.readFile).mockClear();

    try {
      await expect(
        resolveFileInputs(
          { fileInputs: FLOW_SPEC },
          {
            flow_path: flowWire([
              member("a.yaml", "a", a!),
              member("b.yaml", "b", b!),
              member("c.yaml", "c", c!),
            ]),
          },
          store.lookup
        )
      ).rejects.toThrow("exceeds the 33554432-byte limit for the members of one call");

      const read = vi.mocked(fs.readFile).mock.calls.map(([file]) => path.basename(String(file)));
      expect(read).toEqual(["a.yaml"]);
      expect(await fs.readdir(scratch)).toEqual([]);
      expect([...store.pending.keys()]).toEqual([]);
      for (const entry of [a!, b!, c!]) await expect(fs.stat(entry.tarPath)).rejects.toThrow();
    } finally {
      restoreTmpdir();
      await fs.rm(scratch, { recursive: true, force: true });
    }
  });

  it("fails when the upload of a member is not on the tool-server", async () => {
    const a = await fragmentUpload("a.yaml", (file) => fs.writeFile(file, FRAGMENT));

    await expect(
      resolveFileInputs(
        { fileInputs: FLOW_SPEC },
        { flow_path: flowWire([member("a.yaml", "expired", a)]) },
        uploadStore({}).lookup
      )
    ).rejects.toThrow(/Upload "expired" was not found on the tool-server/);
  });

  it("removes the uploads of the later members when one member fails", async () => {
    const write = (file: string) => fs.writeFile(file, FRAGMENT);
    const [a, b, c] = await Promise.all(
      ["a.yaml", "b.yaml", "c.yaml"].map((name) => fragmentUpload(name, write))
    );
    const store = uploadStore({ a: a!, b: b!, c: c! });

    await expect(
      resolveFileInputs(
        { fileInputs: FLOW_SPEC },
        {
          flow_path: flowWire([
            member("a.yaml", "a", a!, { contentHash: "0".repeat(64) }),
            member("b.yaml", "b", b!),
            member("c.yaml", "c", c!),
          ]),
        },
        store.lookup
      )
    ).rejects.toThrow(/content hash mismatch/i);

    expect([...store.pending.keys()]).toEqual([]);
    for (const entry of [a!, b!, c!]) await expect(fs.stat(entry.tarPath)).rejects.toThrow();
  });

  it("removes the uploads of a wire that the call does not resolve", async () => {
    // name + flow_path: the tool reports the two sources, so the closure that
    // came with flow_path is never read.
    const a = await fragmentUpload("a.yaml", (file) => fs.writeFile(file, FRAGMENT));
    const store = uploadStore({ a });

    const { args } = await resolveFileInputs(
      { fileInputs: [{ ...FLOW_SPEC[0]!, unwrapWhenSet: "name" }] },
      { name: "saved", flow_path: flowWire([member("a.yaml", "a", a)]) },
      store.lookup
    );

    expect(args.flow_path).toBe(`${FLOWS}/root.yaml`);
    expect([...store.pending.keys()]).toEqual([]);
    await expect(fs.stat(a.tarPath)).rejects.toThrow();
  });
});
