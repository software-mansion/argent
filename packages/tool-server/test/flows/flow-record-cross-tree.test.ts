import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Registry } from "@argent/registry";
import { ToolNotFoundError, ToolExecutionError } from "@argent/registry";
import type { DescribeNode, DescribeTreeData } from "../../src/tools/describe/contract";

// `await-ui-element` evaluates against the agent-facing describe tree; the
// `await:`/`assert:` directive polish converts the step into is evaluated
// against `fetchFlowTree`'s. On no platform does one contain the other, so a
// check can pass live and fail once converted.
//
// These tests serve the RUNNER's tree while the await-ui-element tool is
// stubbed to report success — i.e. the recorder's tree agreed. Every runner
// tree is built by the REAL per-platform flow adapter from a raw payload of
// that platform's shape, so each divergence is the one that projection actually
// produces, not a platform label on one shared fixture.

let fetchCount: number;
// The whole fetch is the seam; `beforeEach` resets it between tests.
let fetchRunnerTree: () => Promise<DescribeTreeData>;
// Makes `probeWhenCondition` REJECT for the one test whose subject is that arm.
let probeRejection: Error | undefined;
vi.mock("../../src/tools/flows/flow-actions", async () => {
  const actual = await vi.importActual<typeof import("../../src/tools/flows/flow-actions")>(
    "../../src/tools/flows/flow-actions"
  );
  return {
    ...actual,
    probeWhenCondition: (...args: Parameters<typeof actual.probeWhenCondition>) =>
      probeRejection ? Promise.reject(probeRejection) : actual.probeWhenCondition(...args),
  };
});

vi.mock("../../src/tools/flows/flow-tree", () => ({
  fetchFlowTree: vi.fn((): Promise<DescribeTreeData> => {
    fetchCount += 1;
    return fetchRunnerTree();
  }),
}));

import { createAwaitUiElementTool, evaluateMatches } from "../../src/tools/await-ui-element";
import { assertSupported } from "../../src/utils/capability";
import { resolveDevice } from "../../src/utils/device-info";
import { findAll, type Selector } from "../../src/utils/ui-tree-match";
import { adaptFullHierarchyToDescribeResult } from "../../src/tools/flows/flow-ios-tree";
import { adaptFullAndroidHierarchyToDescribeResult } from "../../src/tools/flows/flow-android-tree";
import { parseUiAutomatorDump } from "../../src/tools/describe/platforms/android/uiautomator-parser";
import { adaptChromiumTreeForFlows } from "../../src/tools/flows/flow-chromium-tree";
import { adaptVegaTreeForFlows } from "../../src/tools/flows/flow-vega-tree";
import { flowStartRecordingTool } from "../../src/tools/flows/flow-start-recording";
import {
  createFlowAddStepTool,
  directiveCommandHint,
  UNHINTED_DIRECTIVE_KEYS,
} from "../../src/tools/flows/flow-add-step";
import { flowFinishRecordingTool } from "../../src/tools/flows/flow-finish-recording";
import { flowInsertEchoTool } from "../../src/tools/flows/flow-insert-echo";
import {
  __resetRecordingsForTesting,
  parseFlow,
  serializeFlow,
  STEP_DIRECTIVE_KEYS,
} from "../../src/tools/flows/flow-utils";
import { n } from "./harness";

const IOS = "00000000-0000-0000-0000-0000000000ab"; // iOS UDID shape
const ANDROID = "emulator-5554"; // adb-serial shape → classifies android
const CHROMIUM = "chromium-cdp-9222"; // chromium-cdp- prefix → classifies chromium
const VEGA = "amazon-4a27df03c9777152"; // amazon- prefix → classifies vega

const FULL: DescribeNode["frame"] = { x: 0, y: 0, width: 1, height: 1 };
const ROW: DescribeNode["frame"] = { x: 0.1, y: 0.1, width: 0.5, height: 0.05 };

let tmpDir: string;

const IOS_SCREEN = { x: 0, y: 0, width: 390, height: 844 };
const IOS_ROW = { x: 0, y: 100, width: 390, height: 40 };

interface RawIosView {
  className?: string;
  label?: string;
  identifier?: string;
  alpha?: number;
  hidden?: boolean;
  frame?: typeof IOS_ROW;
  windowFrame?: typeof IOS_ROW;
  children?: RawIosView[];
}

/** `ViewHierarchy.getFullHierarchy`'s payload shape, through the iOS adapter. */
function iosRunnerTree(views: RawIosView[]): DescribeNode {
  return adaptFullHierarchyToDescribeResult({
    windows: [
      {
        className: "UIWindow",
        frame: IOS_SCREEN,
        windowFrame: IOS_SCREEN,
        children: views,
      },
    ],
  });
}

function iosLabel(label: string, extra: Partial<RawIosView> = {}): RawIosView {
  return {
    className: "UILabel",
    label,
    frame: IOS_ROW,
    windowFrame: IOS_ROW,
    children: [],
    ...extra,
  };
}

const ANDROID_W = 1080;
const ANDROID_H = 1920;

/** One `android-devtools` dump. Both Android sides parse THIS same XML. */
function androidDump(rows: string): string {
  return `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" class="android.widget.FrameLayout" package="com.acme.app" bounds="[0,0][1080,1920]">
    ${rows}
  </node>
</hierarchy>`;
}

/** That dump through the Android FLOW adapter — what the runner resolves. */
function androidRunnerTree(rows: string): DescribeNode {
  return adaptFullAndroidHierarchyToDescribeResult(androidDump(rows), ANDROID_W, ANDROID_H);
}

/** The same dump through the TRIM — what `await-ui-element` read live. */
function androidRecorderTree(rows: string): DescribeNode {
  return parseUiAutomatorDump(androidDump(rows), ANDROID_W, ANDROID_H);
}

/** The CDP DOM walker's own `DescribeNode` output, through the Chromium adapter. */
function chromiumRunnerTree(children: DescribeNode[]): DescribeNode {
  return adaptChromiumTreeForFlows(n({ role: "html", frame: FULL, children }));
}

/** The Vega toolkit's parsed page source, through the Vega adapter. */
function vegaRunnerTree(children: DescribeNode[]): DescribeNode {
  return adaptVegaTreeForFlows(n({ role: "Screen", frame: FULL, children }));
}

/** A registry whose `await-ui-element` always reports the condition met. */
function registryWhereWaitSucceeds(): Registry {
  return {
    invokeTool: vi.fn(async (id: string) => {
      if (id === "await-ui-element") return { success: true, elapsed: 120 };
      if (id === "gesture-tap") return { tapped: true };
      // The real registry throws `ToolNotFoundError` (not a plain Error) for an
      // unregistered id — `isToolNotFound` keys on that type, so the mock must
      // match production for the directive-hint path to be reached.
      throw new ToolNotFoundError(id);
    }),
    getTool: vi.fn(() => undefined),
  } as unknown as Registry;
}

/** `await-ui-element` returns `{ success: false }`: the condition never held. */
function registryWhereWaitTimesOut(): Registry {
  return registryWhereWaitFails("no element matched the selector");
}

/**
 * A registry whose `await-ui-element` returns `{ success: false }` carrying
 * `note`, and optionally the `cause` the real tool decides in its poll loop.
 *
 * Without `cause` this is the LEGACY shape, where the recorder has only the
 * note to read. With it the note may say anything — on
 * `visible`/`exists`/`text` a blind window produces prose byte-identical to a
 * genuine miss, which is why the cause is carried rather than parsed back out.
 */
function registryWhereWaitFails(note: string, extra: { cause?: string } = {}): Registry {
  return {
    invokeTool: vi.fn(async (id: string) => {
      if (id === "await-ui-element") return { success: false, elapsed: 1500, note, ...extra };
      throw new Error(`Tool "${id}" not found`);
    }),
    getTool: vi.fn(() => undefined),
  } as unknown as Registry;
}

type WaitArgs = {
  udid?: string;
  condition: "visible" | "hidden" | "exists" | "text";
  selector: Record<string, unknown>;
  expectedText?: string;
  textMatch?: "contains" | "equals";
};

async function startRecording(name: string): Promise<void> {
  await flowStartRecordingTool.execute(
    {},
    { name, project_root: tmpDir, executionPrerequisite: "on the form" }
  );
}

/**
 * Client (remote) mode: the in-memory flow is authoritative and this host never
 * owns the file. A `project_root` absent from this host is what selects it.
 */
async function startRemoteRecording(name: string): Promise<void> {
  await flowStartRecordingTool.execute(
    {},
    { name, project_root: tmpDir, executionPrerequisite: "on the form" },
    { fileInputs: { project_root: { presentOnHost: false } } } as never
  );
}

async function recordWait(
  name: string,
  wait: WaitArgs,
  opts: { registry?: Registry; delayMs?: number; signal?: AbortSignal } = {}
) {
  const tool = createFlowAddStepTool(opts.registry ?? registryWhereWaitSucceeds());
  return tool.execute(
    {},
    {
      name,
      project_root: tmpDir,
      command: "await-ui-element",
      args: JSON.stringify({ udid: IOS, ...wait }),
      delayMs: opts.delayMs,
    },
    (opts.signal ? { signal: opts.signal } : undefined) as never
  );
}

async function recordedSteps(name: string) {
  const yaml = await fs.readFile(path.join(tmpDir, ".argent", "flows", `${name}.yaml`), "utf8");
  return parseFlow(yaml).steps;
}

/** The probe's reason, quoted back. It is the only part the cap governs. */
function echoedReasonOf(warning: string): string {
  const open = "directives against (";
  const close = "). As the raw";
  const start = warning.indexOf(open);
  const end = warning.indexOf(close);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return warning.slice(start + open.length, end);
}

/** The warning half of `message`. "Step added" prefixes EVERY message. */
function warningOf(result: { message: string }, name: string): string | undefined {
  const prefix = `Step added to "${name}" flow`;
  expect(result.message.startsWith(prefix)).toBe(true);
  const rest = result.message.slice(prefix.length);
  return rest === "" ? undefined : rest.replace(/^ — /, "");
}

/**
 * The verdicts a finished `summary` carries, keyed by the step number each one
 * follows. A verdict is its own ARRAY ELEMENT, indented under its step: the
 * finish has no bespoke MCP renderer, so a newline folded into the step's
 * element would reach the agent escaped inside one long string.
 */
function verdictsIn(summary: string[]): Map<number, string> {
  const prefix = "   warning: ";
  const byStep = new Map<number, string>();
  let step: number | undefined;
  for (const line of summary) {
    const numbered = /^(\d+)\. /.exec(line);
    if (numbered) {
      step = Number(numbered[1]);
      continue;
    }
    expect(line.startsWith(prefix)).toBe(true);
    expect(step).toBeDefined();
    byStep.set(step as number, line.slice(prefix.length));
  }
  return byStep;
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-cross-tree-"));
  __resetRecordingsForTesting();
  fetchCount = 0;
  probeRejection = undefined;
  fetchRunnerTree = async () => ({
    tree: iosRunnerTree([iosLabel("Continue")]),
    source: "native-devtools",
    screen: { width: 390, height: 844 },
  });
});

afterEach(async () => {
  __resetRecordingsForTesting();
  await fs.rm(tmpDir, { recursive: true, force: true });
  vi.clearAllMocks();
});

/**
 * Serve one runner-tree read. `source` is labelling only: the probe never reads
 * `data.source`, and every clause picks its platform arm from the UDID shape.
 * So a fixture passing "cdp-dom" exercises the Chromium tree SHAPE, which the
 * real `adaptChromiumTreeForFlows` built, not the source.
 */
const serveTree = (tree: DescribeNode, source: DescribeTreeData["source"] = "native-devtools") => {
  fetchRunnerTree = async () => ({ tree, source });
};

