import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  prepareFileInputs,
  type FileInputSpec,
  type FileInputWire,
  type PrepareFileInputsOptions,
} from "../src/file-inputs.js";

// The file arguments of a flow's `tool:` steps that a `collect: "flow"` wire
// sends: the arguments each tool declares as a `file` input, as `GET /tools`
// lists them, at an absolute .png or .yaml path, keyed as the step spells
// them.

const NAME_SPEC: FileInputSpec = {
  target: "flow_file",
  path: "${project_root}/.argent/flows/${name}.yaml",
  kind: "file",
  skipWhenSet: "flow_path",
  collect: "flow",
};

/** The file inputs of the tools the flows below use, as `GET /tools` lists them. */
const LISTING: Record<string, FileInputSpec[]> = {
  "screenshot-diff": [
    { target: "baselinePath", path: "${baselinePath}", kind: "file", optional: true },
    { target: "currentPath", path: "${currentPath}", kind: "file", optional: true },
    { target: "outputDir", path: "${outputDir}", kind: "probe", optional: true },
  ],
  "flow-read-prerequisite": [
    {
      target: "flow_path",
      path: "${flow_path}",
      kind: "file",
      optional: true,
      unwrapWhenSet: "name",
    } as FileInputSpec,
    {
      target: "flow_file",
      path: "${project_root}/.argent/flows/${name}.yaml",
      kind: "file",
      skipWhenSet: "flow_path",
    },
  ],
  "flow-execute": [
    { target: "flow_path", path: "${flow_path}", kind: "file", optional: true, collect: "flow" },
  ],
  "keyboard": [],
};

let tmp: string;
let proj: string;
let flows: string;
let img: string;

beforeEach(async () => {
  tmp = await realpath(await mkdtemp(path.join(tmpdir(), "argent-tool-members-")));
  proj = path.join(tmp, "proj");
  flows = path.join(proj, ".argent", "flows");
  img = path.join(proj, "img");
  await mkdir(flows, { recursive: true });
  await mkdir(img, { recursive: true });
  await writeFile(path.join(img, "a.png"), "png a");
  await writeFile(path.join(img, "b.png"), "png bb");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(tmp, { recursive: true, force: true });
});

const diff = (baselinePath: string, currentPath: string, extra = ""): string =>
  `{ tool: screenshot-diff, args: { baselinePath: "${baselinePath}", currentPath: "${currentPath}"${extra} } }`;

async function flow(name: string, ...steps: string[]): Promise<void> {
  await writeFile(
    path.join(flows, `${name}.yaml`),
    `steps:\n${steps.map((step) => `  - ${step}`).join("\n")}\n`
  );
}

async function collect(
  extra: Record<string, unknown> = {},
  opts: Partial<PrepareFileInputsOptions> = {}
): Promise<FileInputWire> {
  const out = (await prepareFileInputs(
    [NAME_SPEC],
    { name: "main", project_root: proj, ...extra },
    { includeContent: true, toolFileInputs: (tool) => LISTING[tool], ...opts }
  )) as Record<string, FileInputWire>;
  return out.flow_file!;
}

const tools = (wire: FileInputWire) => wire.members!.filter((m) => m.role === "tool");

/** Each tool member as `key: state-or-bytes`. */
const summary = (wire: FileInputWire) =>
  tools(wire).map((m) =>
    m.state === undefined
      ? `${m.key}: ${Buffer.from(m.content!, "base64").toString()}`
      : `${m.key}: ${m.state}${m.error === undefined ? "" : ` (${m.error})`}`
  );

