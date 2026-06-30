import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { materializeArtifacts, ARTIFACT_MARKER, type ArtifactHandle } from "../src/artifacts.js";

const h = (p: Partial<ArtifactHandle>): ArtifactHandle =>
  ({
    [ARTIFACT_MARKER]: true,
    id: "x",
    filename: "f.bin",
    mimeType: "application/octet-stream",
    size: 0,
    ...p,
  }) as ArtifactHandle;

describe("materializeArtifacts keys the download cache by unique id", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "art-collision-"));
    process.env.ARGENT_ARTIFACTS_DIR = root;
  });

  afterEach(async () => {
    delete process.env.ARGENT_ARTIFACTS_DIR;
    await rm(root, { recursive: true, force: true });
  });

  it("two same-filename artifacts keep their own content", async () => {
    const bodies: Record<string, string> = { "1": "AAA", "2": "BBBBBB" };
    const fetchImpl = (async (url: string) => {
      const id = url.split("/").pop()!;
      const buf = Buffer.from(bodies[id]!);
      return {
        ok: true,
        arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
      };
    }) as unknown as typeof fetch;

    const result = {
      a: h({ id: "1", filename: "shot.png", mimeType: "image/png", size: 3 }),
      b: h({ id: "2", filename: "shot.png", mimeType: "image/png", size: 6 }),
    };
    const out = await materializeArtifacts(result, {
      toolsUrl: "http://server",
      deviceId: "dev1",
      fetchImpl,
    });
    const r = out.result as { a: string; b: string };

    // Distinct ids must resolve to distinct local paths…
    expect(r.a).not.toBe(r.b);
    // …each holding its own downloaded bytes (filename-keyed caching collided them).
    expect(await readFile(r.a, "utf8")).toBe("AAA");
    expect(await readFile(r.b, "utf8")).toBe("BBBBBB");
  });
});
