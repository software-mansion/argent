import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  prepareFileInputs,
  type FileInputSpec,
  type FileInputWire,
  type PrepareFileInputsOptions,
} from "../src/file-inputs.js";

// The snapshot baselines a `collect: "flow"` wire sends: the run's baseline
// directory beside the root flow's real file, by name for an update, with
// bytes for a compare, and only what the run's snapshots read.

const NAME_SPEC: FileInputSpec = {
  target: "flow_file",
  path: "${project_root}/.argent/flows/${name}.yaml",
  kind: "file",
  skipWhenSet: "flow_path",
  collect: "flow",
};

let tmp: string;
let proj: string;
let flows: string;

beforeEach(async () => {
  tmp = await realpath(await mkdtemp(path.join(tmpdir(), "argent-baselines-")));
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

async function put(file: string, content: string | Buffer): Promise<string> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
  return file;
}

async function collect(
  name: string,
  extra: Record<string, unknown> = {},
  opts: Partial<PrepareFileInputsOptions> = {}
): Promise<{ wire: FileInputWire; baselineDirs: string[] }> {
  const baselineDirs: string[] = [];
  const out = (await prepareFileInputs(
    [NAME_SPEC],
    { name, project_root: proj, ...extra },
    { includeContent: true, baselineDirs, ...opts }
  )) as Record<string, FileInputWire>;
  return { wire: out.flow_file!, baselineDirs };
}

const baselines = (wire: FileInputWire) => wire.members!.filter((m) => m.role === "baseline");

describe("snapshot baselines sent with a collect: flow wire", () => {
  let dir: string;
  beforeEach(async () => {
    dir = path.join(flows, "__baselines__", "main");
    for (const name of [
      "home__chromium-1000x800.png",
      "home__chromium-1000x800-crop-ab12.png",
      "home__ios-390x844.png",
      "homepage__chromium-1000x800.png",
      "other__chromium-1000x800.png",
    ]) {
      await put(path.join(dir, name), `png:${name}`);
    }
    await put(path.join(dir, "notes.txt"), "not a baseline");
    await put(path.join(flows, "frag.yaml"), flowYaml("snapshot:\n      name: other"));
  });

  it("lists every baseline of the run by name for an update, and allows writes there", async () => {
    await put(path.join(flows, "main.yaml"), flowYaml("snapshot: home"));

    const { wire, baselineDirs } = await collect("main", { updateBaselines: true });

    expect(baselines(wire)).toEqual(
      [
        "home__chromium-1000x800-crop-ab12.png",
        "home__chromium-1000x800.png",
        "home__ios-390x844.png",
        "homepage__chromium-1000x800.png",
        "other__chromium-1000x800.png",
      ].map((name) => ({
        role: "baseline",
        key: path.join(dir, name),
        path: path.join(dir, name),
        state: "listed",
      }))
    );
    expect(baselineDirs).toEqual([dir]);
  });

  it("sends the bytes of its own snapshots' baselines only for a compare, crops included", async () => {
    // `other` is a snapshot of the fragment, so its baselines go too.
    await put(path.join(flows, "main.yaml"), flowYaml("snapshot: home", "run: frag.yaml"));

    const { wire, baselineDirs } = await collect("main");

    expect(
      baselines(wire).map((m) => [
        path.basename(m.key),
        Buffer.from(m.content!, "base64").toString(),
      ])
    ).toEqual(
      [
        "home__chromium-1000x800-crop-ab12.png",
        "home__chromium-1000x800.png",
        "home__ios-390x844.png",
        "other__chromium-1000x800.png",
      ].map((name) => [name, `png:${name}`])
    );
    // A compare writes nothing back.
    expect(baselineDirs).toEqual([]);
  });

  it.each([
    [
      { device: "chromium-cdp-9222" },
      ["home__chromium-1000x800-crop-ab12.png", "home__chromium-1000x800.png"],
    ],
    [{ platform: "ios" }, ["home__ios-390x844.png"]],
    // A remote simulator's baselines are keyed as ios.
    [{ platform: "ios-remote" }, ["home__ios-390x844.png"]],
  ])(
    "sends only one platform's baselines for a compare that names it (%j)",
    async (args, names) => {
      await put(path.join(flows, "main.yaml"), flowYaml("snapshot: home"));

      const { wire } = await collect("main", args);

      expect(baselines(wire).map((m) => path.basename(m.key))).toEqual(names);
    }
  );

  it("keys the directory beside the root flow's real file, by its stem", async () => {
    const vault = path.join(tmp, "proj", "vault");
    await put(path.join(vault, "smoke.yaml"), flowYaml("snapshot: home"));
    await symlink(path.join(vault, "smoke.yaml"), path.join(flows, "main.yaml"));
    const real = path.join(vault, "__baselines__", "smoke");
    await put(path.join(real, "home__ios-390x844.png"), "png");

    const { wire, baselineDirs } = await collect("main", { updateBaselines: true });

    expect(baselines(wire).map((m) => m.key)).toEqual([path.join(real, "home__ios-390x844.png")]);
    expect(baselineDirs).toEqual([real]);
  });

  it("sends nothing and allows no write for a flow without a snapshot step", async () => {
    await put(path.join(flows, "main.yaml"), flowYaml("echo: hi"));

    const { wire, baselineDirs } = await collect("main", { updateBaselines: true });

    expect(wire.members).toEqual([]);
    expect(baselineDirs).toEqual([]);
  });

  it("allows writes into a baseline directory that does not exist yet", async () => {
    await put(path.join(flows, "fresh.yaml"), flowYaml("snapshot: home"));

    const { wire, baselineDirs } = await collect("fresh", { updateBaselines: true });

    expect(baselines(wire)).toEqual([]);
    expect(baselineDirs).toEqual([path.join(flows, "__baselines__", "fresh")]);
  });

  it("refuses a .png name that links to another kind of file or out of the roots, and sends no bytes", async () => {
    await put(path.join(flows, "main.yaml"), flowYaml("snapshot: home"));
    await put(path.join(proj, ".env"), "SECRET=1");
    await put(path.join(tmp, "outside.png"), "outside");
    await symlink(path.join(proj, ".env"), path.join(dir, "home__android-1x1.png"));
    await symlink(path.join(tmp, "outside.png"), path.join(dir, "home__vega-1x1.png"));
    await symlink(path.join(tmp, "nothing.png"), path.join(dir, "home__web-1x1.png"));

    const { wire } = await collect("main");
    const byName = Object.fromEntries(baselines(wire).map((m) => [path.basename(m.key), m]));

    expect(byName["home__android-1x1.png"]).toMatchObject({
      state: "refused",
      error: `${path.join(dir, "home__android-1x1.png")} links to a file that is not a PNG file`,
    });
    expect(byName["home__vega-1x1.png"]).toMatchObject({ state: "refused" });
    expect(byName["home__vega-1x1.png"]!.error).toContain(
      "is outside every root this client serves"
    );
    // A link to nothing is no baseline: the compare reports it missing.
    expect(byName["home__web-1x1.png"]).toMatchObject({ state: "missing" });
    for (const name of ["home__android-1x1.png", "home__vega-1x1.png", "home__web-1x1.png"]) {
      expect(byName[name]!.content).toBeUndefined();
    }

    // An update refuses the link to nothing: a write would create a file there.
    const update = await collect("main", { updateBaselines: true });
    expect(baselines(update.wire).find((m) => m.key.endsWith("home__web-1x1.png"))).toMatchObject({
      state: "refused",
      error: `${path.join(dir, "home__web-1x1.png")} is a symbolic link to a missing file`,
    });
  });

  it("logs one [flow-files] line per baseline", async () => {
    vi.stubEnv("ARGENT_FLOW_FILES_LOG", "1");
    await put(path.join(flows, "main.yaml"), flowYaml("snapshot: home"));
    const lines: string[] = [];

    await collect("main", { device: "chromium-cdp-1" }, { log: (line) => lines.push(line) });

    expect(lines).toEqual([
      `[flow-files] baseline ${path.join(dir, "home__chromium-1000x800-crop-ab12.png")}: inline 41`,
      `[flow-files] baseline ${path.join(dir, "home__chromium-1000x800.png")}: inline 31`,
    ]);
  });

  describe("past the inline budget", () => {
    let server: Server | undefined;
    afterEach(async () => {
      if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    });

    it("uploads each baseline past 256 KiB of inline bytes through POST /upload", async () => {
      let uploads = 0;
      server = createServer((req, res) => {
        req.resume();
        req.on("end", () => {
          uploads++;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ uploadId: `u-${uploads}` }));
        });
      });
      await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
      const { port } = server.address() as AddressInfo;
      await put(path.join(flows, "big.yaml"), flowYaml("snapshot: big"));
      const bigDir = path.join(flows, "__baselines__", "big");
      for (const n of [1, 2, 3]) {
        await put(path.join(bigDir, `big__ios-${n}x1.png`), Buffer.alloc(100 * 1024, n));
      }

      const { wire } = await collect(
        "big",
        {},
        { uploadEndpoint: { url: `http://127.0.0.1:${port}`, token: "" } }
      );

      expect(baselines(wire).map((m) => [m.content !== undefined, m.uploadId])).toEqual([
        [true, undefined],
        [true, undefined],
        [false, "u-1"],
      ]);
      expect(uploads).toBe(1);
    });
  });
});

