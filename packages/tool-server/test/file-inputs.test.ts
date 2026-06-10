import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { FILE_INPUT_MARKER, type FileInputSpec } from "@argent/registry";
import { resolveFileInputs, FileInputError } from "../src/file-inputs";

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
      input: { clientPath: filePath, presentOnHost: true, viaUpload: false },
    });
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

  it("rejects a missing file with no uploaded content", async () => {
    await expect(
      resolveFileInputs(
        { fileInputs: FILE_SPEC },
        { input: wire({ path: path.join(tmpDir, "ghost.png") }) }
      )
    ).rejects.toThrow(FileInputError);
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
});
