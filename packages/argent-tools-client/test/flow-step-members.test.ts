import { mkdir, mkdtemp, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  FILE_INPUT_MARKER,
  prepareFileInputs,
  type FileInputSpec,
  type FileInputWire,
  type PrepareFileInputsOptions,
} from "../src/file-inputs.js";

// What a `collect: "step"` probe sends: flow-add-step runs ONE tool live and
// records it, and over a link the client sends the files that step makes the
// tool-server read, as a replay of the step over the same link reads them.

const STEP_SPEC: FileInputSpec = {
  target: "project_root",
  path: "${project_root}",
  kind: "probe",
  collect: "step",
};

const LISTING: Record<string, FileInputSpec[]> = {
  "screenshot-diff": [
    { target: "baselinePath", path: "${baselinePath}", kind: "file", optional: true },
    { target: "currentPath", path: "${currentPath}", kind: "file", optional: true },
    { target: "outputDir", path: "${outputDir}", kind: "probe", optional: true },
  ],
  "flow-execute": [
    { target: "flow_path", path: "${flow_path}", kind: "file", optional: true, collect: "flow" },
  ],
};

let tmp: string;
let proj: string;
let flows: string;

beforeEach(async () => {
  tmp = await realpath(await mkdtemp(path.join(tmpdir(), "argent-step-members-")));
  proj = path.join(tmp, "proj");
  flows = path.join(proj, ".argent", "flows");
  await mkdir(flows, { recursive: true });
  // The recording file the client wrote from flow-start-recording's directive.
  await writeFile(path.join(flows, "rec.yaml"), "steps: []\n");
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

/** The project_root wire of a flow-add-step call recording `command` with `args` into `rec`. */
async function collectStep(
  command: string,
  args?: Record<string, unknown> | string,
  opts: Partial<PrepareFileInputsOptions> = {},
  extra: Record<string, unknown> = {}
): Promise<{ wire: FileInputWire; baselineDirs: string[] }> {
  const baselineDirs: string[] = [];
  const out = (await prepareFileInputs(
    [STEP_SPEC],
    {
      name: "rec",
      project_root: proj,
      command,
      ...(args === undefined
        ? {}
        : { args: typeof args === "string" ? args : JSON.stringify(args) }),
      ...extra,
    },
    {
      includeContent: true,
      toolFileInputs: (tool) => LISTING[tool],
      baselineDirs,
      ...opts,
    }
  )) as Record<string, FileInputWire>;
  return { wire: out.project_root!, baselineDirs };
}

const keys = (wire: FileInputWire) => wire.members!.map((m) => m.key);

describe("prepareFileInputs with a collect: step probe", () => {
  it("sends the probe alone, with no members, when the call is not routed", async () => {
    const png = await put(path.join(proj, "img", "a.png"), "png a");

    const { wire } = await collectStep(
      "screenshot-diff",
      { baselinePath: png, currentPath: png },
      { includeContent: false }
    );

    expect(wire).toEqual({ [FILE_INPUT_MARKER]: true, path: proj });
  });

  it("sends empty members for a step that reads no file", async () => {
    const { wire } = await collectStep("gesture-tap", { udid: "sim", x: 0.5, y: 0.5 });

    expect(wire).toEqual({ [FILE_INPUT_MARKER]: true, path: proj, members: [] });
  });

  it("sends the file arguments the recorded tool declares, and no other argument", async () => {
    const a = await put(path.join(proj, "img", "a.png"), "png a");
    const b = path.join(proj, "img", "gone.png");

    const { wire } = await collectStep("screenshot-diff", {
      baselinePath: a,
      currentPath: b,
      outputDir: path.join(proj, "out"),
    });

    expect(wire.members).toEqual([
      expect.objectContaining({
        role: "tool",
        key: a,
        content: Buffer.from("png a").toString("base64"),
      }),
      { role: "tool", key: b, path: b, state: "missing" },
    ]);
  });

  it("sends the recording, the sibling and the nested flow with its own files for a flow-execute by name", async () => {
    await put(path.join(flows, "basic.yaml"), flowYaml("run: frag.yaml"));
    await put(path.join(flows, "frag.yaml"), flowYaml("echo: frag"));

    const { wire } = await collectStep("flow-execute", { name: "basic", project_root: proj });

    // The sibling beside the recording's real file and the flow that runs
    // are one file here, so one member.
    expect(keys(wire)).toEqual([
      key(flows, "rec.yaml"),
      key(flows, "basic.yaml"),
      key(flows, "frag.yaml"),
    ]);
    expect(wire.members![0]).toMatchObject({
      role: "flow",
      canonical: path.join(flows, "rec.yaml"),
      spelling: { state: "listed" },
    });
  });

  it("sends the sibling beside the recording's real file apart from the flow that runs", async () => {
    // The recording is a link into a vault, so its siblings are the vault's.
    const vault = path.join(proj, "vault");
    await put(path.join(vault, "real-rec.yaml"), "steps: []\n");
    await rm(path.join(flows, "rec.yaml"));
    await symlink(path.join(vault, "real-rec.yaml"), path.join(flows, "rec.yaml"));
    await put(path.join(vault, "basic.yaml"), flowYaml("echo: vault"));
    await put(path.join(flows, "basic.yaml"), flowYaml("echo: flows"));

    const { wire } = await collectStep("flow-execute", { name: "basic", project_root: proj });

    expect(wire.members!.map((m) => [m.key, m.canonical])).toEqual([
      [key(flows, "rec.yaml"), path.join(vault, "real-rec.yaml")],
      [key(vault, "basic.yaml"), path.join(vault, "basic.yaml")],
      [key(flows, "basic.yaml"), path.join(flows, "basic.yaml")],
    ]);
  });

  it("sends a missing recording as missing, and the nested flow still", async () => {
    await rm(path.join(flows, "rec.yaml"));
    await put(path.join(flows, "basic.yaml"), flowYaml("echo: basic"));

    const { wire } = await collectStep("flow-execute", { name: "basic", project_root: proj });

    expect(wire.members![0]).toMatchObject({ key: key(flows, "rec.yaml"), state: "missing" });
    expect(keys(wire)).toEqual([key(flows, "rec.yaml"), key(flows, "basic.yaml")]);
  });

  it("sends a flow_path that names a sibling under its spelling, and runs it as the name the recorder rewrites it to", async () => {
    await put(path.join(flows, "basic.yaml"), flowYaml("run: frag.yaml"));
    await put(path.join(flows, "frag.yaml"), flowYaml("echo: frag"));

    const { wire } = await collectStep("flow-execute", {
      flow_path: path.join(flows, "basic.yaml"),
      project_root: proj,
    });

    expect(keys(wire)).toEqual([
      key(flows, "rec.yaml"),
      key(flows, "basic.yaml"),
      key(flows, "frag.yaml"),
    ]);
    expect(wire.members![1]).toMatchObject({ spelling: { state: "listed" } });
  });

  it("reports a case-folded flow_path spelling, for the recorder's on-disk check", async (ctx) => {
    await put(path.join(flows, "basic.yaml"), flowYaml("echo: basic"));
    const caseInsensitive = await stat(path.join(flows, "BASIC.yaml")).then(
      () => true,
      () => false
    );
    if (!caseInsensitive) ctx.skip();

    const { wire } = await collectStep("flow-execute", {
      flow_path: path.join(flows, "BASIC.yaml"),
      project_root: proj,
    });

    expect(wire.members!.find((m) => m.key === key(flows, "BASIC.yaml"))).toMatchObject({
      spelling: { state: "case_folded", actual: "basic.yaml", addressable: true },
    });
  });

  it("sends no nested flow for a flow_path that is not a sibling of the recording", async () => {
    await put(path.join(proj, "other", "basic.yaml"), flowYaml("echo: other"));

    const { wire } = await collectStep("flow-execute", {
      flow_path: path.join(proj, "other", "basic.yaml"),
      project_root: proj,
    });

    // The recorder refuses such a step before it reads anything but the recording.
    expect(keys(wire)).toEqual([key(flows, "rec.yaml")]);
  });

  it("sends the nested run's baselines: by name and allowed for an update, with bytes for a compare", async () => {
    await put(path.join(flows, "snap.yaml"), flowYaml("snapshot: page"));
    const dir = path.join(flows, "__baselines__", "snap");
    const page = await put(path.join(dir, "page__chromium-1x1.png"), "png page");
    await put(path.join(dir, "other__chromium-1x1.png"), "png other");

    const update = await collectStep("flow-execute", {
      name: "snap",
      project_root: proj,
      updateBaselines: true,
    });
    expect(update.wire.members!.filter((m) => m.role === "baseline")).toEqual([
      {
        role: "baseline",
        key: path.join(dir, "other__chromium-1x1.png"),
        path: path.join(dir, "other__chromium-1x1.png"),
        state: "listed",
      },
      { role: "baseline", key: page, path: page, state: "listed" },
    ]);
    expect(update.baselineDirs).toEqual([dir]);

    const compare = await collectStep("flow-execute", { name: "snap", project_root: proj });
    expect(compare.wire.members!.filter((m) => m.role === "baseline")).toEqual([
      expect.objectContaining({ key: page, content: Buffer.from("png page").toString("base64") }),
    ]);
    expect(compare.baselineDirs).toEqual([]);
  });

  it.each([
    ["args that are not JSON", "{ not json"],
    ["args that are a JSON array", "[1]"],
    ["args that are JSON text of a string", '"x"'],
  ])("sends nothing for %s", async (_what, args) => {
    await put(path.join(flows, "basic.yaml"), flowYaml("echo: basic"));

    const { wire } = await collectStep("flow-execute", args);

    expect(wire.members).toEqual([]);
  });

  it("sends nothing for a call without a valid name or an absolute project_root", async () => {
    await put(path.join(flows, "basic.yaml"), flowYaml("echo: basic"));
    const step = { name: "basic", project_root: proj };

    expect((await collectStep("flow-execute", step, {}, { name: "../rec" })).wire.members).toEqual(
      []
    );
    const relative = (await prepareFileInputs(
      [STEP_SPEC],
      { name: "rec", project_root: "proj", command: "flow-execute", args: JSON.stringify(step) },
      { includeContent: true }
    )) as Record<string, FileInputWire>;
    expect(relative.project_root!.members).toEqual([]);
  });

  it("logs each member under ARGENT_FLOW_FILES_LOG=1", async () => {
    vi.stubEnv("ARGENT_FLOW_FILES_LOG", "1");
    await put(path.join(flows, "basic.yaml"), flowYaml("echo: basic"));
    const lines: string[] = [];

    await collectStep(
      "flow-execute",
      { name: "basic", project_root: proj },
      { log: (line) => lines.push(line) }
    );

    expect(lines).toEqual([
      `[flow-files] flow ${path.join(flows, "rec.yaml")}: inline ${"steps: []\n".length}`,
      `[flow-files] flow ${path.join(flows, "basic.yaml")}: inline ${flowYaml("echo: basic").length}`,
    ]);
  });
});