describe("a recorded wait is re-probed against the runner's tree", () => {
  it("records the step, with no warning, when both trees agree", async () => {
    await startRecording("agree");

    const result = await recordWait("agree", {
      condition: "visible",
      selector: { text: "Continue" },
    });

    expect(warningOf(result, "agree")).toBeUndefined();
    // The whole artifact: a step of the wrong shape passes a length check.
    expect(await recordedSteps("agree")).toEqual([
      {
        kind: "tool",
        name: "await-ui-element",
        args: { condition: "visible", selector: { text: "Continue" } },
        delayMs: undefined,
      },
    ]);
  });

  // ── The evaluators on the two sides must not drift ────────────────────────
  //
  // The probe re-evaluates with the flow runner's engine (flowFindAll +
  // evaluateCondition); the live wait used await-ui-element's (findAll +
  // evaluateMatches). Nothing else here would notice them drifting apart — the
  // tree is mocked and the live tool stubbed — and the recorder would then warn
  // on every correctly-recorded wait. So feed both engines the SAME tree.
  const AGREEMENT: Array<{ name: string; wait: WaitArgs; tree: () => DescribeNode }> = [
    {
      name: "visible",
      wait: { condition: "visible", selector: { text: "Continue" } },
      tree: () => iosRunnerTree([iosLabel("Continue")]),
    },
    {
      name: "exists",
      wait: { condition: "exists", selector: { identifier: "row" } },
      tree: () => iosRunnerTree([iosLabel("Continue", { identifier: "row" })]),
    },
    {
      name: "hidden",
      wait: { condition: "hidden", selector: { text: "Spinner" } },
      tree: () => iosRunnerTree([iosLabel("Continue")]),
    },
    {
      name: "text/contains",
      wait: { condition: "text", selector: { text: "Total" }, expectedText: "$5.00" },
      tree: () => iosRunnerTree([iosLabel("Total: $5.00")]),
    },
    {
      name: "text/equals",
      wait: {
        condition: "text",
        selector: { text: "Total" },
        expectedText: "Total: $5.00",
        textMatch: "equals",
      },
      tree: () => iosRunnerTree([iosLabel("Total: $5.00")]),
    },
    {
      name: "role selector",
      wait: { condition: "visible", selector: { role: "StaticText" } },
      tree: () => iosRunnerTree([iosLabel("Continue")]),
    },
  ];

  for (const testCase of AGREEMENT) {
    it(`agrees with the live evaluator on a \`${testCase.name}\` wait`, async () => {
      const tree = testCase.tree();
      serveTree(tree);

      // The premise: await-ui-element's own evaluator passes on this tree.
      const liveVerdict = evaluateMatches(
        { udid: IOS, ...testCase.wait } as Parameters<typeof evaluateMatches>[0],
        findAll(tree, testCase.wait.selector as Selector)
      );
      expect(liveVerdict).toBe(true);

      await startRecording("agreecase");
      const result = await recordWait("agreecase", testCase.wait);

      expect(warningOf(result, "agreecase")).toBeUndefined();
    });
  }

  // An unmet condition returns `{ success: false }` and the step is still
  // recorded. The warning claims the raw step "replays fine", and it never passed.
  it("does not claim a wait that never held replays fine", async () => {
    // The runner's tree agrees, so a probe would have found nothing to warn about.
    await startRecording("unmet");

    const result = await recordWait(
      "unmet",
      { condition: "visible", selector: { text: "Continue" } },
      { registry: registryWhereWaitTimesOut() }
    );

    const warning = warningOf(result, "unmet");
    expect(warning).toContain("the wait itself never held");
    expect(warning).toContain("stops the run there");
    expect(warning).not.toContain("replays fine");
    // Nothing was compared, so nothing may blame a tree divergence.
    expect(warning).not.toContain("neither contains the other");
    expect(warning).not.toContain("present in both");
    // "Delete it from the .yaml" holds in host mode only.
    expect(warning).toContain("after `flow-finish-recording`");
    expect(fetchCount).toBe(0);
    expect(await recordedSteps("unmet")).toHaveLength(1);
  });

  // `success: false` also reports that the tool never saw the screen: the tree
  // source failed, or the caller cancelled. Neither is a false condition.
  it("does not call an unreadable tree source a condition that never held", async () => {
    await startRecording("blind");

    const result = await recordWait(
      "blind",
      { condition: "visible", selector: { text: "Continue" } },
      { registry: registryWhereWaitFails("last tree fetch failed: CDP not connected") }
    );

    const warning = warningOf(result, "blind");
    expect(warning).toContain("without a trustworthy read of the UI tree");
    expect(warning).toContain("UNKNOWN, not known-bad");
    // The note carries an error only where a fetch threw. An empty tree gives none.
    expect(warning).toContain("names the tree-source error where a fetch threw");
    expect(warning).not.toContain("read `toolResult.note` for the tree-source error");
    // A window that goes dark only at the end classifies here, and it did compare.
    expect(warning).not.toContain("nothing was ever compared");
    expect(warning).not.toContain("the wait itself never held");
    expect(warning).not.toContain("re-record it once the condition can actually hold");
    expect(warning).not.toContain("delete the step from the .yaml");
    expect(warning).not.toContain("present in both");
    expect(fetchCount).toBe(0);
    expect(await recordedSteps("blind")).toHaveLength(1);
  });

  it("reads the cause off the RESULT, not off a note that reads like a miss", async () => {
    // Every other recorder test here omits `cause`, exercising only
    // `unmetUiWaitCause`'s note fallback. The case the field exists for is the
    // one the note cannot express: on `visible`/`exists`/`text` a blind window
    // reads byte-identical to a genuine miss, and the note alone would send the
    // author to delete the step.
    await startRecording("carried");

    const result = await recordWait(
      "carried",
      { condition: "visible", selector: { text: "Continue" } },
      {
        registry: registryWhereWaitFails("no element matched the selector before timeout", {
          cause: "unreadable",
        }),
      }
    );

    const warning = warningOf(result, "carried");
    expect(warning).toContain("without a trustworthy read of the UI tree");
    expect(warning).toContain("UNKNOWN, not known-bad");
    expect(warning).not.toContain("the wait itself never held");
    // The control: the same note with no cause leaves `unmet` the only answer.
    await startRecording("bare");
    const bare = await recordWait(
      "bare",
      { condition: "visible", selector: { text: "Continue" } },
      { registry: registryWhereWaitFails("no element matched the selector before timeout") }
    );
    expect(warningOf(bare, "bare")).toContain("the wait itself never held");
  });

  // The unmet warning tells the author to delete the failed step, and must say
  // WHEN: after the finish, in both persistence modes. Against a remote client
  // the in-memory copy is authoritative and the next append writes the step
  // back; in host mode the re-read renumbers the steps the verdicts anchor to.
  it("records against a remote client, and defers the delete to the finish", async () => {
    await startRemoteRecording("remoteunmet");

    const result = await recordWait(
      "remoteunmet",
      { condition: "visible", selector: { text: "Continue" } },
      { registry: registryWhereWaitTimesOut() }
    );

    const warning = warningOf(result, "remoteunmet");
    expect(warning).toContain("the wait itself never held");
    expect(warning).toContain("after `flow-finish-recording` rather than mid-recording");
    // The advice the create-flow skill forbids; it renumbers the steps.
    expect(warning).not.toContain("in host (local) mode, where the recorder re-reads");
    // The host wrote no file, so the step and its verdict live in memory.
    expect(result.savedTo).not.toBe(null);
  });

  it("re-probes a wait recorded against a remote client too", async () => {
    serveTree(iosRunnerTree([iosLabel("Proceed")]));
    await startRemoteRecording("remoteprobe");

    const result = await recordWait("remoteprobe", {
      condition: "visible",
      selector: { text: "Continue" },
    });

    expect(warningOf(result, "remoteprobe")).toContain(
      "does NOT hold against the tree the runner resolves"
    );
    // The probe reads the device the same way in either mode.
    expect(fetchCount).toBeGreaterThan(0);
  });

  it("carries a verdict through a client-mode finish", async () => {
    // Client mode is the hardest arm for the anchor comparison: with no file
    // the finish serializes the in-memory flow, parses it back, and compares
    // those steps against `session.flow.steps` — the RAW objects the recorder
    // pushed. Every verdict rides on `summarizeStep` rendering both alike.
    serveTree(iosRunnerTree([iosLabel("Proceed")]));
    await startRemoteRecording("remotefinish");
    await recordWait("remotefinish", { condition: "visible", selector: { text: "Continue" } });
    serveTree(iosRunnerTree([iosLabel("Continue")]));
    await recordWait("remotefinish", { condition: "visible", selector: { text: "Continue" } });

    const finished = await flowFinishRecordingTool.execute(
      {},
      { name: "remotefinish", project_root: tmpDir }
    );

    expect([...verdictsIn(finished.summary).keys()]).toEqual([1]);
    expect(verdictsIn(finished.summary).get(1)).toContain("does NOT hold");
    expect(finished.message).toContain("1 step carries a cross-tree warning");
    expect(finished.message).not.toContain("NOT in `summary`");
    expect(finished.savedTo).not.toBe(tmpDir);
  });

  it("does not call an unconfirmable `hidden` a condition that never held", async () => {
    await startRecording("blindhidden");

    const result = await recordWait(
      "blindhidden",
      { condition: "hidden", selector: { text: "Continue" } },
      {
        registry: registryWhereWaitFails(
          "could not confirm the element is hidden — the UI tree was empty or unreadable at timeout"
        ),
      }
    );

    const warning = warningOf(result, "blindhidden");
    expect(warning).toContain("UNKNOWN, not known-bad");
    expect(warning).not.toContain("the wait itself never held");
  });

  it("does not call a cancelled wait a condition that never held", async () => {
    await startRecording("cancelledwait");

    const result = await recordWait(
      "cancelledwait",
      { condition: "visible", selector: { text: "Continue" } },
      { registry: registryWhereWaitFails("wait was cancelled before the condition was met") }
    );

    const warning = warningOf(result, "cancelledwait");
    expect(warning).toContain("cancelled before its deadline");
    expect(warning).toContain("UNKNOWN, not known-bad");
    expect(warning).not.toContain("the wait itself never held");
    expect(fetchCount).toBe(0);
  });

  // Each guard returns before the probe reads, so `fetchCount` proves it fired.
  it.each([
    ["a non-string condition", { condition: 7, selector: { text: "Continue" } }],
    ["a null selector", { condition: "visible", selector: null }],
    ["a non-object selector", { condition: "visible", selector: "Continue" }],
    ["a non-string udid", { condition: "visible", selector: { text: "Continue" }, udid: 42 }],
  ])("does not probe a wait carrying %s", async (label, badArgs) => {
    const name = `guard${label.replace(/\W/g, "")}`;
    await startRecording(name);
    const tool = createFlowAddStepTool(registryWhereWaitSucceeds());

    const result = await tool.execute(
      {},
      {
        name,
        project_root: tmpDir,
        command: "await-ui-element",
        args: JSON.stringify({ udid: IOS, ...badArgs }),
      }
    );

    expect(warningOf(result, name)).toBeUndefined();
    expect(fetchCount).toBe(0);
    expect(await recordedSteps(name)).toHaveLength(1);
  });

  it("does not re-probe a command that is not a wait", async () => {
    await startRecording("tap");
    const tool = createFlowAddStepTool(registryWhereWaitSucceeds());

    const result = await tool.execute(
      {},
      {
        name: "tap",
        project_root: tmpDir,
        command: "gesture-tap",
        args: JSON.stringify({ udid: IOS, x: 0.2, y: 0.15 }),
      }
    );

    expect(warningOf(result, "tap")).toBeUndefined();
    // One read, the tap's own selector capture. A second means the probe ran.
    expect(fetchCount).toBe(1);
  });

  // `delayMs` is a replay-time sleep; it says nothing about which tree resolves.
  it("still re-probes a wait that carries delayMs", async () => {
    serveTree(iosRunnerTree([iosLabel("Proceed")]));
    await startRecording("delayed");

    const result = await recordWait(
      "delayed",
      { condition: "visible", selector: { text: "Continue" } },
      { delayMs: 250 }
    );

    expect(warningOf(result, "delayed")).toContain("does NOT hold against the tree the runner");
    expect(await recordedSteps("delayed")).toEqual([
      {
        kind: "tool",
        name: "await-ui-element",
        args: { condition: "visible", selector: { text: "Continue" } },
        delayMs: 250,
      },
    ]);
  });

  // ── Which SPELLING of the conversion the verdict is about ────────────────
  //
  // The probe evaluates `args.selector` strictly, as recorded. The directive
  // grammar's bare-string sugar is a LOOSE selector, resolved identifier-first
  // with text only as a fallback — so on a screen where some node's id equals
  // the recorded text the two spellings resolve different elements and the
  // verdict flips. Both trees below are the live Chromium repro's shape:
  // `<button id="Continue">Proceed</button>`.
  const CONTINUE_BUTTON = () =>
    chromiumRunnerTree([
      n({ role: "button", identifier: "Continue", value: "Proceed", frame: ROW, children: [] }),
    ]);

  it("judges the recorded selector strictly, not as the loose bare string", async () => {
    const tree = CONTINUE_BUTTON();
    serveTree(tree, "cdp-dom");

    expect(findAll(tree, { identifier: "Continue" })).toHaveLength(1);
    expect(findAll(tree, { text: "Continue" })).toHaveLength(0);

    await startRecording("strictclean");
    const result = await recordWait("strictclean", {
      udid: CHROMIUM,
      condition: "hidden",
      selector: { text: "Continue" },
    });

    // Strict reading: nothing matches `text=Continue`, so `hidden` holds.
    expect(warningOf(result, "strictclean")).toBeUndefined();
  });

  it("names the strict spelling the verdict is about when it warns", async () => {
    serveTree(CONTINUE_BUTTON(), "cdp-dom");
    await startRecording("strictwarn");

    const result = await recordWait("strictwarn", {
      udid: CHROMIUM,
      condition: "visible",
      selector: { text: "Continue" },
    });
    const warning = warningOf(result, "strictwarn") ?? "";

    expect(warning).toContain("does NOT hold against the tree the runner resolves");
    // Without it the author converts to `{ visible: Continue }`, a check never made.
    expect(warning).toContain("convert it in the strict map spelling");
    expect(warning).toContain("re-parses as a LOOSE selector");
  });

  // ── The `text` comparator the recorded step does NOT carry ───────────────
  //
  // `await-ui-element` compares with `contains` unless the step passed
  // `textMatch: equals`, and the recorded YAML omits a defaulted field — while
  // the `text:` directive has no default and forces the author to pick. So the
  // comparator is a polish-time decision the artifact does not record, and the
  // wrong pick fails on the very screen the probe approved. The skill's
  // conversion rule (no `textMatch` ⇒ `contains:`) is sound only while the two
  // readings differ this way.
  it("judges a text wait with the tool's `contains` default, not `equals`", async () => {
    const totalRow = () => iosRunnerTree([iosLabel("Total: $5.00")]);

    serveTree(totalRow());
    await startRecording("textdefault");
    const defaulted = await recordWait("textdefault", {
      condition: "text",
      selector: { text: "Total" },
      expectedText: "$5.00",
    });
    expect(warningOf(defaulted, "textdefault")).toBeUndefined();

    serveTree(totalRow());
    await startRecording("textequals");
    const exact = await recordWait("textequals", {
      condition: "text",
      selector: { text: "Total" },
      expectedText: "$5.00",
      textMatch: "equals",
    });
    expect(warningOf(exact, "textequals")).toContain('its text was "Total: $5.00"');
  });

  // ── Per-platform divergences, each produced by that platform's adapter ────

  // iOS: an `accessible` container. The AX tree the recorder read merges it
  // into ONE leaf whose label aggregates its children (see
  // `captureTapSelector`), so the author records the merged string and it
  // resolves nothing for the runner: the flow projection keeps the container as
  // an addressable leaf and hoists the children's text into `subtreeText`,
  // which `findAll` does not match on.
  //
  // An `alpha: 0` view would NOT do here: whether the AX tree reports a fully
  // transparent one is a device question the suite cannot settle. The adapter
  // rule that fixture was reaching for is asserted directly below, as what it
  // is — a statement about the projection, not about a divergence.
  const IOS_ACCESSIBLE_CONTAINER = [
    {
      className: "UIView",
      identifier: "total-row",
      frame: IOS_ROW,
      windowFrame: IOS_ROW,
      children: [
        iosLabel("Total", { frame: { x: 0, y: 100, width: 100, height: 40 } }),
        iosLabel("$5.00", { frame: { x: 120, y: 100, width: 100, height: 40 } }),
      ],
    },
  ];

  it("iOS: warns when the AX tree's merged label exists on no single view", async () => {
    const tree = iosRunnerTree(IOS_ACCESSIBLE_CONTAINER);
    expect(findAll(tree, { text: "Total $5.00" })).toHaveLength(0);
    expect(findAll(tree, { identifier: "total-row" })[0]?.subtreeText).toBe("Total $5.00");

    serveTree(tree);
    await startRecording("ios");

    const result = await recordWait("ios", {
      condition: "visible",
      selector: { text: "Total $5.00" },
    });
    const warning = warningOf(result, "ios");

    expect(warning).toContain("does NOT hold against the tree the runner resolves");
    // The probe reads on the same short grace an `assert:` uses, so it predicts
    // that conversion exactly — but only where the two trees really differ,
    // which is this fixture. The consequence stays conditional because the same
    // verdict comes back from a screen that merely moved on; an `await:` polls
    // longer, so it carries the extra escape hatch.
    expect(warning).toContain(
      "if the trees really do differ over this element, an `assert:` conversion fails the same way"
    );
    expect(warning).toContain("an `await:` does too unless the element reaches that tree");
    expect(warning).toContain(
      "if the SCREEN simply moved on since the live wait, this verdict is no evidence"
    );
    expect(warning).not.toContain("WILL fail");
    // WHY the two disagree, in iOS's own terms. Elsewhere this text is only
    // ever pinned by its ABSENCE, so without a positive assertion the whole arm
    // could return "".
    expect(warning).toContain(
      "The recorder reads the accessibility tree and the runner reads the full native view " +
        "hierarchy; they overlap but neither contains the other."
    );
    // And the admission no tree story rules out, appended per arm. The
    // consequence sentence upstream conditions itself on this cause ("if the
    // SCREEN simply moved on…"), so an arm that omits it leaves that
    // conditional groundless.
    expect(warning).toContain("changed between the live wait and this re-probe");
    // iOS must NOT be told a tool "reads the runner's side": the Apple-only
    // full-hierarchy readers return the RAW view tree — both UILabels, still no
    // view carrying the merged label — and match identifier/label/className
    // exactly, where a recorded selector's `text`/`role` are substrings.
    // Anchored on the preceding sentence's end, so the join is pinned too.
    expect(warning).toContain(
      "rule that out first. No read-only tool reports the runner's projection on iOS"
    );
    // The two tools fail the question DIFFERENTLY, so pooling them names a
    // query one cannot be asked: `native-full-hierarchy` takes no matcher at
    // all. Only `native-find-views` has the exact-match behaviour.
    expect(warning).toContain(
      "`native-find-views` matches `identifier`/`label`/`className` EXACTLY"
    );
    expect(warning).toContain("`native-full-hierarchy` takes no matcher at all");
    // Nor may it answer "re-record": the skill's workflow for a testID the
    // trimmed tree hides is to gate on visible text and retarget at polish,
    // which is what PRODUCES this divergence. Sending the author back asks for
    // a step the skill just said cannot be recorded live.
    expect(warning).not.toContain("re-record");
    expect(warning).toContain("retarget the DIRECTIVE at an `id` the full hierarchy carries");
    expect(await recordedSteps("ios")).toHaveLength(1);
  });

  // The projection rule as what it actually is. Whether the AX tree still
  // reports an `alpha: 0` view — and so whether this rule ever produces a
  // divergence — is a device question; that the runner's projection drops one
  // is not.
  it("iOS: the runner's projection drops a transparent view", () => {
    expect(findAll(iosRunnerTree([iosLabel("Continue")]), { text: "Continue" })).toHaveLength(1);
    expect(
      findAll(iosRunnerTree([iosLabel("Continue", { alpha: 0 })]), { text: "Continue" })
    ).toHaveLength(0);
  });

  // On `hidden` the longer `await:` waits for the element to LEAVE, not to arrive.
  it("does not tell a `hidden` wait to wait for the element to arrive", async () => {
    serveTree(iosRunnerTree([iosLabel("Spinner")]));
    await startRecording("hiddenaway");

    const result = await recordWait("hiddenaway", {
      condition: "hidden",
      selector: { text: "Spinner" },
    });
    const warning = warningOf(result, "hiddenaway") ?? "";

    expect(warning).toContain("does NOT hold against the tree the runner resolves");
    expect(warning).toContain("unless the element LEAVES that tree within its longer timeout");
    expect(warning).not.toContain("the element reaches that tree");
    // A `hidden` verdict fires because the tree still HAS the element; retarget inverts.
    expect(warning).toContain("this verdict says that tree still HAS the element");
    expect(warning).toContain("narrow the selector until it matches only what you expect to leave");
    expect(warning).not.toContain("retarget the DIRECTIVE at an `id` the full hierarchy carries");
  });

  it("Android: inverts the retarget remedy for `hidden` too", async () => {
    // Per platform AND per condition: Android names a `resource-id`, iOS an `id`.
    serveTree(androidRunnerTree(ANDROID_ROW), "android-devtools");
    await startRecording("hiddenandroid");

    const result = await recordWait(
      "hiddenandroid",
      { udid: ANDROID, condition: "hidden", selector: { identifier: "continue-row" } },
      {}
    );
    const warning = warningOf(result, "hiddenandroid") ?? "";

    expect(warning).toContain("this verdict says that tree still HAS the element");
    expect(warning).toContain("retargeting at a `resource-id` it definitely carries");
    expect(warning).not.toContain("retarget the DIRECTIVE at a `resource-id` the full hierarchy");
  });

  // Android: a testID'd label inside a testID'd clickable row — an everyday RN
  // `Pressable testID` wrapping a `Text testID`.
  //
  // The TRIM collapses the pair: the row is clickable with no own label, so it
  // BORROWS its descendant's text and the inner TextView disappears into it —
  // `describe` shows one node, `id=continue-row label="Continue"`. The FLOW
  // parse keeps both, and the inner node's own resource-id SHIELDS its text
  // from hoisting, so the row reaches the runner with no text at all. A `text`
  // check on it holds live and not for the runner.
  //
  // A `com.android.systemui` target would NOT work: both parses drop system
  // chrome, so the live wait would fail too and only the stub keeps it green.
  const ANDROID_ROW = `<node index="0" class="android.widget.LinearLayout" resource-id="com.acme.app:id/continue-row" clickable="true" package="com.acme.app" bounds="[40,400][1040,480]">
           <node index="0" class="android.widget.TextView" resource-id="com.acme.app:id/continue-label" text="Continue" package="com.acme.app" bounds="[60,410][600,470]" />
         </node>`;

  it("Android: warns when the trim's collapse gave the runner's node no text", async () => {
    const wait: WaitArgs = {
      udid: ANDROID,
      condition: "text",
      selector: { identifier: "com.acme.app:id/continue-row" },
      expectedText: "Continue",
    };

    // The premise, on the same dump: the LIVE side really does pass.
    const recorderTree = androidRecorderTree(ANDROID_ROW);
    expect(
      evaluateMatches(
        wait as Parameters<typeof evaluateMatches>[0],
        findAll(recorderTree, wait.selector as Selector)
      )
    ).toBe(true);

    serveTree(androidRunnerTree(ANDROID_ROW), "android-devtools");
    await startRecording("android");

    const result = await recordWait("android", wait);
    const warning = warningOf(result, "android");

    expect(warning).toContain("does NOT hold against the tree the runner resolves");
    // Its own sentence after the period, so it must start capitalized.
    expect(warning).toContain(
      "first. No read-only tool exposes the runner's full hierarchy on Android"
    );
    // No tree story rules out a screen that moved on, so every platform says so.
    expect(warning).toContain("changed between the live wait and this re-probe");
    expect(warning).not.toContain("native-find-views");
    // Pin Android's OWN story, not merely that it differs from the others:
    // "four distinct strings" is satisfied by four wrong ones. Android's story
    // is one dump parsed two ways on this host — no view tree, and no second
    // read: both sides call `devtools.getHierarchy()`.
    expect(warning).toContain("Both read the same `getHierarchy` dump");
    expect(warning).toContain("this host then parses it two ways");
    expect(warning).toContain("each holds elements the other drops");
    expect(warning).not.toContain("full native view hierarchy");
    expect(warning).not.toContain("the runner reads the full hierarchy");
    expect(await recordedSteps("android")).toHaveLength(1);
  });

  // Chromium: `projectChromiumNode` drops a node with no on-screen frame, and the
  // walker clamps an off-viewport frame to zero area. `describe` still lists it.
  it("Chromium: warns when the runner's projection drops an off-viewport node", async () => {
    serveTree(
      chromiumRunnerTree([
        // Addressable by id AND by text, so the message must not blame the selector.
        n({
          role: "div",
          identifier: "far",
          value: "Continue",
          frame: { x: 0.03, y: 1, width: 0.94, height: 0 },
        }),
      ]),
      "cdp-dom"
    );
    await startRecording("chromium");

    const result = await recordWait("chromium", {
      udid: CHROMIUM,
      condition: "exists",
      selector: { identifier: "far" },
    });
    const warning = warningOf(result, "chromium");

    // A node is kept only when onScreen AND addressable; naming the latter blames the selector.
    expect(warning).toContain("addressable nodes");
    expect(warning).toContain("clamp");
    expect(warning).toContain("off-viewport");
    expect(warning).toContain("`scroll-to` before the check rather than a different selector");
    // Both axes. `normRect` clamps each edge alone, so a sideways node is zero-WIDTH.
    expect(warning).toContain("zero width for one left or right of it");
    // Not the other direction: the live `exists` passed, so the recorder saw it.
    expect(warning).toContain("5000-node walk limit is not what went wrong");
    expect(warning).not.toContain("past the end of what it read");

    expect(warning).toContain("does NOT hold against the tree the runner resolves");
    expect(warning).toContain(
      "first. No read-only tool exposes the runner's trimmed tree on Chromium"
    );
    expect(warning).not.toContain("native-find-views");
    expect(await recordedSteps("chromium")).toHaveLength(1);
  });

  it("Chromium: inverts its own remedy for a `hidden` divergence", async () => {
    // A `hidden` verdict means that tree still HAS the element.
    serveTree(
      chromiumRunnerTree([
        n({
          role: "div",
          identifier: "still-here",
          value: "Loading",
          frame: { x: 0.1, y: 0.1, width: 0.5, height: 0.05 },
        }),
      ]),
      "cdp-dom"
    );
    await startRecording("chromiumhidden");

    const result = await recordWait("chromiumhidden", {
      udid: CHROMIUM,
      condition: "hidden",
      selector: { identifier: "still-here" },
    });
    const warning = warningOf(result, "chromiumhidden") ?? "";

    expect(warning).toContain("settle it by running the conversion");
    expect(warning).toContain("This verdict says that tree still HAS the element");
    expect(warning).toContain("matches only what you expect to leave");
    expect(warning).not.toContain("the fix there is a `scroll-to` before the check");
    expect(warning).not.toContain("only an `id`/`role` selector can match it");
    // On `hidden` the runner's tree KEPT the element, so its own drops are not the cause.
    expect(warning).toContain("it is the RECORDER that never saw the element");
    expect(warning).toContain("past the end of what it read");
    expect(warning).not.toContain("keeps only addressable nodes");
  });

  // A divergence that is not about MEMBERSHIP. Both trees hold both nodes; the
  // sides elect different ones, because `text` inspects a single winner and
  // `firstInReadingOrder` breaks an exact (y, x) tie by encounter order — and
  // the two enumerate in opposite orders. The verdict is right and every other
  // explanation in the message is wrong for it.
  it("Chromium: names the multi-match cause when a `text` wait elects two different winners", async () => {
    const TIE = { x: 0.007, y: 0.062, width: 0.98, height: 0.014 };
    const recorderRow = n({
      role: "div",
      identifier: "row",
      label: "Total",
      frame: TIE,
      children: [n({ role: "span", value: "Total: $5.00", frame: TIE })],
    });
    serveTree(chromiumRunnerTree([recorderRow]), "cdp-dom");
    await startRecording("tie");

    // The premise: the two enumeration orders hand back opposite winners.
    const sel: Selector = { text: "Total" };
    const recorderMatches = findAll(n({ role: "html", frame: FULL, children: [recorderRow] }), sel);
    const runnerMatches = findAll(chromiumRunnerTree([recorderRow]), sel);
    expect(recorderMatches).toHaveLength(2);
    expect(runnerMatches).toHaveLength(2);
    expect(recorderMatches[0].identifier).toBe("row"); // container first
    expect(runnerMatches[0].value).toBe("Total: $5.00"); // child first

    const result = await recordWait("tie", {
      udid: CHROMIUM,
      condition: "text",
      selector: { text: "Total" },
      expectedText: "Total",
      textMatch: "equals",
    });
    const warning = warningOf(result, "tie");

    expect(warning).toContain("selector matches more than one element");
    expect(warning).toContain("elect DIFFERENT ones from the very same nodes");
    expect(warning).toContain("narrow the selector until it resolves a single node");
    // Membership and timing are both inapplicable, and the message must say so.
    expect(warning).toContain("both trees hold both elements");
    expect(warning).toContain("a longer `await:` timeout cannot help");
    // `text` has its own `awaitStillNeeds` arm; without it the `visible` one applies.
    expect(warning).toContain(
      "unless the element THAT tree elects comes to match on it within its longer timeout"
    );
    expect(warning).not.toContain("that element's text comes to match");
    expect(warning).not.toContain("the element reaches that tree");
    // The MECHANISM: nested pre-order against flattened post-order. Not on iOS.
    expect(warning).toContain("lists a container before its children");
  });

  it("iOS: explains the `text` tie without a container neither of its trees has", async () => {
    // On iOS both sides are FLAT, so the tie is still reachable — two flat
    // lists from different sources can order an exact frame tie differently —
    // but the container-over-child story sends an author hunting a shape the
    // platform does not have. The clause is gated on `condition === "text"`
    // alone, so nothing else keeps it off this arm.
    serveTree(iosRunnerTree([iosLabel("Total: $5.00")]));
    await startRecording("iostie");

    const result = await recordWait("iostie", {
      condition: "text",
      selector: { text: "Total" },
      expectedText: "Total",
      textMatch: "equals",
    });
    const warning = warningOf(result, "iostie") ?? "";

    expect(warning).toContain("elect DIFFERENT ones from the very same nodes");
    expect(warning).toContain("flat lists built from different sources");
    expect(warning).not.toContain("lists a container before its children");
  });

  it("does not raise the multi-match cause on a condition that cannot have it", async () => {
    // `exists`/`visible`/`hidden` quantify over every match, so order cannot matter.
    serveTree(
      chromiumRunnerTree([
        n({ role: "div", identifier: "far", value: "Continue", frame: { ...ROW, height: 0 } }),
      ]),
      "cdp-dom"
    );
    await startRecording("notie");

    const result = await recordWait("notie", {
      udid: CHROMIUM,
      condition: "exists",
      selector: { identifier: "far" },
    });
    const warning = warningOf(result, "notie");

    expect(warning).toContain("does NOT hold against the tree the runner resolves");
    expect(warning).not.toContain("elect DIFFERENT ones");
  });

  // Chromium, the OTHER direction: a node the runner KEEPS.
  // `projectChromiumNode` redacts a password leaf's name to `[password]`, so an
  // `id` selector resolves it while no text selector can. A message that only
  // says "the runner dropped it" is false here in both halves, and its
  // "re-record with a text or label" remedy is unreachable by construction.
  it("Chromium: does not claim the runner dropped a password field it kept", async () => {
    const tree = chromiumRunnerTree([
      n({
        role: "input",
        identifier: "pw-field",
        label: "Enter your secret",
        password: true,
        clickable: true,
        frame: ROW,
      }),
    ]);
    serveTree(tree, "cdp-dom");

    expect(findAll(tree, { identifier: "pw-field" })).toHaveLength(1);
    expect(findAll(tree, { text: "secret" })).toHaveLength(0);
    expect(findAll(tree, { text: "[password]" })).toHaveLength(1);

    await startRecording("chromiumpw");
    const result = await recordWait("chromiumpw", {
      udid: CHROMIUM,
      condition: "visible",
      selector: { text: "secret" },
    });
    const warning = warningOf(result, "chromiumpw") ?? "";

    expect(warning).toContain("does NOT hold against the tree the runner resolves");
    // The verdict is right; the explanation must not name the wrong cause.
    expect(warning).not.toContain("never reaches the runner");
    expect(warning).toContain("`[password]`");
    expect(warning).toContain("only an `id`/`role` selector");
    // `describe` is not a superset: past its shorter walk it omits nodes.
    expect(warning).not.toContain("full DOM the recorder read");
    expect(warning).toContain("omits nodes the runner keeps");
  });

  // Vega is the one platform whose runner tree CANNOT disagree on an unchanged
  // screen: `projectVegaNode` skips nothing, so membership, frames and
  // visibility are identical, and its hoisted `subtreeText` is only ever extra
  // evidence beside a node's own text. The two assertions pin both halves: the
  // hoist never flips a passing check, and a warning blames the screen.
  it("Vega: the text hoist alone never turns a passing check into a warning", async () => {
    const parsed = [
      n({
        identifier: "totals",
        label: "Total",
        frame: ROW,
        children: [n({ role: "text", label: "$5.00", frame: { ...ROW, y: 0.16 }, children: [] })],
      }),
    ];
    const flowTree = vegaRunnerTree(parsed);
    serveTree(flowTree, "vega-automation");
    await startRecording("vegahoist");

    expect(findAll(flowTree, { identifier: "totals" })[0]?.subtreeText).toContain("$5.00");

    const result = await recordWait("vegahoist", {
      udid: VEGA,
      condition: "text",
      selector: { identifier: "totals" },
      expectedText: "Total",
      textMatch: "equals",
    });

    expect(warningOf(result, "vegahoist")).toBeUndefined();
  });

  it("Vega: blames a changed screen, not two different projections", async () => {
    // The only way a Vega probe disagrees: the screen moved on.
    serveTree(
      vegaRunnerTree([n({ role: "text", label: "Proceed", frame: ROW })]),
      "vega-automation"
    );
    await startRecording("vega");

    const result = await recordWait("vega", {
      udid: VEGA,
      condition: "visible",
      selector: { text: "Continue" },
    });
    const warning = warningOf(result, "vega");

    expect(warning).toContain("does NOT hold against the tree the runner resolves");
    // Anchored on the word this arm and the `text` arm differ by: the bare
    // "the SCREEN changed between…" is a substring of BOTH, so forcing the
    // `text` cause everywhere would offer a `visible` author an election tie
    // that `visible` cannot have.
    expect(warning).toContain(
      "disagreement means the SCREEN changed between the live wait and this re-probe"
    );
    expect(warning).not.toContain("elected different elements");
    expect(warning).toContain("`describe` reads the same source the runner does");
    expect(warning).not.toContain("different projections of the screen");
    // Here a disagreement MEANS the screen changed, and on that cause conversion passes.
    expect(warning).not.toContain("WILL fail");
    expect(warning).toContain(
      "if the SCREEN simply moved on since the live wait, this verdict is no evidence"
    );
    // Here the selector is fine, so nothing may send the author to rewrite it.
    expect(warning).not.toContain("retarget the DIRECTIVE");
    expect(warning).not.toContain("re-record with a selector");
    expect(warning).toContain("re-run the wait");
    expect(await recordedSteps("vega")).toHaveLength(1);
  });

  it("Vega: admits the tie its own text clause names two sentences later", async () => {
    // The tie mechanism is not a platform difference but the two enumeration
    // orders, which Vega has too. So on `text` the screen is not the only
    // cause, and saying it is contradicts the clause the same message carries.
    const TIE = { x: 0.1, y: 0.1, width: 0.5, height: 0.05 };
    const row = n({
      identifier: "row",
      label: "Total",
      frame: TIE,
      children: [n({ role: "text", label: "Total: $5.00", frame: TIE, children: [] })],
    });
    serveTree(vegaRunnerTree([row]), "vega-automation");
    await startRecording("vegatie");

    const result = await recordWait("vegatie", {
      udid: VEGA,
      condition: "text",
      selector: { text: "Total" },
      expectedText: "Total",
      textMatch: "equals",
    });
    const warning = warningOf(result, "vegatie") ?? "";

    expect(warning).toContain("elect DIFFERENT ones from the very same nodes");
    expect(warning).toContain("either the SCREEN changed");
    expect(warning).toContain("or the two sides elected different elements");
    // The absolute belongs only to the conditions that cannot have a tie.
    expect(warning).not.toContain("disagreement means the SCREEN changed");
  });

  // Each platform's remedy must be its own; a substring check lets a reword collapse two.
  it("gives each platform a distinct remedy", async () => {
    const warnings = new Map<string, string>();
    for (const [name, udid] of [
      ["ios", IOS],
      ["android", ANDROID],
      ["chromium", CHROMIUM],
      ["vega", VEGA],
    ] as const) {
      serveTree(iosRunnerTree([iosLabel("Proceed")]));
      await startRecording(`distinct-${name}`);
      const result = await recordWait(`distinct-${name}`, {
        udid,
        condition: "visible",
        selector: { text: "Continue" },
      });
      warnings.set(name, warningOf(result, `distinct-${name}`) ?? "");
    }

    expect(new Set(warnings.values()).size).toBe(4);
    for (const warning of warnings.values()) {
      expect(warning).not.toContain("on this platform — keep the step raw");
    }
  }, 15_000);

  // ── Indeterminate: unknown must never be dressed up as a verdict ──────────

  it("records with a warning when the runner's tree cannot be read at all", async () => {
    // Indeterminate is not a verdict, so refusing here would block a sanctioned form.
    fetchRunnerTree = async () => {
      throw new Error("native devtools is unavailable");
    };
    await startRecording("blind");

    const result = await recordWait("blind", {
      condition: "visible",
      selector: { text: "Continue" },
    });
    const warning = warningOf(result, "blind");

    expect(warning).toContain("could not be re-verified against the tree the RUNNER reads");
    expect(warning).toContain("is UNKNOWN, not known-bad");
    expect(warning).not.toContain("neither contains the other");
    expect(warning).not.toContain("No read-only tool");
    expect(warning).not.toContain("re-record");
    expect(await recordedSteps("blind")).toHaveLength(1);
  });

  // The recorder's tree is the accessibility tree only on iOS and Android.
  it("does not call the recorder's tree the accessibility tree on Chromium", async () => {
    fetchRunnerTree = async () => {
      throw new Error("CDP session closed");
    };
    await startRecording("blindchromium");

    const result = await recordWait("blindchromium", {
      udid: CHROMIUM,
      condition: "visible",
      selector: { text: "Continue" },
    });
    const warning = warningOf(result, "blindchromium");

    expect(warning).toContain("the tree `await-ui-element` reads");
    expect(warning).not.toContain("accessibility tree");
    // The bundleId caveat is iOS-only: nothing on Chromium resolves a target app.
    expect(warning).not.toContain("no directive takes a bundleId");
  });

  // The quoted reason ends "provide bundleId explicitly", but no directive takes one.
  it("iOS: says the bundleId its quoted reason recommends cannot reach the probe", async () => {
    fetchRunnerTree = async () => {
      throw new Error(
        "No native-devtools-connected apps are available for auto-targeting. " +
          "Launch or restart the app first, provide bundleId explicitly, or use screenshot " +
          "to inspect visible Home/system UI."
      );
    };
    await startRecording("iosblind");

    const result = await recordWait("iosblind", {
      condition: "visible",
      selector: { text: "General" },
    });
    const warning = warningOf(result, "iosblind");

    // The quoted reason still arrives whole — its tail is the recovery.
    expect(warning).toContain("provide bundleId explicitly");
    expect(warning).toContain("no directive takes a bundleId");
    expect(warning).toContain("`launch-app`");
    expect(warning).toContain("keep the check as a raw `tool:` step");
  });

  it("iOS: the caveat holds when the step DID carry a bundleId", async () => {
    fetchRunnerTree = async () => {
      throw new Error("no connected app; provide bundleId explicitly");
    };
    await startRecording("iosblindbundle");

    const tool = createFlowAddStepTool(registryWhereWaitSucceeds());
    const result = await tool.execute(
      {},
      {
        name: "iosblindbundle",
        project_root: tmpDir,
        command: "await-ui-element",
        args: JSON.stringify({
          udid: IOS,
          bundleId: "com.apple.Preferences",
          condition: "visible",
          selector: { text: "General" },
        }),
      }
    );

    // Supplying one changes nothing, so the warning must not imply it might.
    expect(warningOf(result, "iosblindbundle")).toContain(
      "the `bundleId` on this step reached the live wait only"
    );
  });

  // `probeWhenCondition` budgets its POLL LOOP at the 1s assert grace, but each
  // tree read inside it is awaited unbounded and the clock is checked only
  // between reads — so a slow source stalls the recorder far past the window
  // the warning advertises. Ceiling the probe, and report an overrun as
  // indeterminate rather than as a verdict.
  it("gives up on a tree read that outruns the probe budget, and stops it", async () => {
    // A read held open past the ceiling, then released. One that never settles proves less.
    let releaseRead: () => void = () => {};
    const readLanded = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    // Resolves the instant a SECOND fetch is issued, which must not happen.
    let sawSecondRead: () => void = () => {};
    const secondRead = new Promise<void>((resolve) => {
      sawSecondRead = resolve;
    });
    let reads = 0;
    fetchRunnerTree = async () => {
      if ((reads += 1) > 1) sawSecondRead();
      await readLanded;
      // A tree that does NOT satisfy the condition, or the loop would end here.
      return { tree: iosRunnerTree([iosLabel("Proceed")]), source: "native-devtools" };
    };
    await startRecording("slow");

    const startedAt = Date.now();
    const result = await recordWait("slow", {
      condition: "visible",
      selector: { text: "Continue" },
    });
    const elapsed = Date.now() - startedAt;
    const warning = warningOf(result, "slow");

    expect(warning).toContain("could not be re-verified against the tree the RUNNER reads");
    // The source answered, just too slowly. It is not absent.
    expect(warning).toContain("the source is slow, not down");
    expect(warning).toContain("when the device is quieter");
    expect(warning).not.toContain("once that tree source is back");
    expect(warning).not.toContain("does NOT hold");
    // The bound is a BACKSTOP, not the proof. The read cannot land until
    // `releaseRead()` below, so a probe that did not give up would park forever
    // and never return — returning is the proof, and the per-test timeout
    // catches the failure. Wall-clock only guards an overrun so large the
    // timeout would be reached another way.
    expect(elapsed).toBeLessThan(12_000);
    expect(await recordedSteps("slow")).toHaveLength(1);
    expect(fetchCount).toBe(1);

    // Now let the abandoned read land. Past its deadline the poll loop takes
    // one more full read (`finalPoll`) unless stopped, which would put a second
    // device read behind whatever step runs next — relocating the stall the
    // ceiling exists to remove.
    //
    // Raced rather than slept: `secondRead` resolves the moment a second fetch
    // is issued, so the failure path ends at once and the success path gets the
    // whole window. A fixed 50ms sleep was neither under load.
    releaseRead();
    await Promise.race([secondRead, new Promise((resolve) => setTimeout(resolve, 750))]);
    expect(fetchCount).toBe(1);
  }, 15_000);

  // The budget must cover the branch the probe exists for. A determinate
  // verdict costs TWO full reads — the loop checks its deadline only after a
  // completed read, then fires one more — so a ceiling of "the grace plus one
  // in-flight read" gives the divergence warning half the clean case's
  // tolerance and substitutes the indeterminate one on a merely slow device.
  it("still reaches a determinate verdict when each read is slower than the grace window", async () => {
    // 1.9s per read: over the 1s grace, so the loop takes exactly two reads and
    // the total lands near 3.8s. The clean case returns from the first read, so
    // it always tolerated this; the determinate branch needs two.
    //
    // Both bounds are one-directional under load, which is what keeps this from
    // flaking: load only pushes the total UP, so it stays above the 3500ms
    // ceiling under test while leaving 2.2s under the real 6000ms budget.
    fetchRunnerTree = async () => {
      await new Promise((resolve) => setTimeout(resolve, 1900));
      return { tree: iosRunnerTree([iosLabel("Proceed")]), source: "native-devtools" };
    };
    await startRecording("slowdeterminate");

    const result = await recordWait("slowdeterminate", {
      condition: "visible",
      selector: { text: "Continue" },
    });
    const warning = warningOf(result, "slowdeterminate");

    expect(fetchCount).toBe(2);
    expect(warning).toContain("does NOT hold against the tree the runner resolves");
    expect(warning).not.toContain("could not be re-verified");
  }, 20_000);

  // A `text` reason quotes the matched element's rendered content, and on the
  // flow tree that content is HOISTED — a container carries every descendant's
  // text. Unbounded, one failed check can paste a whole log pane into a tool
  // result the agent reads in full.
  it("caps the screen text it echoes back", async () => {
    const wall = "Lorem ipsum dolor sit amet ".repeat(60); // ~1600 chars
    serveTree(iosRunnerTree([iosLabel(`Total ${wall}`)]));
    await startRecording("long");

    const result = await recordWait("long", {
      condition: "text",
      selector: { text: "Total" },
      expectedText: "$5.00",
    });
    const warning = warningOf(result, "long") ?? "";

    expect(warning).toContain("does NOT hold against the tree the runner resolves");
    expect(warning).toContain("more chars)");
    expect(warning).toContain("Lorem ipsum");
    // Bound the ECHOED REASON, not the whole message: the fixed prose around it
    // is longer than this fixture, so `warning.length < wall.length` would turn
    // on how much explanation the message carries. Pin the EMITTED string,
    // marker included.
    const echoed = echoedReasonOf(warning);
    expect(echoed.length).toBeLessThanOrEqual(200);
    const [, tail] = echoed.split(/… \(\d+ more chars\) …/);
    expect(tail).toHaveLength(60);
  });

  // The cap bounds what is EMITTED, not what is kept. Budgeting the kept content
  // let a 201-character reason come out at 218, announcing "(1 more chars)".
  it("never emits a reason over the cap, or longer than the reason itself", async () => {
    // The fixed prose around the label is 76 characters.
    const FIXED = 76;
    for (const reasonLength of [199, 200, 201, 205, 220, 260]) {
      const label = `Total ${"z".repeat(reasonLength - FIXED - "Total ".length)}`;
      serveTree(iosRunnerTree([iosLabel(label)]));
      const name = `cap${reasonLength}`;
      await startRecording(name);

      const result = await recordWait(name, {
        condition: "text",
        selector: { text: "Total" },
        expectedText: "$5.00",
      });
      const echoed = echoedReasonOf(warningOf(result, name) ?? "");

      expect(echoed.length).toBeLessThanOrEqual(200);
      expect(echoed.length).toBeLessThanOrEqual(reasonLength);
      if (reasonLength <= 200) expect(echoed).not.toContain("more chars)");
      else expect(echoed).toContain("more chars)");
    }
  }, 30_000);

  // The cap ELIDES THE MIDDLE: the note about a dark final poll lives at the END.
  it("keeps the tail of an over-long reason, where the final-poll note lives", async () => {
    const wall = "Lorem ipsum dolor sit amet ".repeat(60);
    // Trusted reads keep the condition false, then the source dies on the last
    // poll. That tail is inside CONDITION_DARK_TAIL_TOLERANCE_MS, so it stays firm.
    const probeStartedAt = Date.now();
    fetchRunnerTree = async () => {
      if (Date.now() - probeStartedAt > 900) throw new Error("native devtools went away");
      return { tree: iosRunnerTree([iosLabel(`Total ${wall}`)]), source: "native-devtools" };
    };
    await startRecording("tail");

    const result = await recordWait("tail", {
      condition: "text",
      selector: { text: "Total" },
      expectedText: "$5.00",
    });
    const warning = warningOf(result, "tail") ?? "";

    // This tier holds only while the dark tail is inside
    // CONDITION_DARK_TAIL_TOLERANCE_MS (2 poll intervals, 600ms). Host load breaks it.
    expect(
      warning,
      "expected the blip tier: under host load the dark tail can exceed CONDITION_DARK_TAIL_TOLERANCE_MS, which turns this indeterminate"
    ).toContain("does NOT hold against the tree the runner resolves");
    expect(warning).toContain("Lorem ipsum");
    expect(warning).toContain("more chars)");
    // The note the head-only cap threw away.
    expect(warning).toContain("native devtools went away");
  });

  it("reports a probe that threw outright as indeterminate, not as a verdict", async () => {
    // The arm no tree fixture reaches: every "cannot be read" case makes
    // `fetchFlowTree` throw, which `waitForCondition` catches into an
    // indeterminate VALUE. This is the other half — the probe itself rejecting
    // — and it must read as "the tree did not answer", not as a divergence.
    probeRejection = new Error("probe blew up");
    await startRecording("threw");

    const result = await recordWait("threw", {
      condition: "visible",
      selector: { text: "Continue" },
    });
    const warning = warningOf(result, "threw") ?? "";

    expect(warning).toContain("could not be re-verified against the tree the RUNNER reads");
    expect(warning).toContain("reading the runner's tree failed: probe blew up");
    expect(warning).toContain("UNKNOWN, not known-bad");
    // A throw is an outage, not slowness: the two get different next moves.
    expect(warning).toContain("re-probe once that tree source is back");
    expect(warning).not.toContain("the source is slow, not down");
    expect(warning).not.toContain("does NOT hold");
    expect(await recordedSteps("threw")).toHaveLength(1);
  });

  it("raises no warning for a wait nested inside a recorded run-sequence", async () => {
    // `flow-start-recording`'s description tells the author this, and nothing
    // pinned it: the recorder keys every wait warning off the tool id, so a
    // `run-sequence` — whose own result carries no `success` key — is neither
    // probed nor reported on, however its nested wait ended. The author has to
    // read `toolResult` themselves, so the claim has to stay true.
    //
    // The sequence must be a CLEAN one. A sequence that stopped short is
    // refused a recording, so it could never reach a wait warning and would
    // pass for the wrong reason. A nested wait that PASSED discriminates,
    // because a top-level wait that passed is what gets re-probed.
    const registry = {
      invokeTool: vi.fn(async (id: string) => {
        if (id === "run-sequence")
          return {
            completed: 2,
            total: 2,
            steps: [
              { tool: "await-ui-element", result: { success: true, elapsed: 12 } },
              { tool: "gesture-tap", result: { tapped: true } },
            ],
          };
        throw new Error(`Tool "${id}" not found`);
      }),
      getTool: vi.fn(() => undefined),
    } as unknown as Registry;
    await startRecording("nested");

    const tool = createFlowAddStepTool(registry);
    const result = await tool.execute(
      {},
      {
        name: "nested",
        project_root: tmpDir,
        command: "run-sequence",
        args: JSON.stringify({
          udid: IOS,
          steps: [
            {
              tool: "await-ui-element",
              args: { condition: "visible", selector: { text: "Nope" } },
            },
            { tool: "gesture-tap", args: { x: 0.5, y: 0.5 } },
          ],
        }),
      }
    );

    // The step does carry a warning, but not a WAIT one: the sequence wraps a
    // coordinate tap, so the recorder objects to the opaque step it had to
    // write. Nothing in it speaks about the runner's tree, and `fetchCount`
    // proves the nested wait was never probed against it.
    const warning = warningOf(result, "nested") ?? "";
    expect(warning).toContain("recorded as one opaque raw step");
    expect(warning).not.toContain("RUNNER");
    expect(warning).not.toContain("re-verified");
    expect(fetchCount).toBe(0);
    expect(result.toolResult).toMatchObject({ completed: 2, total: 2 });
  });

  it("quotes a reason at or under the cap verbatim", async () => {
    serveTree(iosRunnerTree([iosLabel("Proceed")]));
    await startRecording("short");

    const result = await recordWait("short", {
      condition: "visible",
      selector: { text: "Continue" },
    });

    // Well under 200 chars, so nothing may be elided and nothing appended.
    expect(echoedReasonOf(warningOf(result, "short") ?? "")).toBe(
      'no element matched selector text="Continue"'
    );
  });

  it("does not truncate the reason when the runner's tree cannot be read", async () => {
    // An environment error carries no screen content, and its TAIL is the fix.
    const advice =
      "native devtools is unavailable on this device — the app was not launched through " +
      "argent, so the injected helper never attached; relaunch it with `launch-app` (or " +
      "`restart-app`) and re-record the step, or use screenshot to inspect visible Home/Settings";
    expect(advice.length).toBeGreaterThan(200);
    fetchRunnerTree = async () => {
      throw new Error(advice);
    };
    await startRecording("blindlong");

    const result = await recordWait("blindlong", {
      condition: "visible",
      selector: { text: "Continue" },
    });
    const warning = warningOf(result, "blindlong") ?? "";

    expect(warning).toContain("could not be re-verified against the tree the RUNNER reads");
    expect(warning).toContain(advice);
    expect(warning).not.toContain("more chars)");
  });

  // Polish begins after flow-finish-recording, so a verdict must survive it.

  it("carries each step's verdict into flow-finish-recording", async () => {
    await startRecording("polish");

    // Step 1 agrees, so no warning.
    serveTree(iosRunnerTree([iosLabel("Continue")]));
    await recordWait("polish", { condition: "visible", selector: { text: "Continue" } });
    // Step 2 diverges.
    serveTree(iosRunnerTree([iosLabel("Proceed")]));
    await recordWait("polish", { condition: "visible", selector: { text: "Continue" } });

    const finished = await flowFinishRecordingTool.execute(
      {},
      { name: "polish", project_root: tmpDir }
    );

    expect(finished.summary).toHaveLength(3);
    const verdicts = verdictsIn(finished.summary);
    expect([...verdicts.keys()]).toEqual([2]);
    expect(verdicts.get(2)).toContain("does NOT hold against the tree the runner resolves");
    expect(finished.message).toContain("1 step carries a cross-tree warning");
  });

  it("says nothing about warnings when every recorded wait agreed", async () => {
    serveTree(iosRunnerTree([iosLabel("Continue")]));
    await startRecording("clean");
    await recordWait("clean", { condition: "visible", selector: { text: "Continue" } });

    const finished = await flowFinishRecordingTool.execute(
      {},
      { name: "clean", project_root: tmpDir }
    );

    expect(finished.message).toBe('Finished recording "clean" flow (1 steps)');
    expect(finished.summary[0]).not.toContain("warning:");
  });

  it("does not headline a wait that never held as a conversion warning", async () => {
    // The re-probe is skipped on any `success: false`; this step failed LIVE.
    await startRecording("neverheld");
    await recordWait(
      "neverheld",
      { condition: "visible", selector: { text: "NoSuchThing" } },
      { registry: registryWhereWaitTimesOut() }
    );

    const finished = await flowFinishRecordingTool.execute(
      {},
      { name: "neverheld", project_root: tmpDir }
    );

    expect(verdictsIn(finished.summary).get(1)).toContain("the wait itself never held");
    expect(finished.message).toContain("1 step recorded a wait that did not pass");
    expect(finished.message).not.toContain("cross-tree warning");
  });

  it("pluralizes both counts, and joins them", async () => {
    // The wait arm's plural was unpinned. Two of each also pins the join.
    await startRecording("plural");
    serveTree(iosRunnerTree([iosLabel("Proceed")]));
    await recordWait("plural", { condition: "visible", selector: { text: "Continue" } });
    await recordWait("plural", { condition: "visible", selector: { text: "Sign in" } });
    for (const text of ["NoSuchThing", "NorThis"]) {
      await recordWait(
        "plural",
        { condition: "visible", selector: { text } },
        { registry: registryWhereWaitTimesOut() }
      );
    }

    const finished = await flowFinishRecordingTool.execute(
      {},
      { name: "plural", project_root: tmpDir }
    );

    expect(finished.message).toBe(
      'Finished recording "plural" flow (4 steps) — 2 steps carry a cross-tree warning about ' +
        "converting a recorded wait, and 2 steps recorded a wait that did not pass; read " +
        "`summary` before converting or replaying"
    );
  });

  it("counts a probed verdict and an unpassed wait separately", async () => {
    await startRecording("mixed");
    serveTree(iosRunnerTree([iosLabel("Proceed")]));
    await recordWait("mixed", { condition: "visible", selector: { text: "Continue" } });
    await recordWait(
      "mixed",
      { condition: "visible", selector: { text: "NoSuchThing" } },
      { registry: registryWhereWaitTimesOut() }
    );

    const finished = await flowFinishRecordingTool.execute(
      {},
      { name: "mixed", project_root: tmpDir }
    );

    expect(finished.message).toBe(
      'Finished recording "mixed" flow (2 steps) — 1 step carries a cross-tree warning about ' +
        "converting a recorded wait, and 1 step recorded a wait that did not pass; read " +
        "`summary` before converting or replaying"
    );
  });

  it("keeps every verdict when the recording ends with an echo", async () => {
    // `flow-add-echo` appends through the same helper and files no verdict, so
    // a trailing echo must not drop the verdicts already filed: it moves none
    // of the warned steps, and labelling a recording with echoes is what
    // flow-start-recording's description asks for.
    await startRecording("echolast");
    serveTree(iosRunnerTree([iosLabel("Proceed")]));
    await recordWait("echolast", { condition: "visible", selector: { text: "Continue" } });
    await recordWait("echolast", { condition: "visible", selector: { text: "Sign in" } });
    await flowInsertEchoTool.execute(
      {},
      { name: "echolast", project_root: tmpDir, message: "form submitted" }
    );

    const finished = await flowFinishRecordingTool.execute(
      {},
      { name: "echolast", project_root: tmpDir }
    );

    expect(finished.summary).toHaveLength(5);
    expect([...verdictsIn(finished.summary).keys()]).toEqual([1, 2]);
    expect(finished.summary[4]).toContain("3. echo:");
    expect(finished.message).toContain("2 steps carry a cross-tree warning");
  });

  it("drops every verdict when a hand edit renumbered the steps", async () => {
    // Host mode re-reads on every append, so a delete renumbers each later step.
    await startRecording("edited");
    // Step 1 agrees, step 2 diverges and carries the verdict, step 3 agrees.
    serveTree(iosRunnerTree([iosLabel("Continue")]));
    await recordWait("edited", { condition: "visible", selector: { text: "Continue" } });
    serveTree(iosRunnerTree([iosLabel("Proceed")]));
    await recordWait("edited", { condition: "visible", selector: { text: "Continue" } });
    serveTree(iosRunnerTree([iosLabel("Continue")]));
    await recordWait("edited", { condition: "visible", selector: { text: "Continue" } });

    // Delete the MIDDLE step: the innocent third slides into the anchored position 2.
    const file = path.join(tmpDir, ".argent", "flows", "edited.yaml");
    const parsed = parseFlow(await fs.readFile(file, "utf8"));
    parsed.steps = [parsed.steps[0], parsed.steps[2]];
    await fs.writeFile(file, serializeFlow(parsed), "utf8");

    const finished = await flowFinishRecordingTool.execute(
      {},
      { name: "edited", project_root: tmpDir }
    );

    expect(finished.summary).toHaveLength(2);
    for (const line of finished.summary) expect(line).not.toContain("warning:");
    // …and `message` must not advertise what the summary no longer carries.
    expect(finished.message).toBe(
      'Finished recording "edited" flow (2 steps) — 1 warning raised during this recording is ' +
        "NOT in `summary`: a hand edit to the .yaml moved the step it judged, so which step it " +
        "belongs to is no longer knowable — re-record that wait to see it again"
    );
  });

  it("drops an untouched step's verdict when a LATER step was edited in place", async () => {
    // Check 1's own behaviour, which nothing else reaches: the warned step is
    // step 1 and the edit is on step 2's args — same length, same order, step 1
    // untouched — so check 2 has nothing to say. Only the whole-flow comparison
    // notices, and it drops EVERY verdict, which the finish must report.
    await startRecording("inplace");
    serveTree(iosRunnerTree([iosLabel("Proceed")]));
    await recordWait("inplace", { condition: "visible", selector: { text: "Continue" } });
    serveTree(iosRunnerTree([iosLabel("Sign in")]));
    await recordWait("inplace", { condition: "visible", selector: { text: "Sign in" } });

    const file = path.join(tmpDir, ".argent", "flows", "inplace.yaml");
    const parsed = parseFlow(await fs.readFile(file, "utf8"));
    const second = parsed.steps[1];
    if (second.kind !== "tool") throw new Error("fixture: expected a recorded tool step");
    second.args = { ...second.args, timeoutMs: 1600 };
    await fs.writeFile(file, serializeFlow(parsed), "utf8");

    const finished = await flowFinishRecordingTool.execute(
      {},
      { name: "inplace", project_root: tmpDir }
    );

    // Step 1 never moved, so check 2 would have kept it.
    expect(finished.summary).toHaveLength(2);
    expect(finished.summary[0]).toContain('"Continue"');
    expect(verdictsIn(finished.summary).size).toBe(0);
    expect(finished.message).toContain(
      "1 warning raised during this recording is NOT in `summary`"
    );
  });

  it("drops the verdict when a hand edit REORDERED the steps", async () => {
    // The flow is still the length the recorder appended, so the count says nothing.
    await startRecording("swapped");
    serveTree(iosRunnerTree([iosLabel("Continue")]));
    await recordWait("swapped", { condition: "visible", selector: { text: "Continue" } });
    // Diverges — the verdict lands on step 2.
    serveTree(iosRunnerTree([iosLabel("Continue")]));
    await recordWait("swapped", { condition: "hidden", selector: { text: "Continue" } });
    serveTree(iosRunnerTree([iosLabel("Continue")]));
    await recordWait("swapped", { condition: "exists", selector: { text: "Continue" } });

    // Hand-swap steps 2 and 3. The step inheriting number 2 agrees across both trees.
    const file = path.join(tmpDir, ".argent", "flows", "swapped.yaml");
    const parsed = parseFlow(await fs.readFile(file, "utf8"));
    parsed.steps = [parsed.steps[0], parsed.steps[2], parsed.steps[1]];
    await fs.writeFile(file, serializeFlow(parsed), "utf8");

    const finished = await flowFinishRecordingTool.execute(
      {},
      { name: "swapped", project_root: tmpDir }
    );

    expect(finished.summary).toHaveLength(3);
    for (const line of finished.summary) expect(line).not.toContain("warning:");
    expect(finished.message).toContain(
      "1 warning raised during this recording is NOT in `summary`"
    );
  });

  it("drops the verdict of a step deleted before the recording went on", async () => {
    // The append re-reads the edited file, so nothing in it says an edit happened.
    await startRecording("deleted");
    serveTree(iosRunnerTree([iosLabel("Proceed")]));
    await recordWait("deleted", { condition: "visible", selector: { text: "Continue" } });
    serveTree(iosRunnerTree([iosLabel("Sign in")]));
    await recordWait("deleted", { condition: "visible", selector: { text: "Sign in" } });

    // Delete the diverging step 1, the remedy `UNMET_WAIT_WARNING` offers.
    const file = path.join(tmpDir, ".argent", "flows", "deleted.yaml");
    const parsed = parseFlow(await fs.readFile(file, "utf8"));
    parsed.steps = parsed.steps.slice(1);
    await fs.writeFile(file, serializeFlow(parsed), "utf8");

    serveTree(iosRunnerTree([iosLabel("Done")]));
    await recordWait("deleted", { condition: "visible", selector: { text: "Done" } });

    const finished = await flowFinishRecordingTool.execute(
      {},
      { name: "deleted", project_root: tmpDir }
    );

    expect(finished.summary).toHaveLength(2);
    // Step 1 is now the clean "Sign in" wait; the verdict under 1 judged a goner.
    expect(finished.summary[0]).toContain('"Sign in"');
    expect(verdictsIn(finished.summary).size).toBe(0);
    for (const line of finished.summary) expect(line).not.toContain("warning:");
    expect(finished.message).toContain(
      "1 warning raised during this recording is NOT in `summary`"
    );
  });

  it("drops the verdict a hand edit moved onto an identical twin step", async () => {
    // The case both content checks are blind to. A verdict is not a function of
    // the step's content — the probe reads the live device at that step's
    // moment — so a byte-identical wait can diverge at one position and agree
    // at another. Renumber the two and the anchor cannot tell them apart.
    await startRecording("twins");
    serveTree(iosRunnerTree([iosLabel("Ready marker")]));
    await recordWait("twins", { condition: "visible", selector: { text: "Ready marker" } });
    // Step 2 diverges: the runner's tree does not hold "Continue".
    serveTree(iosRunnerTree([iosLabel("Proceed")]));
    await recordWait("twins", { condition: "visible", selector: { text: "Continue" } });
    // Step 3 is the byte-identical call against a tree that DOES hold it.
    serveTree(iosRunnerTree([iosLabel("Continue")]));
    await recordWait("twins", { condition: "visible", selector: { text: "Continue" } });

    const file = path.join(tmpDir, ".argent", "flows", "twins.yaml");
    const parsed = parseFlow(await fs.readFile(file, "utf8"));
    parsed.steps = parsed.steps.slice(1);
    await fs.writeFile(file, serializeFlow(parsed), "utf8");

    // …and record on, so the append re-reads the edited file.
    serveTree(iosRunnerTree([iosLabel("Ready marker")]));
    await recordWait("twins", { condition: "visible", selector: { text: "Ready marker" } });

    const finished = await flowFinishRecordingTool.execute(
      {},
      { name: "twins", project_root: tmpDir }
    );

    // Step 1 diverged; step 2 is the twin that passed. A verdict on either is a lie.
    expect(finished.summary).toHaveLength(3);
    expect(verdictsIn(finished.summary).size).toBe(0);
    expect(finished.summary[1]).toContain('"Continue"');
    for (const line of finished.summary) expect(line).not.toContain("warning:");
  });

  it("drops the verdict a delete INSIDE the prefix moved onto an identical twin", async () => {
    // The same false conviction, but mid-prefix. The shortened file renders like
    // an unedited one; only a hypothesis anchored at 2 sees the splice.
    await startRecording("midtwins");
    serveTree(iosRunnerTree([iosLabel("Ready marker")]));
    await recordWait("midtwins", { condition: "visible", selector: { text: "Ready marker" } });
    serveTree(iosRunnerTree([iosLabel("Proceed")]));
    await recordWait("midtwins", { condition: "visible", selector: { text: "Continue" } });
    serveTree(iosRunnerTree([iosLabel("Continue")]));
    await recordWait("midtwins", { condition: "visible", selector: { text: "Continue" } });

    // Hand-delete the diverging step 2, leaving its twin to inherit the number.
    const file = path.join(tmpDir, ".argent", "flows", "midtwins.yaml");
    const parsed = parseFlow(await fs.readFile(file, "utf8"));
    parsed.steps = [parsed.steps[0], parsed.steps[2]];
    await fs.writeFile(file, serializeFlow(parsed), "utf8");

    serveTree(iosRunnerTree([iosLabel("Ready marker")]));
    await recordWait("midtwins", { condition: "visible", selector: { text: "Ready marker" } });

    const finished = await flowFinishRecordingTool.execute(
      {},
      { name: "midtwins", project_root: tmpDir }
    );

    // Number 2 now holds the twin that AGREED, so a verdict there convicts it.
    expect(finished.summary).toHaveLength(3);
    expect(verdictsIn(finished.summary).size).toBe(0);
    expect(finished.summary[1]).toContain('"Continue"');
    for (const line of finished.summary) expect(line).not.toContain("warning:");
    expect(finished.message).toContain(
      "1 warning raised during this recording is NOT in `summary`"
    );
  });

  it("keeps a live verdict when a delete makes the next append reuse its number", async () => {
    // TWO verdicts alive across the edit, which makes the reused key reachable:
    // the file loses a step, so the next append returns a `stepCount` a verdict
    // already holds. Overwriting it would lose a warning on a step still in the
    // flow and still diverging.
    await startRecording("collide");
    serveTree(iosRunnerTree([iosLabel("Proceed")]));
    await recordWait("collide", { condition: "visible", selector: { text: "Alpha" } });
    serveTree(iosRunnerTree([iosLabel("Proceed")]));
    await recordWait("collide", { condition: "visible", selector: { text: "Beta" } });

    // Delete "Alpha": the file is one step long again, so the next append is 2.
    const file = path.join(tmpDir, ".argent", "flows", "collide.yaml");
    const parsed = parseFlow(await fs.readFile(file, "utf8"));
    parsed.steps = parsed.steps.slice(1);
    await fs.writeFile(file, serializeFlow(parsed), "utf8");

    serveTree(iosRunnerTree([iosLabel("Proceed")]));
    const third = await recordWait("collide", {
      condition: "visible",
      selector: { text: "Gamma" },
    });
    expect(third.stepCount).toBe(2);

    const finished = await flowFinishRecordingTool.execute(
      {},
      { name: "collide", project_root: tmpDir }
    );

    // "Beta" moved from 2 to 1, so its verdict cannot be reported against a
    // number any more — but it must be COUNTED, not replaced by "Gamma"'s.
    // Three verdicts were raised: one survives, "Alpha"'s went with the deleted
    // step, "Beta"'s with the renumbering.
    expect(finished.summary[0]).toContain('"Beta"');
    expect([...verdictsIn(finished.summary).keys()]).toEqual([2]);
    expect(finished.summary[2]).toContain('"Gamma"');
    expect(finished.message).toContain("1 step carries a cross-tree warning");
    expect(finished.message).toContain(
      "2 warnings raised during this recording are NOT in `summary`"
    );
  });

  it("is declared longRunning, so the probe's budget is not spent from a 30s cap", () => {
    // The recorded tool runs inside this call, so it is as long as whatever it
    // wraps — and the three it most often wraps all declare this. Without it
    // the MCP adapter caps the POST at FETCH_TIMEOUT_MS and retries the body
    // MAX_RETRIES more times, each retry re-running the action and appending
    // another step. The re-probe spends PROBE_BUDGET_MS from that same ceiling.
    expect(createFlowAddStepTool(registryWhereWaitSucceeds()).longRunning).toBe(true);
    // The tool it proxies most often: a standalone wait duplicated once recorded.
    expect(createAwaitUiElementTool(registryWhereWaitSucceeds()).longRunning).toBe(true);
  });

  it("says nothing about discarded verdicts when none were", async () => {
    // A clean recording's `message` must stay the bare line.
    await startRecording("nodrop");
    serveTree(iosRunnerTree([iosLabel("Continue")]));
    await recordWait("nodrop", { condition: "visible", selector: { text: "Continue" } });

    const finished = await flowFinishRecordingTool.execute(
      {},
      { name: "nodrop", project_root: tmpDir }
    );

    expect(finished.message).toBe('Finished recording "nodrop" flow (1 steps)');
  });

  it("keeps the verdicts a hand edit left in place", async () => {
    // The other half of the anchor rule: removing an UNwarned step must not
    // cost the steps before it their verdicts, or the guard is the length
    // heuristic under another name. The removed step must be DISTINGUISHABLE
    // from the warned one — deleting a step identical to its neighbour leaves
    // the file matching both alignments (see the test below).
    await startRecording("kept");
    serveTree(iosRunnerTree([iosLabel("Proceed")]));
    await recordWait("kept", { condition: "visible", selector: { text: "Continue" } });
    serveTree(iosRunnerTree([iosLabel("Sign in")]));
    await recordWait("kept", { condition: "visible", selector: { text: "Sign in" } });

    // Delete the clean step 2, then record one more warned step.
    const file = path.join(tmpDir, ".argent", "flows", "kept.yaml");
    const parsed = parseFlow(await fs.readFile(file, "utf8"));
    parsed.steps = parsed.steps.slice(0, 1);
    await fs.writeFile(file, serializeFlow(parsed), "utf8");

    serveTree(iosRunnerTree([iosLabel("Proceed")]));
    await recordWait("kept", { condition: "visible", selector: { text: "Sign in" } });

    const finished = await flowFinishRecordingTool.execute(
      {},
      { name: "kept", project_root: tmpDir }
    );

    expect([...verdictsIn(finished.summary).keys()]).toEqual([1, 2]);
    expect(finished.message).toContain("2 steps carry a cross-tree warning");
  });

  it("drops the verdict when a delete of a twin puts the length back", async () => {
    // The case a prefix comparison alone cannot see. Step 1 diverges and
    // carries the verdict; step 2 is the byte-identical wait against a tree
    // that DOES hold the element. Delete step 1 and record one more that agrees
    // — the file is two steps long again, so the length says nothing, and the
    // survivor at number 1 renders exactly like the step the verdict judged.
    // Every wait left agreed, so any verdict here convicts an innocent step.
    await startRecording("relen");
    serveTree(iosRunnerTree([iosLabel("Proceed")]));
    await recordWait("relen", { condition: "visible", selector: { text: "Continue" } });
    serveTree(iosRunnerTree([iosLabel("Continue")]));
    await recordWait("relen", { condition: "visible", selector: { text: "Continue" } });

    const file = path.join(tmpDir, ".argent", "flows", "relen.yaml");
    const parsed = parseFlow(await fs.readFile(file, "utf8"));
    parsed.steps = parsed.steps.slice(1);
    await fs.writeFile(file, serializeFlow(parsed), "utf8");

    serveTree(iosRunnerTree([iosLabel("Continue")]));
    await recordWait("relen", { condition: "visible", selector: { text: "Continue" } });

    const finished = await flowFinishRecordingTool.execute(
      {},
      { name: "relen", project_root: tmpDir }
    );

    expect(finished.summary).toHaveLength(2);
    expect(verdictsIn(finished.summary).size).toBe(0);
    expect(finished.message).toContain(
      "1 warning raised during this recording is NOT in `summary`"
    );
  });

  it("drops the verdict when an inserted twin takes the warned step's number", async () => {
    // The same blindness reversed: number 1 holds an inserted copy, never probed.
    await startRecording("grown");
    serveTree(iosRunnerTree([iosLabel("Proceed")]));
    await recordWait("grown", { condition: "visible", selector: { text: "Continue" } });

    const file = path.join(tmpDir, ".argent", "flows", "grown.yaml");
    const parsed = parseFlow(await fs.readFile(file, "utf8"));
    parsed.steps = [parsed.steps[0], parsed.steps[0]];
    await fs.writeFile(file, serializeFlow(parsed), "utf8");

    serveTree(iosRunnerTree([iosLabel("Continue")]));
    await recordWait("grown", { condition: "visible", selector: { text: "Continue" } });

    const finished = await flowFinishRecordingTool.execute(
      {},
      { name: "grown", project_root: tmpDir }
    );

    expect(finished.summary).toHaveLength(3);
    expect(verdictsIn(finished.summary).size).toBe(0);
    expect(finished.message).toContain(
      "1 warning raised during this recording is NOT in `summary`"
    );
  });

  it("records the next step when a hand edit made an earlier one unserializable", async () => {
    // The anchor check renders both views of the prefix, and a cyclic YAML
    // alias — which `parseFlow` accepts inside a step's `args` — has no
    // rendering. Throwing there fails an append that already wrote the step and
    // ran it on the device, so the documented retry duplicates both.
    await startRecording("cyclic");
    serveTree(iosRunnerTree([iosLabel("Proceed")]));
    await recordWait("cyclic", { condition: "visible", selector: { text: "Continue" } });

    // Alias the step's own `args` map back into itself: it cannot be stringified.
    const file = path.join(tmpDir, ".argent", "flows", "cyclic.yaml");
    await fs.writeFile(
      file,
      [
        "steps:",
        "  - tool: await-ui-element",
        "    args: &cyc",
        `      udid: ${IOS}`,
        "      condition: visible",
        "      selector:",
        "        text: Continue",
        "      self: *cyc",
        "executionPrerequisite: on the form",
        "",
      ].join("\n"),
      "utf8"
    );

    const echo = await flowInsertEchoTool.execute(
      {},
      { name: "cyclic", project_root: tmpDir, message: "form submitted" }
    );

    expect(echo.stepCount).toBe(2);
    expect((await recordedSteps("cyclic")).map((s) => s.kind)).toEqual(["tool", "echo"]);

    // The edited step cannot be vouched for, so its verdict goes.
    const finished = await flowFinishRecordingTool.execute(
      {},
      { name: "cyclic", project_root: tmpDir }
    );
    expect(verdictsIn(finished.summary).size).toBe(0);
    expect(finished.message).toContain(
      "1 warning raised during this recording is NOT in `summary`"
    );
  });

  // ── Cancellation ─────────────────────────────────────────────────────────

  it("keeps the step when the run is cancelled during the re-probe", async () => {
    // The mock ignores the signal, so the abort lands AFTER the recorded tool ran.
    await startRecording("cancel");
    const controller = new AbortController();
    controller.abort();

    const result = await recordWait(
      "cancel",
      { condition: "visible", selector: { text: "Continue" } },
      { signal: controller.signal }
    );

    const warning = warningOf(result, "cancel");
    expect(warning).toContain("re-probe against the tree the RUNNER reads was cancelled");
    // Nothing was compared, so the verdict is unknown — not a divergence.
    expect(warning).toContain("UNKNOWN, not known-bad");
    expect(warning).not.toContain("does NOT hold");
    expect(await recordedSteps("cancel")).toHaveLength(1);
    // ZERO reads. The caller's signal must reach the POLL LOOP, not just the
    // wait for it: `waitForCondition` tests it before its first fetch, so an
    // already-cancelled call must never touch the device. Dropping `ctx.signal`
    // would let `settleWithin` report the abort while the loop still reads.
    expect(fetchCount).toBe(0);
  });

  it("aborts mid-probe in band rather than as a tool failure", async () => {
    // The abort arrives while the probe polls. A throw there loses the step.
    const controller = new AbortController();
    fetchRunnerTree = async () => {
      controller.abort();
      throw new Error("cancelled mid-read");
    };
    await startRecording("cancelmid");

    const result = await recordWait(
      "cancelmid",
      { condition: "visible", selector: { text: "Continue" } },
      { signal: controller.signal }
    );

    expect(warningOf(result, "cancelmid")).toContain("was cancelled before it answered");
    expect(await recordedSteps("cancelmid")).toHaveLength(1);
  });

  // Why the clause tables carry no `ios-remote` arm: a remote sim never reaches
  // the probe. `await-ui-element` declares no appleRemote capability, so
  // assertSupported throws while the step is still executing live. If that
  // capability is ever added, both tables need an ios-remote arm — the
  // AX-vs-full-hierarchy story, not the generic fallback.
  it("cannot be reached on ios-remote: await-ui-element refuses the device", () => {
    const tool = createAwaitUiElementTool(registryWhereWaitSucceeds());
    expect(tool.capability?.appleRemote).toBeUndefined();
    expect(() =>
      assertSupported("await-ui-element", tool.capability, resolveDevice(`remote:${IOS}`))
    ).toThrow(/not supported on ios-remote/);
  });
});

