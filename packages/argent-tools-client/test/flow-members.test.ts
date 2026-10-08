import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MAX_RUN_DEPTH } from "@argent/registry";

import {
  prepareFileInputs,
  type FileInputSpec,
  type FileInputWire,
  type PrepareFileInputsOptions,
} from "../src/file-inputs.js";

const NAME_SPEC: FileInputSpec = {
  target: "flow_file",
  path: "${project_root}/.argent/flows/${name}.yaml",
  kind: "file",
  skipWhenSet: "flow_path",
  collect: "flow",
};
const PATH_SPEC: FileInputSpec = {
  target: "flow_path",
  path: "${flow_path}",
  kind: "file",
  collect: "flow",
};

let tmp: string;
let proj: string;
let flows: string;

beforeEach(async () => {
  // realpath: on macOS the temp dir is spelled through the /var -> /private/var link.
  tmp = await realpath(await mkdtemp(path.join(tmpdir(), "argent-members-")));
  proj = path.join(tmp, "proj");
  flows = path.join(proj, ".argent", "flows");
  await mkdir(flows, { recursive: true });
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(tmp, { recursive: true, force: true });
});

const flowYaml = (...steps: string[]): string =>
  `steps:\n${steps.map((step) => `  - ${step}`).join("\n")}\n`;

async function put(file: string, content: string): Promise<string> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
  return file;
}

const key = (anchorDir: string, target: string): string => `${anchorDir}\0${target}`;

async function collectByName(
  name: string,
  extra: Record<string, unknown> = {},
  opts: Partial<PrepareFileInputsOptions> = {}
): Promise<FileInputWire> {
  const out = (await prepareFileInputs(
    [NAME_SPEC],
    { name, project_root: proj, ...extra },
    { includeContent: true, ...opts }
  )) as Record<string, FileInputWire>;
  return out.flow_file!;
}

async function collectByPath(
  flowPath: string,
  projectRoot = proj,
  opts: Partial<PrepareFileInputsOptions> = {}
): Promise<FileInputWire> {
  const out = (await prepareFileInputs(
    [PATH_SPEC],
    { flow_path: flowPath, project_root: projectRoot },
    { includeContent: true, ...opts }
  )) as Record<string, FileInputWire>;
  return out.flow_path!;
}

function memberByKey(wire: FileInputWire, k: string) {
  const member = wire.members?.find((m) => m.key === k);
  expect(member, `member ${JSON.stringify(k)}`).toBeDefined();
  return member!;
}

