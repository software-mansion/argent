import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs/promises";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import {
  CLIENT_CONTENT_CAP_BYTES,
  FLOW_FILE_NAME_PATTERN,
  canonicalFlowPath,
  classifyOnDiskSpelling,
  type ClientRequestLine,
  type ClientServiceOp,
} from "@argent/registry";
import { createClientServicesHandler } from "../src/client-services.js";

// The registry's resolution code reads through this module object, so a spy on
// it sees every directory the handler lists.
const fsCjs = createRequire(import.meta.url)("node:fs/promises") as typeof fs;

let tmpDir: string;
let projectDir: string;
let flowsDir: string;

beforeEach(async () => {
  // realpath up front: macOS puts tmpdir under /var, a symlink to /private/var,
  // and every path the handler answers is a realpath.
  tmpDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "client-services-")));
  projectDir = path.join(tmpDir, "proj");
  flowsDir = path.join(projectDir, ".argent", "flows");
  await fs.mkdir(flowsDir, { recursive: true });
  await fs.writeFile(path.join(flowsDir, "root.yaml"), "steps:\n  - run: frag.yaml\n");
  await fs.writeFile(path.join(flowsDir, "frag.yaml"), "steps:\n  - echo: hi\n");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

const ALL: ClientServiceOp[] = ["resolve-file", "read-file", "write-file"];

async function handlerFor(roots: string[], advertised: ClientServiceOp[] = ALL) {
  const handler = await createClientServicesHandler({ roots, advertised });
  if (!handler) throw new Error("expected a handler");
  return handler;
}

function resolveLine(
  anchorDir: string,
  target: string,
  extra: Partial<ClientRequestLine> = {}
): ClientRequestLine {
  return {
    event: "client-request",
    invocation: "inv-1",
    id: "req-1",
    op: "resolve-file",
    args: { anchorDir, target, kind: "flow" },
    ...extra,
  };
}

describe("createClientServicesHandler", () => {
  it("realpaths the roots, drops a missing one and offers the implemented ops in order", async () => {
    const linkToProject = path.join(tmpDir, "proj-link");
    await fs.symlink(projectDir, linkToProject);
    // Advertised out of order, with an op this client does not implement
    // (run-script) and without one it does (read-file).
    const handler = await handlerFor(
      [linkToProject, path.join(tmpDir, "nope")],
      ["write-file", "run-script", "resolve-file"]
    );
    expect(handler.param).toEqual({
      ops: ["resolve-file", "write-file"],
      roots: [projectDir],
    });
  });

  it("returns null with no existing root and with no shared op", async () => {
    expect(
      await createClientServicesHandler({ roots: [path.join(tmpDir, "nope")], advertised: ALL })
    ).toBeNull();
    expect(
      await createClientServicesHandler({ roots: [projectDir], advertised: ["run-script"] })
    ).toBeNull();
    expect(await createClientServicesHandler({ roots: [projectDir], advertised: [] })).toBeNull();
  });
});

