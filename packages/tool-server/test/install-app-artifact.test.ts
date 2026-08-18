import { execFileSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { lookup } = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup }));

import { installAppTool } from "../src/tools/install-app";
import {
  prepareAndroidRemoteArtifact,
  prepareIosRemoteArtifact,
} from "../src/tools/install-app/artifact";
import { downloadAppArtifact } from "../src/tools/install-app/download";
import { extractZipArchive } from "../src/tools/install-app/zip";

let fixtureRoot: string;

beforeEach(async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), "argent-install-app-test-"));
  lookup.mockReset();
  lookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(fixtureRoot, { recursive: true, force: true });
});

async function makeApk(name: string, packageName: string): Promise<string> {
  const sourceDir = join(fixtureRoot, `${name}-source`);
  const apkPath = join(fixtureRoot, `${name}.apk`);
  await mkdir(sourceDir);
  await writeFile(
    join(sourceDir, "AndroidManifest.xml"),
    `<manifest package="${packageName}" xmlns:android="http://schemas.android.com/apk/res/android" />`
  );
  execFileSync("zip", ["-q", apkPath, "AndroidManifest.xml"], { cwd: sourceDir });
  return apkPath;
}

function mockArtifactFetch(bytes: Buffer, filename: string, contentType = "application/zip"): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(bytes, {
          status: 200,
          headers: {
            "content-disposition": `attachment; filename="${filename}"`,
            "content-type": contentType,
            "content-length": String(bytes.byteLength),
          },
        })
    )
  );
}

describe("install-app schema", () => {
  it("accepts an HTTP artifact URL and optional headers", () => {
    expect(
      installAppTool.zodSchema!.safeParse({
        udid: "emulator-5554",
        url: "https://example.com/app.apk",
        headers: { Authorization: "Bearer token" },
      }).success
    ).toBe(true);
  });

  it("rejects empty device ids and non-HTTP sources", () => {
    expect(
      installAppTool.zodSchema!.safeParse({ udid: "", url: "https://example.com/app.apk" }).success
    ).toBe(false);
    expect(
      installAppTool.zodSchema!.safeParse({
        udid: "emulator-5554",
        url: "file:///tmp/app.apk",
      }).success
    ).toBe(false);
  });
});

describe("remote app artifact materialization", () => {
  it("downloads a direct APK and resolves its package name", async () => {
    const apkPath = await makeApk("direct", "com.example.direct");
    mockArtifactFetch(
      await readFile(apkPath),
      "direct.apk",
      "application/vnd.android.package-archive"
    );

    const artifact = await prepareAndroidRemoteArtifact({
      udid: "emulator-5554",
      url: "https://example.com/direct.apk",
    });
    expect(artifact.bundleId).toBe("com.example.direct");
    await expect(access(artifact.installablePath)).resolves.toBeUndefined();
    await artifact.cleanup();
    await expect(access(artifact.installablePath)).rejects.toThrow();
  });

  it("extracts a GitHub-style ZIP containing exactly one APK", async () => {
    const apkPath = await makeApk("nested", "com.example.nested");
    const zipPath = join(fixtureRoot, "github-artifact.zip");
    execFileSync("zip", ["-q", zipPath, apkPath]);
    mockArtifactFetch(await readFile(zipPath), "artifact.zip");

    const artifact = await prepareAndroidRemoteArtifact({
      udid: "emulator-5554",
      url: "https://api.github.com/repos/example/app/actions/artifacts/123/zip",
    });
    expect(artifact.bundleId).toBe("com.example.nested");
    expect(artifact.installablePath).toMatch(/nested\.apk$/);
    await artifact.cleanup();
  });

  it("extracts a GitHub ZIP containing a nested iOS .app tarball", async () => {
    const payloadDir = join(fixtureRoot, "payload");
    const appDir = join(payloadDir, "Demo.app");
    await mkdir(appDir, { recursive: true });
    await writeFile(
      join(appDir, "Info.plist"),
      `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>com.example.remoteios</string>
</dict></plist>`
    );
    const tarPath = join(fixtureRoot, "Demo.app.tar.gz");
    execFileSync("tar", ["-czf", tarPath, "-C", payloadDir, "Demo.app"]);
    const zipPath = join(fixtureRoot, "ios-artifact.zip");
    execFileSync("zip", ["-q", zipPath, tarPath]);
    mockArtifactFetch(await readFile(zipPath), "artifact.zip");

    const artifact = await prepareIosRemoteArtifact({
      udid: "00000000-0000-0000-0000-000000000000",
      url: "https://api.github.com/repos/example/app/actions/artifacts/456/zip",
    });
    expect(artifact.bundleId).toBe("com.example.remoteios");
    expect(artifact.installablePath).toMatch(/Demo\.app$/);
    await artifact.cleanup();
  });
});

describe("remote download boundary", () => {
  it("rejects redirects to private-network destinations before fetching them", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(null, { status: 302, headers: { location: "http://127.0.0.1/app.apk" } })
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(downloadAppArtifact("https://example.com/app.apk", undefined)).rejects.toThrow(
      /private|loopback/i
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not forward authorization to a different redirect origin", async () => {
    const observedHeaders: Array<Headers> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: URL, init?: RequestInit) => {
        observedHeaders.push(new Headers(init?.headers));
        if (observedHeaders.length === 1) {
          return new Response(null, {
            status: 302,
            headers: { location: "https://downloads.example.net/app.apk" },
          });
        }
        return new Response(Buffer.from("not-an-apk"), {
          status: 200,
          headers: { "content-type": "application/vnd.android.package-archive" },
        });
      })
    );

    const downloaded = await downloadAppArtifact("https://example.com/app.apk", {
      "Authorization": "Bearer secret",
      "X-Build": "123",
    });
    await downloaded.cleanup();
    expect(observedHeaders[0]?.get("authorization")).toBe("Bearer secret");
    expect(observedHeaders[1]?.get("authorization")).toBeNull();
    expect(observedHeaders[1]?.get("x-build")).toBe("123");
  });
});

describe("app archive extraction", () => {
  it("rejects ZIP path traversal before writing outside the extraction root", async () => {
    const zipSource = join(fixtureRoot, "zip-source");
    const safeZip = join(fixtureRoot, "safe.zip");
    const maliciousZip = join(fixtureRoot, "malicious.zip");
    const outputDir = join(fixtureRoot, "output");
    await mkdir(zipSource);
    await mkdir(outputDir);
    await writeFile(join(zipSource, "safe.txt"), "payload");
    execFileSync("zip", ["-q", safeZip, "safe.txt"], { cwd: zipSource });
    const bytes = await readFile(safeZip);
    // The local and central headers both carry the same eight-byte filename.
    // Replacing it in-place keeps the ZIP structurally valid while making the
    // path malicious; extraction must reject it before creating any output.
    const malicious = Buffer.from(
      bytes.toString("binary").replaceAll("safe.txt", "../x.txt"),
      "binary"
    );
    await writeFile(maliciousZip, malicious);

    await expect(extractZipArchive(maliciousZip, outputDir)).rejects.toThrow(/unsafe path/i);
    await expect(access(join(fixtureRoot, "x.txt"))).rejects.toThrow();
  });
});
