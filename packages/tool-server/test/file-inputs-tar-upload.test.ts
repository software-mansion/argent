import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { FILE_INPUT_MARKER, type FileInputSpec } from "@argent/registry";
import { resolveFileInputs, type UploadEntry } from "../src/file-inputs";

const execFileAsync = promisify(execFile);

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "tar-dir-test-"));
});

afterEach(async () => {
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
    ).rejects.toThrow(/no upload was provided/);
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

    const { args } = await resolveFileInputs(
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

    const { args, fileInputs } = await resolveFileInputs(
      { fileInputs: TAR_UPLOAD_SPEC },
      { appPath: wireUpload("/client/app.apk", uploadId, entry) },
      (id) => (id === uploadId ? entry : undefined)
    );

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

    const { args } = await resolveFileInputs(
      { fileInputs: TAR_UPLOAD_SPEC },
      { appPath: wireUpload("/client/MyApp.app", uploadId, entry) },
      (id) => (id === uploadId ? entry : undefined)
    );

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

    // tar should already be removed by resolveOne after extraction
    await expect(fs.stat(tarPath)).rejects.toThrow();
    await cleanup();
  });

  it("fails with guidance when remote but no uploadId provided", async () => {
    const ghost = path.join(tmpDir, "NotHere.app");

    await expect(
      resolveFileInputs(
        { fileInputs: TAR_UPLOAD_SPEC },
        { appPath: wire({ path: ghost }) },
        () => undefined
      )
    ).rejects.toThrow(/no upload was provided/);
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
  });

  it("refuses to extract archives with path-traversal members", async () => {
    const tarPath = path.join(tmpDir, "malicious.tar.gz");
    const innocent = path.join(tmpDir, "innocent.txt");
    await fs.writeFile(innocent, "pwned");
    // BSD/GNU tar: rewrite member names to climb out of the extract dir.
    await execFileAsync("tar", ["-czf", tarPath, "-s", ",^,../../,", "-C", tmpDir, "innocent.txt"]);
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
