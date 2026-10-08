/**
 * Parity between what the argent client sends with a linked flow and what the
 * runner reads. The client walks a flow's `run:` closure with the registry's
 * collector before the call; the runner resolves `run:` targets with its own
 * parser while it runs. Every resolution the runner makes must be one the
 * client sent, or a linked run fails a step a co-located run passes.
 *
 * Each case runs a flow twice: co-located, recording the runner's
 * resolutions, and as an upload carrying the closure the client would send,
 * built here the client's way. The recorded resolutions must all be members,
 * and the two reports must agree step for step. The same holds for the
 * snapshot baselines a compare run reads: every one must be among those the
 * client sends for the snapshot names the collector finds, and for the file
 * arguments the `tool:` steps of a linked run read: every one must be among
 * those the client sends for the tool steps the collector finds.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import { PNG } from "pngjs";
import {
  ArtifactStore,
  baselineKeyFor,
  canonicalFlowPath,
  classifyOnDiskSpelling,
  collectFlowRequests,
  flowMemberKey,
  FLOW_FILE_NAME_PATTERN,
  isClientFileArgument,
  MAX_RUN_DEPTH,
  toolStepFiles,
  type Registry,
  type ResolvedFileInput,
  type ResolvedMember,
} from "@argent/registry";
import { createRunFlowTool, type FlowRunResult } from "../../src/tools/flows/flow-run";
import { ClientProjectAccess, HostProjectAccess } from "../../src/tools/flows/project-access";
import { flowReadPrerequisiteTool } from "../../src/tools/flows/flow-read-prerequisite";
import { screenshotDiffTool } from "../../src/tools/screenshot-diff";

// The step registry below serves no describe tree, so an unstubbed settle
// would poll to its own deadline before a snapshot's capture.
vi.mock("../../src/tools/flows/flow-actions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/tools/flows/flow-actions")>()),
  settleTree: vi.fn(async () => ({})),
}));

const DEVICE = "00000000-0000-0000-0000-0000000000ab";
let tmpDir: string;

function mockRegistry(): Registry {
  return {
    invokeTool: vi.fn(async (id: string) => (id === "list-devices" ? { devices: [] } : {})),
    getTool: vi.fn(() => undefined),
    resolveService: vi.fn(async () => ({ isConnected: () => true })),
  } as unknown as Registry;
}

async function write(rel: string, text: string): Promise<void> {
  const file = path.join(tmpDir, rel);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text, "utf8");
}

const flows = (rel: string) => path.join(".argent", "flows", rel);

/** The closure the argent client sends with the root flow at `spelled`, built the client's way. */
async function clientClosure(spelled: string): Promise<ResolvedFileInput> {
  const canonical = await canonicalFlowPath(spelled);
  const members: Record<string, ResolvedMember> = {};
  const queue = [{ canonical, text: await fs.readFile(canonical, "utf8"), hop: 0 }];
  for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
    const anchorDir = path.dirname(file.canonical);
    for (const target of collectFlowRequests(parseYaml(file.text)).runTargets) {
      const key = flowMemberKey(anchorDir, target);
      if (Object.hasOwn(members, key)) continue;
      const memberPath = anchorDir + path.sep + target;
      const real = await canonicalFlowPath(memberPath);
      const spelling = await classifyOnDiskSpelling(
        path.dirname(memberPath),
        path.posix.basename(target),
        FLOW_FILE_NAME_PATTERN
      );
      const text = await fs.readFile(real, "utf8").catch(() => null);
      if (text === null) {
        members[key] = { role: "flow", state: "missing", canonical: real, spelling };
        continue;
      }
      members[key] = { role: "flow", state: "present", canonical: real, spelling, text };
      if (file.hop + 1 < MAX_RUN_DEPTH) queue.push({ canonical: real, text, hop: file.hop + 1 });
    }
  }
  return {
    clientPath: spelled,
    presentOnHost: false,
    viaUpload: true,
    canonical,
    spelling: await classifyOnDiskSpelling(path.dirname(spelled), path.basename(spelled)),
    members,
  };
}

function summary(result: FlowRunResult | { notice: string }): string[] {
  if (!("steps" in result)) throw new Error(`expected a run result, got: ${result.notice}`);
  return result.steps.map((s) =>
    [s.kind, s.status, s.flow ?? "", s.message ?? "", s.reason ?? ""].join(" | ")
  );
}

