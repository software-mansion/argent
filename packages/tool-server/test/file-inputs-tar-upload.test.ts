import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { FILE_INPUT_MARKER, type FileInputSpec } from "@argent/registry";
import { resolveFileInputs } from "../src/file-inputs";

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
  it("resolves in place when the directory exists on this host", async () => {
    const appDir = await makeFakeApp();

    const { args, fileInputs } = await resolveFileInputs(
      { fileInputs: TAR_UPLOAD_SPEC },
      { appPath: wire({ path: appDir }) }
    );

    expect(args.appPath).toBe(appDir);
    expect(fileInputs!.appPath).toMatchObject({ presentOnHost: true, viaUpload: false });
  });

  it("resolves a file in place when it exists on this host", async () => {
    const apk = await makeFakeApk();

    const { args, fileInputs } = await resolveFileInputs(
      { fileInputs: TAR_UPLOAD_SPEC },
      { appPath: wire({ path: apk }) }
    );

    expect(args.appPath).toBe(apk);
    expect(fileInputs!.appPath).toMatchObject({ presentOnHost: true, viaUpload: false });
  });

  it("extracts the uploaded archive and returns the app dir path", async () => {
    const appDir = await makeFakeApp("MyApp.app");
    const tarPath = await tarApp(appDir);
    const uploadId = "test-upload-id";

    const { args, fileInputs, cleanup } = await resolveFileInputs(
      { fileInputs: TAR_UPLOAD_SPEC },
      { appPath: wire({ path: "/client/MyApp.app", uploadId }) },
      (id) => (id === uploadId ? { tarPath } : undefined)
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

    const { args, fileInputs } = await resolveFileInputs(
      { fileInputs: TAR_UPLOAD_SPEC },
      { appPath: wire({ path: "/client/app.apk", uploadId }) },
      (id) => (id === uploadId ? { tarPath } : undefined)
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

    const { args } = await resolveFileInputs(
      { fileInputs: TAR_UPLOAD_SPEC },
      { appPath: wire({ path: "/client/MyApp.app", uploadId }) },
      (id) => (id === uploadId ? { tarPath } : undefined)
    );

    const resolvedPath = args.appPath as string;
    expect(path.basename(resolvedPath)).toBe("MyApp.app");
    expect((await fs.stat(resolvedPath)).isDirectory()).toBe(true);
  });

  it("removes the original tar after extraction", async () => {
    const appDir = await makeFakeApp();
    const tarPath = await tarApp(appDir);
    const uploadId = "test-upload-id-2";

    const { cleanup } = await resolveFileInputs(
      { fileInputs: TAR_UPLOAD_SPEC },
      { appPath: wire({ path: "/client/MyApp.app", uploadId }) },
      (id) => (id === uploadId ? { tarPath } : undefined)
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

  it("fails clearly when the uploadId is not in the registry", async () => {
    await expect(
      resolveFileInputs(
        { fileInputs: TAR_UPLOAD_SPEC },
        { appPath: wire({ path: "/client/MyApp.app", uploadId: "stale-id" }) },
        () => undefined
      )
    ).rejects.toThrow(/was not found on the tool-server/);
  });
});
