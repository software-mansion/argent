import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { ArtifactHandle } from "../src/artifacts.js";
import { materializeArtifacts, ARTIFACT_MARKER } from "../src/artifacts.js";

/**
 * The durable path checks `size` before it downloads, precisely so a hostile
 * `argent link` server cannot stream an unbounded body into client memory. The
 * temp-cache path below it has no such cap — it reads the whole response with
 * `arrayBuffer()` — so a durable artifact must never fall through to it because
 * its *download* failed. Only an unusable destination may degrade that way.
 *
 * That makes a failed fetch the interesting case: a server that can make one
 * request fail gets a second, uncapped read of the same artifact for free.
 */
describe("a durable artifact whose download fails", () => {
  let projectRoot: string;
  let cwdSpy: ReturnType<typeof vi.spyOn>;

  const handle = (size: number): ArtifactHandle =>
    ({
      [ARTIFACT_MARKER]: true,
      id: "shot-1",
      filename: "screen.png",
      mimeType: "image/png",
      size,
      saveDir: ".argent/screenshots",
    }) as unknown as ArtifactHandle;

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "argent-dl-fail-"));
    await writeFile(join(projectRoot, "package.json"), "{}");
    cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(projectRoot);
  });

  afterEach(async () => {
    cwdSpy.mockRestore();
    await rm(projectRoot, { recursive: true, force: true });
  });

  it("does not re-fetch uncapped after the capped fetch rejects", async () => {
    // The server refuses the durable request outright, then serves a body far
    // larger than the size it declared. Retrying is what hands it the uncapped
    // read; the declared 64 bytes never bounded anything.
    const huge = new Uint8Array(4 * 1024 * 1024);
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      if (calls === 1) throw new Error("socket hang up");
      return new Response(huge, { status: 200 });
    }) as unknown as typeof fetch;

    const out = await materializeArtifacts(
      { image: handle(64) },
      { toolsUrl: "http://127.0.0.1:1/", fetchImpl }
    );

    expect(calls).toBe(1);
    expect((out.result as { image: unknown }).image).toBeNull();
    expect(out.images).toHaveLength(0);
  });

  it("does not re-fetch uncapped when the response body errors mid-stream", async () => {
    // Same hand-back, reached the other way: the headers are fine and the cap is
    // armed, then the stream breaks. `readCapped` rejects, and treating that as
    // a destination problem sends the retry down the uncapped path.
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      if (calls === 1) {
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(8));
              controller.error(new Error("stream reset"));
            },
          }),
          { status: 200 }
        );
      }
      return new Response(new Uint8Array(4 * 1024 * 1024), { status: 200 });
    }) as unknown as typeof fetch;

    const out = await materializeArtifacts(
      { image: handle(64) },
      { toolsUrl: "http://127.0.0.1:1/", fetchImpl }
    );

    expect(calls).toBe(1);
    expect((out.result as { image: unknown }).image).toBeNull();
  });

  it("still degrades to the temp cache when only the destination is unusable", async () => {
    // The other half of the contract: the bytes were fine, so an unwritable
    // durable directory must cost a shorter-lived file, not the file itself.
    // `.argent/screenshots` is occupied by a regular file, so `mkdir` fails.
    await writeFile(join(projectRoot, ".argent"), "not a directory");

    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response(png, { status: 200 });
    }) as unknown as typeof fetch;

    const out = await materializeArtifacts(
      { image: handle(png.length) },
      { toolsUrl: "http://127.0.0.1:1/", fetchImpl }
    );

    const path = (out.result as { image: string }).image;
    expect(typeof path).toBe("string");
    expect(path).not.toContain(".argent");
    expect(calls).toBeGreaterThan(0);
    expect(out.images).toHaveLength(1);
  });
});