async function runBothWays(name: string): Promise<{
  resolved: string[];
  closure: ResolvedFileInput;
  colocated: string[];
  linked: string[];
}> {
  const spy = vi.spyOn(HostProjectAccess.prototype, "resolveFlowFile");
  let colocated: string[];
  let resolved: string[];
  try {
    colocated = summary(
      await createRunFlowTool(mockRegistry()).execute(
        {},
        { name, project_root: tmpDir, device: DEVICE },
        { artifacts: new ArtifactStore() }
      )
    );
    // Read before the restore, which clears the recorded calls.
    resolved = spy.mock.calls.map(([anchorDir, target]) => flowMemberKey(anchorDir, target));
  } finally {
    spy.mockRestore();
  }

  const spelled = path.join(tmpDir, flows(`${name}.yaml`));
  const closure = await clientClosure(spelled);
  // The upload is materialized away from the project, as the boundary does.
  const uploadDir = await fs.mkdtemp(path.join(os.tmpdir(), "parity-upload-"));
  const uploaded = path.join(uploadDir, `${name}.yaml`);
  await fs.copyFile(spelled, uploaded);
  try {
    const linked = summary(
      await createRunFlowTool(mockRegistry()).execute(
        {},
        { name, project_root: tmpDir, flow_file: uploaded, device: DEVICE },
        { artifacts: new ArtifactStore(), fileInputs: { flow_file: closure } }
      )
    );
    return { resolved, closure, colocated, linked };
  } finally {
    await fs.rm(uploadDir, { recursive: true, force: true });
  }
}

beforeEach(async () => {
  tmpDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "flow-parity-")));
  await write(flows("frag-echo.yaml"), "steps:\n  - echo: inside fragment\n");
  await write(
    flows("withrun.yaml"),
    "steps:\n  - echo: before\n  - run: frag-echo.yaml\n  - echo: after\n"
  );
  await write(
    flows("s2a.yaml"),
    "steps:\n  - echo: s2a start\n  - run: ../../shared/s2b.yaml\n  - echo: s2a end\n"
  );
  await write("shared/s2b.yaml", "steps:\n  - echo: s2b in shared\n  - run: ../lib/s2c\n");
  await write("lib/s2c.yaml", "steps:\n  - echo: s2c in lib\n");
  await write(
    flows("s3when.yaml"),
    "steps:\n" +
      "  - when: { platform: chromium }\n    steps:\n      - run: s3untaken.yaml\n" +
      "  - when: { platform: ios }\n    steps:\n      - run: s3taken.yaml\n" +
      "  - echo: s3 end\n"
  );
  await write(flows("s3taken.yaml"), "steps:\n  - echo: s3 TAKEN fragment ran\n");
  await write(flows("s3untaken.yaml"), "steps:\n  - echo: s3 UNTAKEN fragment ran\n");
  await write(
    flows("s4.yaml"),
    "steps:\n" +
      "  - when: { platform: android }\n    steps:\n      - run: nosuch-untaken.yaml\n" +
      "  - when: { platform: ios }\n    steps:\n      - run: nosuch-taken.yaml\n" +
      "  - echo: s4 after\n"
  );
  await write(flows("s6a.yaml"), "steps:\n  - echo: s6a\n  - run: s6b.yaml\n");
  await write(flows("s6b.yaml"), "steps:\n  - echo: s6b\n  - run: s6a.yaml\n");
  for (let i = 1; i <= 23; i++) {
    const n = String(i).padStart(2, "0");
    const next = String(i + 1).padStart(2, "0");
    await write(
      flows(`c${n}.yaml`),
      i === 23
        ? "steps:\n  - echo: c23 bottom\n"
        : `steps:\n  - echo: c${n}\n  - run: c${next}.yaml\n`
    );
  }
  await write(flows("nested-when.yaml"), "steps:\n  - run: when-frag.yaml\n");
  await write(
    flows("when-frag.yaml"),
    "steps:\n" +
      "  - when: { platform: ios }\n    steps:\n" +
      "      - when: { platform: ios }\n        steps:\n          - run: sub/deep.yaml\n"
  );
  await write(flows("sub/deep.yaml"), "steps:\n  - echo: two blocks deep\n  - run: ../frag-echo\n");
  await write(flows("norun.yaml"), "steps:\n  - echo: no composition\n");
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("the client's run: closure covers every resolution the runner makes", () => {
  it.each([
    ["withrun", 1],
    ["s2a", 2],
    ["s3when", 2],
    ["s4", 2],
    ["s6a", 2],
    ["c01", MAX_RUN_DEPTH],
    ["nested-when", 3],
    ["norun", 0],
  ])("%s", async (name, expectedMembers) => {
    const { resolved, closure, colocated, linked } = await runBothWays(name);

    const sent = Object.keys(closure.members!);
    expect(sent).toHaveLength(expectedMembers);
    // A flow that composes resolves at least once, so the check below bites.
    expect(resolved.length > 0).toBe(expectedMembers > 0);
    for (const key of resolved) expect(sent).toContain(key);
    expect(linked).toEqual(colocated);
  });

  it("resolves the chain to the depth guard, and the client sends nothing past it", async () => {
    const { resolved, closure, colocated } = await runBothWays("c01");

    // c02 … c21: the runner resolves c21 for its cycle check, then refuses it
    // for depth, so c22 is never asked for.
    expect(resolved).toHaveLength(MAX_RUN_DEPTH);
    expect(Object.values(closure.members!).map((m) => path.basename(m.canonical ?? ""))).toEqual(
      Array.from({ length: MAX_RUN_DEPTH }, (_, i) => `c${String(i + 2).padStart(2, "0")}.yaml`)
    );
    expect(colocated.some((line) => /max run depth/.test(line))).toBe(true);
  });
});

