import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Registry } from "@argent/registry";
import type { DescribeNode, DescribeTreeData } from "../../src/tools/describe/contract";

// Serve the flow tree directly: flows resolve selectors against the platform's
// full-hierarchy source and hard-fail rather than degrade to the AX tree, so
// these unit tests stub the tree fetch itself.
let currentTree: () => DescribeNode;
vi.mock("../../src/tools/flows/flow-tree", () => ({
  fetchFlowTree: vi.fn(
    async (): Promise<DescribeTreeData> => ({
      tree: currentTree(),
      source: "native-devtools",
    })
  ),
}));

import { createRunFlowTool, type FlowRunResult } from "../../src/tools/flows/flow-run";
import { serializeFlow, parseFlow } from "../../src/tools/flows/flow-utils";

const DEVICE = "00000000-0000-0000-0000-0000000000ab"; // iOS UDID shape
let tmpDir: string;

function n(partial: Partial<DescribeNode> & { frame: DescribeNode["frame"] }): DescribeNode {
  return { role: "AXOther", children: [], ...partial };
}

function screen(children: DescribeNode[]): DescribeNode {
  return n({ role: "AXWindow", frame: { x: 0, y: 0, width: 1, height: 1 }, children });
}

function label(text: string, extra: Partial<DescribeNode> = {}): DescribeNode {
  return n({
    role: "AXStaticText",
    label: text,
    frame: { x: 0.1, y: 0.1, width: 0.5, height: 0.05 },
    ...extra,
  });
}

/** Registry that records every gesture tool invocation's args. */
function mockRegistry(calls: Array<{ tool: string; args: Record<string, unknown> }>): Registry {
  return {
    invokeTool: vi.fn(async (id: string, args: Record<string, unknown>) => {
      if (id === "list-devices") return { devices: [] };
      calls.push({ tool: id, args });
      return { ok: true };
    }),
    getTool: vi.fn(() => ({ inputSchema: { properties: { udid: {} } } })),
  } as unknown as Registry;
}

