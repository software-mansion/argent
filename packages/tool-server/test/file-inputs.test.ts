import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { FILE_INPUT_MARKER, type FileInputSpec } from "@argent/registry";
import { resolveFileInputs, FileInputError } from "../src/file-inputs";
import { redirectTmpdir } from "./helpers/tmpdir-env";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "file-inputs-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function wire(overrides: Record<string, unknown>) {
  return { [FILE_INPUT_MARKER]: true, ...overrides };
}

const FILE_SPEC: FileInputSpec[] = [{ target: "input", path: "${input}", kind: "file" }];

describe("resolveFileInputs", () => {
  it("passes plain-string args through untouched (legacy callers)", async () => {
    const body = { input: "/some/path.png", other: 1 };
    const { args, fileInputs } = await resolveFileInputs({ fileInputs: FILE_SPEC }, body);
    expect(args).toEqual(body);
    expect(fileInputs).toBeUndefined();
  });

  it("uses the wrapper path in place when it matches on this host", async () => {
    const filePath = path.join(tmpDir, "input.png");
    await fs.writeFile(filePath, "png-bytes");
    const st = await fs.stat(filePath);

    const { args, fileInputs } = await resolveFileInputs(
      { fileInputs: FILE_SPEC },
      { input: wire({ path: filePath, size: st.size, mtimeMs: st.mtimeMs }) }
    );

    expect(args.input).toBe(filePath);
    expect(fileInputs).toEqual({
      input: { clientPath: filePath, presentOnHost: true, viaUpload: false, statVerified: true },
    });
  });

  it("resolves a stat-less wrapper in place but without statVerified", async () => {
    const filePath = path.join(tmpDir, "stat-less.yaml");
    await fs.writeFile(filePath, "steps: []\n");

    const { args, fileInputs } = await resolveFileInputs(
      { fileInputs: FILE_SPEC },
      { input: wire({ path: filePath }) }
    );

    // Lenient presence stays (co-located callers that could not stat rely on
    // it) but must not read as the strong same-file evidence containment
    // gates require.
    expect(args.input).toBe(filePath);
    expect(fileInputs!.input).toMatchObject({ presentOnHost: true, viaUpload: false });
    expect(fileInputs!.input.statVerified).toBeUndefined();
  });

  it("resolves a size-only wrapper in place but without statVerified", async () => {
    const filePath = path.join(tmpDir, "size-only.yaml");
    await fs.writeFile(filePath, "steps: []\n");
    const st = await fs.stat(filePath);

    const { args, fileInputs } = await resolveFileInputs(
      { fileInputs: FILE_SPEC },
      { input: wire({ path: filePath, size: st.size }) }
    );

    // The size matches the host file, but statVerified means BOTH stat fields
    // were carried and matched — a size alone is far easier for a caller to
    // know than the ms-rounded mtime and must not count as the strong form.
    expect(args.input).toBe(filePath);
    expect(fileInputs!.input).toMatchObject({ presentOnHost: true, viaUpload: false });
    expect(fileInputs!.input.statVerified).toBeUndefined();
  });

  it("resolves an mtime-only wrapper in place but without statVerified", async () => {
    const filePath = path.join(tmpDir, "mtime-only.yaml");
    await fs.writeFile(filePath, "steps: []\n");
    const st = await fs.stat(filePath);

    const { args, fileInputs } = await resolveFileInputs(
      { fileInputs: FILE_SPEC },
      { input: wire({ path: filePath, mtimeMs: st.mtimeMs }) }
    );

    // Same conjunction from the other side: a matching mtime with no size on
    // the wire is only half the client stat, so the strong form stays off.
    expect(args.input).toBe(filePath);
    expect(fileInputs!.input).toMatchObject({ presentOnHost: true, viaUpload: false });
    expect(fileInputs!.input.statVerified).toBeUndefined();
  });

  it("falls back to uploaded content when the stat does not match", async () => {
    const filePath = path.join(tmpDir, "input.png");
    await fs.writeFile(filePath, "stale");
    const content = Buffer.from("fresh client bytes");

    const { args, fileInputs } = await resolveFileInputs(
      { fileInputs: FILE_SPEC },
      {
        input: wire({
          path: filePath,
          size: content.length,
          content: content.toString("base64"),
        }),
      }
    );

    expect(args.input).not.toBe(filePath);
    expect(await fs.readFile(args.input as string, "utf8")).toBe("fresh client bytes");
    expect(fileInputs!.input).toMatchObject({ presentOnHost: false, viaUpload: true });
  });

  it("materializes uploaded content for a path that does not exist here", async () => {
    const clientPath = path.join(tmpDir, "not-here", "flow.yaml");
    const content = Buffer.from("steps: []\n");

    const { args } = await resolveFileInputs(
      { fileInputs: FILE_SPEC },
      {
        input: wire({
          path: clientPath,
          size: content.length,
          content: content.toString("base64"),
        }),
      }
    );

    expect(await fs.readFile(args.input as string, "utf8")).toBe("steps: []\n");
  });

  it("cleanup removes materialized uploads and is a no-op for in-place paths", async () => {
    const inPlace = path.join(tmpDir, "in-place.png");
    await fs.writeFile(inPlace, "png-bytes");
    const st = await fs.stat(inPlace);
    const content = Buffer.from("uploaded bytes");

    const specs: FileInputSpec[] = [
      { target: "a", path: "${a}", kind: "file" },
      { target: "b", path: "${b}", kind: "file" },
    ];
    const { args, cleanup } = await resolveFileInputs(
      { fileInputs: specs },
      {
        a: wire({ path: inPlace, size: st.size, mtimeMs: st.mtimeMs }),
        b: wire({
          path: "/client/only.png",
          size: content.length,
          content: content.toString("base64"),
        }),
      }
    );

    const materialized = args.b as string;
    expect(await fs.readFile(materialized, "utf8")).toBe("uploaded bytes");

    await cleanup();
    await expect(fs.stat(materialized)).rejects.toThrow();
    // The temp dir holding it is gone too, and double-cleanup is harmless.
    await expect(fs.stat(path.dirname(materialized))).rejects.toThrow();
    await cleanup();
    // In-place inputs are the caller's files — never removed.
    expect(await fs.readFile(inPlace, "utf8")).toBe("png-bytes");
  });

  it("cleans up already-materialized uploads when a later spec fails", async () => {
    const content = Buffer.from("bytes");
    const specs: FileInputSpec[] = [
      { target: "a", path: "${a}", kind: "file" },
      { target: "b", path: "${b}", kind: "file" },
    ];

    // resolveFileInputs materializes into mkdtemp(join(os.tmpdir(),
    // "argent-file-input-")). Scope the tmpdir to this test so the listing
    // below covers only dirs this run created — the machine-wide tmpdir also
    // holds the in-flight dirs of any concurrent run, which would read as an
    // uncleaned leak.
    const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "argent-file-input-scan-"));
    const restoreTmpdir = redirectTmpdir(scratch);

    const listInputTempDirs = async () => {
      const entries = await fs.readdir(scratch);
      return entries.filter((e) => e.startsWith("argent-file-input-"));
    };

    try {
      await expect(
        resolveFileInputs(
          { fileInputs: specs },
          {
            a: wire({
              path: "/client/a.png",
              size: content.length,
              content: content.toString("base64"),
            }),
            b: wire({ path: path.join(tmpDir, "ghost.png") }),
          }
        )
      ).rejects.toThrow(FileInputError);

      expect(await listInputTempDirs()).toEqual([]);
    } finally {
      restoreTmpdir();
      await fs.rm(scratch, { recursive: true, force: true });
    }
  });

  it("rejects a missing file with no uploaded content", async () => {
    await expect(
      resolveFileInputs(
        { fileInputs: FILE_SPEC },
        { input: wire({ path: path.join(tmpDir, "ghost.png") }) }
      )
    ).rejects.toThrow(/was not found on the tool-server host/);
  });

  it("explains the transfer limit when content was omitted for size and the path is absent", async () => {
    await expect(
      resolveFileInputs(
        { fileInputs: FILE_SPEC },
        {
          input: wire({
            path: path.join(tmpDir, "huge.bin"),
            size: 36 * 1024 * 1024,
            mtimeMs: 1234,
            contentOmitted: "size-limit",
          }),
        }
      )
    ).rejects.toThrow(/36 MB — larger than the 32 MB file-input transfer limit/);
  });

  it("still resolves an oversize file in place when it matches on this host", async () => {
    const filePath = path.join(tmpDir, "big-but-here.bin");
    await fs.writeFile(filePath, "stat-matched bytes");
    const st = await fs.stat(filePath);

    const { args, fileInputs } = await resolveFileInputs(
      { fileInputs: FILE_SPEC },
      {
        input: wire({
          path: filePath,
          size: st.size,
          mtimeMs: st.mtimeMs,
          contentOmitted: "size-limit",
        }),
      }
    );

    expect(args.input).toBe(filePath);
    expect(fileInputs!.input).toMatchObject({ presentOnHost: true, viaUpload: false });
  });

  it("rejects an upload whose decoded size disagrees with the recorded size", async () => {
    await expect(
      resolveFileInputs(
        { fileInputs: FILE_SPEC },
        {
          input: wire({
            path: "/client/file.png",
            size: 999,
            content: Buffer.from("short").toString("base64"),
          }),
        }
      )
    ).rejects.toThrow(/truncated or corrupted/);
  });

  it("directory kind resolves in place when the directory exists", async () => {
    const spec: FileInputSpec[] = [{ target: "root", path: "${root}", kind: "directory" }];
    const { args, fileInputs } = await resolveFileInputs(
      { fileInputs: spec },
      { root: wire({ path: tmpDir }) }
    );
    expect(args.root).toBe(tmpDir);
    expect(fileInputs!.root).toMatchObject({ presentOnHost: true });
  });

  it("directory kind fails with remote-mode guidance when absent on this host", async () => {
    const spec: FileInputSpec[] = [{ target: "root", path: "${root}", kind: "directory" }];
    await expect(
      resolveFileInputs({ fileInputs: spec }, { root: wire({ path: path.join(tmpDir, "nope") }) })
    ).rejects.toThrow(/does not exist on the tool-server host/);
  });

  it("probe kind never fails and reports presence via metadata", async () => {
    const spec: FileInputSpec[] = [{ target: "dir", path: "${dir}", kind: "probe" }];
    const ghost = path.join(tmpDir, "ghost-dir");

    const present = await resolveFileInputs({ fileInputs: spec }, { dir: wire({ path: tmpDir }) });
    expect(present.args.dir).toBe(tmpDir);
    expect(present.fileInputs!.dir).toMatchObject({ presentOnHost: true });

    const absent = await resolveFileInputs({ fileInputs: spec }, { dir: wire({ path: ghost }) });
    expect(absent.args.dir).toBe(ghost);
    expect(absent.fileInputs!.dir).toMatchObject({ presentOnHost: false });
  });

  it("ignores wrappers on undeclared targets", async () => {
    const body = { smuggled: wire({ path: "/etc/passwd" }) };
    const { args, fileInputs } = await resolveFileInputs({ fileInputs: FILE_SPEC }, body);
    // Left untouched — the tool's own schema validation rejects the object.
    expect(args.smuggled).toEqual(body.smuggled);
    expect(fileInputs).toBeUndefined();
  });

  it("drops a derived wrapper whose skipWhenSet param is set instead of resolving it", async () => {
    // Old-client skew: the client wrapped the derived target even though the
    // superseding source param is also on the wire. The wrapper's path does
    // not exist, which without the skip would fail resolution here — masking
    // the tool's own dual-source validation.
    const sourcePath = path.join(tmpDir, "explicit.yaml");
    await fs.writeFile(sourcePath, "steps: []\n");
    const st = await fs.stat(sourcePath);
    const specs: FileInputSpec[] = [
      { target: "source", path: "${source}", kind: "file", optional: true },
      { target: "derived", path: "${root}/${name}.yaml", kind: "file", skipWhenSet: "source" },
    ];

    const { args, fileInputs } = await resolveFileInputs(
      { fileInputs: specs },
      {
        name: "ghost",
        root: tmpDir,
        source: wire({ path: sourcePath, size: st.size, mtimeMs: st.mtimeMs }),
        derived: wire({ path: path.join(tmpDir, "ghost.yaml") }),
      }
    );

    // The derived wrapper is gone (not a dangling object that would fail the
    // tool's string schema); the source resolved normally.
    expect("derived" in args).toBe(false);
    expect(args.source).toBe(sourcePath);
    expect(fileInputs).toEqual({
      source: { clientPath: sourcePath, presentOnHost: true, viaUpload: false, statVerified: true },
    });
  });

  it("drops a derived wrapper even when the skipWhenSet param is an empty string", async () => {
    // "" is a provided source to the tool's `=== undefined` dual-source check,
    // so the wrapper must be dropped here too — resolving it would let a
    // missing saved flow 422 before that check can name the real misuse.
    const specs: FileInputSpec[] = [
      { target: "source", path: "${source}", kind: "file", optional: true },
      { target: "derived", path: "${root}/${name}.yaml", kind: "file", skipWhenSet: "source" },
    ];

    const { args } = await resolveFileInputs(
      { fileInputs: specs },
      {
        name: "ghost",
        root: tmpDir,
        source: "",
        derived: wire({ path: path.join(tmpDir, "ghost.yaml") }),
      }
    );

    expect("derived" in args).toBe(false);
    expect(args.source).toBe("");
  });

  it("resolves a derived wrapper normally when the skipWhenSet param is absent", async () => {
    const derivedPath = path.join(tmpDir, "saved.yaml");
    await fs.writeFile(derivedPath, "steps: []\n");
    const st = await fs.stat(derivedPath);
    const specs: FileInputSpec[] = [
      { target: "source", path: "${source}", kind: "file", optional: true },
      { target: "derived", path: "${root}/${name}.yaml", kind: "file", skipWhenSet: "source" },
    ];

    const { args } = await resolveFileInputs(
      { fileInputs: specs },
      {
        name: "saved",
        root: tmpDir,
        derived: wire({ path: derivedPath, size: st.size, mtimeMs: st.mtimeMs }),
      }
    );

    expect(args.derived).toBe(derivedPath);
  });

  const UNWRAP_SPEC: FileInputSpec[] = [
    { target: "source", path: "${source}", kind: "file", optional: true, unwrapWhenSet: "name" },
  ];

  it("unwraps a caller-authored wrapper to its client path when the unwrapWhenSet param is set", async () => {
    // Dual-source misuse on the CALLER-authored target: dropping it (the
    // skipWhenSet remedy) would rewrite the call as valid single-source, and
    // resolving it would make the error hinge on file existence — so the
    // wrapper is handed on as the plain path string for the tool's own
    // exactly-one validation to reject. The path is a ghost on purpose:
    // resolution would throw here, unwrapping must not.
    const ghost = path.join(tmpDir, "ghost.yaml");

    const { args, fileInputs } = await resolveFileInputs(
      { fileInputs: UNWRAP_SPEC },
      { name: "saved", source: wire({ path: ghost }) }
    );

    expect(args.source).toBe(ghost);
    // Nothing was probed — no metadata may vouch for a file never looked at.
    expect(fileInputs).toBeUndefined();
  });

  it("unwraps even when the unwrapWhenSet param is an empty string", async () => {
    // Same presence semantics as skipWhenSet: "" is a provided source to the
    // tool's `=== undefined` dual-source check, so the check must see both.
    const ghost = path.join(tmpDir, "ghost.yaml");

    const { args } = await resolveFileInputs(
      { fileInputs: UNWRAP_SPEC },
      { name: "", source: wire({ path: ghost }) }
    );

    expect(args.source).toBe(ghost);
  });

  it("resolves a caller-authored wrapper normally when the unwrapWhenSet param is absent", async () => {
    const sourcePath = path.join(tmpDir, "explicit.yaml");
    await fs.writeFile(sourcePath, "steps: []\n");
    const st = await fs.stat(sourcePath);

    const { args, fileInputs } = await resolveFileInputs(
      { fileInputs: UNWRAP_SPEC },
      { source: wire({ path: sourcePath, size: st.size, mtimeMs: st.mtimeMs }) }
    );

    expect(args.source).toBe(sourcePath);
    expect(fileInputs).toEqual({
      source: { clientPath: sourcePath, presentOnHost: true, viaUpload: false, statVerified: true },
    });
  });

  it("still throws for an unresolvable wrapper when the unwrapWhenSet param is absent", async () => {
    // Single-source call, file genuinely missing: the boundary's own error is
    // the right diagnosis, and unwrapWhenSet must not soften it.
    await expect(
      resolveFileInputs(
        { fileInputs: UNWRAP_SPEC },
        { source: wire({ path: path.join(tmpDir, "ghost.yaml") }) }
      )
    ).rejects.toThrow(FileInputError);
  });
});