describe("the client's baselines cover every baseline a compare run reads", () => {
  let capture: string;
  beforeEach(async () => {
    const png = new PNG({ width: 30, height: 60 });
    png.data.fill(200);
    capture = path.join(tmpDir, "capture.png");
    await fs.writeFile(capture, PNG.sync.write(png));
    await write(
      flows("snaproot.yaml"),
      "steps:\n  - snapshot: home\n  - run: snapfrag.yaml\n" +
        "  - when: { platform: android }\n    steps:\n      - snapshot: { name: never }\n"
    );
    await write(
      flows("snapfrag.yaml"),
      "steps:\n  - when: { platform: ios }\n    steps:\n      - snapshot:\n          name: inner\n"
    );
  });

  /** A device that only takes screenshots. */
  function snapRegistry(): Registry {
    return {
      invokeTool: vi.fn(async (id: string) =>
        id === "screenshot" ? { image: { hostPath: capture } } : { ok: true }
      ),
      getTool: vi.fn(() => ({ inputSchema: { properties: { udid: {} } } })),
      resolveService: vi.fn(async () => ({ isConnected: () => true })),
    } as unknown as Registry;
  }

  const run = (args: Record<string, unknown>, ctx: Record<string, unknown> = {}) =>
    createRunFlowTool(snapRegistry()).execute(
      {},
      { name: "snaproot", project_root: tmpDir, device: DEVICE, ...args } as never,
      { artifacts: new ArtifactStore(), ...ctx }
    );

  it("snaproot", async () => {
    // Seed the baselines co-located, then record what a compare reads.
    expect(summary(await run({ updateBaselines: true })).every((l) => !/error|fail/.test(l))).toBe(
      true
    );
    const spy = vi.spyOn(HostProjectAccess.prototype, "readFile");
    let colocated: string[];
    let read: string[];
    try {
      colocated = summary(await run({}));
      read = spy.mock.calls.map(([file]) => file);
    } finally {
      spy.mockRestore();
    }

    // The client's way: the closure's snapshot names, and the files of those
    // snapshots in the run's baseline directory.
    const spelled = path.join(tmpDir, flows("snaproot.yaml"));
    const closure = await clientClosure(spelled);
    const names = new Set<string>();
    for (const text of [
      await fs.readFile(spelled, "utf8"),
      ...Object.values(closure.members!).map((m) => m.text ?? ""),
    ]) {
      for (const name of collectFlowRequests(parseYaml(text)).snapshots) names.add(name);
    }
    expect([...names].sort()).toEqual(["home", "inner", "never"]);
    const dir = path.join(
      path.dirname(closure.canonical!),
      "__baselines__",
      baselineKeyFor(closure.canonical!, "snaproot")
    );
    for (const file of await fs.readdir(dir)) {
      if (![...names].some((name) => file.startsWith(`${name}__`))) continue;
      closure.members![path.join(dir, file)] = {
        role: "baseline",
        state: "present",
        hostPath: path.join(dir, file),
      };
    }

    expect(read.length).toBe(2);
    for (const file of read) expect(Object.keys(closure.members!)).toContain(file);

    const uploadDir = await fs.mkdtemp(path.join(os.tmpdir(), "parity-upload-"));
    const uploaded = path.join(uploadDir, "snaproot.yaml");
    await fs.copyFile(spelled, uploaded);
    try {
      const linked = summary(
        await run({ flow_file: uploaded }, { fileInputs: { flow_file: closure } })
      );
      expect(linked).toEqual(colocated);
    } finally {
      await fs.rm(uploadDir, { recursive: true, force: true });
    }
  });
});