describe("resolve-file", () => {
  it("answers resolve-file with canonical, spelling, exists, size, mtimeMs and base64 content", async () => {
    const handler = await handlerFor([projectDir]);
    const fragPath = path.join(flowsDir, "frag.yaml");
    const st = await fs.stat(fragPath);

    const answer = await handler.handle(resolveLine(flowsDir, "frag.yaml"));

    expect(answer).toEqual({
      id: "req-1",
      ok: true,
      canonical: fragPath,
      spelling: { state: "listed" },
      exists: true,
      size: st.size,
      mtimeMs: st.mtimeMs,
      content: Buffer.from("steps:\n  - echo: hi\n").toString("base64"),
    });
  });

  it("resolves a .. target that stays inside a root, through a non-realpath anchor", async () => {
    const sharedDir = path.join(projectDir, "shared");
    await fs.mkdir(sharedDir);
    await fs.writeFile(path.join(sharedDir, "login.yaml"), "steps: []\n");
    const handler = await handlerFor([projectDir]);
    // The anchor the server sends is the client path as the caller spelled it,
    // which may go through a symlink the roots do not.
    const linkedFlows = path.join(tmpDir, "flows-link");
    await fs.symlink(flowsDir, linkedFlows);

    const answer = await handler.handle(resolveLine(linkedFlows, "../../shared/login.yaml"));

    expect(answer).toMatchObject({
      ok: true,
      canonical: path.join(sharedDir, "login.yaml"),
      spelling: { state: "listed" },
      exists: true,
    });
  });

  it("answers exists: false for a missing fragment", async () => {
    const handler = await handlerFor([projectDir]);

    const answer = await handler.handle(resolveLine(flowsDir, "missing.yaml"));

    expect(answer).toEqual({
      id: "req-1",
      ok: true,
      canonical: path.join(flowsDir, "missing.yaml"),
      spelling: { state: "absent" },
      exists: false,
    });
  });

  it("refuses a target that resolves outside every root through ..", async () => {
    await fs.writeFile(path.join(tmpDir, "outside.yaml"), "steps: []\n");
    const handler = await handlerFor([projectDir]);

    const answer = await handler.handle(resolveLine(flowsDir, "../../../outside.yaml"));

    expect(answer).toMatchObject({ id: "req-1", ok: false });
    expect((answer as { error: string }).error).toContain("outside every root");
    // Where it points is the client's business: the server only learns "outside".
    expect((answer as { error: string }).error).not.toContain(path.join(tmpDir, "outside.yaml"));
  });

  it("refuses an outside target with the same words whether or not it exists", async () => {
    await fs.mkdir(path.join(tmpDir, "there"));
    const handler = await handlerFor([projectDir]);

    const exists = await handler.handle(resolveLine(flowsDir, "../../../there/x.yaml"));
    const absent = await handler.handle(resolveLine(flowsDir, "../../../nowhere/x.yaml"));

    const shape = (answer: unknown, word: string) =>
      (answer as { error: string }).error.replace(word, "<dir>");
    expect(exists).toMatchObject({ ok: false });
    expect(shape(exists, "there")).toBe(shape(absent, "nowhere"));
  });

  it("refuses an anchor directory outside every root", async () => {
    const elsewhere = path.join(tmpDir, "elsewhere");
    await fs.mkdir(elsewhere);
    await fs.writeFile(path.join(elsewhere, "frag.yaml"), "steps: []\n");
    const handler = await handlerFor([projectDir]);

    const answer = await handler.handle(resolveLine(elsewhere, "frag.yaml"));

    expect(answer).toMatchObject({ ok: false, error: expect.stringContaining("anchor directory") });
  });

  it("refuses a symlink whose target lies outside every root", async () => {
    const elsewhere = path.join(tmpDir, "elsewhere");
    await fs.mkdir(elsewhere);
    await fs.writeFile(path.join(elsewhere, "real.yaml"), "steps: []\n");
    await fs.symlink(path.join(elsewhere, "real.yaml"), path.join(flowsDir, "link.yaml"));
    const handler = await handlerFor([projectDir]);

    const answer = await handler.handle(resolveLine(flowsDir, "link.yaml"));

    expect(answer).toMatchObject({ ok: false });
    expect((answer as { error: string }).error).not.toContain(elsewhere);
    expect((answer as { error: string }).error).toContain("outside every root");
  });

  it("lists no directory outside the roots before it refuses", async () => {
    const outside = path.join(tmpDir, "there");
    await fs.mkdir(outside);
    const handler = await handlerFor([projectDir]);
    const readdir = vi.spyOn(fsCjs, "readdir");

    const answer = await handler.handle(resolveLine(flowsDir, "../../../there/x.yaml"));

    expect(answer).toMatchObject({ ok: false });
    const listed = readdir.mock.calls.map((call) => path.resolve(String(call[0])));
    expect(listed.filter((dir) => dir.startsWith(outside))).toEqual([]);
  });

  it("refuses a target spelled through a directory outside the roots, even when the file leads back in", async () => {
    // The casing check lists the directory the target is SPELLED in, so that
    // directory is fenced too, not only the file the target resolves to.
    const outside = path.join(tmpDir, "outside");
    await fs.mkdir(outside);
    await fs.symlink(path.join(flowsDir, "frag.yaml"), path.join(outside, "x.yaml"));
    await fs.symlink(outside, path.join(flowsDir, "escape"));
    const handler = await handlerFor([projectDir]);
    const readdir = vi.spyOn(fsCjs, "readdir");

    const answer = await handler.handle(resolveLine(flowsDir, "escape/x.yaml"));

    expect(answer).toMatchObject({
      ok: false,
      error: expect.stringContaining("outside every root"),
    });
    expect(readdir.mock.calls.map((call) => path.resolve(String(call[0])))).not.toContain(outside);
  });

  it("answers a target whose directory does not exist as a missing file", async () => {
    const handler = await handlerFor([projectDir]);

    const answer = await handler.handle(resolveLine(flowsDir, "gone/frag.yaml"));

    expect(answer).toMatchObject({ ok: true, exists: false });
  });

  it("refuses a .yaml name that links to a file of another kind", async () => {
    await fs.writeFile(path.join(projectDir, ".env"), "SECRET=1\n");
    await fs.symlink(path.join(projectDir, ".env"), path.join(flowsDir, "x.yaml"));
    const handler = await handlerFor([projectDir]);

    const answer = await handler.handle(resolveLine(flowsDir, "x.yaml"));

    expect(answer).toEqual({
      id: "req-1",
      ok: false,
      error: "x.yaml links to a file that is not a YAML file",
    });
  });

  it("serves a .yaml name that links to a .yml flow", async () => {
    await fs.writeFile(path.join(flowsDir, "real.yml"), "steps: []\n");
    await fs.symlink(path.join(flowsDir, "real.yml"), path.join(flowsDir, "alias.yaml"));
    const handler = await handlerFor([projectDir]);

    expect(await handler.handle(resolveLine(flowsDir, "alias.yaml"))).toMatchObject({
      ok: true,
      exists: true,
      canonical: path.join(flowsDir, "real.yml"),
    });
  });

  it("names a link loop as a host read would, not as a missing file", async () => {
    await fs.symlink("loop.yaml", path.join(flowsDir, "loop.yaml"));
    const handler = await handlerFor([projectDir]);

    expect(await handler.handle(resolveLine(flowsDir, "loop.yaml"))).toMatchObject({
      ok: false,
      error: expect.stringMatching(/^ELOOP: /),
    });
  });

  it("names a directory that cannot be searched as a host read would", async () => {
    // Root searches any directory, so this needs another user.
    if (process.getuid?.() === 0) return;
    const locked = path.join(flowsDir, "locked");
    await fs.mkdir(locked);
    await fs.writeFile(path.join(locked, "frag.yaml"), "steps: []\n");
    await fs.chmod(locked, 0o000);
    const handler = await handlerFor([projectDir]);

    try {
      expect(await handler.handle(resolveLine(flowsDir, "locked/frag.yaml"))).toMatchObject({
        ok: false,
        error: expect.stringMatching(/^EACCES: /),
      });
    } finally {
      await fs.chmod(locked, 0o755);
    }
  });

  it("names a directory and an unreadable file as a host read would", async () => {
    await fs.mkdir(path.join(flowsDir, "dir.yaml"));
    const handler = await handlerFor([projectDir]);

    expect(await handler.handle(resolveLine(flowsDir, "dir.yaml"))).toMatchObject({
      ok: false,
      error: "EISDIR: illegal operation on a directory, read",
    });

    // Root reads a mode-000 file anyway, so the EACCES half needs another user.
    if (process.getuid?.() === 0) return;
    const locked = path.join(flowsDir, "locked.yaml");
    await fs.writeFile(locked, "steps: []\n");
    await fs.chmod(locked, 0o000);
    try {
      expect(await handler.handle(resolveLine(flowsDir, "locked.yaml"))).toMatchObject({
        ok: false,
        error: expect.stringMatching(/^EACCES: permission denied, open /),
      });
    } finally {
      await fs.chmod(locked, 0o644);
    }
  });

  it("refuses a basename that is not .yaml", async () => {
    await fs.writeFile(path.join(flowsDir, "helper.mjs"), "export default 1;\n");
    const handler = await handlerFor([projectDir]);

    const answer = await handler.handle(resolveLine(flowsDir, "helper.mjs"));

    expect(answer).toMatchObject({ ok: false, error: expect.stringContaining("not a .yaml file") });
  });

  it("refuses a file above 32 MiB", async () => {
    // A sparse file: only the size matters, and APFS writes no data for a hole.
    const hugePath = path.join(flowsDir, "huge.yaml");
    const fh = await fs.open(hugePath, "w");
    await fh.truncate(CLIENT_CONTENT_CAP_BYTES + 1);
    await fh.close();
    const handler = await handlerFor([projectDir]);

    const answer = await handler.handle(resolveLine(flowsDir, "huge.yaml"));

    expect(answer).toMatchObject({ ok: false, error: expect.stringContaining("32 MiB") });
  });

  it("refuses an op it did not offer and a kind it does not know", async () => {
    const handler = await handlerFor([projectDir], ["resolve-file"]);
    expect(handler.param.ops).toEqual(["resolve-file"]);

    expect(
      await handler.handle({ ...resolveLine(flowsDir, "frag.yaml"), op: "read-file" })
    ).toMatchObject({ ok: false, error: "op read-file is not served by this client" });
    expect(
      await handler.handle(
        resolveLine(flowsDir, "frag.yaml", {
          args: { anchorDir: flowsDir, target: "frag.yaml", kind: "script" },
        })
      )
    ).toMatchObject({ ok: false, error: expect.stringContaining('kind "script" is not known') });
  });

  it("refuses malformed args instead of throwing", async () => {
    const handler = await handlerFor([projectDir]);

    expect(
      await handler.handle(resolveLine(flowsDir, "frag.yaml", { args: { anchorDir: 1 } as never }))
    ).toMatchObject({ ok: false, error: expect.stringContaining("needs string") });
    expect(
      await handler.handle({ ...resolveLine(flowsDir, "frag.yaml"), args: null as never })
    ).toMatchObject({ ok: false, error: expect.stringContaining("no args object") });
  });

  it("reports case_folded spelling exactly as classifyOnDiskSpelling does", async () => {
    await fs.writeFile(path.join(flowsDir, "Frag.yaml"), "steps: []\n");
    await fs.rm(path.join(flowsDir, "frag.yaml"), { force: true });
    const handler = await handlerFor([projectDir]);

    const answer = await handler.handle(resolveLine(flowsDir, "frag.yaml"));

    // On a case-insensitive filesystem (APFS, NTFS) the file opens under the
    // mis-cased spelling, so canonical resolves and the spelling says so; on a
    // case-sensitive one nothing matches. Either way the handler reports what
    // the registry's classifier reports, byte for byte.
    const expected = await classifyOnDiskSpelling(flowsDir, "frag.yaml", FLOW_FILE_NAME_PATTERN);
    expect(["case_folded", "absent"]).toContain(expected.state);
    const exists = await fs.stat(path.join(flowsDir, "frag.yaml")).then(
      () => true,
      () => false
    );
    expect(answer).toMatchObject({
      ok: true,
      canonical: await canonicalFlowPath(flowsDir + path.sep + "frag.yaml"),
      spelling: expected,
      exists,
    });
    if (expected.state === "case_folded") {
      expect(expected).toEqual({ state: "case_folded", actual: "Frag.yaml", addressable: true });
    }
  });

  it("logs the op and the path, never the content, under ARGENT_CLIENT_SERVICES_LOG=1", async () => {
    const handler = await handlerFor([projectDir]);
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await handler.handle(resolveLine(flowsDir, "frag.yaml"));
    expect(write).not.toHaveBeenCalled();

    vi.stubEnv("ARGENT_CLIENT_SERVICES_LOG", "1");
    await handler.handle(resolveLine(flowsDir, "frag.yaml"));

    expect(write.mock.calls.map((c) => String(c[0]))).toEqual([
      `[client-services] resolve-file ${path.join(flowsDir, "frag.yaml")}\n`,
    ]);
  });
});

