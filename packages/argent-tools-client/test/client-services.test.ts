import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import { createRequire, syncBuiltinESMExports } from "node:module";
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
// it sees every directory the handler lists; the handler's own named imports
// see the spy once syncBuiltinESMExports() has run.
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
  syncBuiltinESMExports();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

const ALL: ClientServiceOp[] = ["resolve-file", "read-file", "write-file"];

/**
 * A handler as the tools client builds it. By default the root flow is
 * `root.yaml`, and the run's baselines live in `.argent/flows/__baselines__/login`,
 * beside the real file of `login.yaml`, the root flow of the read-file and
 * write-file tests; a test of the root fence names another directory.
 */
async function handlerFor(
  roots: string[],
  {
    rootFlow = path.join(flowsDir, "root.yaml"),
    advertised = ALL,
    baselineDir = path.join(flowsDir, "__baselines__", "login"),
    log,
  } = {} as {
    rootFlow?: string;
    advertised?: ClientServiceOp[];
    baselineDir?: string | null;
    log?: (line: string) => void;
  }
) {
  const handler = await createClientServicesHandler({
    roots,
    rootFlow,
    advertised,
    baselineDir,
    log,
  });
  if (!handler) throw new Error("expected a handler");
  return handler;
}

/** Make the root flow compose exactly these run: targets. */
async function composes(...targets: string[]): Promise<void> {
  await fs.writeFile(
    path.join(flowsDir, "root.yaml"),
    `steps:\n${targets.map((t) => `  - run: ${JSON.stringify(t)}\n`).join("")}`
  );
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
    const handler = await handlerFor([linkToProject, path.join(tmpDir, "nope")], {
      advertised: ["write-file", "run-script", "resolve-file"],
    });
    expect(handler.param).toEqual({
      ops: ["resolve-file", "write-file"],
      roots: [projectDir],
    });
  });

  it("returns null with no existing root and with no shared op", async () => {
    const none = { rootFlow: path.join(flowsDir, "root.yaml"), baselineDir: null };
    expect(
      await createClientServicesHandler({
        roots: [path.join(tmpDir, "nope")],
        advertised: ALL,
        ...none,
      })
    ).toBeNull();
    // run-script is not one of this client's ops.
    expect(
      await createClientServicesHandler({
        roots: [projectDir],
        advertised: ["run-script"],
        ...none,
      })
    ).toBeNull();
    expect(
      await createClientServicesHandler({ roots: [projectDir], advertised: [], ...none })
    ).toBeNull();
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
    // The server anchors its first request at the root flow's directory as
    // the caller spelled it: a root the client sent, through a symlink its
    // real path does not cross.
    const linkedFlows = path.join(tmpDir, "flows-link");
    await fs.symlink(flowsDir, linkedFlows);
    await composes("../../shared/login.yaml");
    const handler = await handlerFor([projectDir, linkedFlows]);

    const answer = await handler.handle(resolveLine(linkedFlows, "../../shared/login.yaml"));

    expect(answer).toMatchObject({
      ok: true,
      canonical: path.join(sharedDir, "login.yaml"),
      spelling: { state: "listed" },
      exists: true,
    });
  });

  it("answers exists: false for a missing fragment", async () => {
    await composes("missing.yaml");
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

    expect(answer).toEqual({
      id: "req-1",
      ok: false,
      error: `frag.yaml is outside every root this client serves (${projectDir})`,
    });
  });

  it("refuses an in-root link to an outside file with the same text whether or not that file exists", async () => {
    const outside = path.join(tmpDir, "outside");
    await fs.mkdir(outside);
    await fs.symlink(path.join(outside, "y.yaml"), path.join(flowsDir, "x.yaml"));
    const handler = await handlerFor([projectDir]);

    await fs.writeFile(path.join(outside, "y.yaml"), "secret: 1\n");
    const exists = await handler.handle(resolveLine(flowsDir, "x.yaml"));
    await fs.rm(path.join(outside, "y.yaml"));
    const missing = await handler.handle(resolveLine(flowsDir, "x.yaml"));

    expect(exists).toEqual({
      id: "req-1",
      ok: false,
      error: `x.yaml is outside every root this client serves (${projectDir})`,
    });
    expect(missing).toEqual(exists);
  });

  it("answers a dangling in-root link to an in-root file as that missing file", async () => {
    await fs.symlink(path.join(flowsDir, "gone.yaml"), path.join(flowsDir, "dangling.yaml"));
    await composes("dangling.yaml");
    const handler = await handlerFor([projectDir]);

    expect(await handler.handle(resolveLine(flowsDir, "dangling.yaml"))).toEqual({
      id: "req-1",
      ok: true,
      canonical: path.join(flowsDir, "gone.yaml"),
      spelling: { state: "listed" },
      exists: false,
    });
  });

  it("refuses a target that leaves the roots and comes back with .. the same way whatever is out there", async () => {
    // An honest kernel walk leaves the root at `outside` whether or not it
    // exists; collapsing the `..` lexically would come back in and serve
    // frag.yaml only when `outside` is missing, or only when it exists.
    const outside = path.join(tmpDir, "outside");
    const target = "../../../outside/../proj/.argent/flows/frag.yaml";
    const handler = await handlerFor([projectDir]);

    await fs.mkdir(outside);
    const asDirectory = await handler.handle(resolveLine(flowsDir, target));
    await fs.rmdir(outside);
    await fs.writeFile(outside, "x");
    const asFile = await handler.handle(resolveLine(flowsDir, target));
    await fs.rm(outside);
    const absent = await handler.handle(resolveLine(flowsDir, target));

    expect(asDirectory).toEqual({
      id: "req-1",
      ok: false,
      error: `${target} is outside every root this client serves (${projectDir})`,
    });
    expect(asFile).toEqual(asDirectory);
    expect(absent).toEqual(asDirectory);
  });

  it("touches nothing outside the roots while it refuses a path that leaves them", async () => {
    const outside = path.join(tmpDir, "outside");
    await fs.mkdir(outside);
    const handler = await handlerFor([projectDir]);
    const spies = (
      ["lstat", "stat", "realpath", "readlink", "readdir", "readFile", "open"] as const
    ).map((name) => vi.spyOn(fsCjs, name));
    syncBuiltinESMExports();

    const answer = await handler.handle(
      resolveLine(flowsDir, "../../../outside/../proj/.argent/flows/frag.yaml")
    );
    vi.restoreAllMocks();
    syncBuiltinESMExports();

    const touched = spies.flatMap((spy) => spy.mock.calls.map((call) => String(call[0])));
    // The spies are live: the walk looked at the anchor on its way.
    expect(touched).toContain(flowsDir);
    // A spelling that names `outside` as a component makes the kernel look there.
    expect(touched.filter((p) => p.split(path.sep).includes("outside"))).toEqual([]);
    expect(answer).toMatchObject({ ok: false });
  });

  it("answers the realpath of every existing file, as a co-located run resolves it", async () => {
    const sharedDir = path.join(projectDir, "shared");
    await fs.mkdir(sharedDir);
    await fs.writeFile(path.join(sharedDir, "login.yaml"), "steps: []\n");
    await fs.writeFile(path.join(projectDir, "beside.yaml"), "steps: []\n");
    // A lexical collapse of `linked/../beside.yaml` would name this one.
    await fs.writeFile(path.join(flowsDir, "beside.yaml"), "steps: []\n");
    await fs.symlink(sharedDir, path.join(flowsDir, "linked"));
    await fs.symlink("../../shared/login.yaml", path.join(flowsDir, "alias.yaml"));
    const targets = ["frag.yaml", "linked/login.yaml", "linked/../beside.yaml", "alias.yaml"];
    // On a case-insensitive filesystem a mis-cased name opens too.
    const folds = await fs.stat(path.join(flowsDir, "FRAG.yaml")).then(
      () => true,
      () => false
    );
    if (folds) targets.push("FRAG.yaml");
    await composes(...targets);
    const handler = await handlerFor([projectDir]);
    for (const target of targets) {
      const spelled = flowsDir + path.sep + target;
      expect(await handler.handle(resolveLine(flowsDir, target))).toMatchObject({
        ok: true,
        exists: true,
        canonical: await fs.realpath(spelled),
      });
    }
    expect(await fs.realpath(flowsDir + path.sep + "linked/../beside.yaml")).toBe(
      path.join(projectDir, "beside.yaml")
    );
  });

  it("resolves a root spelled through a symlink that lies above its real path", async () => {
    // As /var is a link to /private/var on macOS: the spelling crosses a link
    // that is neither inside a real root nor on the way to one.
    await fs.mkdir(path.join(tmpDir, "real"));
    await fs.rename(projectDir, path.join(tmpDir, "real", "proj"));
    await fs.symlink(path.join(tmpDir, "real"), path.join(tmpDir, "alias"));
    const spelledFlows = path.join(tmpDir, "alias", "proj", ".argent", "flows");
    const handler = await handlerFor([path.join(tmpDir, "alias", "proj"), spelledFlows], {
      rootFlow: path.join(spelledFlows, "root.yaml"),
    });

    expect(await handler.handle(resolveLine(spelledFlows, "root.yaml"))).toMatchObject({
      ok: true,
      exists: true,
      canonical: path.join(tmpDir, "real", "proj", ".argent", "flows", "root.yaml"),
    });
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

  it("follows a link of the user's that is spelled through an alias above the roots", async () => {
    // As a link to $TMPDIR/... on macOS goes through /var, a link to /var/... .
    const vault = path.join(tmpDir, "real", "vault");
    await fs.mkdir(vault, { recursive: true });
    await fs.writeFile(path.join(vault, "x.yaml"), "steps:\n  - run: frag.yaml\n");
    await fs.symlink(path.join(tmpDir, "real"), path.join(tmpDir, "alias"));
    await fs.symlink(path.join(tmpDir, "alias", "vault", "x.yaml"), path.join(flowsDir, "x.yaml"));
    const handler = await handlerFor([projectDir, vault], {
      rootFlow: path.join(flowsDir, "x.yaml"),
    });

    expect(await handler.handle(resolveLine(flowsDir, "x.yaml"))).toMatchObject({
      ok: true,
      exists: true,
      canonical: path.join(vault, "x.yaml"),
    });
    // The same alias spelled by the server is outside the roots.
    expect(await handler.handle(resolveLine(flowsDir, "../../../alias/vault/x.yaml"))).toEqual({
      id: "req-1",
      ok: false,
      error: `../../../alias/vault/x.yaml is outside every root this client serves (${projectDir}, ${vault})`,
    });
  });

  it("names a file used as a directory as a host read would", async () => {
    // A host read of a run: target names ENOTDIR; only read-file answers it as missing.
    await composes("frag.yaml/x.yaml");
    const handler = await handlerFor([projectDir]);

    expect(await handler.handle(resolveLine(flowsDir, "frag.yaml/x.yaml"))).toMatchObject({
      ok: false,
      error: expect.stringMatching(/^ENOTDIR: /),
    });
  });

  it("answers a target whose directory does not exist as a missing file", async () => {
    await composes("gone/frag.yaml");
    const handler = await handlerFor([projectDir]);

    const answer = await handler.handle(resolveLine(flowsDir, "gone/frag.yaml"));

    expect(answer).toMatchObject({ ok: true, exists: false });
  });

  it("refuses a .yaml name that links to a file of another kind", async () => {
    await fs.writeFile(path.join(projectDir, ".env"), "SECRET=1\n");
    await fs.symlink(path.join(projectDir, ".env"), path.join(flowsDir, "x.yaml"));
    await composes("x.yaml");
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
    await composes("alias.yaml");
    const handler = await handlerFor([projectDir]);

    expect(await handler.handle(resolveLine(flowsDir, "alias.yaml"))).toMatchObject({
      ok: true,
      exists: true,
      canonical: path.join(flowsDir, "real.yml"),
    });
  });

  it("names a link loop as a host read would, not as a missing file", async () => {
    await fs.symlink("loop.yaml", path.join(flowsDir, "loop.yaml"));
    await composes("loop.yaml");
    const handler = await handlerFor([projectDir]);

    expect(await handler.handle(resolveLine(flowsDir, "loop.yaml"))).toMatchObject({
      ok: false,
      error: expect.stringMatching(/^ELOOP: /),
    });
  });

  it("names a directory and an unreadable file as a host read would", async () => {
    await fs.mkdir(path.join(flowsDir, "dir.yaml"));
    await composes("dir.yaml", "locked.yaml");
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
    await composes("huge.yaml");
    const handler = await handlerFor([projectDir]);

    const answer = await handler.handle(resolveLine(flowsDir, "huge.yaml"));

    expect(answer).toMatchObject({ ok: false, error: expect.stringContaining("32 MiB") });
  });

  it("refuses an op it did not offer and a kind it does not know", async () => {
    const handler = await handlerFor([projectDir], { advertised: ["resolve-file"] });
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
      `[client-services] resolve-file ${path.join(flowsDir, "frag.yaml")}: served\n`,
    ]);
  });
});

