import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import supertest from "supertest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createHttpApp, type HttpAppHandle } from "../src/http";
import { ArtifactStore } from "@argent/registry";
import type { Registry } from "@argent/registry";

const isFlagEnabledMock = vi.hoisted(() => vi.fn(() => false));

// supertest/superagent doesn't buffer binary bodies (gzip) by default.
function binaryParser(res: NodeJS.ReadableStream, cb: (err: Error | null, body: Buffer) => void) {
  const chunks: Buffer[] = [];
  res.on("data", (c: Buffer) => chunks.push(Buffer.from(c)));
  res.on("end", () => cb(null, Buffer.concat(chunks)));
  res.on("error", (e: Error) => cb(e, Buffer.alloc(0)));
}

vi.mock("../src/utils/update-checker", () => ({
  getUpdateState: vi.fn(() => ({
    updateAvailable: false,
    latestVersion: null,
    currentVersion: "1.0.0",
  })),
  isUpdateNoteSuppressed: vi.fn(() => true),
  suppressUpdateNote: vi.fn(),
}));

vi.mock("@argent/configuration-core", () => ({
  isFlagEnabled: isFlagEnabledMock,
}));

// A minimal Registry carrying a real ArtifactStore — the `/artifacts/:id` route
// resolves files from `registry.artifacts`, so the test registers into the same
// store instance it hands to createHttpApp.
function stubRegistry(): Registry {
  return {
    artifacts: new ArtifactStore(),
    getSnapshot: vi.fn(() => ({ services: new Map(), namespaces: [], tools: [] })),
    getTool: vi.fn(() => undefined),
    invokeTool: vi.fn(),
  } as unknown as Registry;
}