describe("tool: file arguments sent with a collect: flow wire", () => {
  it("sends each file argument the tool declares, inline, keyed as the step spells it", async () => {
    const a = path.join(img, "a.png");
    const dotted = `${img}/../img/b.png`;
    await flow("main", "echo: x", diff(a, dotted));

    const wire = await collect();

    expect(tools(wire)).toEqual([
      expect.objectContaining({ role: "tool", key: a, path: a, size: 5 }),
      expect.objectContaining({ role: "tool", key: dotted, path: dotted, size: 6 }),
    ]);
    expect(summary(wire)).toEqual([`${a}: png a`, `${dotted}: png bb`]);
  });

  it("sends no argument the tool does not declare as a file, whatever it looks like", async () => {
    const a = path.join(img, "a.png");
    await flow(
      "main",
      `{ tool: keyboard, args: { text: "${a}" } }`,
      `{ tool: describe, args: { extra: "${a}" } }`,
      `{ tool: screenshot-diff, args: { baselinePath: "${a}", outputDir: "${img}" } }`
    );

    const wire = await collect();

    // Only the screenshot-diff baseline; outputDir is a probe, not a file.
    expect(summary(wire)).toEqual([`${a}: png a`]);
  });

  it("sends nothing for tool: steps without the tools' listing", async () => {
    await flow("main", diff(path.join(img, "a.png"), path.join(img, "b.png")));

    const wire = await collect({}, { toolFileInputs: undefined });

    expect(tools(wire)).toEqual([]);
  });

  it("sends a .yaml or .PNG argument, and never a relative or other-extension one", async () => {
    await writeFile(path.join(img, "C.PNG"), "upper");
    await flow(
      "main",
      diff(path.join(img, "C.PNG"), "img/a.png"),
      diff(path.join(img, "a.webp"), path.join(img, "a.json")),
      `{ tool: flow-read-prerequisite, args: { project_root: "${proj}", flow_path: "${path.join(flows, "main.yaml")}" } }`
    );

    const wire = await collect();

    expect(tools(wire).map((m) => m.key)).toEqual([
      path.join(img, "C.PNG"),
      path.join(flows, "main.yaml"),
    ]);
  });

  it("skips tool: flow-execute and an input whose superseding argument is also set", async () => {
    await flow(
      "main",
      `{ tool: flow-execute, args: { flow_path: "${path.join(flows, "other.yaml")}" } }`,
      `{ tool: flow-read-prerequisite, args: { name: main, project_root: "${proj}", flow_path: "${path.join(flows, "main.yaml")}" } }`
    );

    expect(tools(await collect())).toEqual([]);
  });

  it("sends the arguments of a fragment's steps and of every when: branch, each path once", async () => {
    const a = path.join(img, "a.png");
    const b = path.join(img, "b.png");
    await flow("frag", diff(b, a));
    await flow(
      "main",
      diff(a, a),
      "run: frag.yaml",
      `{ when: { platform: ios }, steps: [ ${diff(b, b)} ] }`
    );

    const wire = await collect();

    expect(tools(wire).map((m) => m.key)).toEqual([a, b]);
  });

  it("sends a missing file as missing, also behind a regular file", async () => {
    const gone = path.join(img, "gone.png");
    const behind = path.join(img, "a.png", "x.png");
    await flow("main", diff(gone, behind));

    expect(summary(await collect())).toEqual([`${gone}: missing`, `${behind}: missing`]);
  });

  it("refuses a file outside every root with the same words whether or not it exists", async () => {
    const outside = path.join(tmp, "outside.png");
    await writeFile(outside, "secret");
    const absent = path.join(tmp, "absent.png");
    await flow("main", diff(outside, absent));

    expect(summary(await collect())).toEqual([
      `${outside}: refused (${outside} is outside every root this client serves (${proj}))`,
      `${absent}: refused (${absent} is outside every root this client serves (${proj}))`,
    ]);
  });

  it("refuses a path the flow spells through a link out of the roots", async () => {
    await mkdir(path.join(tmp, "elsewhere"));
    await writeFile(path.join(tmp, "elsewhere", "a.png"), "outside bytes");
    await symlink(path.join(tmp, "elsewhere"), path.join(proj, "linked"));
    const spelled = path.join(proj, "linked", "a.png");
    await flow("main", diff(spelled, path.join(img, "a.png")));

    const [refused] = summary(await collect());
    expect(refused).toBe(
      `${spelled}: refused (${spelled} is outside every root this client serves (${proj}))`
    );
  });

  it("refuses a .png name that links to a .env, and never sends its bytes", async () => {
    await writeFile(path.join(proj, ".env"), "TOKEN=hunter2");
    await symlink("../.env", path.join(img, "secret.png"));
    const secret = path.join(img, "secret.png");
    await flow("main", diff(secret, path.join(img, "a.png")));

    const wire = await collect();

    expect(summary(wire)[0]).toBe(
      `${secret}: refused (${secret} links to a file that is not one of .png, .yaml)`
    );
    expect(JSON.stringify(wire)).not.toContain(Buffer.from("TOKEN=hunter2").toString("base64"));
  });

  it("refuses a directory with a .png name", async () => {
    const dir = path.join(img, "dir.png");
    await mkdir(dir);
    await flow("main", diff(dir, path.join(img, "a.png")));

    expect(summary(await collect())[0]).toBe(
      `${dir}: refused (EISDIR: illegal operation on a directory, read)`
    );
  });

  it("sends a baseline that a tool: step names once, with its bytes, also in an update run", async () => {
    const dir = path.join(flows, "__baselines__", "main");
    await mkdir(dir, { recursive: true });
    const page = path.join(dir, "page__chromium-1x1.png");
    await writeFile(page, "old baseline");
    await writeFile(path.join(dir, "other__chromium-1x1.png"), "other");
    await flow("main", "snapshot: page", diff(page, path.join(img, "a.png")));

    const wire = await collect({ updateBaselines: true });

    expect(wire.members!.filter((m) => m.key === page)).toEqual([
      expect.objectContaining({
        role: "tool",
        content: Buffer.from("old baseline").toString("base64"),
      }),
    ]);
    expect(wire.members!.filter((m) => m.role === "baseline").map((m) => m.key)).toEqual([
      path.join(dir, "other__chromium-1x1.png"),
    ]);
  });

  it("logs each tool file under ARGENT_FLOW_FILES_LOG=1", async () => {
    vi.stubEnv("ARGENT_FLOW_FILES_LOG", "1");
    const a = path.join(img, "a.png");
    const gone = path.join(img, "gone.png");
    await flow("main", diff(a, gone));
    const lines: string[] = [];

    await collect({}, { log: (line) => lines.push(line) });

    expect(lines).toEqual([
      `[flow-files] tool ${a}: inline 5`,
      `[flow-files] tool ${gone}: missing`,
    ]);
  });
});