// `command` names an MCP tool, but the vocabulary an author has in mind
// while recording is the flow file's own directives, so `command: "echo"`
// used to come back as a bare "Tool not found".
describe("a flow-directive name points at the tool that records it", () => {
  beforeEach(async () => {
    await flowStartRecordingTool.execute(
      {},
      { name: "hints", project_root: tmpDir, executionPrerequisite: "anywhere" }
    );
  });

  const hint = async (command: string) => {
    const tool = createFlowAddStepTool(registryWhereWaitSucceeds());
    return tool.execute({}, { name: "hints", project_root: tmpDir, command });
  };

  it("answers EVERY directive the parser accepts, or lists it as deliberately unanswered", async () => {
    // Every name the parser accepts must be answered or exempted on purpose:
    // one left out answers with the bare "Tool not found" this feature exists
    // to replace. Held against the parser's own registry rather than a copy, so
    // a directive added there cannot slip through.
    const unanswered = STEP_DIRECTIVE_KEYS.filter((key) => directiveCommandHint(key) === undefined);
    expect([...unanswered].sort()).toEqual([...UNHINTED_DIRECTIVE_KEYS].sort());
  });

  it("names no tool for the directives that have none, and says what to do instead", async () => {
    // Five directives have no recording tool, each for its own reason, and an
    // author who is told to "call X" for one of them goes looking for a tool
    // that does not exist.
    const cases: [string, string][] = [
      ["wait", "a fixed sleep is not a readiness signal"],
      ["long-press", "there is no gesture-long-press"],
      ["scroll-to", "it SEARCHES"],
      ["snapshot", "compares the screen against a stored baseline"],
      ["when", "it GUARDS the steps nested under it"],
    ];
    for (const [command, why] of cases) {
      const result = await hint(command);
      expect(result.message, command).toContain("is a flow directive, not a tool");
      expect(result.message, command).toContain("records one");
      expect(result.message, command).toContain(why);
      // No "Record it by calling `X` through flow-add-step" — that sentence
      // is the table's, and following it here sends the author after a tool
      // that does not exist.
      expect(result.message, command).not.toContain("Record it by calling");
      expect(result.message, command).toContain("no step was recorded");
      expect(result.stepCount, command).toBe(0);
    }
    expect(await recordedSteps("hints")).toEqual([]);
  });

  it("names gesture-pinch for `pinch`, stored raw", async () => {
    const result = await hint("pinch");
    expect(result.message).toContain("gesture-pinch");
    expect(result.message).toContain("stored as a raw `tool: gesture-pinch` step");
    expect(result.stepCount).toBe(0);
  });

  it("names flow-add-echo for `echo`", async () => {
    const result = await hint("echo");
    expect(result.message).toContain("flow-add-echo");
    expect(result.message).toContain("no step was recorded");
  });

  it("explains that `wait` has no recording tool at all", async () => {
    const result = await hint("wait");
    expect(result.message).toContain("a fixed sleep is not a readiness signal");
    expect(result.message).toContain("await-ui-element");
  });

  it("names restart-app for `launch`", async () => {
    expect((await hint("launch")).message).toContain("restart-app");
  });

  // Routing `echo` through flow-add-step appends TWO steps: flow-add-echo
  // writes its own directive, and flow-add-step records a raw
  // `tool: flow-add-echo` step that errors on every replay, since no recording
  // is open then. Both report success.
  it("refuses a recorder tool as `command` instead of nesting it", async () => {
    const tool = createFlowAddStepTool(registryWhereWaitSucceeds());
    for (const command of [
      "flow-add-echo",
      "flow-add-step",
      "flow-start-recording",
      "flow-finish-recording",
    ]) {
      const result = await tool.execute(
        {},
        { name: "hints", project_root: tmpDir, command, args: "{}" }
      );
      expect(result.message, command).toContain("no step was recorded");
      expect(result.stepCount, command).toBe(0);
    }
    expect(await recordedSteps("hints")).toEqual([]);
  });

  it("gives each refused recorder tool ITS OWN reason", async () => {
    // The `command` `.describe()` promises the four are refused "each for its
    // own reason", so the per-entry text IS the contract. Without a content
    // assertion per entry, exchanging the `flow-start-recording` and
    // `flow-finish-recording` bodies passes while an author is told that
    // finishing truncates and starting ends the take.
    const tool = createFlowAddStepTool(registryWhereWaitSucceeds());
    const reasons: [string, string[], string[]][] = [
      [
        "flow-add-echo",
        ["must be called DIRECTLY", "fails on every replay"],
        ["truncates", "ends the recording"],
      ],
      ["flow-add-step", ["cannot record itself"], ["truncates", "ends the recording"]],
      ["flow-start-recording", ["truncates the flow it names", "erase"], ["ends the recording"]],
      [
        "flow-finish-recording",
        ["ends the recording", "cannot also be a step in it"],
        ["truncates"],
      ],
    ];
    for (const [command, present, absent] of reasons) {
      const result = await tool.execute(
        {},
        { name: "hints", project_root: tmpDir, command, args: "{}" }
      );
      for (const fragment of present) {
        expect(result.message, `${command} should say "${fragment}"`).toContain(fragment);
      }
      for (const fragment of absent) {
        expect(result.message, `${command} should not say "${fragment}"`).not.toContain(fragment);
      }
    }
    expect(await recordedSteps("hints")).toEqual([]);
  });

  it("refuses a recorder tool BEFORE parsing `args`, so malformed `args` cannot pre-empt the guidance", async () => {
    // The guard runs ahead of `JSON.parse(params.args)` on purpose: a nested
    // recorder tool must be refused even when `args` is malformed, or a bare
    // SyntaxError replaces the guidance. Every other test passes valid `args`,
    // so only this one catches a guard moved after the parse.
    const tool = createFlowAddStepTool(registryWhereWaitSucceeds());
    const result = await tool.execute(
      {},
      { name: "hints", project_root: tmpDir, command: "flow-add-echo", args: "{not valid json" }
    );
    expect(result.message).toContain("must be called DIRECTLY");
    expect(result.message).toContain("no step was recorded");
    expect(result.stepCount).toBe(0);
    expect(await recordedSteps("hints")).toEqual([]);
  });

  it("still answers a directive name when `args` is malformed", async () => {
    // The hint fires from the sub-invoke catch, which a JSON syntax error never
    // reaches. An author who wrote `command: "echo"` needs to hear that echo is
    // a directive, not that a payload which was never going to run is
    // unparseable.
    const tool = createFlowAddStepTool(registryWhereWaitSucceeds());
    for (const command of ["echo", "wait", "tap", "run"]) {
      const result = await tool.execute(
        {},
        { name: "hints", project_root: tmpDir, command, args: "{not json" }
      );
      expect(result.message, command).toContain("is a flow directive");
      expect(result.message, command).toContain("no step was recorded");
      expect(result.stepCount, command).toBe(0);
    }
    expect(await recordedSteps("hints")).toEqual([]);
  });

  it("lets a REGISTERED command's malformed `args` fail as the syntax error it is", async () => {
    // The gate is the registry, not the hint table: a command the registry
    // knows is not a directive the author misspelled, whatever it is named, so
    // its unparseable payload must surface as itself.
    const registryWhereTapIsRegistered = {
      invokeTool: vi.fn(async () => ({ ok: true })),
      getTool: vi.fn((id: string) => (id === "tap" ? ({ id } as never) : undefined)),
    } as unknown as Registry;
    const tool = createFlowAddStepTool(registryWhereTapIsRegistered);
    await expect(
      tool.execute({}, { name: "hints", project_root: tmpDir, command: "tap", args: "{not json" })
    ).rejects.toThrow(SyntaxError);
    expect(await recordedSteps("hints")).toEqual([]);
  });

  it("reports the step count as the hand-edited file now stands, not the stale snapshot", async () => {
    // Host mode re-reads the flow on the record-nothing paths so a
    // mid-recording hand edit reaches the count they report. The failure half
    // below expects 0, which matches the in-memory snapshot with or without the
    // refresh — so only this test catches a dropped
    // `session.flow = parseFlow(...)`.
    const tool = createFlowAddStepTool(registryWhereWaitSucceeds());
    const flowPath = path.join(tmpDir, ".argent", "flows", "hints.yaml");

    // One recorded step, so the in-memory snapshot is a NON-zero number that
    // differs from what the file will say — a count of 0 either way would not
    // tell the two sources apart.
    await tool.execute(
      {},
      {
        name: "hints",
        project_root: tmpDir,
        command: "gesture-tap",
        args: JSON.stringify({ udid: IOS, x: 0.5, y: 0.5 }),
      }
    );
    expect(await recordedSteps("hints")).toHaveLength(1);

    // The author edits the YAML by hand while the recording is open.
    await fs.writeFile(flowPath, "steps:\n  - echo: one\n  - echo: two\n  - echo: three\n", "utf8");

    const result = await tool.execute(
      {},
      { name: "hints", project_root: tmpDir, command: "echo", args: "{}" }
    );

    expect(result.message).toContain("flow-add-echo");
    expect(result.message).not.toContain("could not be read");
    expect(result.stepCount).toBe(3); // the file, not the snapshot's 1
  });

  it("qualifies the step count when the persisted flow can no longer be read", async () => {
    // When the record-nothing paths' re-read (or parse) fails, the count comes
    // from the last valid in-memory snapshot and must SAY so — otherwise the
    // author reads a confident number for a file that is now broken.
    const tool = createFlowAddStepTool(registryWhereWaitSucceeds());
    await fs.writeFile(
      path.join(tmpDir, ".argent", "flows", "hints.yaml"),
      "steps:\n  - [unclosed",
      "utf8"
    );

    const result = await tool.execute(
      {},
      { name: "hints", project_root: tmpDir, command: "echo", args: "{}" }
    );

    expect(result.message).toContain("flow-add-echo");
    expect(result.message).toContain("The persisted flow could not be read and parsed");
    expect(result.message).toContain("last valid in-memory snapshot");
    expect(result.stepCount).toBe(0);
  });

  it("tells the author to call flow-add-echo directly, not through the recorder", async () => {
    const result = await hint("echo");
    expect(result.message).toContain("DIRECTLY");
    expect(result.message).toContain("fails on every replay");
  });

  it("does not claim a rewrite for the commands the recorder stores raw", async () => {
    // `type`/`await`/`assert` are recorded as `tool:` steps; polish converts
    // them. Promising a rewrite sends the author looking for a directive that
    // is not in the file.
    for (const command of ["type", "await", "assert"]) {
      const result = await hint(command);
      expect(result.message, command).toContain("stored as a raw");
      expect(result.message, command).toContain("polish pass");
    }
    // …while the four that ARE rewritten still say so.
    expect((await hint("launch")).message).toContain("rewrites it into the `launch:` step");
  });

  it("names the TOOL that records each directive the recorder stores raw", async () => {
    // Which tool to call is the one fact these hints exist to convey, and the
    // assertions above hold whichever tool is named — so without this, swapping
    // `type`'s `keyboard` for `await-ui-element` passes while the recorder
    // tells an author to record typing with a wait.
    const named: [string, string][] = [
      ["type", "keyboard"],
      ["await", "await-ui-element"],
      ["assert", "await-ui-element"],
    ];
    for (const [command, tool] of named) {
      const message = (await hint(command)).message;
      expect(message, command).toContain(`Record it by calling \`${tool}\` through flow-add-step`);
      expect(message, command).toContain(`stored as a raw \`tool: ${tool}\` step`);
    }
    // `type` must not be answered with the wait tool, nor the checks with the
    // typing one — the mutation that stayed green was exactly that swap.
    expect((await hint("type")).message).not.toContain("await-ui-element");
    for (const command of ["await", "assert"]) {
      expect((await hint(command)).message, command).not.toContain("`keyboard`");
    }
  });

  it("qualifies a rewrite hint with the delayMs opt-out", async () => {
    // `tap`/`launch`/`run` are rewritten only when the flow-add-step call sets no
    // `delayMs` (a replay delay has no directive form, so the step is kept raw).
    // The hint has to say so, or an author who adds delayMs is promised a `tap:`
    // step the recorder then declines to write.
    const tap = (await hint("tap")).message;
    expect(tap).toContain("rewrites it into the `tap:` step");
    expect(tap).toContain("delayMs");
    expect(tap).toContain("raw `tool: gesture-tap`");
  });

  it("names flow-execute for `run`, with the sibling-flow rewrite condition", async () => {
    // `run` is rewritten into a `run:` step only when its target resolves as a
    // sibling flow; the hint must state that condition (and the delayMs opt-out),
    // or the author is promised a `run:` step the recorder may decline to write.
    const msg = (await hint("run")).message;
    expect(msg).toContain("flow-execute");
    expect(msg).toContain("rewrites it into the `run:` step");
    expect(msg).toContain("sibling flow");
    expect(msg).toContain("delayMs");
    // Three outcomes, not two. "Otherwise the raw step is kept" holds for the
    // name route only: a non-sibling flow_path is refused before anything runs,
    // and a remote recording keeps the raw step whatever the target is.
    expect(msg).toContain("REMOTE");
    expect(msg).toContain("refused outright and records nothing");
  });

  it("lets a genuine tool failure report itself", async () => {
    // "screenshot" is not a directive name, so a not-found for it must surface
    // as the registry's own error rather than being rewritten.
    await expect(hint("screenshot")).rejects.toThrow(/not found/i);
  });

  it("does not rewrite a REGISTERED tool's own 'not found' failure into a directive hint", async () => {
    // The identity check in `isToolNotFound`: a tool that RAN and failed with a
    // message containing "not found" is a ToolExecutionError, not a
    // ToolNotFoundError — so even a command sharing a directive name (`tap`)
    // surfaces its own error. A message-substring check would mask it.
    const registryWhereTapRanAndFailed = {
      invokeTool: vi.fn(async () => {
        throw new ToolExecutionError("tap", "element not found");
      }),
      getTool: vi.fn(() => undefined),
    } as unknown as Registry;
    const tool = createFlowAddStepTool(registryWhereTapRanAndFailed);
    await expect(
      tool.execute({}, { name: "hints", project_root: tmpDir, command: "tap", args: "{}" })
    ).rejects.toThrow(/element not found/);
  });

  it("treats a prototype-member command name as a plain not-found, not a table hit", async () => {
    // `command` is caller-controlled. A value equal to an inherited member
    // (`__proto__`, `constructor`, …) must not read truthy off the directive
    // tables' prototype and refuse the call with a garbage message — it falls
    // through to the ordinary not-found, and records nothing.
    for (const command of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
      await expect(hint(command), command).rejects.toThrow(/not found/i);
    }
    expect(await recordedSteps("hints")).toEqual([]);
  });
});