describe("ArtifactStore", () => {
  it("registers a file and infers filename, mime type, and size", async () => {
    const dir = await mkdtemp(join(tmpdir(), "artifact-reg-"));
    try {
      const filePath = join(dir, "shot.png");
      await writeFile(filePath, Buffer.from([1, 2, 3, 4]));

      const handle = await new ArtifactStore().register(filePath);
      expect(handle.__argentArtifact).toBe(true);
      expect(handle.filename).toBe("shot.png");
      expect(handle.mimeType).toBe("image/png");
      expect(handle.size).toBe(4);
      expect(typeof handle.id).toBe("string");
      // Emitted so a co-located client can read the file directly (gate).
      expect(handle.hostPath).toBe(filePath);
      expect(typeof handle.mtimeMs).toBe("number");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("honours filename and mimeType overrides", async () => {
    const dir = await mkdtemp(join(tmpdir(), "artifact-reg-"));
    try {
      const filePath = join(dir, "raw.bin");
      await writeFile(filePath, "hi");
      const handle = await new ArtifactStore().register(filePath, {
        filename: "pretty.png",
        mimeType: "image/png",
      });
      expect(handle.filename).toBe("pretty.png");
      expect(handle.mimeType).toBe("image/png");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("marks a directory (e.g. a .trace bundle) for tar.gz delivery", async () => {
    const root = await mkdtemp(join(tmpdir(), "artifact-dir-"));
    try {
      const bundle = join(root, "session.trace");
      await mkdir(bundle, { recursive: true });
      await writeFile(join(bundle, "data.bin"), "trace");

      const handle = await new ArtifactStore().register(bundle);
      expect(handle.archive).toBe("tar.gz");
      expect(handle.filename).toBe("session.trace");
      expect(handle.hostPath).toBe(bundle);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("honours an explicit archive option when the path can't be stat'd", async () => {
    const handle = await new ArtifactStore().register("/tmp/does-not-exist-yet.trace", {
      archive: "tar.gz",
    });
    expect(handle.archive).toBe("tar.gz");
  });

  it("lists safe metadata for registered artifacts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "artifact-list-store-"));
    try {
      const filePath = join(dir, "shot.png");
      await writeFile(filePath, "png");
      const store = new ArtifactStore();
      const handle = await store.register(filePath, { mimeType: "image/png" });

      expect(store.list()).toEqual([
        {
          id: handle.id,
          filename: "shot.png",
          mimeType: "image/png",
          size: 3,
          isDirectory: false,
        },
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("GET /artifacts", () => {
  let handle: HttpAppHandle | null = null;

  beforeEach(() => {
    isFlagEnabledMock.mockReturnValue(false);
  });

  afterEach(() => {
    handle?.dispose();
    handle = null;
    isFlagEnabledMock.mockReset();
  });

  it("is hidden unless the artifact list endpoint flag is enabled", async () => {
    handle = createHttpApp(stubRegistry());
    const res = await supertest(handle.app).get("/artifacts");

    expect(res.status).toBe(404);
  });

  it("returns registered artifact metadata without host paths", async () => {
    const dir = await mkdtemp(join(tmpdir(), "artifact-list-route-"));
    try {
      const filePath = join(dir, "img.png");
      await writeFile(filePath, "image");
      const registry = stubRegistry();
      const artifact = await registry.artifacts.register(filePath, { mimeType: "image/png" });
      isFlagEnabledMock.mockReturnValue(true);

      handle = createHttpApp(registry);
      const res = await supertest(handle.app).get("/artifacts");

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        artifacts: [
          {
            id: artifact.id,
            filename: "img.png",
            mimeType: "image/png",
            size: 5,
            isDirectory: false,
          },
        ],
      });
      expect(JSON.stringify(res.body)).not.toContain(filePath);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("GET /artifacts/:id", () => {
  let handle: HttpAppHandle | null = null;

  afterEach(() => {
    handle?.dispose();
    handle = null;
  });

  it("streams a registered file with its content type", async () => {
    const dir = await mkdtemp(join(tmpdir(), "artifact-route-"));
    try {
      const filePath = join(dir, "img.png");
      const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xaa, 0xbb]);
      await writeFile(filePath, bytes);
      const registry = stubRegistry();
      const artifact = await registry.artifacts.register(filePath, { mimeType: "image/png" });

      handle = createHttpApp(registry);
      const res = await supertest(handle.app).get(`/artifacts/${artifact.id}`);

      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toContain("image/png");
      expect(Buffer.from(res.body)).toEqual(bytes);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("streams a directory bundle as a gzipped tar that unpacks to the original files", async () => {
    const root = await mkdtemp(join(tmpdir(), "artifact-bundle-"));
    try {
      const bundle = join(root, "session.trace");
      await mkdir(join(bundle, "sub"), { recursive: true });
      await writeFile(join(bundle, "top.txt"), "top");
      await writeFile(join(bundle, "sub", "nested.txt"), "nested");

      const registry = stubRegistry();
      const artifact = await registry.artifacts.register(bundle);
      handle = createHttpApp(registry);
      const res = await supertest(handle.app)
        .get(`/artifacts/${artifact.id}`)
        .buffer(true)
        .parse(binaryParser as never);

      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toContain("application/gzip");
      expect(res.headers["content-disposition"]).toContain("session.trace.tar.gz");

      // Round-trip: the gzipped tar lists the bundle's own files under its name.
      const tarball = join(root, "out.tar.gz");
      await writeFile(tarball, res.body);
      const listing = execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" });
      expect(listing).toContain("session.trace/top.txt");
      expect(listing).toContain("session.trace/sub/nested.txt");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("404s an unknown artifact id", async () => {
    handle = createHttpApp(stubRegistry());
    const res = await supertest(handle.app).get("/artifacts/does-not-exist");
    expect(res.status).toBe(404);
  });

  it("410s when the registered file has been removed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "artifact-gone-"));
    const filePath = join(dir, "gone.png");
    await writeFile(filePath, "x");
    const registry = stubRegistry();
    const artifact = await registry.artifacts.register(filePath);
    await rm(dir, { recursive: true, force: true });

    handle = createHttpApp(registry);
    const res = await supertest(handle.app).get(`/artifacts/${artifact.id}`);
    expect(res.status).toBe(410);
  });
});
