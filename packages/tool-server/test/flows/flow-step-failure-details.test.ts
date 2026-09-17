import { describe, expect, it, vi } from "vitest";
import type { DescribeNode, DescribeTreeData } from "../../src/tools/describe/contract";

// Serve the flow tree directly: flows resolve selectors against the platform's
// full-hierarchy source and hard-fail rather than degrade to the AX tree, so
// these unit tests stub the tree fetch itself. A `currentTree` that throws is a
// failed tree read.
let currentTree: () => DescribeNode;
vi.mock("../../src/tools/flows/flow-tree", () => ({
  fetchFlowTree: vi.fn(
    async (): Promise<DescribeTreeData> => ({
      tree: currentTree(),
      source: "native-devtools",
    })
  ),
}));

import { createFlowTestHarness, label, screen } from "./harness";

const { run, writeFlow } = createFlowTestHarness({
  tempDirectoryPrefix: "flow-failure-details-",
  reset: () => {
    currentTree = () => screen([]);
  },
});

const DETAIL_KEYS = ["hint", "expected", "actual", "indeterminate"] as const;

const INDETERMINATE_HINT =
  "argent could not read the screen, so this is not a verdict on the app; re-run, or fix the " +
  "device and tree source, before editing the flow";

function disconnected(): never {
  throw new Error("native devtools disconnected");
}

const assertTotalEquals42 = {
  kind: "assert",
  condition: "text",
  selector: { identifier: "total" },
  expectedText: "$42.00",
  textMatch: "equals",
} as const;

describe("tap-family selector misses", () => {
  it("reports zero-area matches as not visible, with a hint that names the possible causes", async () => {
    currentTree = () =>
      screen([
        label("Pay", { frame: { x: 0.1, y: 0.2, width: 0, height: 0.05 } }),
        label("Buy", { frame: { x: 0.1, y: 0.3, width: 0.5, height: 0 } }),
        label("Buy", { frame: { x: 0.1, y: 0.4, width: 0, height: 0 } }),
      ]);
    await writeFlow("one-zero-area", {
      executionPrerequisite: "",
      steps: [{ kind: "tap", selector: { text: "Pay" } }],
    });
    await writeFlow("two-zero-area", {
      executionPrerequisite: "",
      steps: [{ kind: "tap", selector: { text: "Buy" } }],
    });

    // Both flows read the same tree, so they share one auto-wait.
    const [one, two] = await Promise.all([run("one-zero-area"), run("two-zero-area")]);

    expect(one.steps[0]).toMatchObject({
      status: "fail",
      reason: '1 element matched text="Pay" but none was visible (zero-area frame)',
    });
    expect(two.steps[0]).toMatchObject({
      status: "fail",
      reason: '2 elements matched text="Buy" but none was visible (zero-area frame)',
    });
    for (const [step] of [one.steps, two.steps]) {
      expect(step.hint).toBe(
        "the element is in the tree but has no on-screen area; it may be off-screen (add a " +
          "scroll-to step before this one), collapsed, or not laid out yet"
      );
    }
  }, 15_000);
});

describe("text check failures", () => {
  it("quotes the element's own text in the hint when it differs from the subtree text", async () => {
    currentTree = () =>
      screen([label("$41.50", { identifier: "total", subtreeText: "Total $41.50" })]);
    await writeFlow("own-text", { executionPrerequisite: "", steps: [assertTotalEquals42] });

    const [step] = (await run("own-text")).steps;

    expect(step).toMatchObject({
      status: "fail",
      reason: 'element matched id="total" but its text did not equal "$42.00"',
      expected: "$42.00",
      actual: "Total $41.50",
      hint: `the element's own text is "$41.50"; the check accepts the subtree text or the own text`,
    });
  });

  it("caps a long actual text at 300 characters and keeps it out of the reason", async () => {
    // An emoji across the cut: the cap drops its first half rather than split it.
    const screenText = "Home Cart Checkout Pay Total $41.50 Apply coupon "
      .repeat(50)
      .slice(0, 299)
      .concat("😀", "Continue shopping ".repeat(100));
    currentTree = () => screen([label("", { identifier: "root", subtreeText: screenText })]);
    await writeFlow("container", {
      executionPrerequisite: "",
      steps: [
        {
          kind: "assert",
          condition: "text",
          selector: { identifier: "root" },
          expectedText: "Order placed",
          textMatch: "contains",
        },
      ],
    });

    const [step] = (await run("container")).steps;

    expect(step.status).toBe("fail");
    expect(step.expected).toBe("Order placed");
    expect(step.actual).toBe(`${screenText.slice(0, 299)}…`);
    expect(step.reason).toBe(
      'element matched id="root" but its text did not contain "Order placed"'
    );
  });
});

describe("unreadable tree", () => {
  it("flags an await that could never read the tree as indeterminate, with the re-run hint", async () => {
    currentTree = disconnected;
    await writeFlow("blind-await", {
      executionPrerequisite: "",
      steps: [{ kind: "await", condition: "visible", selector: { text: "Done" }, timeout: 500 }],
    });

    const [step] = (await run("blind-await")).steps;

    expect(step).toMatchObject({ status: "fail", indeterminate: true, hint: INDETERMINATE_HINT });
    expect(step.reason).toContain("native devtools disconnected");
    expect(step).not.toHaveProperty("expected");
    expect(step).not.toHaveProperty("actual");
  });

  it("gives a when guard that could not be evaluated the same flag and hint", async () => {
    currentTree = disconnected;
    await writeFlow("blind-guard", {
      executionPrerequisite: "",
      steps: [
        {
          kind: "when",
          condition: { kind: "ui", condition: "visible", selector: { text: "What's new" } },
          steps: [{ kind: "tap", selector: { text: "Skip" } }],
        },
      ],
    });

    const result = await run("blind-guard");

    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["when:error", "tap:skip"]);
    expect(result.steps[0]).toMatchObject({ indeterminate: true, hint: INDETERMINATE_HINT });
    expect(result.steps[0].reason).toMatch(/^could not evaluate when guard/);
  });
});

describe("passing steps", () => {
  it("adds none of the detail fields to a step that passed", async () => {
    currentTree = () => screen([label("Checkout")]);
    await writeFlow("green", {
      executionPrerequisite: "",
      steps: [
        { kind: "tap", selector: { text: "Checkout" } },
        { kind: "assert", condition: "visible", selector: { text: "Checkout" } },
      ],
    });

    const result = await run("green");

    expect(result.steps.map((s) => s.status)).toEqual(["pass", "pass"]);
    for (const step of result.steps) {
      for (const key of DETAIL_KEYS) expect(step).not.toHaveProperty(key);
    }
  });
});
