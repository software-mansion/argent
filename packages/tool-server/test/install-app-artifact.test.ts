import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { ClientRequest, IncomingMessage, RequestOptions } from "node:http";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { PassThrough } from "node:stream";
import { extractZipArchive } from "@argent/archive";
import { getFailureSignal } from "@argent/registry";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { httpsRequest, lookup } = vi.hoisted(() => ({
  httpsRequest: vi.fn(),
  lookup: vi.fn(),
}));
vi.mock("node:dns/promises", () => ({ lookup }));
vi.mock("node:https", () => ({ request: httpsRequest }));

import { installAppTool } from "../src/tools/install-app";
import {
  prepareAndroidRemoteArtifact,
  prepareIosRemoteArtifact,
} from "../src/tools/install-app/artifact";
import { downloadAppArtifact } from "../src/tools/install-app/download";
import { resolveAndroidPackageName } from "../src/tools/install-app/android-manifest";
import { resolveIosBundleId } from "../src/tools/install-app/ios-bundle";

let fixtureRoot: string;

beforeEach(async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), "argent-install-app-test-"));
  lookup.mockReset();
  lookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
  httpsRequest.mockReset();
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

function makeBinaryAndroidManifest(packageName: string): Buffer {
  const values = ["manifest", "package", packageName];
  const encoded = values.map((value) => {
    const bytes = Buffer.from(value, "utf8");
    return Buffer.concat([Buffer.from([value.length, bytes.length]), bytes, Buffer.from([0])]);
  });
  const stringOffsets: number[] = [];
  let stringDataLength = 0;
  for (const value of encoded) {
    stringOffsets.push(stringDataLength);
    stringDataLength += value.length;
  }
  const paddedLength = (stringDataLength + 3) & ~3;
  const stringPool = Buffer.alloc(28 + values.length * 4 + paddedLength);
  stringPool.writeUInt16LE(0x0001, 0);
  stringPool.writeUInt16LE(28, 2);
  stringPool.writeUInt32LE(stringPool.length, 4);
  stringPool.writeUInt32LE(values.length, 8);
  stringPool.writeUInt32LE(0x100, 16);
  stringPool.writeUInt32LE(28 + values.length * 4, 20);
  let dataOffset = 28 + values.length * 4;
  for (let index = 0; index < values.length; index += 1) {
    stringPool.writeUInt32LE(stringOffsets[index]!, 28 + index * 4);
    encoded[index]!.copy(stringPool, dataOffset);
    dataOffset += encoded[index]!.length;
  }

  const startElement = Buffer.alloc(56);
  startElement.writeUInt16LE(0x0102, 0);
  startElement.writeUInt16LE(16, 2);
  startElement.writeUInt32LE(startElement.length, 4);
  startElement.writeUInt32LE(1, 8);
  startElement.writeUInt32LE(0xffffffff, 12);
  startElement.writeUInt32LE(0xffffffff, 16);
  startElement.writeUInt32LE(0, 20);
  startElement.writeUInt16LE(20, 24);
  startElement.writeUInt16LE(20, 26);
  startElement.writeUInt16LE(1, 28);
  startElement.writeUInt32LE(0xffffffff, 36);
  startElement.writeUInt32LE(1, 40);
  startElement.writeUInt32LE(2, 44);
  startElement.writeUInt16LE(8, 48);
  startElement.writeUInt8(0x03, 51);
  startElement.writeUInt32LE(2, 52);

  const document = Buffer.alloc(8);
  document.writeUInt16LE(0x0003, 0);
  document.writeUInt16LE(8, 2);
  document.writeUInt32LE(document.length + stringPool.length + startElement.length, 4);
  return Buffer.concat([document, stringPool, startElement]);
}

async function makeBinaryManifestApk(name: string, packageName: string): Promise<string> {
  const sourceDir = join(fixtureRoot, `${name}-binary-source`);
  const apkPath = join(fixtureRoot, `${name}.apk`);
  await mkdir(sourceDir);
  await writeFile(join(sourceDir, "AndroidManifest.xml"), makeBinaryAndroidManifest(packageName));
  execFileSync("zip", ["-q", apkPath, "AndroidManifest.xml"], { cwd: sourceDir });
  return apkPath;
}

