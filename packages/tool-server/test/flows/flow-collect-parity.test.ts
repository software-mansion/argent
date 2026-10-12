/**
 * Parity between what the argent client sends with a linked flow and what the
 * runner reads. The client walks a flow's `run:` closure before the call
 * (collectFlowMembers, which takes each file's targets from the registry's
 * collectFlowRequests); the runner parses each file with parseFlow and
 * resolves its `run:` targets while it runs. Every resolution the runner can
 * make must be one the client sent, or a linked run fails a step a co-located
 * run passes.
 *
 * Two checks hold them together. Every YAML form the runner parses names the
 * same targets to both, in every `when:` branch, since which branch runs is
 * decided on the device. And each composed flow runs twice: co-located,
 * recording the runner's resolutions, and with the closure the client sends,
 * through the client's and this server's file boundary. Every recorded
 * resolution must be a member, and the two reports must agree step for step.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  ArtifactStore,
  flowMemberKey,
  MAX_RUN_DEPTH,
  type FileInputMember,
  type FileInputWire,
  type Registry,
} from "@argent/registry";
import { resolveFileInputs } from "../../src/file-inputs";
import { createRunFlowTool, type FlowRunResult } from "../../src/tools/flows/flow-run";
import { blockSteps, parseFlow, type FlowStep } from "../../src/tools/flows/flow-utils";
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

/**
 * The call's arguments as the argent client sends them over a link, from the
 * client's own source: the root flow's bytes and its `run:` closure.
 */
async function clientWire(
  fileInputs: unknown,
  args: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const client = path.resolve(__dirname, "../../../argent-tools-client/src");
  const { prepareFileInputs } = (await import(path.join(client, "file-inputs.ts"))) as {
    prepareFileInputs(specs: unknown, args: unknown, opts: object): Promise<unknown>;
  };
  const { collectFlowMembers } = (await import(path.join(client, "flow-files.ts"))) as {
    collectFlowMembers: unknown;
  };
  return (await prepareFileInputs(fileInputs, args, {
    includeContent: true,
    collectMembers: collectFlowMembers,
  })) as Record<string, unknown>;
}

/**
 * The `run:` targets the runner's parse gives `text`, every block included,
 * walked the way its pre-run check walks them.
 */
function runnerTargets(text: string): string[] {
  const targets = new Set<string>();
  const walk = (steps: FlowStep[]): void => {
    for (const step of steps) {
      if (step.kind === "run") targets.add(step.flow);
      const inner = blockSteps(step);
      if (inner) walk(inner);
    }
  };
  walk(parseFlow(text).steps);
  return [...targets];
}

function summary(result: FlowRunResult | { notice: string }): string[] {
  if (!("steps" in result)) throw new Error(`expected a run result, got: ${result.notice}`);
  return result.steps.map((s) =>
    [s.kind, s.status, s.flow ?? "", s.message ?? "", s.reason ?? ""].join(" | ")
  );
}

async function runBothWays(name: string): Promise<{
  resolved: string[];
  sent: string[];
  colocated: string[];
  linked: string[];
}> {
  const tool = createRunFlowTool(mockRegistry());
  const args = { name, project_root: tmpDir, device: DEVICE };
  const spy = vi.spyOn(HostProjectAccess.prototype, "resolveFlowFile");
  let colocated: string[];
  let resolved: string[];
  try {
    colocated = summary(await tool.execute({}, args, { artifacts: new ArtifactStore() }));
    // Read before the restore, which clears the recorded calls.
    resolved = spy.mock.calls.map(([anchorDir, target]) => flowMemberKey(anchorDir, target));
  } finally {
    spy.mockRestore();
  }

  // The boundary materializes the root away from the project, and the runner
  // reads every fragment from the members, so the linked run reads nothing there.
  const boundary = await resolveFileInputs(tool, await clientWire(tool.fileInputs, args));
  try {
    const linked = summary(
      await tool.execute({}, boundary.args as typeof args, {
        artifacts: new ArtifactStore(),
        fileInputs: boundary.fileInputs,
      })
    );
    const sent = Object.keys(boundary.fileInputs!.flow_file!.members!);
    return { resolved, sent, colocated, linked };
  } finally {
    await boundary.cleanup();
  }
}

