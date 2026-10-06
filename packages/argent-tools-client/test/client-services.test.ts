import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs/promises";
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

const ALL: ClientServiceOp[] = ["resolve-file"];

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
    const handler = await handlerFor(
      [linkToProject, path.join(tmpDir, "nope")],
      ["read-file", "resolve-file"]
    );
    expect(handler.param).toEqual({
      ops: ["resolve-file"],
      roots: [projectDir],
    });
  });

  it("returns null with no existing root and with no shared op", async () => {
    expect(
      await createClientServicesHandler({ roots: [path.join(tmpDir, "nope")], advertised: ALL })
    ).toBeNull();
    expect(
      await createClientServicesHandler({ roots: [projectDir], advertised: ["read-file"] })
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
    expect((answer as { error: string }).error).toContain(path.join(tmpDir, "outside.yaml"));
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
    expect((answer as { error: string }).error).toContain(path.join(elsewhere, "real.yaml"));
    expect((answer as { error: string }).error).toContain("outside every root");
  });

  it("refuses a target whose directory does not exist on this client", async () => {
    const handler = await handlerFor([projectDir]);

    const answer = await handler.handle(resolveLine(flowsDir, "gone/frag.yaml"));

    expect(answer).toMatchObject({ ok: false, error: expect.stringContaining("does not exist") });
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
