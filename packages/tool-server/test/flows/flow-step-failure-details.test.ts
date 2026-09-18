import { describe, expect, it, vi } from "vitest";
import type { DescribeNode, DescribeTreeData } from "../../src/tools/describe/contract";

let currentTree: () => DescribeNode;
/** The reader's own flags, set by the blind-read tests (Vega's shape). */
let currentFlags: Pick<DescribeTreeData, "hint" | "should_restart"> = {};
vi.mock("../../src/tools/flows/flow-tree", () => ({
  fetchFlowTree: vi.fn(
    async (): Promise<DescribeTreeData> => ({
      tree: currentTree(),
      source: "native-devtools",
      ...currentFlags,
    })
  ),
}));

import { createFlowTestHarness, label, screen } from "./harness";

const { run, writeFlow } = createFlowTestHarness({
  tempDirectoryPrefix: "flow-failure-details-",
  reset: () => {
    currentTree = () => screen([]);
    currentFlags = {};
  },
});

const DETAIL_KEYS = ["hint", "expected", "actual", "expectedKind", "indeterminate"] as const;

const INDETERMINATE_HINT =
  "check the app first — a crash, or a screen the app emptied itself, reads the same here as a " +
  "tree source that stopped answering — then check the device and the tree source; re-run " +
  "before you edit the flow";

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

describe("selector misses on a screen that was never read", () => {
  // The reader answered with an empty tree AND its own "I could not see the app"
  // flags — an unattached Vega toolkit, or an AX service asking for a relaunch.
  // "no element matched" is a claim about what the screen holds, and this read
  // supports no such claim.
  const VEGA_HINT =
    "No UI tree from the Vega automation toolkit. The toolkit attaches at app launch — " +
    "relaunch the foreground app.";

  it("refuses a verdict and gives the reader's repair, not the scroll-to advice", async () => {
    currentTree = () => screen([]);
    currentFlags = { hint: VEGA_HINT };
    await writeFlow("blind-tap", {
      executionPrerequisite: "",
      steps: [{ kind: "tap", selector: { text: "Home" } }],
    });

    const [step] = (await run("blind-tap")).steps;

    expect(step).toMatchObject({ status: "fail", indeterminate: true, hint: VEGA_HINT });
    expect(step.reason).toBe(
      'the UI tree read back empty and degraded, so text="Home" was never looked for — this is ' +
        "the reader reporting it could not see the app, not the app rendering nothing"
    );
    expect(step.reason).not.toContain("no element matched");
  }, 20_000);

  it("falls back to the shared re-run hint when the reader gave none", async () => {
    currentTree = () => screen([]);
    currentFlags = { should_restart: true };
    await writeFlow("blind-type", {
      executionPrerequisite: "",
      steps: [{ kind: "type", into: { identifier: "search" }, text: "socks" }],
    });

    const [step] = (await run("blind-type")).steps;

    expect(step).toMatchObject({ status: "fail", indeterminate: true, hint: INDETERMINATE_HINT });
  }, 20_000);

  it("still reports a genuinely empty screen as one, with the scroll-to hint", async () => {
    // Same empty tree, no reader flags: the read IS evidence about the screen.
    currentTree = () => screen([]);
    await writeFlow("empty-tap", {
      executionPrerequisite: "",
      steps: [{ kind: "tap", selector: { text: "Home" } }],
    });

    const [step] = (await run("empty-tap")).steps;

    expect(step).toMatchObject({
      status: "fail",
      reason: 'no element matched selector text="Home"',
      hint: "if it is off-screen, add a scroll-to step before this one",
    });
    expect(step).not.toHaveProperty("indeterminate");
  }, 20_000);
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
    // A literal expectation carries no pattern marker, so the renderers quote it.
    expect(step).not.toHaveProperty("expectedKind");
  });

  it("caps a long actual text at 300 characters and keeps it out of the reason", async () => {
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

  it("names the app in the shared hint when the app is what went dark", async () => {
    // Both triggers below are the app, not the environment: the shared hint
    // must not send either back for a re-run as noise.
    currentTree = () => {
      throw new Error(
        "com.argent.flowtest lost its devtools connection after launch (the app crashed, was " +
          "terminated, or its socket closed)"
      );
    };
    await writeFlow("crashed", {
      executionPrerequisite: "",
      steps: [{ kind: "await", condition: "visible", selector: { text: "Done" }, timeout: 500 }],
    });

    const [crashed] = (await run("crashed")).steps;

    expect(crashed).toMatchObject({ indeterminate: true, hint: INDETERMINATE_HINT });
    expect(crashed.reason).toContain("the app crashed, was terminated");
    expect(crashed.hint).not.toMatch(/not a verdict on the app/);
    expect(crashed.hint).toMatch(/^check the app first/);
  });

  it("gives a screen the app emptied after a match the same hint", async () => {
    // The element was seen, then the tree read back empty: an error boundary
    // that unmounted the root reads exactly like a dead tree source, so the
    // hint has to send the reader to the app before the device.
    let reads = 0;
    currentTree = () =>
      reads++ === 0 ? screen([label("Loading", { identifier: "status" })]) : screen([]);
    await writeFlow("blanked", {
      executionPrerequisite: "",
      steps: [
        {
          kind: "await",
          condition: "text",
          selector: { identifier: "status" },
          expectedText: "Ready",
          textMatch: "equals",
          // Long enough for the empty reads to outlast the dark-tail
          // tolerance, which is what makes the verdict indeterminate.
          timeout: 2000,
        },
      ],
    });

    const [blanked] = (await run("blanked")).steps;

    expect(blanked).toMatchObject({
      status: "fail",
      indeterminate: true,
      hint: INDETERMINATE_HINT,
    });
    expect(blanked.reason).toMatch(/empty or degraded/);
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