interface MockResponseOptions {
  status?: number;
  statusMessage?: string;
  headers?: Record<string, string>;
  observeRequest?: (options: RequestOptions) => void;
  observeResponse?: (response: IncomingMessage) => void;
}

function mockHttpsResponse(bytes: Buffer, options: MockResponseOptions = {}): void {
  httpsRequest.mockImplementationOnce(
    (_url: URL, requestOptions: RequestOptions, callback: (response: IncomingMessage) => void) => {
      options.observeRequest?.(requestOptions);
      const request = new EventEmitter() as ClientRequest;
      request.end = (() => {
        queueMicrotask(() => {
          const stream = new PassThrough();
          const response = stream as unknown as IncomingMessage;
          response.statusCode = options.status ?? 200;
          response.statusMessage = options.statusMessage ?? "OK";
          response.headers = options.headers ?? {};
          options.observeResponse?.(response);
          callback(response);
          stream.end(bytes);
        });
        return request;
      }) as ClientRequest["end"];
      return request;
    }
  );
}

function mockArtifactDownload(
  bytes: Buffer,
  filename: string,
  contentType = "application/zip"
): void {
  mockHttpsResponse(bytes, {
    headers: {
      "content-disposition": `attachment; filename="${filename}"`,
      "content-type": contentType,
      "content-length": String(bytes.byteLength),
    },
  });
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
  it("resolves the package name from a real-format binary AndroidManifest", async () => {
    const apkPath = await makeBinaryManifestApk("binary-manifest", "com.example.binarymanifest");
    await expect(resolveAndroidPackageName(apkPath)).resolves.toBe("com.example.binarymanifest");
  });

  it("resolves a binary Info.plist without relying on macOS plutil", async () => {
    const appDir = join(fixtureRoot, "Binary.app");
    await mkdir(appDir);
    await writeFile(
      join(appDir, "Info.plist"),
      Buffer.from(
        "YnBsaXN0MDDSAQIDBF8QEkNGQnVuZGxlRXhlY3V0YWJsZV8QEkNGQnVuZGxlSWRlbnRpZmllclREZW1vXxASY29tLmV4YW1wbGUuYmluYXJ5CA0iNzwAAAAAAAABAQAAAAAAAAAFAAAAAAAAAAAAAAAAAAAAUQ==",
        "base64"
      )
    );
    await expect(resolveIosBundleId(appDir)).resolves.toBe("com.example.binary");
  });

  it("downloads a direct APK and resolves its package name", async () => {
    const apkPath = await makeApk("direct", "com.example.direct");
    mockArtifactDownload(
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
    execFileSync("zip", ["-q", zipPath, basename(apkPath)], { cwd: fixtureRoot });
    mockArtifactDownload(await readFile(zipPath), "artifact.zip");

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
    execFileSync("zip", ["-q", zipPath, basename(tarPath)], { cwd: fixtureRoot });
    mockArtifactDownload(await readFile(zipPath), "artifact.zip");

    const artifact = await prepareIosRemoteArtifact({
      udid: "00000000-0000-0000-0000-000000000000",
      url: "https://api.github.com/repos/example/app/actions/artifacts/456/zip",
    });
    expect(artifact.bundleId).toBe("com.example.remoteios");
    expect(artifact.installablePath).toMatch(/Demo\.app$/);
    await artifact.cleanup();
  });

  it("accepts a multi-entry tarball containing an app plus its dSYM", async () => {
    const payloadDir = join(fixtureRoot, "multi-payload");
    const appDir = join(payloadDir, "Multi.app");
    const dsymDir = join(payloadDir, "Multi.app.dSYM");
    await mkdir(appDir, { recursive: true });
    await mkdir(dsymDir, { recursive: true });
    await writeFile(
      join(appDir, "Info.plist"),
      "<plist><dict><key>CFBundleIdentifier</key><string>com.example.multi</string></dict></plist>"
    );
    await writeFile(join(dsymDir, "symbols"), "debug symbols");
    const tarPath = join(fixtureRoot, "multi.tar.gz");
    execFileSync("tar", ["-czf", tarPath, "-C", payloadDir, "Multi.app", "Multi.app.dSYM"]);
    mockArtifactDownload(await readFile(tarPath), "multi.tar.gz", "application/gzip");

    const artifact = await prepareIosRemoteArtifact({
      udid: "00000000-0000-0000-0000-000000000000",
      url: "https://example.com/multi.tar.gz",
    });
    expect(artifact.bundleId).toBe("com.example.multi");
    expect(artifact.installablePath).toMatch(/Multi\.app$/);
    await artifact.cleanup();
  });
});

