import { describe, expect, it, vi } from "vitest";
import { FAILURE_CODES, FailureError } from "@argent/registry";
import type { DescribeNode, DescribeTreeData } from "../../src/tools/describe/contract";

let currentTree: () => DescribeNode;
/** The reader's own flags, set by the blind-read tests. */
let currentFlags: Pick<DescribeTreeData, "hint" | "should_restart"> = {};
/** The tree source. A blind-read test sets the one that really sends its flags. */
let currentSource: DescribeTreeData["source"] = "native-devtools";
vi.mock("../../src/tools/flows/flow-tree", () => ({
  fetchFlowTree: vi.fn(
    async (): Promise<DescribeTreeData> => ({
      tree: currentTree(),
      source: currentSource,
      ...currentFlags,
    })
  ),
}));

import { createFlowTestHarness, label, screen } from "./harness";
import { selectorMiss, waitForFrame, type ActionEnv } from "../../src/tools/flows/flow-actions";

const { run, writeFlow } = createFlowTestHarness({
  tempDirectoryPrefix: "flow-failure-details-",
  reset: () => {
    currentTree = () => screen([]);
    currentFlags = {};
    currentSource = "native-devtools";
  },
});

const DETAIL_KEYS = ["hint", "expected", "actual", "expectedKind", "indeterminate"] as const;

/** A Vega device for the tests that resolve a cropOn frame directly. */
const VEGA = { registry: {}, device: { id: "vega-vvd", platform: "vega" } } as ActionEnv;

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

describe("zero-area selector misses on Vega", () => {
  it("does not suggest a scroll-to step, which Vega refuses", async () => {
    // Vega's tree keeps an off-screen node at zero area, so a cropOn that
    // finds only such a node reaches the zero-area hint.
    currentSource = "vega-automation";
    currentTree = () =>
      screen([
        label("Price", { identifier: "price", frame: { x: 0, y: 1.2, width: 0, height: 0 } }),
      ]);

    const miss = await waitForFrame(VEGA, { identifier: "price" });

    if (miss === "aborted" || !("unresolved" in miss)) throw new Error("expected a miss");
    expect(selectorMiss(miss)).toEqual({
      reason: '1 element matched id="price" but none was visible (zero-area frame)',
      hint:
        "the element is in the tree but has no on-screen area; it may be off-screen, " +
        "collapsed, or not laid out yet",
    });
  }, 20_000);
});