describe("read-file and write-file", () => {
  // Where the tool-server puts a baseline: beside the root flow's real file.
  let keyDir: string;
  let baseline: string;
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

  beforeEach(() => {
    keyDir = path.join(flowsDir, "__baselines__", "login");
    baseline = path.join(keyDir, "home__ios-390x844.png");
  });

  function fileLine(
    op: "read-file" | "write-file",
    args: Record<string, unknown>
  ): ClientRequestLine {
    return { event: "client-request", invocation: "inv-1", id: "req-1", op, args };
  }
  const readLine = (file: unknown) => fileLine("read-file", { path: file });
  const writeLine = (file: unknown, bytes: Buffer) =>
    fileLine("write-file", { path: file, content: bytes.toString("base64") });

  const outsideError = (file: string, roots = [projectDir]) =>
    `${file} is outside every root this client serves (${roots.join(", ")})`;
  const notBaselineError = (file: string, verb = "writes") =>
    `${file} is not a snapshot baseline (<dir>/__baselines__/<flow>/<name>.png); ` +
    `this client ${verb} baselines only`;

  async function exists(file: string): Promise<boolean> {
    return fs.lstat(file).then(
      () => true,
      () => false
    );
  }

  /**
   * `<proj>/deep/__baselines__/login`, whose real location is longer than
   * PATH_MAX: realpath gives up with ENAMETOOLONG, while the kernel, which
   * expands `deep` (a short relative link) on its own, still follows the path.
   * A git checkout can carry such links. `cleanup` removes the tree bottom-up
   * through links, since no absolute path reaches its deepest level.
   */
  async function overlongKeyDir(): Promise<{ keyDir: string; cleanup: () => Promise<void> }> {
    const pathMax = process.platform === "linux" ? 4096 : 1024;
    const rest = "/__baselines__/login/home.png".length;
    // The link target plus the rest of the spelled path stays under PATH_MAX;
    // with the project prefix in front, the real path does not.
    const segments: string[] = [];
    for (let left = pathMax - rest - 8; left > 1; left -= 201) {
      segments.push("d".repeat(Math.min(200, left - 1)));
    }
    const via = (k: number) => path.join(projectDir, k === segments.length ? "deep" : `t${k}`);
    await fs.mkdir(path.join(projectDir, "c"), { recursive: true });
    for (let k = 0; k <= segments.length; k++) {
      await fs.symlink(path.join("c", ...segments.slice(0, k)), via(k));
      if (k < segments.length) await fs.mkdir(path.join(via(k), segments[k]!));
    }
    const keyDir = path.join(via(segments.length), "__baselines__", "login");
    await fs.mkdir(keyDir, { recursive: true });
    const cleanup = async () => {
      await fs.rm(path.join(via(segments.length), "__baselines__"), { recursive: true });
      for (let k = segments.length - 1; k >= 0; k--)
        await fs.rmdir(path.join(via(k), segments[k]!));
    };
    return { keyDir, cleanup };
  }

  it("refuses a read whose real location realpath cannot name", async () => {
    const secret = path.join(tmpDir, "outside", "id_rsa");
    await fs.mkdir(path.dirname(secret));
    await fs.writeFile(secret, "PRIVATE KEY");
    const { keyDir: deepKey, cleanup } = await overlongKeyDir();
    try {
      const file = path.join(deepKey, "home.png");
      await fs.symlink(secret, file);
      await expect(fs.realpath(file)).rejects.toMatchObject({ code: "ENAMETOOLONG" });
      await expect(fs.readFile(file, "utf8")).resolves.toBe("PRIVATE KEY");
      const handler = await handlerFor([projectDir]);

      expect(await handler.handle(readLine(file))).toEqual({
        id: "req-1",
        ok: false,
        error: outsideError(file),
      });
    } finally {
      await cleanup();
    }
  });

  it("refuses a write whose real location realpath cannot name", async () => {
    const outside = path.join(tmpDir, "outside");
    await fs.mkdir(outside);
    const { keyDir: deepKey, cleanup } = await overlongKeyDir();
    try {
      const file = path.join(deepKey, "home.png");
      await fs.symlink(path.join(outside, "victim.png"), file);
      await fs.writeFile(path.join(outside, "victim.png"), "untouched");
      const handler = await handlerFor([projectDir]);

      expect(await handler.handle(writeLine(file, PNG))).toEqual({
        id: "req-1",
        ok: false,
        error: outsideError(file),
      });
      expect(await fs.readFile(path.join(outside, "victim.png"), "utf8")).toBe("untouched");
    } finally {
      await cleanup();
    }
  });

  it("answers exists:false for a missing baseline", async () => {
    const handler = await handlerFor([projectDir]);

    expect(await handler.handle(readLine(baseline))).toEqual({
      id: "req-1",
      ok: true,
      exists: false,
    });
  });

  it("reads a baseline as base64 with its size", async () => {
    await fs.mkdir(keyDir, { recursive: true });
    await fs.writeFile(baseline, PNG);
    const st = await fs.stat(baseline);
    const handler = await handlerFor([projectDir]);

    expect(await handler.handle(readLine(baseline))).toEqual({
      id: "req-1",
      ok: true,
      exists: true,
      size: PNG.length,
      mtimeMs: st.mtimeMs,
      content: PNG.toString("base64"),
    });
  });

  it("refuses a read outside the roots", async () => {
    const outside = path.join(tmpDir, "outside", "__baselines__", "login", "home.png");
    await fs.mkdir(path.dirname(outside), { recursive: true });
    await fs.writeFile(outside, PNG);
    const handler = await handlerFor([projectDir]);

    expect(await handler.handle(readLine(outside))).toEqual({
      id: "req-1",
      ok: false,
      error: outsideError(outside),
    });
  });

  it("refuses a read through a symlink that leaves the roots", async () => {
    const elsewhere = path.join(tmpDir, "elsewhere");
    await fs.mkdir(elsewhere);
    await fs.mkdir(path.join(elsewhere, "login"));
    await fs.writeFile(path.join(elsewhere, "login", "real.png"), PNG);
    await fs.mkdir(keyDir, { recursive: true });
    await fs.symlink(path.join(elsewhere, "login", "real.png"), baseline);
    // A whole `__baselines__` directory that leads out, too.
    const otherFlows = path.join(projectDir, "other-flows");
    await fs.mkdir(otherFlows);
    await fs.symlink(elsewhere, path.join(otherFlows, "__baselines__"));
    const throughDir = path.join(otherFlows, "__baselines__", "login", "real.png");
    const handler = await handlerFor([projectDir]);

    for (const file of [baseline, throughDir]) {
      const answer = await handler.handle(readLine(file));
      expect(answer).toEqual({ id: "req-1", ok: false, error: outsideError(file) });
      // Where it points is the client's business: the server only learns "outside".
      expect((answer as { error: string }).error).not.toContain(elsewhere);
    }
  });

  it("refuses a read of a .png name that links to another kind of file", async () => {
    await fs.writeFile(path.join(projectDir, ".env"), "SECRET=1\n");
    await fs.mkdir(keyDir, { recursive: true });
    await fs.symlink(path.join(projectDir, ".env"), baseline);
    const handler = await handlerFor([projectDir]);

    expect(await handler.handle(readLine(baseline))).toEqual({
      id: "req-1",
      ok: false,
      error: `${baseline} links to a file that is not a PNG file`,
    });
  });

  it("refuses a .mjs read, a .yaml read and a .png outside __baselines__", async () => {
    await fs.writeFile(path.join(flowsDir, "helper.mjs"), "export default 1;\n");
    const screenshot = path.join(projectDir, "docs", "Screenshot 2026-10-06.png");
    await fs.mkdir(path.dirname(screenshot));
    await fs.writeFile(screenshot, PNG);
    const handler = await handlerFor([projectDir]);

    // All exist inside the root: read-file serves baselines only.
    for (const file of [
      path.join(flowsDir, "helper.mjs"),
      path.join(flowsDir, "frag.yaml"),
      screenshot,
      path.join(flowsDir, "__baselines__", "home.png"),
      path.join(flowsDir, "__baselines__", "a b", "home.png"),
    ]) {
      expect(await handler.handle(readLine(file))).toEqual({
        id: "req-1",
        ok: false,
        error: notBaselineError(file, "serves"),
      });
    }
  });

  it("refuses a read with a .. segment, a relative path and a non-string path", async () => {
    await fs.mkdir(keyDir, { recursive: true });
    await fs.writeFile(baseline, PNG);
    const handler = await handlerFor([projectDir]);

    // The `..` path names the existing baseline inside the root: it is the
    // form that is refused. (path.join would fold the `..` away.)
    const dotted = [keyDir, "..", "login", path.basename(baseline)].join(path.sep);
    const relative = path.join(".argent", "flows", "__baselines__", "login", "x.png");
    for (const file of [dotted, relative]) {
      expect(await handler.handle(readLine(file))).toEqual({
        id: "req-1",
        ok: false,
        error: notBaselineError(file, "serves"),
      });
    }
    expect(await handler.handle(readLine(1))).toEqual({
      id: "req-1",
      ok: false,
      error: "read-file needs a string path",
    });
  });

  it("names a directory as a host read would", async () => {
    await fs.mkdir(path.join(keyDir, "dir.png"), { recursive: true });
    const handler = await handlerFor([projectDir]);

    expect(await handler.handle(readLine(path.join(keyDir, "dir.png")))).toEqual({
      id: "req-1",
      ok: false,
      error: "EISDIR: illegal operation on a directory, read",
    });
  });

  it("refuses a read above 32 MiB", async () => {
    // A sparse file: only the size matters, and APFS writes no data for a hole.
    await fs.mkdir(keyDir, { recursive: true });
    const fh = await fs.open(baseline, "w");
    await fh.truncate(CLIENT_CONTENT_CAP_BYTES + 1);
    await fh.close();
    const handler = await handlerFor([projectDir]);

    expect(await handler.handle(readLine(baseline))).toEqual({
      id: "req-1",
      ok: false,
      error: `${baseline} is larger than the 32 MiB cap on a file sent to the tool-server`,
    });
  });

  it("refuses a write outside __baselines__", async () => {
    const handler = await handlerFor([projectDir]);

    for (const file of [
      path.join(projectDir, ".argent", "flows", "x.yaml"),
      path.join(projectDir, ".argent", "flows", "x.png"),
      // No `<flow>` directory between `__baselines__` and the file.
      path.join(flowsDir, "__baselines__", "x.png"),
      // The right directory, the wrong kind of file.
      path.join(keyDir, "x.yaml"),
    ]) {
      expect(await handler.handle(writeLine(file, PNG))).toEqual({
        id: "req-1",
        ok: false,
        error: notBaselineError(file),
      });
      expect(await exists(file)).toBe(false);
    }
    expect(await exists(path.join(flowsDir, "__baselines__"))).toBe(false);
  });

  it("refuses a write whose key is not a flow name", async () => {
    const handler = await handlerFor([projectDir]);

    for (const key of ["a b", "a.b"]) {
      const file = path.join(flowsDir, "__baselines__", key, "x.png");
      expect(await handler.handle(writeLine(file, PNG))).toEqual({
        id: "req-1",
        ok: false,
        error: notBaselineError(file),
      });
    }
    expect(await exists(path.join(flowsDir, "__baselines__"))).toBe(false);
  });

  it("refuses a write with a .. segment, a relative path and non-string args", async () => {
    const handler = await handlerFor([projectDir]);

    // The `..` path lands on a valid baseline inside the root: it is the form
    // that is refused.
    const dotted = [flowsDir, "other", "..", "__baselines__", "login", "x.png"].join(path.sep);
    const relative = path.join(".argent", "flows", "__baselines__", "login", "x.png");
    for (const file of [dotted, relative]) {
      expect(await handler.handle(writeLine(file, PNG))).toEqual({
        id: "req-1",
        ok: false,
        error: notBaselineError(file),
      });
    }
    expect(await exists(path.join(flowsDir, "__baselines__"))).toBe(false);

    for (const args of [{ path: baseline }, { path: 1, content: "" }, { content: "" }]) {
      expect(await handler.handle(fileLine("write-file", args))).toEqual({
        id: "req-1",
        ok: false,
        error: "write-file needs string path and content",
      });
    }
  });

  it("refuses a write through a __baselines__ symlink that leaves the roots", async () => {
    const outside = path.join(tmpDir, "outside");
    await fs.mkdir(outside);
    await fs.symlink(outside, path.join(flowsDir, "__baselines__"));
    const handler = await handlerFor([projectDir]);

    const answer = await handler.handle(writeLine(baseline, PNG));

    expect(answer).toEqual({ id: "req-1", ok: false, error: outsideError(baseline) });
    expect((answer as { error: string }).error).not.toContain(outside);
    // Fenced before the key directory is made: nothing was created out there.
    expect(await fs.readdir(outside)).toEqual([]);
  });

  it("refuses a write through a baseline file that is a symlink out of the roots", async () => {
    const outside = path.join(tmpDir, "outside");
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, "real.png"), "old");
    await fs.mkdir(keyDir, { recursive: true });
    await fs.symlink(path.join(outside, "real.png"), baseline);
    const handler = await handlerFor([projectDir]);

    const answer = await handler.handle(writeLine(baseline, PNG));

    expect(answer).toEqual({ id: "req-1", ok: false, error: outsideError(baseline) });
    expect((answer as { error: string }).error).not.toContain(outside);
    expect(await fs.readFile(path.join(outside, "real.png"), "utf8")).toBe("old");
  });

  it("refuses a write through a dangling baseline symlink out of the roots", async () => {
    const outside = path.join(tmpDir, "outside");
    await fs.mkdir(outside);
    await fs.mkdir(keyDir, { recursive: true });
    await fs.symlink(path.join(outside, "planted.sh"), baseline);
    const handler = await handlerFor([projectDir]);

    const answer = await handler.handle(writeLine(baseline, PNG));

    expect({ answer, outside: await fs.readdir(outside) }).toEqual({
      answer: { id: "req-1", ok: false, error: outsideError(baseline) },
      outside: [],
    });
  });

  it("refuses a write through a dangling baseline symlink inside the roots", async () => {
    await fs.mkdir(keyDir, { recursive: true });
    await fs.symlink(path.join(projectDir, "missing.png"), baseline);
    const handler = await handlerFor([projectDir]);

    expect(await handler.handle(writeLine(baseline, PNG))).toEqual({
      id: "req-1",
      ok: false,
      error: `${baseline} is a symbolic link to a missing file`,
    });
    expect(await exists(path.join(projectDir, "missing.png"))).toBe(false);
  });

  it("answers a link out of the roots the same whether or not its target exists", async () => {
    // A refusal must not tell the tool-server whether an outside path exists.
    const outside = path.join(tmpDir, "outside");
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, "there.png"), PNG);
    await fs.mkdir(keyDir, { recursive: true });
    const there = path.join(keyDir, "there.png");
    const gone = path.join(keyDir, "gone.png");
    await fs.symlink(path.join(outside, "there.png"), there);
    await fs.symlink(path.join(outside, "gone.png"), gone);
    const handler = await handlerFor([projectDir]);

    for (const file of [there, gone]) {
      for (const line of [readLine(file), writeLine(file, PNG)]) {
        expect(await handler.handle(line)).toEqual({
          id: "req-1",
          ok: false,
          error: outsideError(file),
        });
      }
    }
    expect(await fs.readdir(outside)).toEqual(["there.png"]);
  });

  it("refuses a write through a baseline that links to another kind of file", async () => {
    await fs.writeFile(path.join(projectDir, ".env"), "SECRET=1\n");
    await fs.mkdir(keyDir, { recursive: true });
    await fs.symlink(path.join(projectDir, ".env"), baseline);
    const handler = await handlerFor([projectDir]);

    expect(await handler.handle(writeLine(baseline, PNG))).toEqual({
      id: "req-1",
      ok: false,
      error: `${baseline} links to a file that is not a PNG file`,
    });
    expect(await fs.readFile(path.join(projectDir, ".env"), "utf8")).toBe("SECRET=1\n");
  });

  it("writes a baseline under a root that is the real location of a symlinked .argent/flows", async () => {
    // The project keeps its flows in a tree outside it; the tools client sends
    // the project and its `.argent/flows`, and the server names the baseline
    // beside the root flow's REAL file.
    const sharedFlows = path.join(tmpDir, "shared-flows");
    await fs.mkdir(sharedFlows);
    await fs.writeFile(path.join(sharedFlows, "login.yaml"), "steps: []\n");
    const linkedProject = path.join(tmpDir, "linked-proj");
    await fs.mkdir(path.join(linkedProject, ".argent"), { recursive: true });
    await fs.symlink(sharedFlows, path.join(linkedProject, ".argent", "flows"));
    const file = path.join(sharedFlows, "__baselines__", "login", "home.png");

    const handler = await handlerFor([linkedProject, path.join(linkedProject, ".argent", "flows")]);
    expect(handler.param.roots).toEqual([linkedProject, sharedFlows]);

    expect(await handler.handle(writeLine(file, PNG))).toEqual({
      id: "req-1",
      ok: true,
      written: file,
      replaced: false,
    });
    expect(await fs.readFile(file)).toEqual(PNG);

    // The flows root is what admits it: the project alone does not reach there.
    await fs.rm(path.join(sharedFlows, "__baselines__"), { recursive: true });
    const projectOnly = await handlerFor([linkedProject]);
    expect(await projectOnly.handle(writeLine(file, PNG))).toEqual({
      id: "req-1",
      ok: false,
      error: outsideError(file, [linkedProject]),
    });
    expect(await exists(path.join(sharedFlows, "__baselines__"))).toBe(false);
  });

  it("writes a baseline and creates the key directory", async () => {
    const handler = await handlerFor([projectDir]);

    expect(await handler.handle(writeLine(baseline, PNG))).toEqual({
      id: "req-1",
      ok: true,
      written: baseline,
      replaced: false,
    });
    expect(await fs.readFile(baseline)).toEqual(PNG);
    // What was written reads back through read-file byte for byte.
    expect(await handler.handle(readLine(baseline))).toMatchObject({
      ok: true,
      exists: true,
      content: PNG.toString("base64"),
    });
  });

  it("overwrites an existing baseline", async () => {
    await fs.mkdir(keyDir, { recursive: true });
    await fs.writeFile(baseline, Buffer.alloc(64, 7));
    const handler = await handlerFor([projectDir]);

    // Shorter than the old file, so a write that did not truncate would show.
    expect(await handler.handle(writeLine(baseline, PNG))).toEqual({
      id: "req-1",
      ok: true,
      written: baseline,
      replaced: true,
    });
    expect(await fs.readFile(baseline)).toEqual(PNG);
  });

  it("refuses content over 32 MiB and writes content of exactly 32 MiB", async () => {
    const handler = await handlerFor([projectDir]);

    expect(
      await handler.handle(writeLine(baseline, Buffer.alloc(CLIENT_CONTENT_CAP_BYTES + 1)))
    ).toEqual({
      id: "req-1",
      ok: false,
      error: `${baseline}: the baseline is larger than the 32 MiB cap on a file it writes`,
    });
    // Refused before the key directory is made.
    expect(await exists(path.join(flowsDir, "__baselines__"))).toBe(false);

    expect(
      await handler.handle(writeLine(baseline, Buffer.alloc(CLIENT_CONTENT_CAP_BYTES)))
    ).toMatchObject({ ok: true, written: baseline });
    expect((await fs.stat(baseline)).size).toBe(CLIENT_CONTENT_CAP_BYTES);
  });

  it("logs the op and the path, never the content, under ARGENT_CLIENT_SERVICES_LOG=1", async () => {
    const handler = await handlerFor([projectDir]);
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await handler.handle(writeLine(baseline, PNG));
    await handler.handle(readLine(baseline));
    expect(write).not.toHaveBeenCalled();

    vi.stubEnv("ARGENT_CLIENT_SERVICES_LOG", "1");
    await handler.handle(writeLine(baseline, PNG));
    await handler.handle(readLine(baseline));

    expect(write.mock.calls.map((c) => String(c[0]))).toEqual([
      `[client-services] write-file ${baseline}\n`,
      `[client-services] read-file ${baseline}\n`,
    ]);

    // A refused request names no file: nothing was read or written.
    write.mockClear();
    await handler.handle(writeLine(path.join(projectDir, "notes.png"), PNG));
    await handler.handle(readLine(path.join(tmpDir, "x", "__baselines__", "k", "home.png")));
    expect(write).not.toHaveBeenCalled();
  });

  it("refuses read-file and write-file when the server did not advertise them", async () => {
    await fs.mkdir(keyDir, { recursive: true });
    await fs.writeFile(baseline, PNG);
    const handler = await handlerFor([projectDir], ["resolve-file"]);
    expect(handler.param.ops).toEqual(["resolve-file"]);

    expect(await handler.handle(readLine(baseline))).toEqual({
      id: "req-1",
      ok: false,
      error: "op read-file is not served by this client",
    });
    const other = path.join(keyDir, "other.png");
    expect(await handler.handle(writeLine(other, PNG))).toEqual({
      id: "req-1",
      ok: false,
      error: "op write-file is not served by this client",
    });
    expect(await exists(other)).toBe(false);
  });
});

describe("roots", () => {
  it("serves a file under a second root", async () => {
    const other = path.join(tmpDir, "other");
    await fs.mkdir(other);
    await fs.writeFile(path.join(other, "a.yaml"), "steps: []\n");
    const handler = await handlerFor([projectDir, other]);

    expect(await handler.handle(resolveLine(other, "a.yaml"))).toMatchObject({
      ok: true,
      canonical: path.join(await fs.realpath(other), "a.yaml"),
      exists: true,
    });
  });
});
