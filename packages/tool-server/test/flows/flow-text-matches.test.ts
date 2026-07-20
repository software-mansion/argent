import { describe, expect, it, vi } from "vitest";
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

import { serializeFlow, parseFlow } from "../../src/tools/flows/flow-utils";
import { createFlowTestHarness, label, n, screen } from "./harness";

const { run, writeFlow } = createFlowTestHarness({
  tempDirectoryPrefix: "flow-matches-",
  reset: () => {
    currentTree = () => screen([]);
  },
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
  // The three deliberate failures run serially and each consumes the 1s
  // assertion grace window before its report can be inspected.
  it("renders every text mode consistently in failing report targets and reasons", async () => {
    currentTree = () => screen([label("Actual", { identifier: "status" })]);
    const cases = [
      {
        name: "contains-report",
        expectedText: 'Expected "value"\nnext',
        textMatch: "contains" as const,
        targetExpectation: 'contains "Expected \\"value\\"\\nnext"',
        reasonExpectation: 'contain "Expected \\"value\\"\\nnext"',
      },
      {
        name: "equals-report",
        expectedText: "C:\\temp\\result",
        textMatch: "equals" as const,
        targetExpectation: 'equals "C:\\\\temp\\\\result"',
        reasonExpectation: 'equal "C:\\\\temp\\\\result"',
      },
      {
        name: "matches-report",
        expectedText: "^Total: \\$\\d+\\.\\d{2}$",
        textMatch: "matches" as const,
        targetExpectation: "matches /^Total: \\$\\d+\\.\\d{2}$/",
        reasonExpectation: "match /^Total: \\$\\d+\\.\\d{2}$/",
      },
    ];

    for (const testCase of cases) {
      await writeFlow(testCase.name, {
        executionPrerequisite: "",
        steps: [
          {
            kind: "assert",
            condition: "text",
            selector: { identifier: "status" },
            expectedText: testCase.expectedText,
            textMatch: testCase.textMatch,
          },
        ],
      });

      const result = await run(testCase.name);
      expect(result.ok).toBe(false);
      expect(result.steps[0]).toMatchObject({
        status: "fail",
        target: `id=status ${testCase.targetExpectation}`,
      });
      expect(result.steps[0]?.reason).toContain(`wanted to ${testCase.reasonExpectation}`);
    }
  }, 10_000);

  it("does not pass an empty-matchable pattern before the selected element has text", async () => {
    currentTree = () =>
      screen([
        n({
          identifier: "status",
          frame: { x: 0.1, y: 0.1, width: 0.5, height: 0.05 },
        }),
      ]);
    await writeFlow("empty-status", {
      executionPrerequisite: "",
      steps: [
        {
          kind: "assert",
          condition: "text",
          selector: { identifier: "status" },
          expectedText: "(Saved)?",
          textMatch: "matches",
        },
      ],
    });

    const result = await run("empty-status");

    expect(result.ok).toBe(false);
  });

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