describe("the client's tool files cover every file a tool: step of a linked run reads", () => {
  const tools: Record<string, { fileInputs?: unknown }> = {
    "screenshot-diff": screenshotDiffTool,
    "flow-read-prerequisite": flowReadPrerequisiteTool,
  };
  beforeEach(async () => {
    await write("img/a.png", "a");
    await write("img/b.png", "b");
    await write("img/c.png", "c");
    const diff = (base: string, now: string) =>
      `{ tool: screenshot-diff, args: { baselinePath: ${base}, currentPath: ${now} } }`;
    await write(
      flows("toolroot.yaml"),
      "steps:\n" +
        `  - ${diff(path.join(tmpDir, "img/a.png"), `${tmpDir}/img/../img/b.png`)}\n` +
        `  - { tool: keyboard, args: { text: ${path.join(tmpDir, "img/c.png")} } }\n` +
        `  - { tool: flow-read-prerequisite, args: { project_root: ${tmpDir}, flow_path: ${path.join(tmpDir, flows("frag-echo.yaml"))} } }\n` +
        "  - run: toolfrag.yaml\n" +
        "  - when: { platform: android }\n    steps:\n" +
        `      - ${diff(path.join(tmpDir, "img/c.png"), path.join(tmpDir, "img/c.png"))}\n`
    );
    await write(
      flows("toolfrag.yaml"),
      `steps:\n  - ${diff(path.join(tmpDir, "img/b.png"), path.join(tmpDir, "img/a.png"))}\n`
    );
  });

  function toolRegistry(): Registry {
    return {
      invokeTool: vi.fn(async (id: string) =>
        id === "list-devices" ? { devices: [] } : { ok: true }
      ),
      getTool: vi.fn((id: string) => ({
        ...tools[id],
        inputSchema: { properties: { udid: {} } },
      })),
      resolveService: vi.fn(async () => ({ isConnected: () => true })),
    } as unknown as Registry;
  }

  it("toolroot", async () => {
    const run = (args: Record<string, unknown>, ctx: Record<string, unknown> = {}) =>
      createRunFlowTool(toolRegistry()).execute(
        {},
        { name: "toolroot", project_root: tmpDir, device: DEVICE, ...args } as never,
        { artifacts: new ArtifactStore(), ...ctx }
      );
    const colocated = summary(await run({}));

    // The client's way: the file arguments of the tool: steps of the root and
    // of its closure, by the path as written, for the tools that declare them.
    const spelled = path.join(tmpDir, flows("toolroot.yaml"));
    const closure = await clientClosure(spelled);
    for (const text of [
      await fs.readFile(spelled, "utf8"),
      ...Object.values(closure.members!).map((m) => m.text ?? ""),
    ]) {
      for (const step of collectFlowRequests(parseYaml(text)).toolSteps) {
        const specs = (tools[step.tool]?.fileInputs ?? []) as Parameters<typeof toolStepFiles>[0];
        for (const file of toolStepFiles(specs, step.args)) {
          if (!isClientFileArgument(file)) continue;
          closure.members![file.path] = { role: "tool", state: "present", hostPath: file.path };
        }
      }
    }
    const sent = Object.keys(closure.members!).filter(
      (key) => closure.members![key]!.role === "tool"
    );
    // The text a keyboard step types is not a file, whatever it looks like.
    expect(sent.sort()).toEqual(
      [
        path.join(tmpDir, "img/a.png"),
        `${tmpDir}/img/../img/b.png`,
        path.join(tmpDir, "img/b.png"),
        path.join(tmpDir, "img/c.png"),
        path.join(tmpDir, flows("frag-echo.yaml")),
      ].sort()
    );

    const spy = vi.spyOn(ClientProjectAccess.prototype, "readFile");
    const uploadDir = await fs.mkdtemp(path.join(os.tmpdir(), "parity-upload-"));
    const uploaded = path.join(uploadDir, "toolroot.yaml");
    await fs.copyFile(spelled, uploaded);
    let read: string[];
    let linked: string[];
    try {
      linked = summary(await run({ flow_file: uploaded }, { fileInputs: { flow_file: closure } }));
      read = spy.mock.calls.map(([file]) => file);
    } finally {
      spy.mockRestore();
      await fs.rm(uploadDir, { recursive: true, force: true });
    }

    // Two diffs and the prerequisite read, never the untaken branch's file.
    expect(read).toHaveLength(5);
    for (const file of read) expect(sent).toContain(file);
    expect(linked).toEqual(colocated);
    expect(colocated.every((line) => !/error|fail/.test(line))).toBe(true);
  });
});