beforeEach(async () => {
  tmpDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "flow-parity-")));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("the client's walk and the runner's parse name the same run: targets", () => {
  it.each([
    [
      "block style, a bare name and a path out of the directory",
      "steps:\n  - run: login\n  - run: ../../shared/common.yaml\n",
    ],
    [
      "every when: branch, taken or not",
      "steps:\n  - when: { platform: ios }\n    steps:\n      - run: ios\n" +
        "  - when: { platform: android }\n    steps:\n      - run: android\n",
    ],
    [
      "a when: inside a when:",
      "steps:\n  - when: { platform: ios }\n    steps:\n" +
        "      - when: { platform: ios }\n        steps:\n          - run: sub/deep\n",
    ],
    [
      "anchors and aliases of a step, a steps list and a target",
      "steps:\n  - &login { run: login }\n" +
        "  - when: { platform: ios }\n    steps: &branch\n      - *login\n      - run: &shared sub/shared\n" +
        "  - when: { platform: android }\n    steps: *branch\n  - run: *shared\n",
    ],
    [
      "merge keys under YAML 1.1",
      "%YAML 1.1\n---\nsteps:\n  - &base { run: login }\n  - <<: *base\n" +
        "  - when: { platform: ios }\n    <<: { steps: [{ run: sub/merged }] }\n",
    ],
    [
      "quoted keys and values",
      '"steps":\n  - \'run\': "login"\n  - "when": { \'platform\': ios }\n' +
        "    'steps':\n      - \"run\": 'sub/quoted'\n",
    ],
    [
      "flow style",
      "{ steps: [{ run: login }, { when: { platform: ios }, steps: [{ run: sub/flow }] }] }\n",
    ],
    [
      "a byte order mark and CRLF line ends",
      "\uFEFFsteps:\r\n  - run: login\r\n  - when: { platform: ios }\r\n    steps:\r\n" +
        "      - run: sub/crlf\r\n",
    ],
    [
      "document markers and comments",
      "# a flow\n---\nsteps: # the steps\n  - run: login # first\n" +
        "  - when: { platform: ios }\n    steps:\n      - run: sub/marked\n...\n",
    ],
    [
      "block scalars and tags",
      "steps:\n  - run: >-\n      login\n  - run: !!str sub/tagged\n" +
        "  - when: { platform: ios }\n    steps:\n      - run: |-\n          sub/literal\n",
    ],
  ])("%s", async (_form, text) => {
    // No target exists, so the client sends each one as missing and reads no further.
    const flowsDir = path.join(tmpDir, flows(""));
    await write(flows("root.yaml"), text);
    const fileInputs = createRunFlowTool(mockRegistry()).fileInputs;

    const wire = await clientWire(fileInputs, { name: "root", project_root: tmpDir });

    const expected = runnerTargets(text);
    expect(expected).not.toEqual([]);
    const members = (wire.flow_file as FileInputWire).members as FileInputMember[];
    expect(members.map((m) => m.key)).toEqual(expected.map((t) => flowMemberKey(flowsDir, t)));
  });
});

describe("the client's run: closure covers every resolution the runner makes", () => {
  beforeEach(async () => {
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
    for (let i = 1; i <= MAX_RUN_DEPTH + 3; i++) {
      const n = String(i).padStart(2, "0");
      const next = String(i + 1).padStart(2, "0");
      await write(
        flows(`c${n}.yaml`),
        i === MAX_RUN_DEPTH + 3
          ? `steps:\n  - echo: c${n} bottom\n`
          : `steps:\n  - echo: c${n}\n  - run: c${next}.yaml\n`
      );
    }
    // A cycle that closes on the deepest hop the runner resolves.
    for (let i = 1; i <= MAX_RUN_DEPTH; i++) {
      const n = String(i).padStart(2, "0");
      const next = i === MAX_RUN_DEPTH ? "01" : String(i + 1).padStart(2, "0");
      await write(flows(`cyc${n}.yaml`), `steps:\n  - echo: cyc${n}\n  - run: cyc${next}.yaml\n`);
    }
    await write(flows("nested-when.yaml"), "steps:\n  - run: when-frag.yaml\n");
    await write(
      flows("when-frag.yaml"),
      "steps:\n" +
        "  - when: { platform: ios }\n    steps:\n" +
        "      - when: { platform: ios }\n        steps:\n          - run: sub/deep.yaml\n"
    );
    await write(
      flows("sub/deep.yaml"),
      "steps:\n  - echo: two blocks deep\n  - run: ../frag-echo\n"
    );
    await write(flows("norun.yaml"), "steps:\n  - echo: no composition\n");
  });

  it.each([
    ["withrun", 1],
    ["s2a", 2],
    ["s3when", 2],
    ["s4", 2],
    ["s6a", 2],
    ["c01", MAX_RUN_DEPTH],
    ["cyc01", MAX_RUN_DEPTH],
    ["nested-when", 3],
    ["norun", 0],
  ])("%s", async (name, expectedMembers) => {
    const { resolved, sent, colocated, linked } = await runBothWays(name);

    expect(sent).toHaveLength(expectedMembers);
    // A flow that composes resolves at least once, so the check below bites.
    expect(resolved.length > 0).toBe(expectedMembers > 0);
    for (const key of resolved) expect(sent).toContain(key);
    expect(linked).toEqual(colocated);
  });

  it("resolves the chain to the depth guard, and the client sends nothing past it", async () => {
    const { resolved, sent, colocated } = await runBothWays("c01");

    // c02 … c21: the runner resolves c21 for its cycle check, then refuses it
    // for depth, so c22 is never asked for.
    expect(resolved).toHaveLength(MAX_RUN_DEPTH);
    expect(sent.map((key) => path.basename(key.split("\0")[1]!))).toEqual(
      Array.from({ length: MAX_RUN_DEPTH }, (_, i) => `c${String(i + 2).padStart(2, "0")}.yaml`)
    );
    expect(colocated.some((line) => /max run depth/.test(line))).toBe(true);
  });

  it("names a cycle that closes on the deepest hop, as the co-located run does", async () => {
    const { linked } = await runBothWays("cyc01");

    // A fragment named like the root shows as ./cyc01, so the two read apart.
    expect(linked.at(-1)).toMatch(/cyclic flow reference: cyc01 → cyc02 → .* → cyc20 → \.\/cyc01$/);
  });
});
