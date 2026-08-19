import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";

// A durable write that dies part-way is the one filesystem failure the rest of
// the suite cannot stage: it needs the destination to accept the create and
// then refuse the bytes, which is what a full disk or a file-size limit does.
// Mocked at the module boundary — the real `writeFile` still runs, so the
// partial file it leaves behind is a real one.
const durableFailures: string[] = [];
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    default: actual,
    writeFile: vi.fn(async (p: unknown, data: unknown, opts: unknown) => {
      if (typeof p === "string" && durableFailures.some((d) => p.startsWith(d))) {
        // Create the file and write what "fits", then fail like the disk did.
        await actual.writeFile(p, Buffer.alloc(4), { flag: "wx" });
        throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
      }
      return actual.writeFile(p as string, data as Buffer, opts as never);
    }),
  };
});

const { mkdtemp, mkdir, rm, readdir, writeFile: realWriteFile } = await import("node:fs/promises");
import type { ArtifactHandle } from "../src/artifacts.js";
const { materializeArtifacts, ARTIFACT_MARKER } = await import("../src/artifacts.js");

const MP4 = [0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70];

function fakeFetch(map: Record<string, number[]>): typeof fetch {
  return (async (url: string) => {
    const id = url.split("/artifacts/")[1]!;
    const bytes = map[id];
    if (!bytes) return new Response(null, { status: 404 });
    return new Response(new Uint8Array(bytes), { status: 200 });
  }) as unknown as typeof fetch;
}

describe("a durable write that fails part-way", () => {
  let projectRoot: string;
  let cwdSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "argent-partial-"));
    await realWriteFile(join(projectRoot, "package.json"), "{}");
    cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(projectRoot);
    durableFailures.length = 0;
  });

  afterEach(async () => {
    cwdSpy.mockRestore();
    await rm(projectRoot, { recursive: true, force: true });
  });

  it("leaves no truncated file holding the artifact's canonical name", async () => {
    // Left in place, the corpse keeps that name for good: it is unreadable, and
    // every later capture of the same name is pushed to `name (2).ext` by the
    // exclusive write. So the failed candidate is removed before the error
    // propagates.
    const dir = join(projectRoot, ".argent/recordings");
    await mkdir(dir, { recursive: true });
    durableFailures.push(dir);

    const h: ArtifactHandle = {
      [ARTIFACT_MARKER]: true,
      id: "nospc",
      filename: "clip.mp4",
      mimeType: "video/mp4",
      size: MP4.length,
      hostPath: "/nonexistent/remote-only.mp4",
      saveDir: ".argent/recordings",
    };
    const { result } = await materializeArtifacts(
      { video: h },
      { toolsUrl: "http://remote:3001", fetchImpl: fakeFetch({ nospc: MP4 }) }
    );

    expect(await readdir(dir)).toEqual([]);
    // The destination failed, not the bytes, so the artifact still arrives —
    // from the disposable cache, outside the project.
    const video = (result as { video: string }).video;
    expect(video.startsWith(projectRoot)).toBe(false);
  });

  it("keeps the canonical name free for the next capture", async () => {
    // The consequence the cleanup exists for: after a failed write, a healthy
    // capture of the same name must land ON the canonical name, not beside it.
    const dir = join(projectRoot, ".argent/recordings");
    await mkdir(dir, { recursive: true });
    durableFailures.push(dir);

    const handleFor = (id: string): ArtifactHandle => ({
      [ARTIFACT_MARKER]: true,
      id,
      filename: "clip.mp4",
      mimeType: "video/mp4",
      size: MP4.length,
      hostPath: "/nonexistent/remote-only.mp4",
      saveDir: ".argent/recordings",
    });

    await materializeArtifacts(
      { video: handleFor("first") },
      { toolsUrl: "http://remote:3001", fetchImpl: fakeFetch({ first: MP4 }) }
    );
    durableFailures.length = 0; // disk has room again
    const { result } = await materializeArtifacts(
      { video: handleFor("second") },
      { toolsUrl: "http://remote:3001", fetchImpl: fakeFetch({ second: MP4 }) }
    );

    expect((result as { video: string }).video).toBe(join(dir, "clip.mp4"));
    expect(await readdir(dir)).toEqual(["clip.mp4"]);
  });
});