describe("snapshot baselines of the runs that nested tool: flow-execute steps start", () => {
  const nested = (name: string, extra = ""): string =>
    `{ tool: flow-execute, args: { name: ${name}, project_root: "${proj}"${extra} } }`;
  let innerDir: string;

  beforeEach(async () => {
    innerDir = path.join(flows, "__baselines__", "inner-snap");
    for (const name of [
      "page__chromium-1000x800.png",
      "page__ios-390x844.png",
      "other__chromium-1000x800.png",
    ]) {
      await put(path.join(innerDir, name), `png:${name}`);
    }
    // The outer flow's own directory holds a baseline of the same name: a
    // nested run never reads or writes it.
    await put(path.join(flows, "__baselines__", "outer", "page__chromium-1000x800.png"), "outer");
    await put(path.join(flows, "inner-snap.yaml"), flowYaml("snapshot: page"));
  });

  const summary = (wire: FileInputWire) =>
    baselines(wire).map((m) =>
      m.state === undefined
        ? `${path.relative(flows, m.key)}: ${Buffer.from(m.content!, "base64").toString()}`
        : `${path.relative(flows, m.key)}: ${m.state}`
    );

  it("sends the nested run's own baselines with bytes for a compare, from beside the nested flow", async () => {
    await put(path.join(flows, "outer.yaml"), flowYaml("echo: before", nested("inner-snap")));

    const { wire, baselineDirs } = await collect("outer");

    expect(summary(wire)).toEqual([
      "__baselines__/inner-snap/page__chromium-1000x800.png: png:page__chromium-1000x800.png",
      "__baselines__/inner-snap/page__ios-390x844.png: png:page__ios-390x844.png",
    ]);
    expect(baselineDirs).toEqual([]);
  });

  it("lists them and allows writes there when the nested run updates, by the call or by its step", async () => {
    await put(path.join(flows, "outer.yaml"), flowYaml(nested("inner-snap")));
    await put(
      path.join(flows, "own.yaml"),
      flowYaml(nested("inner-snap", ", updateBaselines: true"))
    );
    const listed = [
      "__baselines__/inner-snap/other__chromium-1000x800.png: listed",
      "__baselines__/inner-snap/page__chromium-1000x800.png: listed",
      "__baselines__/inner-snap/page__ios-390x844.png: listed",
    ];

    const inherited = await collect("outer", { updateBaselines: true });
    expect(summary(inherited.wire)).toEqual(listed);
    // Only the run that has snapshots keys a directory: not the outer flow's.
    expect(inherited.baselineDirs).toEqual([innerDir]);

    const own = await collect("own");
    expect(summary(own.wire)).toEqual(listed);
    expect(own.baselineDirs).toEqual([innerDir]);
  });

  it("sends bytes and allows no write for a nested run with updateBaselines: false in an updating call", async () => {
    await put(
      path.join(flows, "outer.yaml"),
      flowYaml(nested("inner-snap", ", updateBaselines: false"))
    );

    const { wire, baselineDirs } = await collect("outer", { updateBaselines: true });

    expect(summary(wire)).toEqual([
      "__baselines__/inner-snap/page__chromium-1000x800.png: png:page__chromium-1000x800.png",
      "__baselines__/inner-snap/page__ios-390x844.png: png:page__ios-390x844.png",
    ]);
    expect(baselineDirs).toEqual([]);
  });

  it("sends one directory once for a run that updates it and one that compares it (rw-root)", async () => {
    // Step 1 writes the nested baselines, step 2 compares against them in the
    // same call: the compared names go with their bytes (a write replaces
    // them), every other one by name, and the directory takes writes.
    await put(
      path.join(flows, "rw-root.yaml"),
      flowYaml(nested("inner-snap"), nested("inner-snap", ", updateBaselines: false"))
    );

    const { wire, baselineDirs } = await collect("rw-root", { updateBaselines: true });

    expect(summary(wire)).toEqual([
      "__baselines__/inner-snap/other__chromium-1000x800.png: listed",
      "__baselines__/inner-snap/page__chromium-1000x800.png: png:page__chromium-1000x800.png",
      "__baselines__/inner-snap/page__ios-390x844.png: png:page__ios-390x844.png",
    ]);
    expect(baselineDirs).toEqual([innerDir]);
    expect(wire.members!.filter((m) => m.role === "flow").map((m) => m.key)).toEqual([
      `${flows}\0inner-snap.yaml`,
    ]);
  });

  it("sends the baselines of the call's platform for a nested run, whatever device its step names", async () => {
    // The runner binds the run's own device into a nested step.
    await put(
      path.join(flows, "outer.yaml"),
      flowYaml(nested("inner-snap", ", device: emulator-5554"))
    );

    const { wire } = await collect("outer", { device: "chromium-cdp-9222" });

    expect(summary(wire)).toEqual([
      "__baselines__/inner-snap/page__chromium-1000x800.png: png:page__chromium-1000x800.png",
    ]);
  });

  it("keys a nested run's directory beside the nested flow's real file, by its stem", async () => {
    const vault = path.join(proj, "vault");
    await put(path.join(vault, "real-login.yaml"), flowYaml("snapshot: page"));
    await symlink(path.join(vault, "real-login.yaml"), path.join(flows, "login.yaml"));
    const real = path.join(vault, "__baselines__", "real-login");
    await put(path.join(real, "page__ios-1x1.png"), "png");
    await put(path.join(flows, "outer.yaml"), flowYaml(nested("login")));

    const { wire, baselineDirs } = await collect("outer", { updateBaselines: true });

    expect(baselines(wire).map((m) => [m.key, m.state])).toEqual([
      [path.join(real, "page__ios-1x1.png"), "listed"],
    ]);
    expect(baselineDirs).toEqual([real]);
  });

  it("keeps the root run's and a nested run's directories apart", async () => {
    await put(path.join(flows, "outer.yaml"), flowYaml("snapshot: page", nested("inner-snap")));

    const { wire, baselineDirs } = await collect("outer", { updateBaselines: true });

    expect(summary(wire)).toEqual([
      "__baselines__/outer/page__chromium-1000x800.png: listed",
      "__baselines__/inner-snap/other__chromium-1000x800.png: listed",
      "__baselines__/inner-snap/page__chromium-1000x800.png: listed",
      "__baselines__/inner-snap/page__ios-390x844.png: listed",
    ]);
    expect(baselineDirs).toEqual([path.join(flows, "__baselines__", "outer"), innerDir]);
  });
});
