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

import {
  serializeFlow,
  parseFlow,
  selectorToYaml,
  type FlowSelector,
} from "../../src/tools/flows/flow-utils";
import { createFlowTestHarness, label, n, screen } from "./harness";

const { run, runWithCalls, writeFlow } = createFlowTestHarness({
  tempDirectoryPrefix: "flow-sel-matches-",
  reset: () => {
    currentTree = () => screen([]);
  },
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

  it("round-trips strict literal and regex selectors combined with both id and role", () => {
    const flow = {
      executionPrerequisite: "",
      steps: [
        {
          kind: "tap" as const,
          selector: {
            text: "Checkout",
            identifier: "checkout-button",
            role: "AXButton",
          },
        },
        {
          kind: "tap" as const,
          selector: {
            textMatches: "^Order #\\d+$",
            identifier: "order-row",
            role: "AXButton",
          },
        },
      ],
    };

    const yaml = serializeFlow(flow);
    expect(yaml).toContain("text: Checkout");
    expect(yaml).toContain("id: checkout-button");
    expect(yaml).toContain('matches: "^Order #\\\\d+$"');
    expect(yaml).toContain("id: order-row");
    expect(yaml).toContain("role: AXButton");
    expect(parseFlow(yaml).steps).toEqual(flow.steps);
  });

  it("round-trips a non-empty loose text-only selector through bare-string YAML", () => {
    const flow = {
      executionPrerequisite: "",
      steps: [{ kind: "tap" as const, selector: { text: "Checkout", loose: true } }],
    };

    const yaml = serializeFlow(flow);
    expect(yaml).toContain("- tap: Checkout");
    expect(parseFlow(yaml).steps).toEqual(flow.steps);
  });

  it("rejects literal + regex selectors instead of silently dropping either constraint", () => {
    expect(() =>
      serializeFlow({
        executionPrerequisite: "",
        steps: [
          {
            kind: "tap",
            selector: { text: "OK", textMatches: "^OK \\d+$", loose: true },
          },
        ],
      })
    ).toThrow(/both `text` and `textMatches` are set.*only one `text` constraint/i);

    expect(() =>
      serializeFlow({
        executionPrerequisite: "",
        steps: [{ kind: "tap", selector: { text: "Order", textMatches: "#\\d+" } }],
      })
    ).toThrow(/both `text` and `textMatches` are set.*only one `text` constraint/i);
  });

  it("rejects loose selector shapes that bare-string YAML cannot preserve", () => {
    const selectors = [
      { loose: true },
      { identifier: "confirm", loose: true },
      { role: "button", loose: true },
      { text: "OK", identifier: "confirm", loose: true },
      { text: "OK", role: "button", loose: true },
      { textMatches: "^OK$", loose: true },
      { textMatches: "^OK$", identifier: "confirm", loose: true },
      { textMatches: "^OK$", role: "button", loose: true },
      { textMatches: "^OK$", identifier: "confirm", role: "button", loose: true },
    ] satisfies FlowSelector[];

    for (const selector of selectors) {
      expect(() =>
        serializeFlow({
          executionPrerequisite: "",
          steps: [{ kind: "tap", selector }],
        })
      ).toThrow(/cannot serialize loose flow selector.*only a loose text-only selector/i);
    }
  });

  it("rejects empty loose text with the visible-character error", () => {
    // The empty-text guard is now shared with the strict map spelling and
    // also refuses invisible-only text (icon-font PUA glyphs, zero-width) —
    // see "rejects a text selector with no visible characters" in flow-tap.
    expect(() => selectorToYaml({ text: "", loose: true })).toThrow(
      /`text` must contain at least one visible character/i
    );
  });

  it("suggests matches for a misspelled matcher key", () => {
    expect(() =>
      parseFlow("steps:\n  - assert: { visible: { text: { matchse: 'a' } } }\n")
    ).toThrow(/text matcher has unknown key `matchse` \(did you mean `matches`\?\)/i);
  });

  it("rejects unknown and extra matcher keys specifically", () => {
    expect(() =>
      parseFlow("steps:\n  - assert: { visible: { text: { contains: 'a' } } }\n")
    ).toThrow(/text matcher has unknown key `contains` — allowed keys: matches/i);
    expect(() =>
      parseFlow("steps:\n  - assert: { visible: { text: { matches: 'a', equals: 'b' } } }\n")
    ).toThrow(/text matcher has unknown key `equals` — allowed keys: matches/i);
  });

  it("keeps the exact-shape diagnostic for empty maps and wrong matcher shapes", () => {
    expect(() => parseFlow("steps:\n  - assert: { visible: { text: {} } }\n")).toThrow(
      /text matcher takes exactly \{ matches/i
    );
    expect(() => parseFlow("steps:\n  - assert: { visible: { text: [matches] } }\n")).toThrow(
      /text matcher takes exactly \{ matches/i
    );
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

  it("still lets an empty-matching regex select actual non-empty text", async () => {
    currentTree = () => screen([label("Downloading")]);
    await writeFlow("non-empty-text", {
      executionPrerequisite: "",
      steps: [
        {
          kind: "assert",
          condition: "visible",
          selector: { textMatches: "Uploading|Downloading|" },
        },
      ],
    });

    expect((await run("non-empty-text")).ok).toBe(true);
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

    const result = await runWithCalls("rank");

    expect(result.ok).toBe(true);
    const tap = result.calls.find((c) => c.tool === "gesture-tap");
    expect(tap).toBeDefined();
    expect(tap!.args.x).toBeCloseTo(0.5, 5); // leaf centre, not container centre y
    expect(tap!.args.y).toBeCloseTo(0.425, 5);
  });

  it("does not treat an empty sibling field as an exact regex hit", async () => {
    const smallerMixedFieldNode = n({
      label: "",
      value: "Downloading",
      frame: { x: 0.1, y: 0.1, width: 0.05, height: 0.05 },
    });
    const largerExactNode = label("123", {
      frame: { x: 0.4, y: 0.4, width: 0.2, height: 0.05 },
    });
    currentTree = () => screen([smallerMixedFieldNode, largerExactNode]);
    await writeFlow("empty-sibling-rank", {
      executionPrerequisite: "",
      steps: [{ kind: "tap", selector: { textMatches: "\\d*" } }],
    });

    const result = await runWithCalls("empty-sibling-rank");

    expect(result.ok).toBe(true);
    const tap = result.calls.find((c) => c.tool === "gesture-tap");
    expect(tap).toBeDefined();
    // Both non-empty fields match `\d*`, but only "123" is fully consumed.
    // The empty label must not give the smaller mixed-field node an exact tie.
    expect(tap!.args.x).toBeCloseTo(0.5, 5);
    expect(tap!.args.y).toBeCloseTo(0.425, 5);
  });
});
