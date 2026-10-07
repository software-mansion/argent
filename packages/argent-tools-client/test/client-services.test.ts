import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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

const ALL: ClientServiceOp[] = ["resolve-file"];

async function handlerFor(
  roots: string[],
  { rootFlow = path.join(flowsDir, "root.yaml"), advertised = ALL } = {} as {
    rootFlow?: string;
    advertised?: ClientServiceOp[];
  }
) {
  const handler = await createClientServicesHandler({ roots, rootFlow, advertised });
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
    const handler = await handlerFor([linkToProject, path.join(tmpDir, "nope")], {
      advertised: ["read-file", "resolve-file"],
    });
    expect(handler.param).toEqual({
      ops: ["resolve-file"],
      roots: [projectDir],
    });
  });

  it("returns null with no existing root and with no shared op", async () => {
    const rootFlow = path.join(flowsDir, "root.yaml");
    expect(
      await createClientServicesHandler({
        roots: [path.join(tmpDir, "nope")],
        rootFlow,
        advertised: ALL,
      })
    ).toBeNull();
    expect(
      await createClientServicesHandler({
        roots: [projectDir],
        rootFlow,
        advertised: ["read-file"],
      })
    ).toBeNull();
    expect(
      await createClientServicesHandler({ roots: [projectDir], rootFlow, advertised: [] })
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
      `[client-services] resolve-file ${path.join(flowsDir, "frag.yaml")}\n`,
    ]);
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
        createClientServicesHandler({ roots: [projectDir], rootFlow, advertised: ALL })
      );

    expect(await handlerWith("steps:\n  - echo: hi\n")).toBeNull();
    expect(await handlerWith('steps:\n  - run: "/abs.yaml"\n')).toBeNull();
    expect(await handlerWith("steps: [ { run: frag.yaml }\n")).toBeNull();
    expect(await handlerWith(null)).toBeNull();
    await fs.mkdir(rootFlow);
    expect(
      await createClientServicesHandler({ roots: [projectDir], rootFlow, advertised: ALL })
    ).toBeNull();
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