describe("prepareFileInputs with a collect: flow spec", () => {
  it("sends the root's canonical and spelling and each run: target as a member with inline bytes", async () => {
    const fragText = flowYaml("echo: inside");
    await put(path.join(flows, "frag.yaml"), fragText);
    await put(path.join(flows, "main.yaml"), flowYaml("echo: before", "run: frag.yaml"));

    const wire = await collectByName("main");

    expect(wire.canonical).toBe(path.join(flows, "main.yaml"));
    expect(wire.spelling).toEqual({ state: "listed" });
    expect(wire.members).toHaveLength(1);
    const st = await stat(path.join(flows, "frag.yaml"));
    expect(wire.members![0]).toEqual({
      role: "flow",
      key: key(flows, "frag.yaml"),
      path: path.join(flows, "frag.yaml"),
      canonical: path.join(flows, "frag.yaml"),
      spelling: { state: "listed" },
      size: Buffer.byteLength(fragText),
      mtimeMs: st.mtimeMs,
      content: Buffer.from(fragText).toString("base64"),
    });
  });

  it("completes an extension-less target the way the runner does", async () => {
    await put(path.join(flows, "frag.yaml"), flowYaml("echo: x"));
    await put(path.join(flows, "main.yaml"), flowYaml("run: frag"));

    const wire = await collectByName("main");

    expect(wire.members!.map((m) => m.key)).toEqual([key(flows, "frag.yaml")]);
  });

  it("anchors each fragment's targets at that fragment's own real directory", async () => {
    await put(path.join(proj, "shared", "b.yaml"), flowYaml("run: ../lib/c"));
    await put(path.join(proj, "lib", "c.yaml"), flowYaml("echo: c"));
    await put(path.join(flows, "main.yaml"), flowYaml("run: ../../shared/b.yaml"));

    const wire = await collectByName("main");

    expect(wire.members!.map((m) => [m.key, m.canonical])).toEqual([
      [key(flows, "../../shared/b.yaml"), path.join(proj, "shared", "b.yaml")],
      [key(path.join(proj, "shared"), "../lib/c.yaml"), path.join(proj, "lib", "c.yaml")],
    ]);
  });

  it("sends each resolution once, and ends a cycle", async () => {
    await put(path.join(flows, "a.yaml"), flowYaml("run: b.yaml", "run: b.yaml"));
    await put(path.join(flows, "b.yaml"), flowYaml("run: a.yaml"));

    const wire = await collectByName("a");

    // b names a, so the runner resolves a again to see the cycle: a is a member too.
    expect(wire.members!.map((m) => m.key)).toEqual([key(flows, "b.yaml"), key(flows, "a.yaml")]);
  });

  it("sends a chain as deep as the runner resolves, and no deeper", async () => {
    const last = MAX_RUN_DEPTH + 1;
    for (let i = 0; i <= last; i++) {
      await put(
        path.join(flows, `n${i}.yaml`),
        i < last ? flowYaml(`echo: n${i}`, `run: n${i + 1}.yaml`) : flowYaml("echo: bottom")
      );
    }

    const wire = await collectByName("n0");

    expect(wire.members).toHaveLength(MAX_RUN_DEPTH);
    expect(wire.members!.at(-1)!.canonical).toBe(path.join(flows, `n${MAX_RUN_DEPTH}.yaml`));
  });

  it("sends the targets of every when: branch, taken or not", async () => {
    await put(path.join(flows, "ios.yaml"), flowYaml("echo: ios"));
    await put(path.join(flows, "web.yaml"), flowYaml("echo: web"));
    await put(
      path.join(flows, "main.yaml"),
      [
        "steps:",
        "  - when: { platform: ios }",
        "    steps:",
        "      - run: ios.yaml",
        "  - when: { platform: chromium }",
        "    steps:",
        "      - run: web.yaml",
        "",
      ].join("\n")
    );

    const wire = await collectByName("main");

    expect(wire.members!.map((m) => m.key)).toEqual([
      key(flows, "ios.yaml"),
      key(flows, "web.yaml"),
    ]);
  });

  it("takes no target from a value the runner refuses", async () => {
    await put(path.join(flows, "login.yml"), flowYaml("echo: yml"));
    await put(
      path.join(flows, "main.yaml"),
      [
        "steps:",
        `  - run: ${path.join(flows, "abs.yaml")}`,
        "  - run: 'sub\\x.yaml'",
        "  - run:",
        "  - run: 123",
        "  - run: login.yml",
        "  - run: shared/",
        "",
      ].join("\n")
    );

    const wire = await collectByName("main");

    expect(wire.members).toEqual([]);
  });

  it("sends a target with nothing there as missing, at its nearest real ancestor", async () => {
    await put(
      path.join(flows, "main.yaml"),
      flowYaml("run: nosuch.yaml", "run: nodir/deeper/x.yaml")
    );

    const wire = await collectByName("main");

    const missing = memberByKey(wire, key(flows, "nosuch.yaml"));
    expect(missing).toMatchObject({
      state: "missing",
      canonical: path.join(flows, "nosuch.yaml"),
      spelling: { state: "absent" },
    });
    expect(missing.content).toBeUndefined();
    expect(memberByKey(wire, key(flows, "nodir/deeper/x.yaml"))).toMatchObject({
      state: "missing",
      canonical: path.join(flows, "nodir", "deeper", "x.yaml"),
    });
  });

  it("refuses a target outside every root, with the same words whether or not it exists", async () => {
    await put(path.join(tmp, "outside.yaml"), flowYaml("echo: outside"));
    await put(
      path.join(flows, "main.yaml"),
      flowYaml("run: ../../../outside.yaml", "run: ../../../absent.yaml")
    );

    const wire = await collectByName("main");

    // Only the outermost root: the flows dir lies inside the project.
    const roots = `(${proj})`;
    for (const target of ["../../../outside.yaml", "../../../absent.yaml"]) {
      const member = memberByKey(wire, key(flows, target));
      expect(member.state).toBe("refused");
      expect(member.content).toBeUndefined();
      expect(member.error).toBe(`${target} is outside every root this client serves ${roots}`);
    }
  });

  it("sends a fragment under a symlinked .argent/flows from its real location", async () => {
    const elsewhere = path.join(tmp, "elsewhere", "flows");
    await rm(flows, { recursive: true });
    await put(path.join(elsewhere, "frag.yaml"), flowYaml("echo: real"));
    await put(path.join(elsewhere, "main.yaml"), flowYaml("run: frag.yaml"));
    await symlink(elsewhere, flows);

    const wire = await collectByName("main");

    expect(wire.canonical).toBe(path.join(elsewhere, "main.yaml"));
    expect(memberByKey(wire, key(elsewhere, "frag.yaml"))).toMatchObject({
      canonical: path.join(elsewhere, "frag.yaml"),
      content: Buffer.from(flowYaml("echo: real")).toString("base64"),
    });
  });

  it("anchors a symlinked root flow beside its real file, never beside the link", async () => {
    const real = path.join(proj, "real");
    await put(path.join(real, "root.yaml"), flowYaml("run: frag.yaml"));
    await put(path.join(real, "frag.yaml"), flowYaml("echo: REAL"));
    await put(path.join(flows, "frag.yaml"), flowYaml("echo: DECOY"));
    await symlink(path.join("..", "..", "real", "root.yaml"), path.join(flows, "link.yaml"));

    const wire = await collectByName("link");

    expect(wire.canonical).toBe(path.join(real, "root.yaml"));
    expect(wire.members).toHaveLength(1);
    expect(wire.members![0]).toMatchObject({
      key: key(real, "frag.yaml"),
      canonical: path.join(real, "frag.yaml"),
      content: Buffer.from(flowYaml("echo: REAL")).toString("base64"),
    });
  });

  it("serves the project of a root saved under <P>/.argent/flows when project_root is elsewhere", async () => {
    const sub = path.join(proj, "sub");
    await mkdir(sub, { recursive: true });
    await put(path.join(proj, "lib", "x.yaml"), flowYaml("echo: lib"));
    const root = await put(path.join(flows, "main.yaml"), flowYaml("run: ../../lib/x.yaml"));

    const wire = await collectByPath(root, sub);

    expect(memberByKey(wire, key(flows, "../../lib/x.yaml"))).toMatchObject({
      canonical: path.join(proj, "lib", "x.yaml"),
      size: Buffer.byteLength(flowYaml("echo: lib")),
    });
    expect(wire.members![0]!.state).toBeUndefined();
  });

  it("refuses a .yaml name that links to a file that is not YAML, and sends one that links to .yml", async () => {
    await put(path.join(proj, ".env"), "SECRET=1\n");
    await put(path.join(flows, "real.yml"), flowYaml("echo: yml"));
    await symlink(path.join("..", "..", ".env"), path.join(flows, "secret.yaml"));
    await symlink("real.yml", path.join(flows, "alias.yaml"));
    await put(path.join(flows, "main.yaml"), flowYaml("run: secret.yaml", "run: alias.yaml"));

    const wire = await collectByName("main");

    const secret = memberByKey(wire, key(flows, "secret.yaml"));
    expect(secret).toMatchObject({
      state: "refused",
      error: "secret.yaml links to a file that is not a YAML file",
    });
    expect(secret.content).toBeUndefined();
    expect(memberByKey(wire, key(flows, "alias.yaml"))).toMatchObject({
      canonical: path.join(flows, "real.yml"),
      content: Buffer.from(flowYaml("echo: yml")).toString("base64"),
    });
  });

  it("refuses a target that is a directory as a host read would", async () => {
    await mkdir(path.join(flows, "dir.yaml"));
    await put(path.join(flows, "main.yaml"), flowYaml("run: dir.yaml"));

    const wire = await collectByName("main");

    expect(memberByKey(wire, key(flows, "dir.yaml"))).toMatchObject({
      state: "refused",
      error: "EISDIR: illegal operation on a directory, read",
    });
  });

  it("reports a case-folded spelling as classifyOnDiskSpelling does", async (ctx) => {
    await put(path.join(flows, "frag.yaml"), flowYaml("echo: x"));
    const caseInsensitive = await stat(path.join(flows, "FRAG.yaml")).then(
      () => true,
      () => false
    );
    if (!caseInsensitive) ctx.skip();
    await put(path.join(flows, "main.yaml"), flowYaml("run: FRAG.yaml"));

    const wire = await collectByName("main");

    expect(memberByKey(wire, key(flows, "FRAG.yaml")).spelling).toEqual({
      state: "case_folded",
      actual: "frag.yaml",
      addressable: true,
    });
  });

  it("sends no members and no canonical when the call is not routed", async () => {
    await put(path.join(flows, "frag.yaml"), flowYaml("echo: x"));
    await put(path.join(flows, "main.yaml"), flowYaml("run: frag.yaml"));

    const wire = await collectByName("main", {}, { includeContent: false });

    expect(wire.members).toBeUndefined();
    expect(wire.canonical).toBeUndefined();
    expect(wire.spelling).toBeUndefined();
    expect(wire.content).toBeUndefined();
  });

  it("sends no members for a root flow it cannot read", async () => {
    const wire = await collectByName("nosuch");

    expect(wire.members).toBeUndefined();
    expect(wire.content).toBeUndefined();
  });

  describe("inline budget", () => {
    let server: Server | undefined;
    afterEach(async () => {
      if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    });

    it("uploads the members past 256 KiB of inline bytes through POST /upload", async () => {
      const bodies: Buffer[] = [];
      const auth: Array<string | undefined> = [];
      server = createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
          if (req.method !== "POST" || req.url !== "/upload") {
            res.statusCode = 404;
            res.end();
            return;
          }
          bodies.push(Buffer.concat(chunks));
          auth.push(req.headers.authorization);
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ uploadId: `u-${bodies.length}` }));
        });
      });
      await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
      const { port } = server.address() as AddressInfo;

      // A YAML comment pads each fragment to 100 KiB: two fit the 256 KiB budget, the third does not.
      const padded = (name: string) =>
        `# ${"x".repeat(100 * 1024 - 40)}\n${flowYaml(`echo: ${name}`)}`;
      for (const name of ["f1", "f2", "f3"])
        await put(path.join(flows, `${name}.yaml`), padded(name));
      await put(
        path.join(flows, "main.yaml"),
        flowYaml("run: f1.yaml", "run: f2.yaml", "run: f3.yaml")
      );

      const wire = await collectByName(
        "main",
        {},
        { uploadEndpoint: { url: `http://127.0.0.1:${port}`, token: "tok" } }
      );

      const [f1, f2, f3] = wire.members!;
      expect(f1!.content).toBeDefined();
      expect(f2!.content).toBeDefined();
      expect(f3!.content).toBeUndefined();
      expect(bodies).toHaveLength(1);
      expect(auth).toEqual(["Bearer tok"]);
      // A gzip stream, hashed as posted.
      expect(bodies[0]!.subarray(0, 2)).toEqual(Buffer.from([0x1f, 0x8b]));
      expect(f3).toMatchObject({
        uploadId: "u-1",
        contentHash: createHash("sha256").update(bodies[0]!).digest("hex"),
        size: Buffer.byteLength(padded("f3")),
        canonical: path.join(flows, "f3.yaml"),
      });
    });

    it("keeps every member inline when no upload endpoint is given", async () => {
      const padded = `# ${"x".repeat(200 * 1024)}\n${flowYaml("echo: big")}`;
      await put(path.join(flows, "b1.yaml"), padded);
      await put(path.join(flows, "b2.yaml"), padded);
      await put(path.join(flows, "main.yaml"), flowYaml("run: b1.yaml", "run: b2.yaml"));

      const wire = await collectByName("main");

      expect(wire.members!.map((m) => m.content !== undefined)).toEqual([true, true]);
    });
  });

  describe("the [flow-files] log", () => {
    it("writes one line per member under ARGENT_FLOW_FILES_LOG=1, through opts.log", async () => {
      vi.stubEnv("ARGENT_FLOW_FILES_LOG", "1");
      await put(path.join(flows, "frag.yaml"), flowYaml("echo: x"));
      await put(path.join(tmp, "outside.yaml"), flowYaml("echo: out"));
      await put(
        path.join(flows, "main.yaml"),
        flowYaml("run: frag.yaml", "run: nosuch.yaml", "run: ../../../outside.yaml")
      );
      const lines: string[] = [];

      await collectByName("main", {}, { log: (line) => lines.push(line) });

      expect(lines).toEqual([
        `[flow-files] flow ${path.join(flows, "frag.yaml")}: inline ${Buffer.byteLength(flowYaml("echo: x"))}`,
        `[flow-files] flow ${path.join(flows, "nosuch.yaml")}: missing`,
        `[flow-files] flow ${path.join(tmp, "outside.yaml")}: refused (../../../outside.yaml is ` +
          `outside every root this client serves (${proj}))`,
      ]);
    });

    it("escapes control characters in a logged path", async () => {
      vi.stubEnv("ARGENT_FLOW_FILES_LOG", "1");
      const odd = path.join(tmp, "we\u0007ird");
      const oddFlows = path.join(odd, ".argent", "flows");
      await put(path.join(oddFlows, "frag.yaml"), flowYaml("echo: x"));
      await put(path.join(oddFlows, "main.yaml"), flowYaml("run: frag.yaml"));
      const lines: string[] = [];

      await prepareFileInputs(
        [NAME_SPEC],
        { name: "main", project_root: odd },
        { includeContent: true, log: (line) => lines.push(line) }
      );

      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain("we\\u0007ird");
      expect(lines[0]).not.toContain("\u0007");
    });

    it("writes nothing without ARGENT_FLOW_FILES_LOG=1", async () => {
      await put(path.join(flows, "frag.yaml"), flowYaml("echo: x"));
      await put(path.join(flows, "main.yaml"), flowYaml("run: frag.yaml"));
      const log = vi.fn();

      await collectByName("main", {}, { log });

      expect(log).not.toHaveBeenCalled();
    });
  });

  it("reads the root bytes it sends as the members' source, not a second read", async () => {
    // The root's own bytes are the wire's content; its members come from that text.
    await put(path.join(flows, "frag.yaml"), flowYaml("echo: x"));
    const root = await put(path.join(flows, "main.yaml"), flowYaml("run: frag.yaml"));

    const wire = await collectByPath(root);

    expect(Buffer.from(wire.content!, "base64").toString("utf8")).toBe(
      await readFile(root, "utf8")
    );
    expect(wire.members!.map((m) => m.key)).toEqual([key(flows, "frag.yaml")]);
  });
});
