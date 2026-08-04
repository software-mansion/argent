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
vi.mock("../../src/tools/flows/flow-tree", () => ({
  fetchFlowTree: vi.fn(
    async (): Promise<DescribeTreeData> => ({
      tree: runnerTree(),
      source: "native-devtools",
      screen: { width: 390, height: 844 },
    })
  ),
}));

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

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-cross-tree-"));
  __resetRecordingsForTesting();
  runnerTree = () => screen(["Continue"]);
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
    expect(result.message).toContain("native-find-views");
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

    expect(result.message).toContain("Step added");
    expect(result.message).toContain("could not be re-verified against the tree the RUNNER reads");
    expect(parseFlow(await onDisk("blind")).steps).toHaveLength(1);
  }, 20_000);

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
    expect(result.message).toContain(
      "no read-only tool exposes the runner's full hierarchy on Android"
    );
    expect(result.message).not.toContain("reads the runner's side");
    expect(result.message).not.toContain("native-find-views");
    expect(parseFlow(await onDisk("android")).steps).toHaveLength(1);
  }, 20_000);

  it("on Chromium, names describe (the DOM walker) as the runner's reader", async () => {
    runnerTree = () => screen(["Proceed"]);
    await flowStartRecordingTool.execute(
      {},
      { name: "chromium", project_root: tmpDir, executionPrerequisite: "on the form" }
    );

    const result = await recordWait("chromium", "Continue", CHROMIUM);

    expect(result.message).toContain("does NOT hold against the tree the runner resolves");
    expect(result.message).toContain(
      "`describe` (this platform's DOM walker) reads the runner's side"
    );
    expect(result.message).not.toContain("native-find-views");
    expect(parseFlow(await onDisk("chromium")).steps).toHaveLength(1);
  }, 20_000);
});
