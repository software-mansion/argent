import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Registry } from "@argent/registry";
import type { DescribeNode, DescribeTreeData } from "../../src/tools/describe/contract";

// `await-ui-element` evaluates against the ACCESSIBILITY tree; the
// `await:`/`assert:` directive the flow carries is evaluated against the full
// native hierarchy. They overlap but neither contains the other — an id in the
// runner tree can be absent from the AX tree, and a text field's value visible
// to the recorder can be invisible to the runner. So a check could pass live
// and fail on every replay, which makes "each step is executed live so you
// verify it works before it's recorded" untrue exactly where it matters.
//
// These tests serve the RUNNER's tree (what `fetchFlowTree` returns) while the
// await-ui-element tool is stubbed to report success, i.e. the AX tree agreed.

let runnerTree: () => DescribeNode;
// The whole fetch is the seam, not just the tree it yields: a test that needs
// the read itself to hang (rather than to throw or to return) replaces this.
// Reset in beforeEach so no test leaks its implementation into the next.
let fetchRunnerTree: () => Promise<DescribeTreeData>;
vi.mock("../../src/tools/flows/flow-tree", () => ({
  fetchFlowTree: vi.fn((): Promise<DescribeTreeData> => fetchRunnerTree()),
}));

const defaultFetch = async (): Promise<DescribeTreeData> => ({
  tree: runnerTree(),
  source: "native-devtools",
  screen: { width: 390, height: 844 },
});

import { createAwaitUiElementTool } from "../../src/tools/await-ui-element";
import { assertSupported } from "../../src/utils/capability";
import { resolveDevice } from "../../src/utils/device-info";
import { flowStartRecordingTool } from "../../src/tools/flows/flow-start-recording";
import { createFlowAddStepTool } from "../../src/tools/flows/flow-add-step";
import { __resetRecordingsForTesting, parseFlow } from "../../src/tools/flows/flow-utils";

const DEVICE = "00000000-0000-0000-0000-0000000000ab"; // iOS UDID shape
let tmpDir: string;

const FULL: DescribeNode["frame"] = { x: 0, y: 0, width: 1, height: 1 };

function screen(labels: string[]): DescribeNode {
  return {
    role: "AXWindow",
    frame: FULL,
    children: labels.map((label, i) => ({
      role: "AXStaticText",
      label,
      frame: { x: 0, y: 0.1 * i, width: 1, height: 0.08 },
      children: [],
    })),
  };
}

/** A registry whose `await-ui-element` always reports the condition met. */
function registryWhereWaitSucceeds(): Registry {
  return {
    invokeTool: vi.fn(async (id: string) => {
      if (id === "await-ui-element") return { success: true, elapsed: 120 };
      throw new Error(`Tool "${id}" not found`);
    }),
    getTool: vi.fn(() => undefined),
  } as unknown as Registry;
}

/**
 * A registry whose `await-ui-element` reports the condition NEVER held — the
 * `{ success: false }` shape the tool returns instead of throwing.
 */
function registryWhereWaitTimesOut(): Registry {
  return {
    invokeTool: vi.fn(async (id: string) => {
      if (id === "await-ui-element") {
        return {
          success: false,
          elapsed: 1500,
          note: "no element matched the selector before timeout",
        };
      }
      throw new Error(`Tool "${id}" not found`);
    }),
    getTool: vi.fn(() => undefined),
  } as unknown as Registry;
}

async function onDisk(name: string): Promise<string> {
  return fs.readFile(path.join(tmpDir, ".argent", "flows", `${name}.yaml`), "utf8");
}

async function recordWait(name: string, selectorText: string, udid: string = DEVICE) {
  const tool = createFlowAddStepTool(registryWhereWaitSucceeds());
  return tool.execute(
    {},
    {
      name,
      project_root: tmpDir,
      command: "await-ui-element",
      args: JSON.stringify({
        udid,
        condition: "visible",
        selector: { text: selectorText },
      }),
    }
  );
}

