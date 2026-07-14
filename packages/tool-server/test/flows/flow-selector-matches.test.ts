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
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-sel-matches-"));
  currentTree = () => screen([]);
});
afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("regex text selectors: parse/serialize", () => {
  it("round-trips the matcher through every selector slot", () => {
    const flow = {
      executionPrerequisite: "",
      steps: [
        {
          kind: "await" as const,
          condition: "visible" as const,
          selector: { textMatches: "^x: \\d+, y: -\\d+$" },
          timeout: 10000,
        },
        {
          kind: "assert" as const,
          condition: "hidden" as const,
          selector: { textMatches: "^Uploading \\d+%$", role: "AXStaticText" },
        },
        {
          kind: "assert" as const,
          condition: "text" as const,
          selector: { textMatches: "^Total\\b" },
          expectedText: "\\$\\d+\\.\\d{2}",
          textMatch: "matches" as const,
        },
        { kind: "tap" as const, selector: { textMatches: "^Order #\\d+$" } },
        {
          kind: "scroll-to" as const,
          target: { textMatches: "^Order #\\d+$" },
          direction: "down" as const,
          within: { identifier: "feed" },
        },
      ],
    };
    expect(parseFlow(serializeFlow(flow)).steps).toEqual(flow.steps);
  });

  it("parses the YAML spelling; combines with id/role as usual (logical AND)", () => {
    const steps = parseFlow(
      "steps:\n" +
        "  - assert: { visible: { text: { matches: '^Taps: \\d+$' } } }\n" +
        "  - assert: { visible: { id: counter, text: { matches: '\\d+' } } }\n"
    ).steps;
    expect(steps).toEqual([
      { kind: "assert", condition: "visible", selector: { textMatches: "^Taps: \\d+$" } },
      {
        kind: "assert",
        condition: "visible",
        selector: { identifier: "counter", textMatches: "\\d+" },
      },
    ]);
  });

  it("rejects a matcher map that is not exactly { matches }", () => {
    expect(() =>
      parseFlow("steps:\n  - assert: { visible: { text: { contains: 'a' } } }\n")
    ).toThrow(/text matcher takes exactly \{ matches/i);
    expect(() =>
      parseFlow("steps:\n  - assert: { visible: { text: { matches: 'a', equals: 'b' } } }\n")
    ).toThrow(/text matcher takes exactly \{ matches/i);
  });

  it("rejects an empty or non-string pattern", () => {
    expect(() => parseFlow("steps:\n  - assert: { visible: { text: { matches: '' } } }\n")).toThrow(
      /non-empty `matches` pattern/i
    );
    expect(() => parseFlow("steps:\n  - assert: { visible: { text: { matches: 3 } } }\n")).toThrow(
      /non-empty `matches` pattern/i
    );
  });

  it("rejects an invalid pattern at parse time, in condition and action slots alike", () => {
    expect(() =>
      parseFlow("steps:\n  - assert: { visible: { text: { matches: '(' } } }\n")
    ).toThrow(/not a valid regular expression/i);
    expect(() => parseFlow("steps:\n  - tap: { text: { matches: '[' } }\n")).toThrow(
      /not a valid regular expression/i
    );
    expect(() =>
      parseFlow("steps:\n  - type: { into: { text: { matches: '(' } }, text: hi }\n")
    ).toThrow(/not a valid regular expression/i);
  });
});

describe("regex text selectors: condition execution", () => {
  it("visible passes on a leaf whose own text matches; unanchored is the contains analog", async () => {
    currentTree = () => screen([label("Total: $4.99 (incl. tax)")]);
    await writeFlow("price", {
      executionPrerequisite: "",
      steps: [
        {
          kind: "assert",
          condition: "visible",
          selector: { textMatches: "Total: \\$\\d+\\.\\d{2}" },
        },
      ],
    });

    const result = await run("price");

    expect(result.ok).toBe(true);
  });

  it("matches each node's OWN text, not the hoisted subtreeText", async () => {
    // A testID container whose value lives in hoisted descendant text: the
    // `text` condition (assertText) sees it, but a selector matcher must not —
    // per-node semantics keep wrapper chains out of the match set.
    currentTree = () => screen([label("", { identifier: "console", subtreeText: "x: 12, y: -3" })]);
    await writeFlow("own-text", {
      executionPrerequisite: "",
      steps: [{ kind: "assert", condition: "visible", selector: { textMatches: "^x: \\d+" } }],
    });

    const result = await run("own-text");

    expect(result.ok).toBe(false);
    expect(result.steps[0]?.reason).toContain("text=/^x: \\d+/");
  });

  it("is case-sensitive, unlike plain text selectors", async () => {
    currentTree = () => screen([label("Taps: 3")]);
    await writeFlow("case", {
      executionPrerequisite: "",
      steps: [{ kind: "assert", condition: "visible", selector: { textMatches: "taps" } }],
    });

    const result = await run("case");

    expect(result.ok).toBe(false);
  });

  it("hidden with a regex holds when no visible node's own text matches", async () => {
    currentTree = () => screen([label("Done")]);
    await writeFlow("hidden", {
      executionPrerequisite: "",
      steps: [
        { kind: "assert", condition: "hidden", selector: { textMatches: "^Uploading \\d+%$" } },
      ],
    });
    expect((await run("hidden")).ok).toBe(true);

    currentTree = () => screen([label("Uploading 42%")]);
    expect((await run("hidden")).ok).toBe(false);
  });

});

describe("regex text selectors: action ranking", () => {
  it("a full-consume hit on the leaf beats a container's partial hit", async () => {
    // The container's (aggregated) label merely contains the order line; the
    // leaf's own label IS the order line. The regex analog of exact-beats-
    // substring must land the tap on the leaf, not the container's centre.
    const leaf = label("Order #1234", {
      frame: { x: 0.4, y: 0.4, width: 0.2, height: 0.05 },
    });
    const container = label("Order #1234 Archive", {
      frame: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 },
    });
    currentTree = () => screen([container, leaf]);
    await writeFlow("rank", {
      executionPrerequisite: "",
      steps: [{ kind: "tap", selector: { textMatches: "Order #\\d+" } }],
    });

    const result = await run("rank");

    expect(result.ok).toBe(true);
    const tap = result.calls.find((c) => c.tool === "gesture-tap");
    expect(tap).toBeDefined();
    expect(tap!.args.x).toBeCloseTo(0.5, 5); // leaf centre, not container centre y
    expect(tap!.args.y).toBeCloseTo(0.425, 5);
  });
});
