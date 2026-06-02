import { describe, it, expect, vi, afterEach } from "vitest";
import supertest from "supertest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createHttpApp, type HttpAppHandle } from "../src/http";
import { getArtifactRegistry } from "../src/artifacts";
import type { Registry } from "@argent/registry";

vi.mock("../src/utils/update-checker", () => ({
  getUpdateState: vi.fn(() => ({
    updateAvailable: false,
    latestVersion: null,
    currentVersion: "1.0.0",
  })),
  isUpdateNoteSuppressed: vi.fn(() => true),
  suppressUpdateNote: vi.fn(),
}));

function stubRegistry(): Registry {
  return {
    getSnapshot: vi.fn(() => ({ services: new Map(), namespaces: [], tools: [] })),
    getTool: vi.fn(() => undefined),
    invokeTool: vi.fn(),
  } as unknown as Registry;
}

describe("artifact registry", () => {
  it("registers a file and infers filename, mime type, and size", async () => {
    const dir = await mkdtemp(join(tmpdir(), "artifact-reg-"));
    try {
      const filePath = join(dir, "shot.png");
      await writeFile(filePath, Buffer.from([1, 2, 3, 4]));

      const handle = await getArtifactRegistry().register(filePath);
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
      const handle = await getArtifactRegistry().register(filePath, {
        filename: "pretty.png",
        mimeType: "image/png",
      });
      expect(handle.filename).toBe("pretty.png");
      expect(handle.mimeType).toBe("image/png");
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
      const artifact = await getArtifactRegistry().register(filePath, { mimeType: "image/png" });

      handle = createHttpApp(stubRegistry());
      const res = await supertest(handle.app).get(`/artifacts/${artifact.id}`);

      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toContain("image/png");
      expect(Buffer.from(res.body)).toEqual(bytes);
    } finally {
      await rm(dir, { recursive: true, force: true });
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
    const artifact = await getArtifactRegistry().register(filePath);
    await rm(dir, { recursive: true, force: true });

    handle = createHttpApp(stubRegistry());
    const res = await supertest(handle.app).get(`/artifacts/${artifact.id}`);
    expect(res.status).toBe(410);
  });
});
