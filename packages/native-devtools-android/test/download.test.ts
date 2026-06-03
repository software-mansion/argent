import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fsp } from "node:fs";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  downloadTraceProcessor,
  resolveReleaseTag,
  traceProcessorCachePath,
} from "../src/index";

const VERSION = "v0.0.0-test";
const PLATFORM = "linux-amd64";

// A plausible binary: ≥1 MB and starting with the ELF magic.
function elfBuffer(size = 1024 * 1024 + 16): Buffer {
  const buf = Buffer.alloc(size, 0x00);
  buf[0] = 0x7f;
  buf[1] = 0x45; // E
  buf[2] = 0x4c; // L
  buf[3] = 0x46; // F
  return buf;
}

function webStreamFrom(buf: Buffer): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(buf));
      controller.close();
    },
  });
}

function fakeResponse(buf: Buffer | null, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    body: buf ? webStreamFrom(buf) : null,
    headers: {
      get: (k: string) =>
        k.toLowerCase() === "content-length" && buf ? String(buf.length) : null,
    },
  } as unknown as Response;
}

describe("downloadTraceProcessor", () => {
  let savedHome: string | undefined;
  let savedUrl: string | undefined;
  let home: string;

  beforeEach(async () => {
    savedHome = process.env.HOME;
    savedUrl = process.env.ARGENT_TRACE_PROCESSOR_URL;
    home = await fsp.mkdtemp(path.join(os.tmpdir(), "tp-home-"));
    // os.homedir() reads $HOME on POSIX → redirect the ~/.argent cache here.
    process.env.HOME = home;
    process.env.ARGENT_TRACE_PROCESSOR_URL = "https://example.test/trace_processor_shell";
  });

  afterEach(async () => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedUrl === undefined) delete process.env.ARGENT_TRACE_PROCESSOR_URL;
    else process.env.ARGENT_TRACE_PROCESSOR_URL = savedUrl;
    vi.unstubAllGlobals();
    await fsp.rm(home, { recursive: true, force: true });
  });

  it("downloads, chmods 0o755, and atomically lands the binary in the cache", async () => {
    const fetchMock = vi.fn().mockResolvedValue(fakeResponse(elfBuffer()));
    vi.stubGlobal("fetch", fetchMock);

    const result = await downloadTraceProcessor({ platform: PLATFORM, version: VERSION });

    const expectedPath = traceProcessorCachePath(VERSION, PLATFORM);
    expect(result.fromCache).toBe(false);
    expect(result.path).toBe(expectedPath);
    expect(fs.existsSync(expectedPath)).toBe(true);
    expect(fs.statSync(expectedPath).mode & 0o777).toBe(0o755);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // No leftover temp files in the cache dir.
    const dir = path.dirname(expectedPath);
    expect(fs.readdirSync(dir)).toEqual(["trace_processor_shell"]);
  });

  it("is idempotent — a second call hits the cache without re-fetching", async () => {
    const fetchMock = vi.fn().mockResolvedValue(fakeResponse(elfBuffer()));
    vi.stubGlobal("fetch", fetchMock);

    await downloadTraceProcessor({ platform: PLATFORM, version: VERSION });
    const second = await downloadTraceProcessor({ platform: PLATFORM, version: VERSION });

    expect(second.fromCache).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a non-binary (HTML 404 body) and leaves no file at the cache path", async () => {
    // ≥1 MB so it clears the size floor and exercises the magic-byte check.
    const html = Buffer.alloc(1024 * 1024 + 16, 0x3c); // '<' repeated
    const fetchMock = vi.fn().mockResolvedValue(fakeResponse(html));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      downloadTraceProcessor({ platform: PLATFORM, version: VERSION })
    ).rejects.toThrow();

    expect(fs.existsSync(traceProcessorCachePath(VERSION, PLATFORM))).toBe(false);
  }, 15_000);

  it("fails fast on a 404 without retrying", async () => {
    const fetchMock = vi.fn().mockResolvedValue(fakeResponse(null, 404));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      downloadTraceProcessor({ platform: PLATFORM, version: VERSION })
    ).rejects.toThrow();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(traceProcessorCachePath(VERSION, PLATFORM))).toBe(false);
  });
});

describe("resolveReleaseTag", () => {
  let savedTag: string | undefined;

  beforeEach(() => {
    savedTag = process.env.ARGENT_TRACE_PROCESSOR_TAG;
    delete process.env.ARGENT_TRACE_PROCESSOR_TAG;
  });

  afterEach(() => {
    if (savedTag === undefined) delete process.env.ARGENT_TRACE_PROCESSOR_TAG;
    else process.env.ARGENT_TRACE_PROCESSOR_TAG = savedTag;
  });

  it("maps a clean version to argent-v<version>", () => {
    expect(resolveReleaseTag("0.8.1")).toBe("argent-v0.8.1");
  });

  it("falls back to argent-main for null/unknown", () => {
    expect(resolveReleaseTag(null)).toBe("argent-main");
    expect(resolveReleaseTag("unknown")).toBe("argent-main");
  });

  it("ARGENT_TRACE_PROCESSOR_TAG overrides the version-derived tag", () => {
    process.env.ARGENT_TRACE_PROCESSOR_TAG = "argent-my-branch";
    expect(resolveReleaseTag("0.8.1")).toBe("argent-my-branch");
    expect(resolveReleaseTag(null)).toBe("argent-my-branch");
  });
});
