import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, rm, readFile, writeFile, stat } from "node:fs/promises";
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

// ── gate: local short-circuit (co-located tool-server) ───────────────

describe("materializeArtifacts local short-circuit", () => {
  let root: string;
  let hostDir: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "argent-artifacts-"));
    hostDir = await mkdtemp(join(tmpdir(), "argent-host-"));
    process.env.ARGENT_ARTIFACTS_DIR = root;
  });

  afterEach(async () => {
    delete process.env.ARGENT_ARTIFACTS_DIR;
    await rm(root, { recursive: true, force: true });
    await rm(hostDir, { recursive: true, force: true });
  });

  // Writes a real file and returns a handle pointing at it with matching
  // integrity metadata — i.e. what a co-located tool-server would emit.
  async function localFileHandle(
    id: string,
    filename: string,
    mimeType: string,
    bytes: number[]
  ): Promise<ArtifactHandle> {
    const hostPath = join(hostDir, filename);
    await writeFile(hostPath, Buffer.from(bytes));
    const st = await stat(hostPath);
    return {
      [ARTIFACT_MARKER]: true,
      id,
      filename,
      mimeType,
      size: st.size,
      hostPath,
      mtimeMs: st.mtimeMs,
    };
  }

  const throwingFetch: typeof fetch = (async () => {
    throw new Error("fetch must not be called when the file is already local");
  }) as unknown as typeof fetch;

  it("uses hostPath directly without downloading and reads image bytes in place", async () => {
    const h = await localFileHandle("img1", "shot.png", "image/png", PNG);
    const { result, images } = await materializeArtifacts(
      { image: h },
      { toolsUrl: "http://localhost:3001", deviceId: "DEV-1", fetchImpl: throwingFetch }
    );

    // Resolved to the original host path — no copy under the temp cache.
    expect((result as { image: string }).image).toBe(h.hostPath);
    expect((result as { image: string }).image.startsWith(artifactDir("DEV-1"))).toBe(false);

    expect(images).toHaveLength(1);
    expect(images[0]!.localPath).toBe(h.hostPath);
    expect(images[0]!.data).toEqual(Buffer.from(PNG));
  });

  it("uses hostPath for non-image artifacts without reading or copying", async () => {
    const h = await localFileHandle("cpu1", "cpu.xml", "application/xml", [60, 61, 62]);
    const { result, images } = await materializeArtifacts(
      { exportedFiles: { cpu: h } },
      { toolsUrl: "http://localhost:3001", fetchImpl: throwingFetch }
    );
    expect((result as { exportedFiles: { cpu: string } }).exportedFiles.cpu).toBe(h.hostPath);
    expect(images).toHaveLength(0);
  });

  it("falls back to download when the recorded size no longer matches", async () => {
    const h = await localFileHandle("img2", "shot.png", "image/png", PNG);
    const stale = { ...h, size: h.size + 1 }; // file changed since registration
    const { result, images } = await materializeArtifacts(
      { image: stale },
      { toolsUrl: "http://remote:3001", fetchImpl: fakeFetch({ img2: PNG }) }
    );

    const out = (result as { image: string }).image;
    expect(out).not.toBe(h.hostPath);
    expect(out.startsWith(artifactDir())).toBe(true); // downloaded into the temp cache
    expect(Buffer.from(await readFile(out))).toEqual(Buffer.from(PNG));
    expect(images).toHaveLength(1);
  });

  it("falls back to download when hostPath does not exist locally (remote host)", async () => {
    const h: ArtifactHandle = {
      [ARTIFACT_MARKER]: true,
      id: "img3",
      filename: "shot.png",
      mimeType: "image/png",
      size: PNG.length,
      hostPath: join(hostDir, "does-not-exist.png"),
      mtimeMs: 123,
    };
    const { result } = await materializeArtifacts(
      { image: h },
      { toolsUrl: "http://remote:3001", fetchImpl: fakeFetch({ img3: PNG }) }
    );
    expect((result as { image: string }).image.startsWith(artifactDir())).toBe(true);
  });
});