describe("selector misses on a screen that was never read", () => {
  // The reader answered with an empty tree AND its own flags. In a flow only
  // Vega's toolkit reader does this: the other flow sources send no flags, and
  // a physical iPhone's source throws on this shape. Vega refuses a tap before
  // it reads a tree, so a snapshot's cropOn is where a flow meets this read.
  // "no element matched" is a claim about what the screen holds, and this read
  // supports no such claim.
  const VEGA_HINT =
    "No UI tree from the Vega automation toolkit. The toolkit attaches at app launch — " +
    "relaunch the foreground app.";
  it("refuses a verdict on a Vega cropOn and gives the toolkit's repair, not the scroll-to advice", async () => {
    currentSource = "vega-automation";
    currentTree = () => screen([]);
    currentFlags = { hint: VEGA_HINT };

    const miss = await waitForFrame(VEGA, { text: "Home" });

    if (miss === "aborted" || !("unresolved" in miss)) throw new Error("expected a miss");
    expect(selectorMiss(miss)).toEqual({
      indeterminate: true,
      reason:
        'the UI tree read back empty and degraded, so text="Home" was never looked for — this ' +
        "is the reader reporting it could not see the app, not the app rendering nothing",
      hint: VEGA_HINT,
    });
  }, 20_000);

  it("leaves the hint to the runner when the reader gave none", () => {
    // No flow tree source sends flags without a hint today. The runner would
    // add its shared hint to this outcome.
    expect(selectorMiss({ unresolved: { text: "Home" }, matched: 0, blind: {} })).toEqual({
      indeterminate: true,
      reason:
        'the UI tree read back empty and degraded, so text="Home" was never looked for — this ' +
        "is the reader reporting it could not see the app, not the app rendering nothing",
    });
  });

  it("gives an assert, an await and a when guard the reader's repair too", async () => {
    currentSource = "vega-automation";
    currentTree = () => screen([]);
    currentFlags = { hint: VEGA_HINT };
    await writeFlow("blind-assert", {
      executionPrerequisite: "",
      steps: [{ kind: "assert", condition: "visible", selector: { text: "Home" } }],
    });
    await writeFlow("blind-await-hint", {
      executionPrerequisite: "",
      steps: [{ kind: "await", condition: "visible", selector: { text: "Home" }, timeout: 500 }],
    });
    await writeFlow("blind-when", {
      executionPrerequisite: "",
      steps: [
        {
          kind: "when",
          condition: { kind: "ui", condition: "visible", selector: { text: "Home" } },
          steps: [{ kind: "tap", selector: { text: "Home" } }],
        },
      ],
    });

    const runs = await Promise.all([
      run("blind-assert"),
      run("blind-await-hint"),
      run("blind-when"),
    ]);

    for (const { steps } of runs) {
      expect(steps[0]).toMatchObject({ indeterminate: true, hint: VEGA_HINT });
      expect(steps[0].reason).toMatch(/every read of the UI tree was empty or degraded/);
    }
  }, 20_000);

  it("judges a Vega cropOn miss on the rounds that looked, when only the last reads are blind", async () => {
    // Earlier rounds read the screen and did not find the element; then the
    // toolkit went blind. "was never looked for" would be false.
    currentSource = "vega-automation";
    const blindFrom = Date.now() + 3000;
    currentTree = () => {
      const blind = Date.now() >= blindFrom;
      currentFlags = blind ? { hint: VEGA_HINT } : {};
      return blind ? screen([]) : screen([label("Home")]);
    };

    const miss = await waitForFrame(VEGA, { identifier: "price-card" });

    if (miss === "aborted" || !("unresolved" in miss)) throw new Error("expected a miss");
    expect(Date.now()).toBeGreaterThan(blindFrom);
    // No scroll-to advice: Vega refuses scroll-to, as it does in the zero-area hint.
    expect(selectorMiss(miss)).toEqual({ reason: 'no element matched selector id="price-card"' });
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

  it("quotes an own text that holds quotes and backslashes as JSON, like the actual text", async () => {
    currentTree = () =>
      screen([label('Say "hi" C:\\x', { identifier: "greet", subtreeText: "Hello there" })]);
    await writeFlow("own-text-quotes", {
      executionPrerequisite: "",
      steps: [{ ...assertTotalEquals42, selector: { identifier: "greet" } }],
    });

    const [step] = (await run("own-text-quotes")).steps;

    expect(step.hint).toBe(
      'the element\'s own text is "Say \\"hi\\" C:\\\\x"; the check accepts the subtree text or the own text'
    );
  });

  it("cuts a long own text in the hint at 300 characters and counts the rest outside the quotes", async () => {
    const own = "Total ".repeat(80);
    currentTree = () => screen([label(own, { identifier: "total", subtreeText: `${own} $41.50` })]);
    await writeFlow("own-text-long", { executionPrerequisite: "", steps: [assertTotalEquals42] });

    const [step] = (await run("own-text-long")).steps;

    expect(step.hint).toBe(
      `the element's own text is "${own.slice(0, 300)}" … (180 more characters); the check ` +
        "accepts the subtree text or the own text"
    );
  });

  it("keeps the own-text hint when the final poll fails, and closes the reason with the note", async () => {
    // Trusted reads until about one poll before the 1s assert deadline, then
    // the source throws: the blip tier, whose verdict stands.
    let firstReadAt: number | undefined;
    currentTree = () => {
      firstReadAt ??= Date.now();
      if (Date.now() - firstReadAt >= 950) disconnected();
      return screen([label("$41.50", { identifier: "total", subtreeText: "Total $41.50" })]);
    };
    await writeFlow("own-text-blip", { executionPrerequisite: "", steps: [assertTotalEquals42] });

    const [step] = (await run("own-text-blip")).steps;

    expect(step).toMatchObject({
      status: "fail",
      reason:
        'element matched id="total" but its text did not equal "$42.00" (the final poll ' +
        "could not read the UI tree: native devtools disconnected)",
      actual: "Total $41.50",
      hint: `the element's own text is "$41.50"; the check accepts the subtree text or the own text`,
    });
    expect(step).not.toHaveProperty("indeterminate");
  });

  it("keeps the whole found text in actual, and out of the reason", async () => {
    // A difference late in a large container's text must stay visible in the
    // report. Only the printed line is cut.
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
    expect(step.actual).toBe(screenText);
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

describe("refused tree read", () => {
  // A read refused with a `validation` failure is refused again on every re-run
  // (here: the flow reads an Apple system app). The check did not run, but the
  // step must not be flagged, or told, to run again.
  function refused(): never {
    throw new FailureError("com.apple.Preferences is an Apple system app", {
      error_code: FAILURE_CODES.NATIVE_DEVTOOLS_NOT_INJECTABLE,
      failure_stage: "flow_tree_pinned_target",
      failure_area: "tool_server",
      error_kind: "validation",
    });
  }

  it("does not flag an assert or a when guard for a re-run", async () => {
    currentTree = refused;
    await writeFlow("refused-assert", {
      executionPrerequisite: "",
      steps: [{ kind: "assert", condition: "visible", selector: { text: "General" } }],
    });
    await writeFlow("refused-guard", {
      executionPrerequisite: "",
      steps: [
        {
          kind: "when",
          condition: { kind: "ui", condition: "visible", selector: { text: "General" } },
          steps: [{ kind: "tap", selector: { text: "General" } }],
        },
      ],
    });

    const [assertRun, guardRun] = await Promise.all([run("refused-assert"), run("refused-guard")]);

    expect(assertRun.steps[0]).toMatchObject({ status: "fail" });
    expect(assertRun.steps[0].reason).toContain("is an Apple system app");
    // The guard still errors: its block is never skipped on a read it could not do.
    expect(guardRun.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["when:error", "tap:skip"]);
    for (const step of [assertRun.steps[0], guardRun.steps[0]]) {
      expect(step).not.toHaveProperty("indeterminate");
      expect(step).not.toHaveProperty("hint");
    }
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
