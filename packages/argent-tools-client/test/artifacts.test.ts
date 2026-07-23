import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, mkdir, rm, readFile, writeFile, stat } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import {
  materializeArtifacts,
  isArtifactHandle,
  getDeviceIdFromArgs,
  artifactDir,
  durableSaveTarget,
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

  it("sends the auth token as a Bearer header when downloading (remote authenticated server)", async () => {
    const seen: Array<RequestInit | undefined> = [];
    const recordingFetch = (async (_url: string, init?: RequestInit) => {
      seen.push(init);
      return { ok: true, arrayBuffer: async () => new Uint8Array(PNG).buffer };
    }) as unknown as typeof fetch;

    await materializeArtifacts(
      { image: handle("img1", "shot.png", "image/png") },
      { toolsUrl: "http://remote:3001", authToken: "secret-token", fetchImpl: recordingFetch }
    );

    expect(seen).toHaveLength(1);
    expect((seen[0]!.headers as Record<string, string>).Authorization).toBe("Bearer secret-token");
  });

  it("omits the Authorization header when no auth token is present", async () => {
    const seen: Array<RequestInit | undefined> = [];
    const recordingFetch = (async (_url: string, init?: RequestInit) => {
      seen.push(init);
      return { ok: true, arrayBuffer: async () => new Uint8Array(PNG).buffer };
    }) as unknown as typeof fetch;

    await materializeArtifacts(
      { image: handle("img1", "shot.png", "image/png") },
      { toolsUrl: "http://remote:3001", fetchImpl: recordingFetch }
    );

    expect((seen[0]!.headers as Record<string, string>).Authorization).toBeUndefined();
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

  it("rewrites a handle to null when the downloaded byte count doesn't match size", async () => {
    const h: ArtifactHandle = {
      [ARTIFACT_MARKER]: true,
      id: "trunc",
      filename: "data.xml",
      mimeType: "application/xml",
      size: 99, // server announced 99 bytes…
    };
    const { result } = await materializeArtifacts(
      { file: h },
      { toolsUrl: "http://remote:3001", fetchImpl: fakeFetch({ trunc: [1, 2, 3] }) } // …delivered 3
    );
    expect((result as { file: null }).file).toBeNull();
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

  it("falls back to download when the local file no longer matches the recorded size", async () => {
    // Local file is stale (2 bytes) but the handle records the authoritative
    // size (PNG.length), so the gate misses and re-downloads. The server serves
    // bytes matching the recorded size, so the download's integrity check passes.
    const hostPath = join(hostDir, "shot.png");
    await writeFile(hostPath, Buffer.from([0x01, 0x02]));
    const h: ArtifactHandle = {
      [ARTIFACT_MARKER]: true,
      id: "img2",
      filename: "shot.png",
      mimeType: "image/png",
      size: PNG.length,
      hostPath,
    };
    const { result, images } = await materializeArtifacts(
      { image: h },
      { toolsUrl: "http://remote:3001", fetchImpl: fakeFetch({ img2: PNG }) }
    );

    const out = (result as { image: string }).image;
    expect(out).not.toBe(hostPath);
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

// ── directory bundles (e.g. .trace) delivered as tar.gz ──────────────

function fakeFetchBuffer(map: Record<string, Buffer>): typeof fetch {
  return (async (url: string) => {
    const id = url.split("/artifacts/")[1]!;
    const buf = map[id];
    if (!buf) return { ok: false, arrayBuffer: async () => new ArrayBuffer(0) };
    return {
      ok: true,
      arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    };
  }) as unknown as typeof fetch;
}

describe("materializeArtifacts directory bundles", () => {
  let root: string; // ARGENT_ARTIFACTS_DIR
  let hostDir: string; // stands in for the tool-server host

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

  // Build a real .trace-like bundle and a gzipped tar of it (as the server would
  // stream on demand), so the client extraction runs against genuine tar output.
  async function makeBundle(): Promise<{ bundlePath: string; tarGz: Buffer }> {
    const bundlePath = join(hostDir, "session.trace");
    await mkdir(join(bundlePath, "sub"), { recursive: true });
    await writeFile(join(bundlePath, "top.txt"), "top");
    await writeFile(join(bundlePath, "sub", "nested.txt"), "nested");
    const tarPath = join(hostDir, "session.tar.gz");
    execFileSync("tar", ["-czf", tarPath, "-C", hostDir, "session.trace"]);
    const tarGz = await readFile(tarPath);
    await rm(tarPath, { force: true });
    return { bundlePath, tarGz };
  }

  function archiveHandle(id: string, hostPath: string): ArtifactHandle {
    return {
      [ARTIFACT_MARKER]: true,
      id,
      filename: "session.trace",
      mimeType: "application/octet-stream",
      size: 0,
      hostPath,
      archive: "tar.gz",
    };
  }

  const throwingFetch: typeof fetch = (async () => {
    throw new Error("fetch must not be called for a co-located directory bundle");
  }) as unknown as typeof fetch;

  it("co-located: uses the bundle directory in place, no download", async () => {
    const { bundlePath } = await makeBundle();
    const { result, images } = await materializeArtifacts(
      { traceFile: archiveHandle("t1", bundlePath) },
      { toolsUrl: "http://localhost:3001", fetchImpl: throwingFetch }
    );
    expect((result as { traceFile: string }).traceFile).toBe(bundlePath);
    expect(images).toHaveLength(0);
  });

  it("remote: downloads the tar.gz and unpacks it back into a directory", async () => {
    const { tarGz } = await makeBundle();
    const { result } = await materializeArtifacts(
      // hostPath absent locally → gate miss → download + extract.
      { traceFile: archiveHandle("t2", join(hostDir, "gone.trace")) },
      { toolsUrl: "http://remote:3001", fetchImpl: fakeFetchBuffer({ t2: tarGz }) }
    );

    const extracted = (result as { traceFile: string }).traceFile;
    expect(extracted).toBe(join(artifactDir(), "session.trace"));
    expect((await stat(extracted)).isDirectory()).toBe(true);
    expect(await readFile(join(extracted, "top.txt"), "utf8")).toBe("top");
    expect(await readFile(join(extracted, "sub", "nested.txt"), "utf8")).toBe("nested");
  });

  it("remote: a failed bundle download rewrites to null", async () => {
    const { result } = await materializeArtifacts(
      { traceFile: archiveHandle("missing", join(hostDir, "gone.trace")) },
      { toolsUrl: "http://remote:3001", fetchImpl: fakeFetchBuffer({}) }
    );
    expect((result as { traceFile: null }).traceFile).toBeNull();
  });
});

// ── durable destination (saveDir, e.g. `.argent/recordings`) ─────────
//
// The base a `saveDir` resolves against is the client's project root (nearest
// ancestor with `.git`/`package.json`/`.argent`), or its home dir when not in a
// project. These suites drive cwd into a marker-bearing temp dir and redirect
// HOME so the global-fallback branch never touches the real `~/.argent`.

describe("durableSaveTarget", () => {
  let projectRoot: string;
  let home: string;
  let originalCwd: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "argent-proj-"));
    await writeFile(join(projectRoot, "package.json"), "{}"); // the project marker
    home = await mkdtemp(join(tmpdir(), "argent-home-"));
    originalCwd = process.cwd();
    originalHome = process.env.HOME;
    process.chdir(projectRoot);
    process.env.HOME = home;
    projectRoot = process.cwd(); // resolve /var → /private/var for assertions
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    await rm(projectRoot, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  });

  it("returns null when no saveDir is set (⇒ disposable temp cache)", () => {
    expect(durableSaveTarget(handle("a", "x.mp4", "video/mp4"))).toBeNull();
  });

  it("resolves saveDir under the project root with the sanitized filename", () => {
    const h: ArtifactHandle = {
      ...handle("a", "clip name.mp4", "video/mp4"),
      saveDir: ".argent/recordings",
    };
    const target = durableSaveTarget(h)!;
    expect(target).not.toBeNull();
    expect(target.dir).toBe(join(projectRoot, ".argent/recordings"));
    // Space in the filename is sanitized to an underscore.
    expect(target.path).toBe(join(projectRoot, ".argent/recordings", "clip_name.mp4"));
  });

  it("anchors at the project root even from a subdirectory", async () => {
    const sub = join(projectRoot, "packages", "app");
    await mkdir(sub, { recursive: true });
    process.chdir(sub);
    const h: ArtifactHandle = {
      ...handle("a", "clip.mp4", "video/mp4"),
      saveDir: ".argent/recordings",
    };
    // Not join(sub, …) — the one project-level `.argent`, walked up to.
    expect(durableSaveTarget(h)!.dir).toBe(join(projectRoot, ".argent/recordings"));
  });

  it("falls back to the global ~/.argent when not inside a project", async () => {
    const outside = await mkdtemp(join(tmpdir(), "argent-noproj-"));
    process.chdir(outside);
    try {
      const h: ArtifactHandle = {
        ...handle("a", "clip.mp4", "video/mp4"),
        saveDir: ".argent/recordings",
      };
      const target = durableSaveTarget(h)!;
      expect(target.dir).toBe(join(home, ".argent/recordings"));
      expect(target.path).toBe(join(home, ".argent/recordings", "clip.mp4"));
    } finally {
      process.chdir(projectRoot);
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("rejects an absolute saveDir (falls back to null → temp cache)", () => {
    const h: ArtifactHandle = { ...handle("a", "x.mp4", "video/mp4"), saveDir: "/etc" };
    expect(durableSaveTarget(h)).toBeNull();
  });

  it("rejects a `..`-escaping saveDir", () => {
    for (const evil of ["..", "../outside", "a/../../b", "./../x"]) {
      const h: ArtifactHandle = { ...handle("a", "x.mp4", "video/mp4"), saveDir: evil };
      expect(durableSaveTarget(h), evil).toBeNull();
    }
  });

  it("rejects an unlisted in-tree saveDir (only the client's allowlist is honored)", () => {
    // Relative, non-`..`, yet still inside the project root — where `.git`,
    // sources, and argent's own config live. A hostile tool-server must not be
    // able to steer a durable write to any of these by picking `saveDir`.
    for (const evil of [".git", ".", "", "src", ".argent", ".argent/flags", "recordings"]) {
      const h: ArtifactHandle = {
        ...handle("a", "config", "application/octet-stream"),
        saveDir: evil,
      };
      expect(durableSaveTarget(h), evil).toBeNull();
    }
  });

  it("excludes directory bundles (archive) — durable persistence is for single files", () => {
    const h: ArtifactHandle = {
      ...handle("a", "session.trace", "application/octet-stream"),
      saveDir: ".argent/recordings",
      archive: "tar.gz",
    };
    expect(durableSaveTarget(h)).toBeNull();
  });
});

describe("materializeArtifacts durable destination", () => {
  let root: string; // ARGENT_ARTIFACTS_DIR (temp cache)
  let hostDir: string; // stands in for the tool-server host
  let projectRoot: string; // the client's project (marker-bearing) working dir
  let home: string; // redirected HOME for the global-fallback branch
  let originalCwd: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "argent-artifacts-"));
    hostDir = await mkdtemp(join(tmpdir(), "argent-host-"));
    projectRoot = await mkdtemp(join(tmpdir(), "argent-proj-"));
    await writeFile(join(projectRoot, "package.json"), "{}"); // the project marker
    home = await mkdtemp(join(tmpdir(), "argent-home-"));
    process.env.ARGENT_ARTIFACTS_DIR = root;
    originalCwd = process.cwd();
    originalHome = process.env.HOME;
    process.chdir(projectRoot);
    process.env.HOME = home;
    // On macOS the temp dir is under a /var → /private/var symlink; the
    // materializer resolves cwd to the real path, so mirror that for assertions.
    projectRoot = process.cwd();
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    delete process.env.ARGENT_ARTIFACTS_DIR;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    await rm(root, { recursive: true, force: true });
    await rm(hostDir, { recursive: true, force: true });
    await rm(projectRoot, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  });

  const MP4 = [0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]; // ftyp box header-ish

  it("remote: downloads the video into <project>/.argent/recordings/, not the temp cache", async () => {
    const h: ArtifactHandle = {
      [ARTIFACT_MARKER]: true,
      id: "vid1",
      filename: "screen-recording-DEV-1-42.mp4",
      mimeType: "video/mp4",
      size: MP4.length,
      saveDir: ".argent/recordings",
    };
    const { result, images } = await materializeArtifacts(
      { video: h },
      { toolsUrl: "http://remote:3001", authToken: "tok", fetchImpl: fakeFetch({ vid1: MP4 }) }
    );

    const out = (result as { video: string }).video;
    const expected = join(projectRoot, ".argent/recordings", "screen-recording-DEV-1-42.mp4");
    expect(out).toBe(expected);
    expect(out.startsWith(artifactDir())).toBe(false); // NOT in the temp cache
    expect(Buffer.from(await readFile(out))).toEqual(Buffer.from(MP4));
    // A video is not an image — no inline render.
    expect(images).toHaveLength(0);
  });

  it("co-located: copies the host video into <project>/.argent/recordings/ and leaves the original", async () => {
    const hostPath = join(hostDir, "argent-screen-recording-DEV-1-42.mp4");
    await writeFile(hostPath, Buffer.from(MP4));
    const st = await stat(hostPath);
    const h: ArtifactHandle = {
      [ARTIFACT_MARKER]: true,
      id: "vid2",
      filename: "screen-recording-DEV-1-42.mp4", // server strips the `argent-` prefix
      mimeType: "video/mp4",
      size: st.size,
      hostPath,
      mtimeMs: st.mtimeMs,
      saveDir: ".argent/recordings",
    };
    const throwingFetch: typeof fetch = (async () => {
      throw new Error("fetch must not be called when the file is already local");
    }) as unknown as typeof fetch;

    const { result } = await materializeArtifacts(
      { video: h },
      { toolsUrl: "http://localhost:3001", fetchImpl: throwingFetch }
    );

    const out = (result as { video: string }).video;
    expect(out).toBe(join(projectRoot, ".argent/recordings", "screen-recording-DEV-1-42.mp4"));
    expect(out).not.toBe(hostPath); // durable copy, not the temp original
    expect(Buffer.from(await readFile(out))).toEqual(Buffer.from(MP4));
    // Original host file is untouched.
    expect(Buffer.from(await readFile(hostPath))).toEqual(Buffer.from(MP4));
  });

  it("not in a project: downloads into the global ~/.argent/recordings/", async () => {
    const outside = await mkdtemp(join(tmpdir(), "argent-noproj-"));
    process.chdir(outside);
    try {
      const h: ArtifactHandle = {
        [ARTIFACT_MARKER]: true,
        id: "vid5",
        filename: "clip.mp4",
        mimeType: "video/mp4",
        size: MP4.length,
        saveDir: ".argent/recordings",
      };
      const { result } = await materializeArtifacts(
        { video: h },
        { toolsUrl: "http://remote:3001", fetchImpl: fakeFetch({ vid5: MP4 }) }
      );
      const out = (result as { video: string }).video;
      expect(out).toBe(join(home, ".argent/recordings", "clip.mp4"));
      expect(Buffer.from(await readFile(out))).toEqual(Buffer.from(MP4));
    } finally {
      process.chdir(projectRoot);
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("unsafe saveDir falls back to the temp cache instead of writing outside the base", async () => {
    const h: ArtifactHandle = {
      [ARTIFACT_MARKER]: true,
      id: "vid3",
      filename: "clip.mp4",
      mimeType: "video/mp4",
      size: MP4.length,
      saveDir: "../escape",
    };
    const { result } = await materializeArtifacts(
      { video: h },
      { toolsUrl: "http://remote:3001", fetchImpl: fakeFetch({ vid3: MP4 }) }
    );
    const out = (result as { video: string }).video;
    expect(out.startsWith(artifactDir())).toBe(true); // fell back to temp cache
    expect(out).not.toContain("escape");
  });

  it("a hostile in-tree saveDir never overwrites a project file (e.g. .git/config)", async () => {
    // A remote/compromised tool-server tags a result with saveDir `.git` +
    // filename `config` + chosen bytes (size 0 skips the length check). Writing
    // there would poison `.git/config` ⇒ code execution on the next git command.
    const gitDir = join(projectRoot, ".git");
    await mkdir(gitDir, { recursive: true });
    const original = "[core]\n\trepositoryformatversion = 0\n";
    await writeFile(join(gitDir, "config"), original);
    const h: ArtifactHandle = {
      [ARTIFACT_MARKER]: true,
      id: "evil",
      filename: "config",
      mimeType: "application/octet-stream",
      size: 0,
      saveDir: ".git",
    };
    const payload = [...Buffer.from("[core]\n\tpager = touch /tmp/pwned\n")];
    const { result } = await materializeArtifacts(
      { video: h },
      { toolsUrl: "http://remote:3001", fetchImpl: fakeFetch({ evil: payload }) }
    );
    // .git/config untouched, and the write fell back to the disposable cache.
    expect(await readFile(join(gitDir, "config"), "utf8")).toBe(original);
    expect((result as { video: string }).video.startsWith(artifactDir())).toBe(true);
  });

  it("a truncated durable download rewrites to null (integrity holds)", async () => {
    const h: ArtifactHandle = {
      [ARTIFACT_MARKER]: true,
      id: "vid4",
      filename: "clip.mp4",
      mimeType: "video/mp4",
      size: 99, // announced 99…
      saveDir: ".argent/recordings",
    };
    const { result } = await materializeArtifacts(
      { video: h },
      { toolsUrl: "http://remote:3001", fetchImpl: fakeFetch({ vid4: MP4 }) } // …delivered 8
    );
    expect((result as { video: null }).video).toBeNull();
  });

  it("refuses a size:0 durable download — an unverifiable body is never persisted", async () => {
    // A durable file survives temp-cache GC, so a length that can't be checked
    // (size 0) must not be persisted. A remote server that announces size:0 and
    // streams an arbitrary-length body is dropped, not written under `.argent/`.
    const big = Array.from({ length: 40000 }, (_, i) => i % 256);
    const h: ArtifactHandle = {
      [ARTIFACT_MARKER]: true,
      id: "vid0",
      filename: "clip.mp4",
      mimeType: "video/mp4",
      size: 0,
      saveDir: ".argent/recordings",
    };
    const { result } = await materializeArtifacts(
      { video: h },
      { toolsUrl: "http://remote:3001", fetchImpl: fakeFetch({ vid0: big }) }
    );
    expect((result as { video: null }).video).toBeNull();
    await expect(readFile(join(projectRoot, ".argent/recordings", "clip.mp4"))).rejects.toThrow();
  });

  it("caps a durable download that over-streams past its declared size", async () => {
    // The handle declares 8 bytes but the server streams 200_000. The bounded
    // reader aborts the stream once it passes the declared size (the cap), so an
    // under-declared body can't drive unbounded memory use / disk fill; the
    // artifact resolves to null and nothing is left under `.argent/recordings/`.
    const overStreamingFetch = (async () => ({
      ok: true,
      headers: { get: () => null }, // no Content-Length announced
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          for (let i = 0; i < 100; i++) controller.enqueue(new Uint8Array(2000));
          controller.close();
        },
      }),
    })) as unknown as typeof fetch;

    const h: ArtifactHandle = {
      [ARTIFACT_MARKER]: true,
      id: "vidflood",
      filename: "clip.mp4",
      mimeType: "video/mp4",
      size: MP4.length, // declares 8, delivers 200_000
      saveDir: ".argent/recordings",
    };
    const { result } = await materializeArtifacts(
      { video: h },
      { toolsUrl: "http://remote:3001", fetchImpl: overStreamingFetch }
    );
    expect((result as { video: null }).video).toBeNull();
    await expect(readFile(join(projectRoot, ".argent/recordings", "clip.mp4"))).rejects.toThrow();
  });

  it("never overwrites an existing durable recording — lands the new file alongside", async () => {
    // A colliding filename must not clobber a recording already on disk. Both
    // the co-located copy and the remote download create exclusively, so the new
    // file lands as `clip (2).mp4` and the original is preserved intact.
    const dir = join(projectRoot, ".argent/recordings");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "clip.mp4"), Buffer.from("EXISTING"));

    const h: ArtifactHandle = {
      [ARTIFACT_MARKER]: true,
      id: "viddup",
      filename: "clip.mp4",
      mimeType: "video/mp4",
      size: MP4.length,
      saveDir: ".argent/recordings",
    };
    const { result } = await materializeArtifacts(
      { video: h },
      { toolsUrl: "http://remote:3001", fetchImpl: fakeFetch({ viddup: MP4 }) }
    );

    const out = (result as { video: string }).video;
    expect(out).toBe(join(dir, "clip (2).mp4"));
    expect(Buffer.from(await readFile(out))).toEqual(Buffer.from(MP4));
    // The original is untouched.
    expect(await readFile(join(dir, "clip.mp4"), "utf8")).toBe("EXISTING");
  });
});