const ANDROID = "emulator-5554"; // adb-serial shape → classifies android
const CHROMIUM = "chromium-cdp-9222"; // chromium-cdp- prefix → classifies chromium
const VEGA = "amazon-4a27df03c9777152"; // amazon- prefix → classifies vega

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-cross-tree-"));
  __resetRecordingsForTesting();
  runnerTree = () => screen(["Continue"]);
  fetchRunnerTree = defaultFetch;
});

afterEach(async () => {
  __resetRecordingsForTesting();
  await fs.rm(tmpDir, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe("a recorded wait is re-probed against the runner's tree", () => {
  it("records the step when both trees agree", async () => {
    await flowStartRecordingTool.execute(
      {},
      { name: "agree", project_root: tmpDir, executionPrerequisite: "on the form" }
    );

    const result = await recordWait("agree", "Continue");

    expect(result.message).toContain("Step added");
    expect(parseFlow(await onDisk("agree")).steps).toHaveLength(1);
  });

  // `await-ui-element` reports an unmet condition by returning
  // { success: false }, so the recorder's success path records the step. The
  // cross-tree warning must not be attached there: it says the raw step
  // "replays fine — it reads the same tree it just passed against", and this
  // one never passed. At replay an unmet wait fails the step and stops the run.
  it("does not claim a wait that never held replays fine", async () => {
    // The runner's tree AGREES with the selector, so the cross-tree probe —
    // had it run — would have found nothing to warn about and the step would
    // have been narrated as clean.
    runnerTree = () => screen(["Continue"]);
    await flowStartRecordingTool.execute(
      {},
      { name: "unmet", project_root: tmpDir, executionPrerequisite: "on the form" }
    );
    const tool = createFlowAddStepTool(registryWhereWaitTimesOut());

    const result = await tool.execute(
      {},
      {
        name: "unmet",
        project_root: tmpDir,
        command: "await-ui-element",
        args: JSON.stringify({
          udid: DEVICE,
          condition: "visible",
          selector: { text: "Continue" },
        }),
      }
    );

    expect(result.message).toContain("the wait itself never held");
    expect(result.message).toContain("stops the run there");
    expect(result.message).not.toContain("replays fine");
    // Nothing was compared, so nothing may blame a tree divergence or send the
    // author to re-record against "a selector present in both".
    expect(result.message).not.toContain("neither contains the other");
    expect(result.message).not.toContain("present in both");
    // Recording the step anyway is the pre-existing behaviour; only the
    // narration changes.
    expect(parseFlow(await onDisk("unmet")).steps).toHaveLength(1);
  });

  it("warns — but still records — a check the runner's tree cannot see", async () => {
    // The wait passed against the AX tree and the element the runner reads has
    // no such text. The step IS recorded, because what the recorder writes is
    // a raw `tool: await-ui-element` step, and at replay that tool reads the
    // very tree it just passed against — "it would fail every run" was false.
    // What the probe really reports is that converting it to `await:`/`assert:`
    // at polish would not resolve, which is exactly what the warning says.
    runnerTree = () => screen(["Proceed"]);
    await flowStartRecordingTool.execute(
      {},
      { name: "disagree", project_root: tmpDir, executionPrerequisite: "on the form" }
    );

    const result = await recordWait("disagree", "Continue");

    expect(result.message).toContain("does NOT hold against the tree the runner resolves");
    // The probe reads on the same short grace an `assert:` uses, so it predicts
    // that conversion exactly; an `await:` polls longer, so it is only warned as
    // conditional — not a flat "WILL fail" the probe's 1s window can't prove.
    expect(result.message).toContain("an `assert:` conversion WILL fail");
    expect(result.message).toContain("an `await:` will too unless the element reaches that tree");
    expect(result.message).not.toContain("`await:`/`assert:` at polish WILL fail");
    // iOS must NOT be told a tool "reads the runner's side": the Apple-only
    // full-hierarchy readers return the RAW view tree (a superset of the
    // runner's projection) and match identifier/label/className exactly, while
    // a recorded selector's `text`/`role` are substrings. They would report
    // elements the runner never sees and miss matches it does make.
    expect(result.message).toContain("No read-only tool reports the runner's projection on iOS");
    expect(result.message).not.toContain("reads the runner's side");
    expect(parseFlow(await onDisk("disagree")).steps).toHaveLength(1);
  }, 20_000);

  it("records with a warning when the runner's tree cannot be read at all", async () => {
    // The injection-free case: the runner's tree source is unavailable on this
    // device. Indeterminate is not a verdict, so refusing here would block a
    // form the skill explicitly sanctions.
    runnerTree = () => {
      throw new Error("native devtools is unavailable");
    };
    await flowStartRecordingTool.execute(
      {},
      { name: "blind", project_root: tmpDir, executionPrerequisite: "on the form" }
    );

    const result = await recordWait("blind", "Continue");

    expect(result.message).toContain("could not be re-verified against the tree the RUNNER reads");
    expect(result.message).toContain("is UNKNOWN, not known-bad");
    // Its own rule: nothing was compared, so nothing may claim the two trees
    // differ — nor append the remedy that follows from a comparison.
    expect(result.message).not.toContain("neither contains the other");
    expect(result.message).not.toContain("No read-only tool");
    expect(result.message).not.toContain("re-record");
    expect(parseFlow(await onDisk("blind")).steps).toHaveLength(1);
  }, 20_000);

  // "the accessibility tree" is the recorder's tree only on iOS and Android. On
  // Chromium the recorder read the CDP DOM and on Vega the toolkit page source,
  // so the indeterminate message must name the READER, not a tree source
  // neither side touched.
  it("does not call the recorder's tree the accessibility tree on Chromium", async () => {
    fetchRunnerTree = async () => {
      throw new Error("CDP session closed");
    };
    await flowStartRecordingTool.execute(
      {},
      { name: "blindchromium", project_root: tmpDir, executionPrerequisite: "on the form" }
    );

    const result = await recordWait("blindchromium", "Continue", CHROMIUM);

    expect(result.message).toContain("could not be re-verified against the tree the RUNNER reads");
    expect(result.message).toContain("the tree `await-ui-element` reads");
    expect(result.message).not.toContain("accessibility tree");
    expect(parseFlow(await onDisk("blindchromium")).steps).toHaveLength(1);
  });

  // The reader clause is platform-specific on purpose: no read-only tool reads
  // Android's runner tree (the full a11y hierarchy — native-find-views /
  // native-full-hierarchy are Apple-only), and Android `describe` returns the
  // TRIMMED tree the recorder already read. So the warning must NOT tell an
  // Android author that `describe` "reads the runner's side" — that would point
  // them at the recorder's own tree, the exact wrong-tree steer this warns
  // about. It also must not name the Apple-only `native-find-views`.
  it("on Android, does not claim `describe` reads the runner's side", async () => {
    runnerTree = () => screen(["Proceed"]);
    await flowStartRecordingTool.execute(
      {},
      { name: "android", project_root: tmpDir, executionPrerequisite: "on the form" }
    );

    const result = await recordWait("android", "Continue", ANDROID);

    expect(result.message).toContain("does NOT hold against the tree the runner resolves");
    // The reader clause is its own sentence after the divergence sentence's
    // period, so it must start capitalized — not "…drops. no read-only…".
    expect(result.message).toContain(
      "drops. No read-only tool exposes the runner's full hierarchy on Android"
    );
    expect(result.message).not.toContain("reads the runner's side");
    expect(result.message).not.toContain("native-find-views");
    expect(parseFlow(await onDisk("android")).steps).toHaveLength(1);
  }, 20_000);

  // The Chromium reader clause is special-cased for the same reason Android is:
  // `describe` on Chromium is the recorder's UN-trimmed DOM (a superset), and it
  // still shows the very nodes — role-only, non-addressable — that the runner's
  // addressable-only tree drops. Telling the author `describe` "reads the
  // runner's side" would send them to a tool that shows the element the runner
  // can't see, so they'd ship an `assert:` that fails every replay. The warning
  // must NOT name `describe` as the runner's reader there.
  it("on Chromium, does not claim `describe` reads the runner's side", async () => {
    runnerTree = () => screen(["Proceed"]);
    await flowStartRecordingTool.execute(
      {},
      { name: "chromium", project_root: tmpDir, executionPrerequisite: "on the form" }
    );

    const result = await recordWait("chromium", "Continue", CHROMIUM);

    expect(result.message).toContain("does NOT hold against the tree the runner resolves");
    // Capitalized, as its own sentence after the divergence sentence's period.
    expect(result.message).toContain(
      "runner. No read-only tool exposes the runner's trimmed tree on Chromium"
    );
    expect(result.message).not.toContain("reads the runner's side");
    expect(result.message).not.toContain("native-find-views");
    expect(parseFlow(await onDisk("chromium")).steps).toHaveLength(1);
  }, 20_000);

  // Vega is the one platform whose two trees hold the SAME elements:
  // flow-vega-tree re-shapes the very page source `describe` read (flatten +
  // text hoist) and drops nothing. So the generic "different projections of the
  // screen" line overstates it, and `describe` really does list what the runner
  // resolves against — the divergence is confined to a container's text.
  it("on Vega, does not claim the two trees are different projections", async () => {
    runnerTree = () => screen(["Proceed"]);
    await flowStartRecordingTool.execute(
      {},
      { name: "vega", project_root: tmpDir, executionPrerequisite: "on the form" }
    );

    const result = await recordWait("vega", "Continue", VEGA);

    expect(result.message).toContain("does NOT hold against the tree the runner resolves");
    expect(result.message).toContain("the flow tree drops nothing from it");
    expect(result.message).toContain("`describe` lists the same elements the runner resolves");
    expect(result.message).not.toContain("different projections of the screen");
    expect(result.message).not.toContain("reads the runner's side");
    expect(parseFlow(await onDisk("vega")).steps).toHaveLength(1);
  }, 20_000);

  // A `condition: "text"` wait carries an expectedText (and optional textMatch)
  // that the probe must forward into the runner-tree evaluation. If they were
  // dropped, the probe would score `text` as false unconditionally and warn on
  // every text wait that actually agrees; if expectedText were ignored, a wrong
  // value would never warn. These two pin both directions.
  it("forwards expectedText on a `text` wait: no warning when the value matches", async () => {
    runnerTree = () => screen(["Total: $5.00"]);
    await flowStartRecordingTool.execute(
      {},
      { name: "textok", project_root: tmpDir, executionPrerequisite: "on the form" }
    );
    const tool = createFlowAddStepTool(registryWhereWaitSucceeds());

    const result = await tool.execute(
      {},
      {
        name: "textok",
        project_root: tmpDir,
        command: "await-ui-element",
        args: JSON.stringify({
          udid: DEVICE,
          condition: "text",
          selector: { text: "Total" },
          expectedText: "$5.00",
        }),
      }
    );

    expect(result.message).toContain("Step added");
    expect(result.message).not.toContain("does NOT hold");
    expect(parseFlow(await onDisk("textok")).steps).toHaveLength(1);
  });

  it("evaluates expectedText on a `text` wait: warns when the value is absent", async () => {
    runnerTree = () => screen(["Total: $3.00"]);
    await flowStartRecordingTool.execute(
      {},
      { name: "textbad", project_root: tmpDir, executionPrerequisite: "on the form" }
    );
    const tool = createFlowAddStepTool(registryWhereWaitSucceeds());

    const result = await tool.execute(
      {},
      {
        name: "textbad",
        project_root: tmpDir,
        command: "await-ui-element",
        args: JSON.stringify({
          udid: DEVICE,
          condition: "text",
          selector: { text: "Total" },
          expectedText: "$5.00",
        }),
      }
    );

    expect(result.message).toContain("does NOT hold against the tree the runner resolves");
    expect(parseFlow(await onDisk("textbad")).steps).toHaveLength(1);
  }, 20_000);

  // `probeWhenCondition` budgets its POLL LOOP at the 1s assert grace, but each
  // tree read inside it is awaited unbounded and the clock is only checked
  // between reads — so a slow source (10s on Chromium CDP, up to 20s for an
  // Android uiautomator dump) stalls the recorder far past the window the
  // warning advertises. The probe must be ceilinged, and an overrun reported as
  // indeterminate rather than as a verdict.
  it("gives up on a tree read that outruns the probe budget", async () => {
    // A read that never settles at all: the only bound that can end this call
    // is the probe's own ceiling.
    fetchRunnerTree = () => new Promise<DescribeTreeData>(() => {});

    await flowStartRecordingTool.execute(
      {},
      { name: "slow", project_root: tmpDir, executionPrerequisite: "on the form" }
    );

    const startedAt = Date.now();
    const result = await recordWait("slow", "Continue");
    const elapsed = Date.now() - startedAt;

    expect(result.message).toContain("could not be re-verified against the tree the RUNNER reads");
    expect(result.message).toContain("did not answer within");
    // Never a verdict: nothing was compared, so the conversion is UNKNOWN.
    expect(result.message).not.toContain("does NOT hold");
    // The ceiling is 4s; anything near a full Chromium (10s) or uiautomator
    // (20s) read means the bound is not holding.
    expect(elapsed).toBeLessThan(6000);
    expect(parseFlow(await onDisk("slow")).steps).toHaveLength(1);
  }, 30_000);

  // The clause tables carry no `ios-remote` arm, and this is why: a remote sim
  // never reaches the probe at all. `await-ui-element` declares no appleRemote
  // capability, so assertSupported throws while the step is still executing
  // live and flow-add-step returns no warning. If that capability is ever
  // added, both tables need an ios-remote arm — the AX-vs-full-hierarchy story
  // is the iOS one, not the generic fallback they would otherwise get.
  it("cannot be reached on ios-remote: await-ui-element refuses the device", () => {
    const tool = createAwaitUiElementTool(registryWhereWaitSucceeds());
    expect(tool.capability?.appleRemote).toBeUndefined();
    expect(() =>
      assertSupported("await-ui-element", tool.capability, resolveDevice("remote:" + DEVICE))
    ).toThrow(/not supported on ios-remote/);
  });

  it("throws AbortError when the run is cancelled during the re-probe", async () => {
    // The live await-ui-element still "passes" (the mock ignores the signal), so
    // the abort lands in the re-probe — strictly after the recorded tool ran.
    // The probe must surface that as an abort and record nothing.
    await flowStartRecordingTool.execute(
      {},
      { name: "cancel", project_root: tmpDir, executionPrerequisite: "on the form" }
    );
    const tool = createFlowAddStepTool(registryWhereWaitSucceeds());
    const controller = new AbortController();
    controller.abort();

    await expect(
      tool.execute(
        {},
        {
          name: "cancel",
          project_root: tmpDir,
          command: "await-ui-element",
          args: JSON.stringify({
            udid: DEVICE,
            condition: "visible",
            selector: { text: "Continue" },
          }),
        },
        { signal: controller.signal } as never
      )
    ).rejects.toThrow(/aborted while re-probing/);

    // The abort fired before the append, so the flow still has no steps.
    expect(parseFlow(await onDisk("cancel")).steps).toHaveLength(0);
  });
});
