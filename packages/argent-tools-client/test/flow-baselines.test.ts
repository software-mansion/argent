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