describe("read-file and write-file", () => {
  // Where the tool-server puts a baseline: beside the root flow's real file.
  let keyDir: string;
  let baseline: string;
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

  beforeEach(async () => {
    keyDir = path.join(flowsDir, "__baselines__", "login");
    baseline = path.join(keyDir, "home__ios-390x844.png");
    await fs.writeFile(path.join(flowsDir, "login.yaml"), "steps:\n  - snapshot: home\n");
  });

  /** A handler for a run of `login.yaml`, a root flow that takes a snapshot and composes nothing. */
  const snapshotHandlerFor = (roots: string[], opts: Parameters<typeof handlerFor>[1] = {}) =>
    handlerFor(roots, { rootFlow: path.join(flowsDir, "login.yaml"), ...opts });

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
  const notBaselineError = (file: string) =>
    `${file} is not a snapshot baseline (<dir>/__baselines__/<flow>/<name>.png); ` +
    `this client writes baselines only`;
  const notServedError = (file: string) =>
    `${file} is neither a file argument of a tool: step in a flow this client served ` +
    `nor a snapshot baseline (<dir>/__baselines__/<flow>/<name>.png)`;

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
      const handler = await snapshotHandlerFor([projectDir], { baselineDir: deepKey });

      // The walk meets the length limit on its way down the real path, before
      // the link out, and refuses with the kernel's error.
      const answer = await handler.handle(readLine(file));
      expect(answer).toEqual({
        id: "req-1",
        ok: false,
        error: expect.stringMatching(/^ENAMETOOLONG: name too long, lstat '/),
      });
      expect((answer as { error: string }).error).not.toContain(path.dirname(secret));
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
      const handler = await snapshotHandlerFor([projectDir], { baselineDir: deepKey });

      const answer = await handler.handle(writeLine(file, PNG));
      expect(answer).toEqual({
        id: "req-1",
        ok: false,
        error: expect.stringMatching(/^ENAMETOOLONG: name too long, lstat '/),
      });
      expect((answer as { error: string }).error).not.toContain(outside);
      expect(await fs.readFile(path.join(outside, "victim.png"), "utf8")).toBe("untouched");
    } finally {
      await cleanup();
    }
  });

  it("refuses a baseline path that is not in normal form", async () => {
    // A doubled slash after a dangling link would hide the link from the
    // fence, and on macOS mkdir -p would build the rest under its target.
    const baselines = path.join(flowsDir, "__baselines__");
    const made = path.join(tmpDir, "outside", "made");
    await fs.mkdir(path.dirname(made));
    await fs.mkdir(baselines, { recursive: true });
    await fs.symlink(made, path.join(baselines, "login"));
    await fs.symlink(made, path.join(projectDir, "dl"));
    const handler = await snapshotHandlerFor([projectDir]);

    for (const file of [
      `${baselines}/login//x.png`,
      `${projectDir}/dl//any/tree/__baselines__/login/x.png`,
      `${baselines}/./login/x.png`,
    ]) {
      expect(await handler.handle(writeLine(file, PNG))).toEqual({
        id: "req-1",
        ok: false,
        error: notBaselineError(file),
      });
      expect(await handler.handle(readLine(file))).toEqual({
        id: "req-1",
        ok: false,
        error: notServedError(file),
      });
    }
    expect(await exists(made)).toBe(false);
  });

  it("fences a dangling link where the kernel goes, behind a directory link", async () => {
    // The key directory links to the project itself, so the baseline's real
    // parent is the project: its `..` leads out, not into __baselines__.
    await fs.mkdir(path.dirname(keyDir), { recursive: true });
    await fs.symlink(projectDir, keyDir);
    await fs.symlink("../outside/gone.png", path.join(projectDir, "x.png"));
    await fs.mkdir(path.join(tmpDir, "outside"));
    const file = path.join(keyDir, "x.png");
    const handler = await snapshotHandlerFor([projectDir]);

    const whenMissing = await handler.handle(readLine(file));
    await fs.writeFile(path.join(tmpDir, "outside", "gone.png"), PNG);
    const whenThere = await handler.handle(readLine(file));

    expect(whenMissing).toEqual({ id: "req-1", ok: false, error: outsideError(file) });
    expect(whenThere).toEqual(whenMissing);
  });

  it("applies a dangling link's `..` after the links before it, as the kernel does", async () => {
    // `s/../probe.*` enters `s`, a link out of the roots, before `..` applies:
    // the target lies out there, whether or not it exists.
    const outside = path.join(tmpDir, "outside");
    await fs.mkdir(path.join(outside, "sub"), { recursive: true });
    await fs.mkdir(keyDir, { recursive: true });
    await fs.symlink(path.join(outside, "sub"), path.join(keyDir, "s"));
    await fs.symlink("s/../probe.png", baseline);
    await fs.symlink(path.join(outside, "sub"), path.join(flowsDir, "s"));
    await fs.symlink("s/../probe.yaml", path.join(flowsDir, "l.yaml"));
    const handler = await snapshotHandlerFor([projectDir]);
    const answers = async () => [
      await handler.handle(readLine(baseline)),
      await handler.handle(writeLine(baseline, PNG)),
      await handler.handle(resolveLine(flowsDir, "l.yaml")),
    ];
    const refusals = [
      { id: "req-1", ok: false, error: outsideError(baseline) },
      { id: "req-1", ok: false, error: outsideError(baseline) },
      { id: "req-1", ok: false, error: outsideError("l.yaml") },
    ];

    const whenMissing = await answers();
    expect(await fs.readdir(outside)).toEqual(["sub"]);
    await fs.writeFile(path.join(outside, "probe.png"), "outside");
    await fs.writeFile(path.join(outside, "probe.yaml"), "steps: []\n");
    const whenThere = await answers();

    expect(whenMissing).toEqual(refusals);
    expect(whenThere).toEqual(refusals);
    expect(await fs.readFile(path.join(outside, "probe.png"), "utf8")).toBe("outside");
  });

  it("refuses a link through an outside file or an unsearchable outside directory alike", async () => {
    const outside = path.join(tmpDir, "outside");
    await fs.mkdir(path.join(outside, "locked"), { recursive: true });
    await fs.writeFile(path.join(outside, "id_rsa"), "PRIVATE");
    await fs.mkdir(keyDir, { recursive: true });
    const links = {
      throughFile: path.join(outside, "id_rsa", "x.png"),
      throughMissing: path.join(outside, "nope", "x.png"),
      throughLocked: path.join(outside, "locked", "x.png"),
    };
    for (const [name, target] of Object.entries(links)) {
      await fs.symlink(target, path.join(keyDir, `${name}.png`));
    }
    if (process.getuid?.() !== 0) await fs.chmod(path.join(outside, "locked"), 0o000);
    const handler = await snapshotHandlerFor([projectDir]);

    try {
      for (const name of Object.keys(links)) {
        const file = path.join(keyDir, `${name}.png`);
        expect(await handler.handle(readLine(file))).toEqual({
          id: "req-1",
          ok: false,
          error: outsideError(file),
        });
      }
    } finally {
      await fs.chmod(path.join(outside, "locked"), 0o755);
    }
  });

  it("refuses links the user cannot read, which the macOS kernel still follows", async () => {
    // macOS enforces a symlink's own mode for readlink and realpath, not when
    // the kernel follows the link; a tar or zip restores such a mode.
    if (process.platform !== "darwin") return;
    const unreadable = (link: string) => execFileSync("chmod", ["-h", "000", link]);
    const outside = path.join(tmpDir, "outside");
    const elsewhere = path.join(outside, "elsewhere");
    await fs.mkdir(elsewhere, { recursive: true });
    await fs.writeFile(path.join(outside, "id_rsa"), "PRIVATE KEY");
    await fs.mkdir(keyDir, { recursive: true });
    await fs.symlink(path.join(outside, "id_rsa"), baseline);
    unreadable(baseline);
    const linkedKey = path.join(flowsDir, "__baselines__", "other");
    await fs.symlink(elsewhere, linkedKey);
    unreadable(linkedKey);
    await fs.symlink(path.join(outside, "id_rsa"), path.join(flowsDir, "leak.yaml"));
    unreadable(path.join(flowsDir, "leak.yaml"));
    const handler = await snapshotHandlerFor([projectDir]);

    // The walk reads each link itself, so the link's mode refuses it here too.
    expect(await handler.handle(readLine(baseline))).toEqual({
      id: "req-1",
      ok: false,
      error: `EACCES: permission denied, readlink '${baseline}'`,
    });
    const written = path.join(linkedKey, "home.png");
    const otherRun = await snapshotHandlerFor([projectDir], { baselineDir: linkedKey });
    expect(await otherRun.handle(writeLine(written, PNG))).toEqual({
      id: "req-1",
      ok: false,
      error: `EACCES: permission denied, readlink '${linkedKey}'`,
    });
    expect(await fs.readdir(elsewhere)).toEqual([]);
    // Composed, so the refusal comes from the walk, not from the served-set gate.
    await composes("leak.yaml");
    const composing = await handlerFor([projectDir]);
    expect(await composing.handle(resolveLine(flowsDir, "leak.yaml"))).toEqual({
      id: "req-1",
      ok: false,
      error: `EACCES: permission denied, readlink '${path.join(flowsDir, "leak.yaml")}'`,
    });
  });

  it("refuses a path in a directory it cannot search with words that name that cause", async () => {
    // Root searches a mode-000 directory anyway.
    if (process.getuid?.() === 0) return;
    await fs.mkdir(keyDir, { recursive: true });
    await fs.writeFile(baseline, PNG);
    await fs.mkdir(path.join(flowsDir, "locked"));
    await fs.writeFile(path.join(flowsDir, "locked", "x.yaml"), "steps: []\n");
    await fs.chmod(keyDir, 0o000);
    await fs.chmod(path.join(flowsDir, "locked"), 0o000);
    const handler = await snapshotHandlerFor([projectDir]);
    await composes("locked/x.yaml");
    const composing = await handlerFor([projectDir]);

    try {
      expect(await handler.handle(readLine(baseline))).toEqual({
        id: "req-1",
        ok: false,
        error: `EACCES: permission denied, lstat '${baseline}'`,
      });
      expect(await composing.handle(resolveLine(flowsDir, "locked/x.yaml"))).toEqual({
        id: "req-1",
        ok: false,
        error: `EACCES: permission denied, lstat '${path.join(flowsDir, "locked", "x.yaml")}'`,
      });
    } finally {
      await fs.chmod(keyDir, 0o755);
      await fs.chmod(path.join(flowsDir, "locked"), 0o755);
    }
  });

  it("answers exists:false for a missing baseline", async () => {
    const handler = await snapshotHandlerFor([projectDir]);

    expect(await handler.handle(readLine(baseline))).toEqual({
      id: "req-1",
      ok: true,
      exists: false,
    });
  });

  it("answers exists:false for a baseline behind a file where a directory should be", async () => {
    // As a host read of a baseline: ENOTDIR is nothing there, not an error.
    const handler = await snapshotHandlerFor([projectDir]);
    await fs.mkdir(path.dirname(keyDir), { recursive: true });
    await fs.writeFile(keyDir, "not a directory");

    expect(await handler.handle(readLine(baseline))).toEqual({
      id: "req-1",
      ok: true,
      exists: false,
    });

    await fs.rm(path.dirname(keyDir), { recursive: true });
    await fs.writeFile(path.dirname(keyDir), "not a directory");
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
    const handler = await snapshotHandlerFor([projectDir]);

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
    const handler = await snapshotHandlerFor([projectDir], { baselineDir: path.dirname(outside) });

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

    for (const file of [baseline, throughDir]) {
      const handler = await snapshotHandlerFor([projectDir], { baselineDir: path.dirname(file) });
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
    const handler = await snapshotHandlerFor([projectDir]);

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
    const handler = await snapshotHandlerFor([projectDir]);

    // All exist inside the root, and no tool: step names them: read-file
    // serves them neither as baselines nor as file arguments.
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
        error: notServedError(file),
      });
    }
  });

  it("refuses a read with a .. segment, a relative path and a non-string path", async () => {
    await fs.mkdir(keyDir, { recursive: true });
    await fs.writeFile(baseline, PNG);
    const handler = await snapshotHandlerFor([projectDir]);

    // The `..` path names the existing baseline inside the root: it is the
    // form that is refused. (path.join would fold the `..` away.)
    const dotted = [keyDir, "..", "login", path.basename(baseline)].join(path.sep);
    const relative = path.join(".argent", "flows", "__baselines__", "login", "x.png");
    for (const file of [dotted, relative]) {
      expect(await handler.handle(readLine(file))).toEqual({
        id: "req-1",
        ok: false,
        error: notServedError(file),
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
    const handler = await snapshotHandlerFor([projectDir]);

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
    const handler = await snapshotHandlerFor([projectDir]);

    expect(await handler.handle(readLine(baseline))).toEqual({
      id: "req-1",
      ok: false,
      error: `${baseline} is larger than the 32 MiB cap on a file sent to the tool-server`,
    });
  });

  it("refuses a write outside __baselines__", async () => {
    const handler = await snapshotHandlerFor([projectDir]);

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
    const handler = await snapshotHandlerFor([projectDir]);

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
    const handler = await snapshotHandlerFor([projectDir]);

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
    const handler = await snapshotHandlerFor([projectDir]);

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
    const handler = await snapshotHandlerFor([projectDir]);

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
    const handler = await snapshotHandlerFor([projectDir]);

    const answer = await handler.handle(writeLine(baseline, PNG));

    expect({ answer, outside: await fs.readdir(outside) }).toEqual({
      answer: { id: "req-1", ok: false, error: outsideError(baseline) },
      outside: [],
    });
  });

  it("refuses a write through a dangling baseline symlink inside the roots", async () => {
    await fs.mkdir(keyDir, { recursive: true });
    await fs.symlink(path.join(projectDir, "missing.png"), baseline);
    const handler = await snapshotHandlerFor([projectDir]);

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
    const handler = await snapshotHandlerFor([projectDir]);

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
    const handler = await snapshotHandlerFor([projectDir]);

    expect(await handler.handle(writeLine(baseline, PNG))).toEqual({
      id: "req-1",
      ok: false,
      error: `${baseline} links to a file that is not a PNG file`,
    });
    expect(await fs.readFile(path.join(projectDir, ".env"), "utf8")).toBe("SECRET=1\n");
  });

  it("refuses to write over a FIFO, a link to one or a directory", async () => {
    // A write to a FIFO blocks until a reader opens it, so the CLI would never exit.
    await fs.mkdir(keyDir, { recursive: true });
    const dir = path.join(keyDir, "dir.png");
    await fs.mkdir(dir);
    const fifo = path.join(keyDir, "fifo.png");
    const viaLink = path.join(keyDir, "via-link.png");
    const targets = [dir];
    try {
      execFileSync("mkfifo", [fifo]);
      await fs.symlink("fifo.png", viaLink);
      targets.unshift(fifo, viaLink);
    } catch {
      // No mkfifo on this system: the directory case still runs.
    }
    const handler = await snapshotHandlerFor([projectDir]);

    for (const file of targets) {
      expect(await handler.handle(writeLine(file, PNG))).toEqual({
        id: "req-1",
        ok: false,
        error: `${file} is not a regular file`,
      });
    }
    expect((await fs.lstat(dir)).isDirectory()).toBe(true);
    if (targets.includes(fifo)) expect((await fs.lstat(fifo)).isFIFO()).toBe(true);
  });

  it("writes a baseline under a root that is the real location of a symlinked .argent/flows", async () => {
    // The project keeps its flows in a tree outside it; the tools client sends
    // the project and its `.argent/flows`, and the server names the baseline
    // beside the root flow's REAL file.
    const sharedFlows = path.join(tmpDir, "shared-flows");
    await fs.mkdir(sharedFlows);
    await fs.writeFile(path.join(sharedFlows, "login.yaml"), "steps:\n  - snapshot: home\n");
    const linkedProject = path.join(tmpDir, "linked-proj");
    const linkedFlows = path.join(linkedProject, ".argent", "flows");
    await fs.mkdir(path.dirname(linkedFlows), { recursive: true });
    await fs.symlink(sharedFlows, linkedFlows);
    const file = path.join(sharedFlows, "__baselines__", "login", "home.png");

    const baselineDir = path.dirname(file);
    const handler = await handlerFor([linkedProject, linkedFlows], {
      rootFlow: path.join(linkedFlows, "login.yaml"),
      baselineDir,
    });
    expect(handler.param.roots).toEqual([linkedProject, sharedFlows]);

    expect(await handler.handle(writeLine(file, PNG))).toEqual({
      id: "req-1",
      ok: true,
      written: file,
      replaced: false,
    });
    expect(await fs.readFile(file)).toEqual(PNG);

    // The flows root is what admits it: the project alone does not reach
    // there, not even the root flow, so no handler serves that run.
    await fs.rm(path.join(sharedFlows, "__baselines__"), { recursive: true });
    expect(
      await createClientServicesHandler({
        roots: [linkedProject],
        rootFlow: path.join(linkedFlows, "login.yaml"),
        advertised: ALL,
        baselineDir,
      })
    ).toBeNull();
    // A handler for a root flow inside the project refuses that baseline too.
    await fs.writeFile(path.join(linkedProject, "main.yaml"), "steps:\n  - snapshot: home\n");
    const projectOnly = await handlerFor([linkedProject], {
      rootFlow: path.join(linkedProject, "main.yaml"),
      baselineDir,
    });
    expect(await projectOnly.handle(writeLine(file, PNG))).toEqual({
      id: "req-1",
      ok: false,
      error: outsideError(file, [linkedProject]),
    });
    expect(await exists(path.join(sharedFlows, "__baselines__"))).toBe(false);
  });

  it("writes a baseline and creates the key directory", async () => {
    const handler = await snapshotHandlerFor([projectDir]);

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
    const handler = await snapshotHandlerFor([projectDir]);

    // Shorter than the old file, so a write that did not truncate would show.
    expect(await handler.handle(writeLine(baseline, PNG))).toEqual({
      id: "req-1",
      ok: true,
      written: baseline,
      replaced: true,
    });
    expect(await fs.readFile(baseline)).toEqual(PNG);
  });

  it("updates a baseline that links to a file in the roots, and keeps the link", async () => {
    const real = path.join(projectDir, "store", "real.png");
    await fs.mkdir(path.dirname(real));
    await fs.writeFile(real, "old");
    await fs.mkdir(keyDir, { recursive: true });
    await fs.symlink(real, baseline);
    const handler = await snapshotHandlerFor([projectDir]);

    expect(await handler.handle(writeLine(baseline, PNG))).toEqual({
      id: "req-1",
      ok: true,
      written: baseline,
      replaced: true,
    });
    expect(await fs.readlink(baseline)).toBe(real);
    expect(await fs.readFile(real)).toEqual(PNG);
    // No temporary file is left beside the real file or the link.
    expect(await fs.readdir(path.dirname(real))).toEqual(["real.png"]);
    expect(await fs.readdir(keyDir)).toEqual([path.basename(baseline)]);
  });

  it("keeps the mode of the baseline it replaces and leaves no temporary file", async () => {
    await fs.mkdir(keyDir, { recursive: true });
    await fs.writeFile(baseline, "old");
    await fs.chmod(baseline, 0o640);
    const fresh = path.join(keyDir, "fresh.png");
    const reference = path.join(tmpDir, "reference");
    await fs.writeFile(reference, "");
    const handler = await snapshotHandlerFor([projectDir]);

    expect(await handler.handle(writeLine(baseline, PNG))).toMatchObject({
      ok: true,
      replaced: true,
    });
    expect(await handler.handle(writeLine(fresh, PNG))).toMatchObject({
      ok: true,
      replaced: false,
    });

    expect((await fs.stat(baseline)).mode & 0o777).toBe(0o640);
    // A new baseline gets the mode that any new file gets.
    expect((await fs.stat(fresh)).mode & 0o777).toBe((await fs.stat(reference)).mode & 0o777);
    expect((await fs.readdir(keyDir)).sort()).toEqual(
      [path.basename(baseline), "fresh.png"].sort()
    );
  });

  it("refuses content over 32 MiB and writes content of exactly 32 MiB", async () => {
    const handler = await snapshotHandlerFor([projectDir]);

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

  it("logs the op, the path and the outcome, never the content, under ARGENT_CLIENT_SERVICES_LOG=1", async () => {
    const handler = await snapshotHandlerFor([projectDir]);
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await handler.handle(writeLine(baseline, PNG));
    await handler.handle(readLine(baseline));
    expect(write).not.toHaveBeenCalled();

    vi.stubEnv("ARGENT_CLIENT_SERVICES_LOG", "1");
    const gone = path.join(keyDir, "gone.png");
    await handler.handle(writeLine(baseline, PNG));
    await handler.handle(readLine(baseline));
    await handler.handle(readLine(gone));

    expect(write.mock.calls.map((c) => String(c[0]))).toEqual([
      `[client-services] write-file ${baseline}: written\n`,
      `[client-services] read-file ${baseline}: served\n`,
      `[client-services] read-file ${gone}: missing\n`,
    ]);

    // A refused request is logged with the refusal: by the path as received
    // until it is known to be a baseline of this run, also when the refusal
    // comes from the read or the write itself (EISDIR, a directory).
    write.mockClear();
    const dirBaseline = path.join(keyDir, "dir.png");
    await fs.mkdir(dirBaseline);
    const notes = path.join(projectDir, "notes.png");
    const foreign = path.join(tmpDir, "x", "__baselines__", "k", "home.png");
    await handler.handle(writeLine(notes, PNG));
    await handler.handle(readLine(foreign));
    expect(await handler.handle(readLine(dirBaseline))).toMatchObject({ ok: false });
    expect(await handler.handle(writeLine(dirBaseline, PNG))).toMatchObject({ ok: false });
    expect(write.mock.calls.map((c) => String(c[0]))).toEqual([
      `[client-services] write-file ${notes}: refused (${notBaselineError(notes)})\n`,
      `[client-services] read-file ${foreign}: refused (${foreign} is not a baseline of this run (${keyDir}/<name>.png))\n`,
      `[client-services] read-file ${dirBaseline}: refused (EISDIR: illegal operation on a directory, read)\n`,
      `[client-services] write-file ${dirBaseline}: refused (${dirBaseline} is not a regular file)\n`,
    ]);
    expect(write.mock.calls.join("\n")).not.toContain(PNG.toString("base64"));
  });

  it("refuses a baseline of another flow or in another directory, and makes nothing there", async () => {
    const otherFlow = path.join(flowsDir, "__baselines__", "other", "home.png");
    await fs.mkdir(path.dirname(otherFlow), { recursive: true });
    await fs.writeFile(otherFlow, "theirs");
    const handler = await snapshotHandlerFor([projectDir]);

    for (const file of [
      otherFlow,
      // The run's own key, under another directory.
      path.join(projectDir, "__baselines__", "login", "home.png"),
      path.join(projectDir, "node_modules", "pkg", "__baselines__", "login", "home.png"),
      path.join(projectDir, ".git", "refs", "heads", "__baselines__", "main", "home.png"),
    ]) {
      const refusal = {
        id: "req-1",
        ok: false,
        error: `${file} is not a baseline of this run (${keyDir}/<name>.png)`,
      };
      expect(await handler.handle(readLine(file))).toEqual(refusal);
      expect(await handler.handle(writeLine(file, PNG))).toEqual(refusal);
    }
    expect(await fs.readFile(otherFlow, "utf8")).toBe("theirs");
    expect(await fs.readdir(path.join(flowsDir, "__baselines__"))).toEqual(["other"]);
    for (const dir of ["__baselines__", "node_modules", ".git"]) {
      expect(await exists(path.join(projectDir, dir))).toBe(false);
    }
  });

  it("makes no directory but the run's own key directory", async () => {
    const before = await fs.readdir(projectDir, { recursive: true });
    const handler = await snapshotHandlerFor([projectDir]);

    expect(await handler.handle(writeLine(baseline, PNG))).toMatchObject({ ok: true });

    const made = [path.dirname(keyDir), keyDir, baseline].map((p) => path.relative(projectDir, p));
    expect((await fs.readdir(projectDir, { recursive: true })).sort()).toEqual(
      [...before, ...made].sort()
    );
  });

  it("refuses every baseline when the run has no baseline directory on this client", async () => {
    await fs.mkdir(keyDir, { recursive: true });
    await fs.writeFile(baseline, PNG);
    const handler = await snapshotHandlerFor([projectDir], { baselineDir: null });
    const refusal = {
      id: "req-1",
      ok: false,
      error: `${baseline} is not a baseline of this run; this run has no baseline directory on this client`,
    };

    expect(await handler.handle(readLine(baseline))).toEqual(refusal);
    expect(await handler.handle(writeLine(baseline, Buffer.from("new")))).toEqual(refusal);
    expect(await fs.readFile(baseline)).toEqual(PNG);
  });

  it("refuses read-file and write-file when the server did not advertise them", async () => {
    await fs.mkdir(keyDir, { recursive: true });
    await fs.writeFile(baseline, PNG);
    // root.yaml composes frag.yaml, so resolve-file alone still builds a
    // handler; login.yaml, which only takes a snapshot, would build none.
    const handler = await handlerFor([projectDir], { advertised: ["resolve-file"] });
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

  describe("read-file for the file arguments of tool: steps", () => {
    const kinds = ".png, .yaml";
    const notToolFileError = (file: string) =>
      `${file} is not a file this client serves for a tool: step (${kinds})`;

    /** One `tool:` step per entry, as flow YAML: JSON args are a YAML flow mapping. */
    const toolSteps = (...steps: [tool: string, args: Record<string, unknown>][]) =>
      `steps:\n${steps.map(([tool, args]) => `  - tool: ${tool}\n    args: ${JSON.stringify(args)}\n`).join("")}`;

    /** Make the root flow exactly these `tool:` steps. */
    async function usesTools(...steps: Parameters<typeof toolSteps>): Promise<void> {
      await fs.writeFile(path.join(flowsDir, "root.yaml"), toolSteps(...steps));
    }

    it("builds a handler for a root flow whose only file is a tool: argument, when read-file is offered", async () => {
      const rootFlow = path.join(flowsDir, "root.yaml");
      const handlerWith = async (args: Record<string, unknown>, advertised: ClientServiceOp[]) => {
        await usesTools(["screenshot-diff", args]);
        return createClientServicesHandler({
          roots: [projectDir],
          rootFlow,
          advertised,
          baselineDir: null,
        });
      };
      const named = { baselinePath: path.join(projectDir, "home.png"), captureCurrent: true };

      expect((await handlerWith(named, ["read-file"]))?.param).toEqual({
        ops: ["read-file"],
        roots: [projectDir],
      });
      // Only read-file carries a file argument.
      expect(await handlerWith(named, ["resolve-file", "write-file"])).toBeNull();
      // No absolute path among the args: the step reads no file of this client.
      expect(await handlerWith({ x: 0.5, y: 0.5 }, ALL)).toBeNull();
      // Text that looks like a path, as a keyboard step types it, is no file.
      expect(await handlerWith({ text: "/start" }, ALL)).toBeNull();
      expect(await handlerWith({ baselinePath: "img/home.png" }, ALL)).toBeNull();
    });

    it("serves a .png that a tool: step of the root flow names", async () => {
      const image = path.join(projectDir, "shots", "home.png");
      await fs.mkdir(path.dirname(image));
      await fs.writeFile(image, PNG);
      const st = await fs.stat(image);
      await usesTools(["screenshot-diff", { baselinePath: image, captureCurrent: true }]);
      const handler = await handlerFor([projectDir]);

      expect(await handler.handle(readLine(image))).toEqual({
        id: "req-1",
        ok: true,
        exists: true,
        size: PNG.length,
        mtimeMs: st.mtimeMs,
        content: PNG.toString("base64"),
      });
    });

    it("serves a named .yaml or .PNG and refuses a named .json, .sqlite or .mjs", async () => {
      // The client reads no tool's schema: any absolute string argument counts.
      const files = Object.fromEntries(
        ["login.yaml", "home.PNG", "config.json", "app.sqlite", "helper.mjs"].map((name) => [
          name,
          path.join(projectDir, name),
        ])
      );
      for (const file of Object.values(files)) await fs.writeFile(file, "{}\n");
      await usesTools(["some-tool", files]);
      const handler = await handlerFor([projectDir]);

      // The extension is matched in any case, as a case-insensitive disk may
      // name the file the flow spells `.png`.
      for (const name of ["login.yaml", "home.PNG"]) {
        expect(await handler.handle(readLine(files[name]))).toMatchObject({
          ok: true,
          exists: true,
          content: Buffer.from("{}\n").toString("base64"),
        });
      }
      for (const name of ["config.json", "app.sqlite", "helper.mjs"]) {
        expect(await handler.handle(readLine(files[name]))).toEqual({
          id: "req-1",
          ok: false,
          error: notToolFileError(files[name]!),
        });
      }
    });

    it("refuses a file no tool: step names, even a .png under the root or a respelling of a named one", async () => {
      const named = path.join(projectDir, "named.png");
      const other = path.join(projectDir, "other.png");
      await fs.writeFile(named, PNG);
      await fs.writeFile(other, PNG);
      await usesTools(["screenshot-diff", { baselinePath: named, captureCurrent: true }]);
      const handler = await handlerFor([projectDir]);

      // The runner asks by the step's spelling, so another one names nothing.
      // (path.join would fold the `..` away.)
      const respelled = [projectDir, "shots", "..", "named.png"].join(path.sep);
      for (const file of [other, respelled]) {
        expect(await handler.handle(readLine(file))).toEqual({
          id: "req-1",
          ok: false,
          error: notServedError(file),
        });
      }
    });

    it("refuses a named file outside the roots the same way whether or not it exists, before looking there", async () => {
      const outside = path.join(tmpDir, "outside");
      await fs.mkdir(outside);
      const there = path.join(outside, "there.png");
      const gone = path.join(outside, "gone.png");
      await fs.writeFile(there, PNG);
      await usesTools(["screenshot-diff", { baselinePath: there, currentPath: gone }]);
      const handler = await handlerFor([projectDir]);
      const spies = (["lstat", "stat", "realpath", "readlink", "readFile", "open"] as const).map(
        (name) => vi.spyOn(fsCjs, name)
      );
      syncBuiltinESMExports();

      const answers = [await handler.handle(readLine(there)), await handler.handle(readLine(gone))];
      vi.restoreAllMocks();
      syncBuiltinESMExports();

      expect(answers).toEqual([
        { id: "req-1", ok: false, error: outsideError(there) },
        { id: "req-1", ok: false, error: outsideError(gone) },
      ]);
      const touched = spies.flatMap((spy) => spy.mock.calls.map((call) => String(call[0])));
      // The spies are live: the walk looked at the way to the root.
      expect(touched).toContain(tmpDir);
      expect(touched.filter((p) => p.startsWith(outside))).toEqual([]);
    });

    it("refuses a named file that the flow spells through a link above the roots", async () => {
      // The flow may be one the tool-server wrote back to this client, so its
      // paths are walked as spelled, as a request's are: a link outside the
      // roots is not followed, even to a file inside them.
      const alias = path.join(tmpDir, "alias");
      await fs.symlink(projectDir, alias);
      const image = path.join(alias, "home.png");
      await fs.writeFile(path.join(projectDir, "home.png"), PNG);
      await usesTools(["screenshot-diff", { baselinePath: image, captureCurrent: true }]);
      const handler = await handlerFor([projectDir]);

      expect(await handler.handle(readLine(image))).toEqual({
        id: "req-1",
        ok: false,
        error: outsideError(image),
      });
    });

    it("refuses a named .png that links to a .env in the roots, or out of the roots", async () => {
      await fs.writeFile(path.join(projectDir, ".env"), "SECRET=1\n");
      const toEnv = path.join(projectDir, "x.png");
      await fs.symlink(path.join(projectDir, ".env"), toEnv);
      const elsewhere = path.join(tmpDir, "elsewhere");
      await fs.mkdir(elsewhere);
      await fs.writeFile(path.join(elsewhere, "real.png"), PNG);
      const toOutside = path.join(projectDir, "y.png");
      await fs.symlink(path.join(elsewhere, "real.png"), toOutside);
      await usesTools(["screenshot-diff", { baselinePath: toEnv, currentPath: toOutside }]);
      const handler = await handlerFor([projectDir]);

      expect(await handler.handle(readLine(toEnv))).toEqual({
        id: "req-1",
        ok: false,
        error: `${toEnv} links to a file that is not one of ${kinds}`,
      });
      const answer = await handler.handle(readLine(toOutside));
      expect(answer).toEqual({ id: "req-1", ok: false, error: outsideError(toOutside) });
      // Where it points is the client's business: the server only learns "outside".
      expect((answer as { error: string }).error).not.toContain(elsewhere);
    });

    it("answers exists: false for a named file that is not there, also behind a regular file", async () => {
      const missing = path.join(projectDir, "missing.png");
      const inMissingDir = path.join(projectDir, "gone", "x.png");
      // frag.yaml is a regular file: the kernel answers ENOTDIR below it.
      const behindFile = path.join(flowsDir, "frag.yaml", "x.png");
      await usesTools(
        ["screenshot-diff", { baselinePath: missing, currentPath: inMissingDir }],
        ["screenshot-diff", { baselinePath: behindFile, captureCurrent: true }]
      );
      const handler = await handlerFor([projectDir]);

      for (const file of [missing, inMissingDir, behindFile]) {
        expect(await handler.handle(readLine(file))).toEqual({
          id: "req-1",
          ok: true,
          exists: false,
        });
      }
    });

    it("serves a fragment's tool: argument only once that fragment was served", async () => {
      // root.yaml runs frag.yaml; only frag.yaml names the image.
      const image = path.join(projectDir, "frag.png");
      await fs.writeFile(image, PNG);
      await fs.writeFile(
        path.join(flowsDir, "frag.yaml"),
        toolSteps(["screenshot-diff", { baselinePath: image, captureCurrent: true }])
      );
      const handler = await handlerFor([projectDir]);

      expect(await handler.handle(readLine(image))).toEqual({
        id: "req-1",
        ok: false,
        error: notServedError(image),
      });
      expect(await handler.handle(resolveLine(flowsDir, "frag.yaml"))).toMatchObject({
        ok: true,
        exists: true,
      });
      expect(await handler.handle(readLine(image))).toMatchObject({
        ok: true,
        exists: true,
        content: PNG.toString("base64"),
      });
    });

    it("serves a tool: argument named inside a when: block", async () => {
      const image = path.join(projectDir, "home.png");
      await fs.writeFile(image, PNG);
      await fs.writeFile(
        path.join(flowsDir, "root.yaml"),
        "steps:\n  - when: { visible: Home }\n    steps:\n      - tool: screenshot-diff\n" +
          `        args: ${JSON.stringify({ baselinePath: image, captureCurrent: true })}\n`
      );
      const handler = await handlerFor([projectDir]);

      expect(await handler.handle(readLine(image))).toMatchObject({
        ok: true,
        exists: true,
        content: PNG.toString("base64"),
      });
    });

    it("serves a baseline-shaped path that a tool: step names as that step's argument", async () => {
      // As a baseline it is another flow's, which this run may not read.
      const theirs = path.join(flowsDir, "__baselines__", "other", "home.png");
      await fs.mkdir(path.dirname(theirs), { recursive: true });
      await fs.writeFile(theirs, PNG);
      await usesTools(["screenshot-diff", { baselinePath: theirs, captureCurrent: true }]);
      const handler = await handlerFor([projectDir]);

      expect(await handler.handle(readLine(theirs))).toMatchObject({
        ok: true,
        exists: true,
        content: PNG.toString("base64"),
      });
    });

    it("logs a tool: argument by the path the server sent under ARGENT_CLIENT_SERVICES_LOG=1", async () => {
      // Spelled through a linked directory, so the real path is another one.
      await fs.mkdir(path.join(projectDir, "store"));
      await fs.writeFile(path.join(projectDir, "store", "home.png"), PNG);
      await fs.symlink(path.join(projectDir, "store"), path.join(projectDir, "shots"));
      const image = path.join(projectDir, "shots", "home.png");
      const outside = path.join(tmpDir, "outside.png");
      await usesTools(["screenshot-diff", { baselinePath: image, currentPath: outside }]);
      const handler = await handlerFor([projectDir]);
      const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      vi.stubEnv("ARGENT_CLIENT_SERVICES_LOG", "1");

      await handler.handle(readLine(image));
      await handler.handle(readLine(outside));

      expect(write.mock.calls.map((c) => String(c[0]))).toEqual([
        `[client-services] read-file ${image}: served\n`,
        `[client-services] read-file ${outside}: refused (${outsideError(outside)})\n`,
      ]);
      expect(write.mock.calls.join("\n")).not.toContain(PNG.toString("base64"));
    });
  });
});

describe("the request log", () => {
  let lines: string[];
  let handler: Awaited<ReturnType<typeof handlerFor>>;
  beforeEach(async () => {
    vi.stubEnv("ARGENT_CLIENT_SERVICES_LOG", "1");
    await fs.mkdir(path.join(flowsDir, "dir.yaml"));
    const fh = await fs.open(path.join(flowsDir, "huge.yaml"), "w");
    await fh.truncate(CLIENT_CONTENT_CAP_BYTES + 1);
    await fh.close();
    await fs.symlink("loop.yaml", path.join(flowsDir, "loop.yaml"));
    await fs.writeFile(path.join(tmpDir, "outside.yaml"), "steps: []\n");
    await fs.writeFile(path.join(projectDir, "secrets.yaml"), "x: 1\n");
    await composes("frag.yaml", "missing.yaml", "dir.yaml", "huge.yaml", "loop.yaml");
    lines = [];
    handler = await handlerFor([projectDir], { log: (line) => lines.push(line) });
  });

  async function logged(line: ClientRequestLine): Promise<string[]> {
    lines.length = 0;
    await handler.handle(line);
    return lines;
  }

  it("writes one line per request, after the answer, naming the outcome", async () => {
    const at = (name: string) => path.join(flowsDir, name);
    expect(await logged(resolveLine(flowsDir, "frag.yaml"))).toEqual([
      `[client-services] resolve-file ${at("frag.yaml")}: served`,
    ]);
    expect(await logged(resolveLine(flowsDir, "missing.yaml"))).toEqual([
      `[client-services] resolve-file ${at("missing.yaml")}: missing`,
    ]);
    expect(await logged(resolveLine(flowsDir, "dir.yaml"))).toEqual([
      `[client-services] resolve-file ${at("dir.yaml")}: refused (EISDIR: illegal operation on a directory, read)`,
    ]);
    expect(await logged(resolveLine(flowsDir, "huge.yaml"))).toEqual([
      `[client-services] resolve-file ${at("huge.yaml")}: refused (${at("huge.yaml")} is larger than the 32 MiB cap on a file sent to the tool-server)`,
    ]);
    expect(await logged(resolveLine(flowsDir, "loop.yaml"))).toEqual([
      `[client-services] resolve-file ${at("loop.yaml")}: refused (ELOOP: too many symbolic links encountered, open '${at("loop.yaml")}')`,
    ]);
  });

  it("names a refused probe by the target as received, never where it leads", async () => {
    expect(await logged(resolveLine(flowsDir, "../../../outside.yaml"))).toEqual([
      `[client-services] resolve-file ../../../outside.yaml: refused (../../../outside.yaml is outside every root this client serves (${projectDir}))`,
    ]);
    expect(await logged(resolveLine(flowsDir, "../../secrets.yaml"))).toEqual([
      "[client-services] resolve-file ../../secrets.yaml: refused (../../secrets.yaml is not a run: target of a flow this client served)",
    ]);
    expect(await logged(resolveLine(flowsDir, "notes.txt"))).toEqual([
      "[client-services] resolve-file notes.txt: refused (notes.txt is not a .yaml file; this client serves flow files only)",
    ]);
    expect(await logged({ ...resolveLine(flowsDir, "frag.yaml"), op: "run-script" })).toEqual([
      "[client-services] run-script frag.yaml: refused (op run-script is not served by this client)",
    ]);
    expect(
      await logged(
        resolveLine(flowsDir, "frag.yaml", {
          args: { anchorDir: flowsDir, target: "frag.yaml", kind: "script" },
        })
      )
    ).toEqual([
      `[client-services] resolve-file frag.yaml: refused (kind "script" is not known to this client; it serves "flow" only)`,
    ]);
    expect(await logged({ ...resolveLine(flowsDir, "frag.yaml"), args: null as never })).toEqual([
      "[client-services] resolve-file (no target): refused (resolve-file request carries no args object)",
    ]);
  });

  it("escapes control characters a server put in a target", async () => {
    const forged = "x.yaml\n[client-services] resolve-file /etc/passwd: served\n.yaml";

    expect(await logged(resolveLine(flowsDir, forged))).toEqual([
      expect.stringMatching(
        /^\[client-services\] resolve-file x\.yaml\\u000a\[client-services\] .*: refused \(.*\)$/
      ),
    ]);
    expect(lines[0]).not.toContain("\n");
  });

  it("answers even when the log sink throws", async () => {
    const throwing = await handlerFor([projectDir], {
      log: () => {
        throw new Error("sink is gone");
      },
    });

    expect(await throwing.handle(resolveLine(flowsDir, "frag.yaml"))).toMatchObject({
      ok: true,
      exists: true,
    });
  });

  it("writes nothing without ARGENT_CLIENT_SERVICES_LOG=1", async () => {
    vi.stubEnv("ARGENT_CLIENT_SERVICES_LOG", "");

    expect(await logged(resolveLine(flowsDir, "frag.yaml"))).toEqual([]);
  });
});

describe("what the handler serves", () => {
  const notComposed = (target: string) => ({
    id: "req-1",
    ok: false,
    error: `${target} is not a run: target of a flow this client served`,
  });

  it("refuses a project file no served flow composes, before reading it", async () => {
    await fs.mkdir(path.join(projectDir, ".github", "workflows"), { recursive: true });
    await fs.writeFile(
      path.join(projectDir, ".github", "workflows", "deploy.yaml"),
      "env:\n  TOKEN: x\n"
    );
    await fs.writeFile(path.join(projectDir, "secrets.yaml"), "db_password: x\n");
    const handler = await handlerFor([projectDir]);
    const spies = (["readFile", "open", "stat"] as const).map((name) => vi.spyOn(fsCjs, name));
    syncBuiltinESMExports();

    const deploy = await handler.handle(resolveLine(projectDir, ".github/workflows/deploy.yaml"));
    const secrets = await handler.handle(resolveLine(flowsDir, "../../secrets.yaml"));
    vi.restoreAllMocks();
    syncBuiltinESMExports();

    expect(deploy).toEqual(notComposed(".github/workflows/deploy.yaml"));
    expect(secrets).toEqual(notComposed("../../secrets.yaml"));
    expect(spies.flatMap((spy) => spy.mock.calls)).toEqual([]);
  });

  it("refuses a file it does not serve with the same text whether or not it exists", async () => {
    const handler = await handlerFor([projectDir]);

    await fs.writeFile(path.join(projectDir, "secrets.yaml"), "db_password: x\n");
    const exists = await handler.handle(resolveLine(flowsDir, "../../secrets.yaml"));
    await fs.rm(path.join(projectDir, "secrets.yaml"));
    const missing = await handler.handle(resolveLine(flowsDir, "../../secrets.yaml"));

    expect(exists).toEqual(notComposed("../../secrets.yaml"));
    expect(missing).toEqual(exists);
  });

  it("serves the root flow where the server asks for it", async () => {
    const handler = await handlerFor([projectDir]);

    expect(await handler.handle(resolveLine(flowsDir, "root.yaml"))).toMatchObject({
      ok: true,
      exists: true,
      canonical: path.join(flowsDir, "root.yaml"),
    });
  });

  it("serves a chain of run: targets, each once the file naming it was served", async () => {
    // root -> sub/a.yaml (inside a when: block) -> login (a bare name beside
    // a.yaml) and ../shared/b.yaml (beside a.yaml, not beside the root).
    await fs.mkdir(path.join(flowsDir, "sub"));
    await fs.mkdir(path.join(flowsDir, "shared"));
    await fs.writeFile(
      path.join(flowsDir, "root.yaml"),
      "steps:\n  - echo: hi\n  - when: { visible: Login }\n    steps:\n      - run: sub/a.yaml\n"
    );
    await fs.writeFile(
      path.join(flowsDir, "sub", "a.yaml"),
      "steps:\n  - run: login\n  - run: ../shared/b.yaml\n"
    );
    await fs.writeFile(path.join(flowsDir, "sub", "login.yaml"), "steps:\n  - echo: login\n");
    await fs.writeFile(path.join(flowsDir, "shared", "b.yaml"), "steps:\n  - echo: b\n");
    const subDir = path.join(flowsDir, "sub");
    const handler = await handlerFor([projectDir]);

    // Only a.yaml names these, and a.yaml has not been served yet.
    expect(await handler.handle(resolveLine(subDir, "login.yaml"))).toEqual(
      notComposed("login.yaml")
    );
    expect(await handler.handle(resolveLine(flowsDir, "root.yaml"))).toMatchObject({ ok: true });
    expect(await handler.handle(resolveLine(flowsDir, "sub/a.yaml"))).toMatchObject({
      ok: true,
      exists: true,
      canonical: path.join(subDir, "a.yaml"),
    });
    expect(await handler.handle(resolveLine(subDir, "login.yaml"))).toMatchObject({
      ok: true,
      exists: true,
      canonical: path.join(subDir, "login.yaml"),
    });
    expect(await handler.handle(resolveLine(subDir, "../shared/b.yaml"))).toMatchObject({
      ok: true,
      exists: true,
      canonical: path.join(flowsDir, "shared", "b.yaml"),
    });
    // The same name beside the root is not what a.yaml composes.
    await fs.writeFile(path.join(flowsDir, "login.yaml"), "steps: []\n");
    expect(await handler.handle(resolveLine(flowsDir, "login.yaml"))).toEqual(
      notComposed("login.yaml")
    );
  });

  it("builds no handler for a root flow that composes nothing or cannot be read here", async () => {
    const rootFlow = path.join(flowsDir, "root.yaml");
    const handlerWith = (content: string | null) =>
      (content === null ? fs.rm(rootFlow) : fs.writeFile(rootFlow, content)).then(() =>
        createClientServicesHandler({
          roots: [projectDir],
          rootFlow,
          advertised: ALL,
          baselineDir: null,
        })
      );

    expect(await handlerWith("steps:\n  - echo: hi\n")).toBeNull();
    expect(await handlerWith('steps:\n  - run: "/abs.yaml"\n')).toBeNull();
    expect(await handlerWith("steps: [ { run: frag.yaml }\n")).toBeNull();
    expect(await handlerWith(null)).toBeNull();
    await fs.mkdir(rootFlow);
    expect(
      await createClientServicesHandler({
        roots: [projectDir],
        rootFlow,
        advertised: ALL,
        baselineDir: null,
      })
    ).toBeNull();
  });

  it("builds a handler for a root flow with a snapshot step only when a baseline op is offered", async () => {
    const rootFlow = path.join(flowsDir, "root.yaml");
    const handlerWith = async (content: string, advertised: ClientServiceOp[]) => {
      await fs.writeFile(rootFlow, content);
      return createClientServicesHandler({
        roots: [projectDir],
        rootFlow,
        advertised,
        baselineDir: path.join(flowsDir, "__baselines__", "root"),
      });
    };
    const snapshotOnly = "steps:\n  - snapshot: home\n";

    // A snapshot step needs a baseline op; resolve-file alone serves it nothing.
    expect(await handlerWith(snapshotOnly, ["resolve-file"])).toBeNull();
    expect((await handlerWith(snapshotOnly, ["read-file"]))?.param).toEqual({
      ops: ["read-file"],
      roots: [projectDir],
    });
    expect((await handlerWith(snapshotOnly, ["write-file"]))?.param.ops).toEqual(["write-file"]);
    // A snapshot inside a when: block counts too.
    expect(
      await handlerWith(
        "steps:\n  - when: { visible: Home }\n    steps:\n      - snapshot: home\n",
        ["read-file"]
      )
    ).not.toBeNull();
  });

  it("takes no run: target from a value the runner refuses", async () => {
    await fs.writeFile(path.join(flowsDir, "abs.yaml"), "steps: []\n");
    await fs.writeFile(
      path.join(flowsDir, "root.yaml"),
      'steps:\n  - run: frag.yaml\n  - run: "/abs.yaml"\n  - run: "C:abs.yaml"\n  - run: "sub\\\\abs.yaml"\n'
    );
    const handler = await handlerFor([projectDir]);

    for (const target of ["/abs.yaml", "C:abs.yaml", "sub\\abs.yaml"]) {
      expect(await handler.handle(resolveLine(flowsDir, target))).toEqual(notComposed(target));
    }
  });

  it("reads the run: targets of a flow whose steps alias themselves", async () => {
    await fs.writeFile(
      path.join(flowsDir, "root.yaml"),
      "steps: &s\n  - run: frag.yaml\n  - when: { visible: Again }\n    steps: *s\n"
    );
    const handler = await handlerFor([projectDir]);

    expect(await handler.handle(resolveLine(flowsDir, "frag.yaml"))).toMatchObject({
      ok: true,
      exists: true,
    });
  });
});

describe("nested flows", () => {
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  const notComposed = (target: string) => ({
    id: "req-1",
    ok: false,
    error: `${target} is not a run: target of a flow this client served`,
  });
  const fileLine = (op: "read-file" | "write-file", args: Record<string, unknown>) =>
    ({ event: "client-request", invocation: "inv-1", id: "req-1", op, args }) as ClientRequestLine;
  const readLine = (file: string) => fileLine("read-file", { path: file });
  const writeLine = (file: string, bytes: Buffer) =>
    fileLine("write-file", { path: file, content: bytes.toString("base64") });

  /** One `tool: flow-execute` step per entry, as flow YAML. */
  const nestedSteps = (...args: Record<string, unknown>[]) =>
    args.map((a) => `  - tool: flow-execute\n    args: ${JSON.stringify(a)}\n`).join("");

  /** Make the root flow exactly these `tool: flow-execute` steps. */
  async function nests(...args: Record<string, unknown>[]): Promise<void> {
    await fs.writeFile(path.join(flowsDir, "root.yaml"), `steps:\n${nestedSteps(...args)}`);
  }

  const handlerWith = (
    advertised: ClientServiceOp[],
    { baselineDir = null as string | null, roots = [projectDir] } = {}
  ) =>
    createClientServicesHandler({
      roots,
      rootFlow: path.join(flowsDir, "root.yaml"),
      advertised,
      baselineDir,
    });

  it("builds a handler for a root flow whose only nesting is a flow-execute step by name, and serves that flow and what it composes", async () => {
    await fs.writeFile(path.join(flowsDir, "child.yaml"), "steps:\n  - run: inner.yaml\n");
    await fs.writeFile(path.join(flowsDir, "inner.yaml"), "steps:\n  - echo: inner\n");
    await nests({ name: "child", project_root: projectDir });

    // resolve-file serves a nested flow; the baseline ops alone serve it nothing.
    expect(await handlerWith(["read-file", "write-file"])).toBeNull();
    const handler = await handlerWith(["resolve-file"]);
    expect(handler?.param).toEqual({ ops: ["resolve-file"], roots: [projectDir] });

    // Only child.yaml names inner.yaml, and child.yaml has not been served yet.
    expect(await handler!.handle(resolveLine(flowsDir, "inner.yaml"))).toEqual(
      notComposed("inner.yaml")
    );
    // Asked for in the project's .argent/flows, and again by the nested run.
    for (let asked = 0; asked < 2; asked++) {
      expect(await handler!.handle(resolveLine(flowsDir, "child.yaml"))).toMatchObject({
        ok: true,
        exists: true,
        canonical: path.join(flowsDir, "child.yaml"),
      });
    }
    expect(await handler!.handle(resolveLine(flowsDir, "inner.yaml"))).toMatchObject({
      ok: true,
      exists: true,
      canonical: path.join(flowsDir, "inner.yaml"),
    });
  });

  it("serves a nested flow named inside a when: block, and one a served nested flow names", async () => {
    await fs.writeFile(
      path.join(flowsDir, "root.yaml"),
      "steps:\n  - when: { visible: Home }\n    steps:\n" +
        nestedSteps({ name: "child", project_root: projectDir }).replace(/^/gm, "    ")
    );
    await fs.writeFile(
      path.join(flowsDir, "child.yaml"),
      `steps:\n${nestedSteps({ name: "grandchild", project_root: projectDir })}`
    );
    await fs.writeFile(path.join(flowsDir, "grandchild.yaml"), "steps:\n  - echo: deep\n");
    const handler = await handlerWith(["resolve-file"]);

    expect(await handler!.handle(resolveLine(flowsDir, "grandchild.yaml"))).toEqual(
      notComposed("grandchild.yaml")
    );
    expect(await handler!.handle(resolveLine(flowsDir, "child.yaml"))).toMatchObject({
      ok: true,
      exists: true,
    });
    expect(await handler!.handle(resolveLine(flowsDir, "grandchild.yaml"))).toMatchObject({
      ok: true,
      exists: true,
      canonical: path.join(flowsDir, "grandchild.yaml"),
    });
  });

  it("takes no flow from a nested step with a relative project_root, an invalid name or a .. segment", async () => {
    await fs.writeFile(path.join(flowsDir, "child.yaml"), "steps: []\n");
    for (const args of [
      { name: "child", project_root: "proj" },
      { name: "child", project_root: `${projectDir}/x/..` },
      { name: "../child", project_root: projectDir },
      { name: "child.yaml", project_root: projectDir },
      { name: "child" },
    ]) {
      await nests(args);
      expect(await handlerWith(ALL)).toBeNull();
    }
  });

  it("takes no flow from a nested step by flow_path, whose .yaml path stays a tool: argument", async () => {
    const child = path.join(flowsDir, "child.yaml");
    await fs.writeFile(child, "steps:\n  - echo: child\n");
    await nests({ flow_path: child });

    // The runner runs no such step over a link, so it asks resolve-file for nothing.
    expect(await handlerWith(["resolve-file"])).toBeNull();
    const handler = await handlerWith(["resolve-file", "read-file"]);
    expect(await handler!.handle(resolveLine(flowsDir, "child.yaml"))).toEqual(
      notComposed("child.yaml")
    );
    expect(await handler!.handle(readLine(child))).toMatchObject({ ok: true, exists: true });
  });

  it("counts a nested flow of a project outside the roots, and refuses it as outside", async () => {
    const otherFlows = path.join(tmpDir, "other", ".argent", "flows");
    await fs.mkdir(otherFlows, { recursive: true });
    await fs.writeFile(path.join(otherFlows, "child.yaml"), "steps: []\n");
    await nests({ name: "child", project_root: path.join(tmpDir, "other") });
    const handler = await handlerWith(["resolve-file"]);

    expect(await handler!.handle(resolveLine(otherFlows, "child.yaml"))).toEqual({
      id: "req-1",
      ok: false,
      error: `child.yaml is outside every root this client serves (${projectDir})`,
    });
  });

  it("serves what a recording file names once the recorded step runs that file as a nested flow", async () => {
    const recording = path.join(flowsDir, "rec.yaml");
    await fs.writeFile(recording, "steps:\n  - run: frag.yaml\n");
    const handler = await createClientServicesHandler({
      roots: [projectDir],
      rootFlow: recording,
      advertised: ["resolve-file"],
      baselineDir: null,
      step: { tool: "flow-execute", args: { name: "rec", project_root: projectDir } },
    });

    expect(await handler!.handle(resolveLine(flowsDir, "frag.yaml"))).toEqual({
      id: "req-1",
      ok: false,
      error: "frag.yaml is not a flow that the recorded step runs",
    });
    expect(await handler!.handle(resolveLine(flowsDir, "rec.yaml"))).toMatchObject({ ok: true });
    expect(await handler!.handle(resolveLine(flowsDir, "frag.yaml"))).toMatchObject({
      ok: true,
      exists: true,
    });
  });

  describe("baselines", () => {
    let rootKeyDir: string;
    let childKeyDir: string;
    beforeEach(async () => {
      rootKeyDir = path.join(flowsDir, "__baselines__", "root");
      childKeyDir = path.join(flowsDir, "__baselines__", "child");
      await fs.writeFile(path.join(flowsDir, "child.yaml"), "steps:\n  - snapshot: home\n");
      await nests({ name: "child", project_root: projectDir });
    });

    async function exists(file: string): Promise<boolean> {
      return fs.lstat(file).then(
        () => true,
        () => false
      );
    }

    it("reaches a nested flow's baseline directory only once resolve-file served that flow", async () => {
      const handler = await handlerWith(ALL, { baselineDir: rootKeyDir });
      const file = path.join(childKeyDir, "home.png");
      const before = {
        id: "req-1",
        ok: false,
        error: `${file} is not a baseline of this run (${rootKeyDir}/<name>.png)`,
      };

      expect(await handler!.handle(readLine(file))).toEqual(before);
      expect(await handler!.handle(writeLine(file, PNG))).toEqual(before);
      expect(await exists(path.join(flowsDir, "__baselines__"))).toBe(false);

      expect(await handler!.handle(resolveLine(flowsDir, "child.yaml"))).toMatchObject({
        ok: true,
        exists: true,
      });

      expect(await handler!.handle(readLine(file))).toEqual({
        id: "req-1",
        ok: true,
        exists: false,
      });
      expect(await handler!.handle(writeLine(file, PNG))).toEqual({
        id: "req-1",
        ok: true,
        written: file,
        replaced: false,
      });
      expect(await handler!.handle(readLine(file))).toMatchObject({
        ok: true,
        exists: true,
        size: PNG.length,
        content: PNG.toString("base64"),
      });
      // The run's own directory stays reachable.
      expect(await handler!.handle(readLine(path.join(rootKeyDir, "home.png")))).toEqual({
        id: "req-1",
        ok: true,
        exists: false,
      });
      // Another flow's baselines stay out of reach; the refusal names both directories.
      const other = path.join(flowsDir, "__baselines__", "other", "home.png");
      const refusal = {
        id: "req-1",
        ok: false,
        error:
          `${other} is not a baseline of this run ` +
          `(${rootKeyDir}/<name>.png, ${childKeyDir}/<name>.png)`,
      };
      expect(await handler!.handle(readLine(other))).toEqual(refusal);
      expect(await handler!.handle(writeLine(other, PNG))).toEqual(refusal);
      expect(await exists(path.dirname(other))).toBe(false);
    });

    it("keeps a nested flow's baselines read-only when every step that names it sets updateBaselines: false", async () => {
      await nests({ name: "child", project_root: projectDir, updateBaselines: false });
      const handler = await handlerWith(ALL, { baselineDir: rootKeyDir });
      const file = path.join(childKeyDir, "home.png");
      await handler!.handle(resolveLine(flowsDir, "child.yaml"));

      expect(await handler!.handle(readLine(file))).toEqual({
        id: "req-1",
        ok: true,
        exists: false,
      });
      expect(await handler!.handle(writeLine(file, PNG))).toEqual({
        id: "req-1",
        ok: false,
        error: `${file} is not a baseline of this run (${rootKeyDir}/<name>.png)`,
      });
      expect(await exists(childKeyDir)).toBe(false);

      // A second step that runs the same flow without opting out lets its run write.
      await nests(
        { name: "child", project_root: projectDir, updateBaselines: false },
        { name: "child", project_root: projectDir }
      );
      const both = await handlerWith(ALL, { baselineDir: rootKeyDir });
      await both!.handle(resolveLine(flowsDir, "child.yaml"));
      expect(await both!.handle(writeLine(file, PNG))).toEqual({
        id: "req-1",
        ok: true,
        written: file,
        replaced: false,
      });
    });

    it("writes no nested flow's baseline when write-file was not offered", async () => {
      const handler = await handlerWith(["resolve-file", "read-file"], { baselineDir: rootKeyDir });
      const file = path.join(childKeyDir, "home.png");
      await handler!.handle(resolveLine(flowsDir, "child.yaml"));

      expect(await handler!.handle(readLine(file))).toEqual({
        id: "req-1",
        ok: true,
        exists: false,
      });
      expect(await handler!.handle(writeLine(file, PNG))).toEqual({
        id: "req-1",
        ok: false,
        error: "op write-file is not served by this client",
      });
      expect(await exists(childKeyDir)).toBe(false);
    });

    it("opens no baseline directory for a run: target or for a nested flow it did not serve", async () => {
      // frag.yaml is a run: target, whose snapshots are the root run's; missing.yaml is not there.
      await fs.writeFile(path.join(flowsDir, "frag.yaml"), "steps:\n  - snapshot: home\n");
      await fs.writeFile(
        path.join(flowsDir, "root.yaml"),
        `steps:\n  - run: frag.yaml\n${nestedSteps({ name: "missing", project_root: projectDir })}`
      );
      const handler = await handlerWith(ALL);
      expect(await handler!.handle(resolveLine(flowsDir, "frag.yaml"))).toMatchObject({
        ok: true,
        exists: true,
      });
      expect(await handler!.handle(resolveLine(flowsDir, "missing.yaml"))).toMatchObject({
        ok: true,
        exists: false,
      });

      for (const key of ["frag", "missing"]) {
        const file = path.join(flowsDir, "__baselines__", key, "home.png");
        expect(await handler!.handle(readLine(file))).toEqual({
          id: "req-1",
          ok: false,
          error: `${file} is not a baseline of this run; this run has no baseline directory on this client`,
        });
      }
    });

    it("keys a nested flow's baselines by the stem of its real file, or by the name the step gives", async () => {
      const vault = path.join(tmpDir, "vault");
      await fs.mkdir(vault);
      await fs.writeFile(path.join(vault, "real-name.yaml"), "steps:\n  - snapshot: home\n");
      await fs.writeFile(path.join(vault, "real.yml"), "steps:\n  - snapshot: home\n");
      await fs.symlink(path.join(vault, "real-name.yaml"), path.join(flowsDir, "linked.yaml"));
      await fs.symlink(path.join(vault, "real.yml"), path.join(flowsDir, "alias.yaml"));
      await nests(
        { name: "linked", project_root: projectDir },
        { name: "alias", project_root: projectDir }
      );
      const handler = await handlerWith(ALL, { roots: [projectDir, vault] });

      expect(await handler!.handle(resolveLine(flowsDir, "linked.yaml"))).toMatchObject({
        ok: true,
        canonical: path.join(vault, "real-name.yaml"),
      });
      expect(await handler!.handle(resolveLine(flowsDir, "alias.yaml"))).toMatchObject({
        ok: true,
        canonical: path.join(vault, "real.yml"),
      });

      for (const key of ["real-name", "alias"]) {
        const file = path.join(vault, "__baselines__", key, "home.png");
        expect(await handler!.handle(readLine(file))).toEqual({
          id: "req-1",
          ok: true,
          exists: false,
        });
      }
      for (const file of [
        path.join(vault, "__baselines__", "linked", "home.png"),
        path.join(flowsDir, "__baselines__", "linked", "home.png"),
        path.join(flowsDir, "__baselines__", "alias", "home.png"),
      ]) {
        expect(await handler!.handle(readLine(file))).toMatchObject({ ok: false });
      }
    });
  });
});

describe("roots", () => {
  it("serves a file under a second root", async () => {
    const other = path.join(tmpDir, "other");
    await fs.mkdir(other);
    await fs.writeFile(path.join(other, "a.yaml"), "steps: []\n");
    await composes("../../../other/a.yaml");
    const handler = await handlerFor([projectDir, other]);

    expect(await handler.handle(resolveLine(other, "a.yaml"))).toMatchObject({
      ok: true,
      canonical: path.join(await fs.realpath(other), "a.yaml"),
      exists: true,
    });
  });
});