describe("remote download boundary", () => {
  it("rejects redirects to private-network destinations before fetching them", async () => {
    mockHttpsResponse(Buffer.alloc(0), {
      status: 302,
      headers: { location: "http://127.0.0.1/app.apk" },
    });

    await expect(downloadAppArtifact("https://example.com/app.apk", undefined)).rejects.toThrow(
      /private|reserved|local/i
    );
    expect(httpsRequest).toHaveBeenCalledTimes(1);
  });

  it("does not forward any caller header to a different redirect origin", async () => {
    const observedHeaders: Array<Record<string, string>> = [];
    mockHttpsResponse(Buffer.alloc(0), {
      status: 302,
      headers: { location: "https://downloads.example.net/app.apk" },
      observeRequest: (options) => observedHeaders.push(options.headers as Record<string, string>),
    });
    mockHttpsResponse(Buffer.from("not-an-apk"), {
      headers: { "content-type": "application/vnd.android.package-archive" },
      observeRequest: (options) => observedHeaders.push(options.headers as Record<string, string>),
    });

    const downloaded = await downloadAppArtifact("https://example.com/app.apk", {
      "Authorization": "Bearer secret",
      "PRIVATE-TOKEN": "custom-secret",
      "X-Build": "123",
    });
    await downloaded.cleanup();
    expect(observedHeaders[0]).toMatchObject({
      "authorization": "Bearer secret",
      "private-token": "custom-secret",
      "x-build": "123",
    });
    expect(observedHeaders[1]).toEqual({});
  });

  it("pins the request socket to the address returned by validation DNS", async () => {
    let connectedAddress: string | undefined;
    let connectedFamily: number | undefined;
    mockHttpsResponse(Buffer.from("payload"), {
      observeRequest: (options) => {
        options.lookup?.("example.com", { family: 4 }, (error, address, family) => {
          expect(error).toBeNull();
          connectedAddress = typeof address === "string" ? address : address[0]?.address;
          connectedFamily =
            typeof family === "number"
              ? family
              : typeof address === "string"
                ? undefined
                : address[0]?.family;
        });
      },
    });

    const downloaded = await downloadAppArtifact("https://example.com/app.apk", undefined);
    await downloaded.cleanup();
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(connectedAddress).toBe("93.184.216.34");
    expect(connectedFamily).toBe(4);
  });

  it("destroys redirect bodies instead of leaving their connections pinned", async () => {
    let redirectResponse: IncomingMessage | undefined;
    mockHttpsResponse(Buffer.from("redirect-body"), {
      status: 302,
      headers: { location: "https://example.com/final.apk" },
      observeResponse: (response) => {
        redirectResponse = response;
      },
    });
    mockHttpsResponse(Buffer.from("payload"));

    const downloaded = await downloadAppArtifact("https://example.com/app.apk", undefined);
    await downloaded.cleanup();
    expect(redirectResponse?.destroyed).toBe(true);
  });

  it("does not classify caller cancellation as a timeout", async () => {
    const controller = new AbortController();
    controller.abort();
    try {
      await downloadAppArtifact("https://example.com/app.apk", undefined, controller.signal);
      expect.unreachable("download should have been canceled");
    } catch (error) {
      expect(getFailureSignal(error)).toMatchObject({
        error_kind: "network",
        network_failure: "other",
      });
    }
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