async function writeFlow(name: string, yaml: Parameters<typeof serializeFlow>[0]): Promise<void> {
  const dir = path.join(tmpDir, ".argent", "flows");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${name}.yaml`), serializeFlow(yaml), "utf8");
}

function asRun(r: FlowRunResult | { notice: string }): FlowRunResult {
  if (!("steps" in r)) throw new Error(`expected a run result, got notice: ${r.notice}`);
  return r;
}

async function run(
  name: string
): Promise<FlowRunResult & { calls: Array<{ tool: string; args: Record<string, unknown> }> }> {
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const tool = createRunFlowTool(mockRegistry(calls));
  const result = asRun(await tool.execute({}, { name, project_root: tmpDir, device: DEVICE }));
  return Object.assign(result, { calls });
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-matches-"));
  currentTree = () => screen([]);
});
afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("text matches: parse/serialize", () => {
  it("round-trips a matches condition on await and assert", () => {
    const flow = {
      executionPrerequisite: "",
      steps: [
        {
          kind: "await" as const,
          condition: "text" as const,
          selector: { identifier: "total" },
          expectedText: "Total: \\$\\d+\\.\\d{2}",
          textMatch: "matches" as const,
          timeout: 10000,
        },
        {
          kind: "assert" as const,
          condition: "text" as const,
          selector: { text: "Taps:", loose: true },
          expectedText: "^Taps: \\d+$",
          textMatch: "matches" as const,
        },
      ],
    };
    expect(parseFlow(serializeFlow(flow)).steps).toEqual(flow.steps);
  });

  it("parses the YAML spelling; single-quoted scalars keep backslashes", () => {
    const steps = parseFlow(
      "steps:\n" + "  - assert: { text: { in: total, matches: 'Total: \\$\\d+\\.\\d{2}' } }\n"
    ).steps;
    expect(steps).toEqual([
      {
        kind: "assert",
        condition: "text",
        selector: { text: "total", loose: true },
        expectedText: "Total: \\$\\d+\\.\\d{2}",
        textMatch: "matches",
      },
    ]);
  });

  it("requires exactly one comparator", () => {
    // Two comparators — previously a stray third key was silently ignored;
    // the three-way exactly-one-of must reject it loudly.
    expect(() =>
      parseFlow('steps:\n  - assert: { text: { in: x, contains: "a", matches: "b" } }\n')
    ).toThrow(/exactly one of `contains`, `equals`, or `matches`/i);
    expect(() => parseFlow("steps:\n  - assert: { text: { in: x } }\n")).toThrow(
      /exactly one of `contains`, `equals`, or `matches`/i
    );
  });

  it("rejects an empty or non-string pattern", () => {
    expect(() => parseFlow("steps:\n  - assert: { text: { in: x, matches: '' } }\n")).toThrow(
      /non-empty `matches`/i
    );
    expect(() => parseFlow("steps:\n  - assert: { text: { in: x, matches: 3 } }\n")).toThrow(
      /non-empty `matches`/i
    );
  });

  it("rejects an invalid pattern at parse time, naming the syntax error", () => {
    expect(() => parseFlow("steps:\n  - assert: { text: { in: x, matches: '(' } }\n")).toThrow(
      /not a valid regular expression/i
    );
    expect(() => parseFlow("steps:\n  - await: { text: { in: x, matches: '[' } }\n")).toThrow(
      /not a valid regular expression/i
    );
  });
});

describe("text matches: execution", () => {
  it("passes unanchored on a partial match (the contains analog)", async () => {
    currentTree = () => screen([label("Total: $4.99 (incl. tax)", { identifier: "total" })]);
    await writeFlow("price", {
      executionPrerequisite: "",
      steps: [
        {
          kind: "assert",
          condition: "text",
          selector: { identifier: "total" },
          expectedText: "Total: \\$\\d+\\.\\d{2}",
          textMatch: "matches",
        },
      ],
    });

    const result = await run("price");

    expect(result.ok).toBe(true);
  });

  it("anchoring with ^…$ gives the equals analog; the reason shows text and pattern", async () => {
    currentTree = () => screen([label("Taps: 42", { identifier: "counter" })]);
    await writeFlow("anchored", {
      executionPrerequisite: "",
      steps: [
        {
          kind: "assert",
          condition: "text",
          selector: { identifier: "counter" },
          expectedText: "^Taps: \\d$",
          textMatch: "matches",
        },
      ],
    });

    const result = await run("anchored");

    expect(result.ok).toBe(false);
    expect(result.steps[0]?.reason).toContain('its text was "Taps: 42"');
    expect(result.steps[0]?.reason).toContain("wanted to match /^Taps: \\d$/");
  });

  it("is case-sensitive, unlike contains/equals", async () => {
    currentTree = () => screen([label("Taps: 3", { identifier: "counter" })]);
    await writeFlow("case", {
      executionPrerequisite: "",
      steps: [
        {
          kind: "assert",
          condition: "text",
          selector: { identifier: "counter" },
          expectedText: "taps",
          textMatch: "matches",
        },
      ],
    });

    const result = await run("case");

    expect(result.ok).toBe(false);
  });

  it("evaluates against hoisted descendant text, like contains/equals", async () => {
    // A testID container whose number lives in a child node: the flow
    // adapters hoist it into subtreeText, which assertText prefers.
    currentTree = () => screen([label("", { identifier: "counter", subtreeText: "Taps: 7" })]);
    await writeFlow("hoisted", {
      executionPrerequisite: "",
      steps: [
        {
          kind: "assert",
          condition: "text",
          selector: { identifier: "counter" },
          expectedText: "^Taps: \\d+$",
          textMatch: "matches",
        },
      ],
    });

    const result = await run("hoisted");

    expect(result.ok).toBe(true);
  });

});
