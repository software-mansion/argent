import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import {
  materializeArtifacts,
  isArtifactHandle,
  getDeviceIdFromArgs,
  artifactDir,
  ARTIFACT_MARKER,
  type ArtifactHandle,
} from "../src/artifacts.js";

function handle(id: string, filename: string, mimeType: string): ArtifactHandle {
  return { [ARTIFACT_MARKER]: true, id, filename, mimeType, size: 0 };
}

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x01, 0x02];

function fakeFetch(map: Record<string, number[]>): typeof fetch {
  return (async (url: string) => {
    const id = url.split("/artifacts/")[1]!;
    const bytes = map[id];
    if (!bytes) return { ok: false, arrayBuffer: async () => new ArrayBuffer(0) };
    return { ok: true, arrayBuffer: async () => new Uint8Array(bytes).buffer };
  }) as unknown as typeof fetch;
}

describe("isArtifactHandle", () => {
  it("recognizes a handle and rejects plain objects", () => {
    expect(isArtifactHandle(handle("a", "x.png", "image/png"))).toBe(true);
    expect(isArtifactHandle({ id: "a" })).toBe(false);
    expect(isArtifactHandle(null)).toBe(false);
    expect(isArtifactHandle("string")).toBe(false);
  });
});

describe("getDeviceIdFromArgs", () => {
  it("reads udid then device_id", () => {
    expect(getDeviceIdFromArgs({ udid: "U1" })).toBe("U1");
    expect(getDeviceIdFromArgs({ device_id: "D1" })).toBe("D1");
    expect(getDeviceIdFromArgs({})).toBeUndefined();
    expect(getDeviceIdFromArgs(null)).toBeUndefined();
  });
});

describe("materializeArtifacts", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "argent-artifacts-"));
    process.env.ARGENT_ARTIFACTS_DIR = root;
  });

  afterEach(async () => {
    delete process.env.ARGENT_ARTIFACTS_DIR;
    await rm(root, { recursive: true, force: true });
  });

  it("downloads an image handle, rewrites it to a local path, and collects the image", async () => {
    const h = handle("img1", "shot.png", "image/png");
    const { result, images } = await materializeArtifacts(
      { image: h },
      { toolsUrl: "http://remote:3001", deviceId: "DEV-1", fetchImpl: fakeFetch({ img1: PNG }) }
    );

    const localPath = (result as { image: string }).image;
    expect(typeof localPath).toBe("string");
    // Lives under the structured cache: <root>/<project>/<session>/<device>/
    expect(localPath.startsWith(artifactDir("DEV-1"))).toBe(true);
    expect(localPath.endsWith("shot.png")).toBe(true);
    expect(Buffer.from(await readFile(localPath))).toEqual(Buffer.from(PNG));

    expect(images).toHaveLength(1);
    expect(images[0]!.mimeType).toBe("image/png");
    expect(images[0]!.localPath).toBe(localPath);
  });

  it("walks nested handles (e.g. exportedFiles) and leaves non-handles untouched", async () => {
    const result = {
      exportedFiles: {
        cpu: handle("cpu1", "cpu.xml", "application/xml"),
        hangs: null,
      },
      duration_ms: 1234,
    };
    const { result: out, images } = await materializeArtifacts(result, {
      toolsUrl: "http://remote:3001",
      fetchImpl: fakeFetch({ cpu1: [60, 61, 62] }),
    });

    const o = out as { exportedFiles: { cpu: string; hangs: null }; duration_ms: number };
    expect(o.duration_ms).toBe(1234);
    expect(o.exportedFiles.hangs).toBeNull();
    expect(o.exportedFiles.cpu.endsWith("cpu.xml")).toBe(true);
    // XML is not an image — no inline render.
    expect(images).toHaveLength(0);
  });

  it("rewrites a handle to null when its download fails", async () => {
    const { result } = await materializeArtifacts(
      { image: handle("missing", "x.png", "image/png") },
      { toolsUrl: "http://remote:3001", fetchImpl: fakeFetch({}) }
    );
    expect((result as { image: null }).image).toBeNull();
  });

  it("scopes the cache dir by device and omits the device segment when absent", () => {
    expect(artifactDir("DEV-9").endsWith("DEV-9")).toBe(true);
    expect(artifactDir()).not.toContain("undefined");
  });
});
