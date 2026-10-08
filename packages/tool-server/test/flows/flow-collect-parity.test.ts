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
 * and the two reports must agree step for step.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import {
  ArtifactStore,
  canonicalFlowPath,
  classifyOnDiskSpelling,
  collectFlowRequests,
  flowMemberKey,
  FLOW_FILE_NAME_PATTERN,
  MAX_RUN_DEPTH,
  type Registry,
  type ResolvedFileInput,
  type ResolvedMember,
} from "@argent/registry";
import { createRunFlowTool, type FlowRunResult } from "../../src/tools/flows/flow-run";
import { HostProjectAccess } from "../../src/tools/flows/project-access";

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
    expect(Object.values(closure.members!).map((m) => path.basename(m.canonical))).toEqual(
      Array.from({ length: MAX_RUN_DEPTH }, (_, i) => `c${String(i + 2).padStart(2, "0")}.yaml`)
    );
    expect(colocated.some((line) => /max run depth/.test(line))).toBe(true);
  });
});