// A nested flow-execute recorded via the `flow_name` alias must still be
// captured as the portable `run: <name>` directive, not kept as a raw
// `tool: flow-execute` step with a false "had no flow name" warning.
describe("a recorded flow-execute honors the flow_name alias", () => {
  // A registry whose only registered tool is flow-execute, which succeeds — so
  // the recorder reaches `captureRunTarget` (which runs only after the sub-tool
  // returns).
  const registryWhereRunSucceeds = (): Registry =>
    ({
      invokeTool: vi.fn(async (id: string) => {
        if (id === "flow-execute") return { ok: true };
        throw new ToolNotFoundError(id);
      }),
      getTool: vi.fn(() => undefined),
    }) as unknown as Registry;

  const recordRun = async (execArgs: Record<string, unknown>) => {
    const tool = createFlowAddStepTool(registryWhereRunSucceeds());
    return tool.execute(
      {},
      {
        name: "wrapper",
        project_root: tmpDir,
        command: "flow-execute",
        args: JSON.stringify(execArgs),
      }
    );
  };

  beforeEach(async () => {
    // `run:` capture resolves the target against the recording's own flows dir,
    // so the sibling must exist and parse.
    const dir = path.join(tmpDir, ".argent", "flows");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "helper.yaml"), "steps:\n  - echo: hi\n");
    await flowStartRecordingTool.execute({}, { name: "wrapper", project_root: tmpDir });
  });

  it("captures `run: <name>` when the nested call named the flow via flow_name", async () => {
    const result = await recordRun({ flow_name: "helper", project_root: tmpDir, device: IOS });
    expect(result.message).not.toContain("had no flow name");
    const steps = await recordedSteps("wrapper");
    expect(steps).toHaveLength(1);
    expect(steps[0]).toEqual({ kind: "run", flow: "helper.yaml" });
  });

  it("still captures `run: <name>` for the canonical `name` (no regression)", async () => {
    await recordRun({ name: "helper", project_root: tmpDir, device: IOS });
    const steps = await recordedSteps("wrapper");
    expect(steps).toHaveLength(1);
    expect(steps[0]).toEqual({ kind: "run", flow: "helper.yaml" });
  });
});
