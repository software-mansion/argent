import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Registry } from "@argent/registry";
import type { DescribeNode, DescribeTreeData } from "../../src/tools/describe/contract";

// `await-ui-element` evaluates against the agent-facing describe tree; the
// `await:`/`assert:` directive that polish converts the step into is evaluated
// against `fetchFlowTree`'s. On no platform does one contain the other, so a
// check can pass live and fail once converted — which makes "each step is
// executed live so you verify it works before it's recorded" untrue exactly
// where it matters.
//
// These tests serve the RUNNER's tree (what `fetchFlowTree` returns) while the
// await-ui-element tool is stubbed to report success, i.e. the recorder's tree
// agreed. Every runner tree here is built by the REAL per-platform flow adapter
// from a raw payload of that platform's own shape, so the divergence each test
// describes is the one that platform's projection actually produces — not a
// platform label pinned on one shared fixture.

let fetchCount: number;
// The whole fetch is the seam, not just the tree it yields: a test that needs
// the read itself to hang (rather than to throw or to return) replaces this.
// Reset in beforeEach so no test leaks its implementation into the next.
let fetchRunnerTree: () => Promise<DescribeTreeData>;
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
import { createFlowAddStepTool } from "../../src/tools/flows/flow-add-step";
import { __resetRecordingsForTesting, parseFlow } from "../../src/tools/flows/flow-utils";
import { n } from "./harness";

const IOS = "00000000-0000-0000-0000-0000000000ab"; // iOS UDID shape
const ANDROID = "emulator-5554"; // adb-serial shape → classifies android
const CHROMIUM = "chromium-cdp-9222"; // chromium-cdp- prefix → classifies chromium
const VEGA = "amazon-4a27df03c9777152"; // amazon- prefix → classifies vega

const FULL: DescribeNode["frame"] = { x: 0, y: 0, width: 1, height: 1 };
const ROW: DescribeNode["frame"] = { x: 0.1, y: 0.1, width: 0.5, height: 0.05 };

let tmpDir: string;

// ── Runner trees, each through its own platform's real flow adapter ──────────

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

/**
 * One `android-devtools` getHierarchy dump. Both Android sides read THIS —
 * `describe`'s default path and the flow tree are two parses of the same XML,
 * so an Android divergence has to be demonstrated on identical input or it is
 * not a divergence at all.
 */
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

// ── Recording harness ────────────────────────────────────────────────────────

/** A registry whose `await-ui-element` always reports the condition met. */
function registryWhereWaitSucceeds(): Registry {
  return {
    invokeTool: vi.fn(async (id: string) => {
      if (id === "await-ui-element") return { success: true, elapsed: 120 };
      if (id === "gesture-tap") return { tapped: true };
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
        return { success: false, elapsed: 1500, note: "no element matched the selector" };
      }
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

/**
 * The probe's own reason, as the determinate warning quotes it back — the only
 * part of the message carrying screen content, and so the only part the cap
 * governs. Asserting on the whole warning instead measures the fixed prose
 * around it, which moves whenever the explanation is reworded.
 */
function echoedReasonOf(warning: string): string {
  const open = "directives against (";
  const close = "). As the raw";
  const start = warning.indexOf(open);
  const end = warning.indexOf(close);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return warning.slice(start + open.length, end);
}

/**
 * The warning half of `message`, or undefined when there is none.
 *
 * Asserting `message` contains "Step added" proves nothing — that is the
 * unconditional prefix of EVERY message, warnings included — so a regression
 * that nags on every correctly-recorded wait would sail through. Split the
 * prefix off and require the remainder to be absent instead.
 */
function warningOf(result: { message: string }, name: string): string | undefined {
  const prefix = `Step added to "${name}" flow`;
  expect(result.message.startsWith(prefix)).toBe(true);
  const rest = result.message.slice(prefix.length);
  return rest === "" ? undefined : rest.replace(/^ — /, "");
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-cross-tree-"));
  __resetRecordingsForTesting();
  fetchCount = 0;
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
    // The whole recorded artifact, not just its count: a step of the wrong
    // shape (device id left in, condition dropped) would pass a length check.
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
  // The probe re-evaluates the recorded condition with the flow runner's engine
  // (flowFindAll + evaluateCondition, inside waitForCondition); the live wait
  // used await-ui-element's (findAll + evaluateMatches). Nothing else in this
  // file would notice them drifting apart — the tree is mocked and the live
  // tool is stubbed — and if they did, the recorder would warn on every
  // correctly-recorded wait forever while the suite stayed green. So feed the
  // SAME tree to both engines and require them to agree.
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

      // What await-ui-element's OWN evaluator decides about this very tree.
      // The fixture is only meaningful if the live side passes: that is the
      // premise the probe is being asked to confirm.
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

  // ── The live wait itself never held ───────────────────────────────────────
  //
  // `await-ui-element` reports an unmet condition by returning
  // { success: false }, so the recorder's success path records the step. The
  // cross-tree warning must not be attached there: it says the raw step
  // "replays fine — it reads the same tree it just passed against", and this
  // one never passed. At replay an unmet wait fails the step and stops the run.
  it("does not claim a wait that never held replays fine", async () => {
    // The runner's tree AGREES with the selector, so the probe — had it run —
    // would have found nothing to warn about and the step would have been
    // narrated as clean.
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
    // Nothing was compared, so nothing may blame a tree divergence or send the
    // author to re-record against "a selector present in both".
    expect(warning).not.toContain("neither contains the other");
    expect(warning).not.toContain("present in both");
    // "Delete it from the .yaml" holds in host mode only: against a remote
    // client the in-memory copy is authoritative mid-recording and the next
    // append writes the step straight back, with nothing reporting the restore.
    expect(warning).toContain("after `flow-finish-recording`");
    // The probe never ran, so the runner's tree was never read.
    expect(fetchCount).toBe(0);
    // Recording the step anyway is the pre-existing behaviour; only the
    // narration changes.
    expect(await recordedSteps("unmet")).toHaveLength(1);
  });

  // ── The probe is gated on the command ─────────────────────────────────────
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
    // Exactly one read — the tap's own selector capture. A second would mean
    // the cross-tree probe ran on a command that has no condition to re-probe.
    expect(fetchCount).toBe(1);
  });

  // A wait carrying `delayMs` is still a wait: the delay is a replay-time sleep
  // before the step, and says nothing about which tree the condition resolves
  // against. (Contrast the tap and restart-app rewrites, which a delayMs
  // deliberately opts out of.)
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
  // The probe evaluates `args.selector` strictly, as the recorded step carries
  // it. The directive grammar's bare-string sugar is a LOOSE selector, which
  // the runner resolves identifier-first and only falls back to text — so on a
  // screen where some node's id equals the recorded text the two spellings
  // resolve different elements and the verdict flips. These two pin the strict
  // reading and the clause that names it; the skill's polish step prescribes
  // the strict map spelling for the same reason.
  //
  // Both trees below are the live Chromium repro's shape:
  // `<button id="Continue">Proceed</button>`.
  const CONTINUE_BUTTON = () =>
    chromiumRunnerTree([
      n({ role: "button", identifier: "Continue", value: "Proceed", frame: ROW, children: [] }),
    ]);

  it("judges the recorded selector strictly, not as the loose bare string", async () => {
    const tree = CONTINUE_BUTTON();
    serveTree(tree, "cdp-dom");

    // The premise: the two spellings really do disagree on this tree. The
    // identifier pass — the bare string's FIRST alternative — matches the
    // button, while the strict `text` the step recorded matches nothing.
    expect(findAll(tree, { identifier: "Continue" })).toHaveLength(1);
    expect(findAll(tree, { text: "Continue" })).toHaveLength(0);

    await startRecording("strictclean");
    const result = await recordWait("strictclean", {
      udid: CHROMIUM,
      condition: "hidden",
      selector: { text: "Continue" },
    });

    // Strict reading: nothing matches `text=Continue`, so `hidden` holds and
    // there is nothing to warn about. Were the probe to adopt the bare
    // string's loose fallback it would find the button and warn here — and
    // then be wrong about the spelling the skill prescribes.
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
    // Without this clause the author converts to `{ visible: Continue }`, whose
    // identifier pass resolves the button — a check the probe never made.
    expect(warning).toContain("convert it in the strict map spelling");
    expect(warning).toContain("re-parses as a LOOSE selector");
  });

  // ── The `text` comparator the recorded step does NOT carry ───────────────
  //
  // `await-ui-element` compares with `contains` unless the step passed
  // `textMatch: equals`, and the recorded YAML omits the field entirely when it
  // was defaulted — while the `text:` directive has no default and forces the
  // author to pick one. So the comparator is a polish-time decision the
  // artifact does not record, and picking the other one fails on the very
  // screen the probe approved. Pin both readings of one tree: the skill's
  // conversion rule (no `textMatch` ⇒ `contains:`) is only sound while they
  // differ this way.
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
    // Same tree, same expectedText — only the comparator differs, and it flips
    // the verdict. That is exactly the trap when polish converts a defaulted
    // step to the `equals:` spelling.
    expect(warningOf(exact, "textequals")).toContain('its text was "Total: $5.00"');
  });

  // ── Per-platform divergences, each produced by that platform's adapter ────

  // iOS: an `accessible` container. The AX tree the recorder read merges it
  // into ONE leaf whose label aggregates its children — this repo says so in
  // `captureTapSelector`'s own comment ("the AX tree collapses an `accessible`
  // container into one leaf whose merged label exists on no single view in the
  // replay hierarchy") and the skill names it as the iOS divergence. So the
  // author records the merged string and it resolves nothing for the runner:
  // the flow projection keeps the container as an addressable leaf and hoists
  // the children's text into `subtreeText`, which `findAll` does not match on.
  //
  // This test USED to serve an `alpha: 0` view, on the premise that the AX tree
  // still reports a fully transparent one. UIKit generally excludes hidden and
  // transparent views from accessibility, and nothing in this repo re-adds
  // them, so that premise is a device question the suite cannot settle — while
  // the merge above is settled by the sources on both sides. (The adapter rule
  // it was reaching for is asserted directly below, as what it is: a statement
  // about the projection, not about a divergence.)
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
    // The premise on the runner's side: the merged string names no node, even
    // though the container is present and carries the pieces as hoisted text.
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
    // that conversion exactly — but only on the branch where the two trees
    // really differ, which is this fixture (the merged label names no node in a
    // hierarchy nothing changed). The consequence is stated conditionally
    // because the same verdict also comes back from a screen that merely moved
    // on, where the conversion is fine; an `await:` polls longer, so it carries
    // the extra escape hatch on top.
    expect(warning).toContain(
      "if the trees really do differ over this element, an `assert:` conversion fails the same way"
    );
    expect(warning).toContain("an `await:` does too unless the element reaches that tree");
    expect(warning).toContain(
      "if the SCREEN simply moved on since the live wait, this verdict is no evidence"
    );
    expect(warning).not.toContain("WILL fail");
    // iOS must NOT be told a tool "reads the runner's side": the Apple-only
    // full-hierarchy readers return the RAW view tree — both UILabels included,
    // and still no view carrying the merged label — and they match
    // identifier/label/className exactly, while a recorded selector's
    // `text`/`role` are substrings.
    expect(warning).toContain("No read-only tool reports the runner's projection on iOS");
    // Nor may it answer "re-record". The skill's own workflow for a testID the
    // trimmed tree hides is to gate on visible text and retarget the id at
    // polish — which is what PRODUCES this divergence — so sending the author
    // back to the recorder asks for the step the skill just said cannot be
    // recorded live, and lands them on the unmet-wait warning instead.
    expect(warning).not.toContain("re-record");
    expect(warning).toContain("retarget the DIRECTIVE at an `id` the full hierarchy carries");
    expect(await recordedSteps("ios")).toHaveLength(1);
  });

  // The projection rule the transparent-view fixture was reaching for, asserted
  // as what it actually is. Whether the AX tree still reports an `alpha: 0`
  // view — and so whether this rule ever produces a cross-tree divergence — is
  // a device question; that the runner's projection drops one is not.
  it("iOS: the runner's projection drops a transparent view", () => {
    expect(findAll(iosRunnerTree([iosLabel("Continue")]), { text: "Continue" })).toHaveLength(1);
    expect(
      findAll(iosRunnerTree([iosLabel("Continue", { alpha: 0 })]), { text: "Continue" })
    ).toHaveLength(0);
  });

  // What the longer `await:` timeout would be waiting FOR is per condition, and
  // on `hidden` it is the opposite event: the wait passes when the element
  // LEAVES. Saying "unless the element reaches that tree" there describes the
  // one outcome that would keep it failing.
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
  });

  // Android: a testID'd label inside a testID'd clickable row — an everyday RN
  // `Pressable testID` wrapping a `Text testID`.
  //
  // The TRIM collapses the pair: the row is clickable with no own label, so it
  // BORROWS its descendant's text and the inner TextView disappears into it —
  // `describe` shows one node, `id=continue-row label="Continue"`. The FLOW
  // parse keeps both, and the inner node's own resource-id SHIELDS its text
  // from hoisting, so the row reaches the runner carrying no text at all. A
  // `text` check on the row therefore holds live and not for the runner.
  //
  // This test USED to model the target inside a `com.android.systemui` node.
  // That divergence cannot occur: both parses drop system chrome (the flow
  // adapter's `isSystemChrome`, the trim's `!opts.includeSystem && isSystemChrome`),
  // so the live wait would have failed too and the recorder would have reported
  // the unmet-wait warning instead. It only went green because the live tool is
  // stubbed to succeed — it pinned the Android wording and proved nothing about
  // Android.
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

    // The premise, on the same dump: the LIVE side really does pass. Without
    // this the fixture only proves the stub returns success.
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
    // The reader clause is its own sentence after the divergence sentence's
    // period, so it must start capitalized — not "…first. no read-only…".
    expect(warning).toContain(
      "first. No read-only tool exposes the runner's full hierarchy on Android"
    );
    // No tree story rules out the screen having moved on between the live wait
    // and the re-probe, so every platform's must say so.
    expect(warning).toContain("changed between the live wait and this re-probe");
    expect(warning).not.toContain("native-find-views");
    expect(await recordedSteps("android")).toHaveLength(1);
  });

  // Chromium: `projectChromiumNode` drops a node with no on-screen frame, and
  // the walker clamps an off-viewport element's frame to zero area. `describe`
  // still lists it — so `exists` holds live and not for the runner.
  it("Chromium: warns when the runner's projection drops an off-viewport node", async () => {
    serveTree(
      chromiumRunnerTree([
        // Addressable by id AND by text — the node is dropped purely for having
        // no on-screen frame, so the message must not blame the selector.
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

    // `projectChromiumNode` keeps a node only when it is onScreen AND
    // addressable. Naming addressability alone reads as a verdict on the
    // selector, and sends an author whose element is merely below the fold
    // hunting for an id it already carries.
    expect(warning).toContain("addressable nodes");
    expect(warning).toContain("clamp");
    expect(warning).toContain("off-viewport");
    expect(warning).toContain("`scroll-to` before the check rather than a different selector");

    expect(warning).toContain("does NOT hold against the tree the runner resolves");
    // Capitalized, as its own sentence after the divergence sentence's period.
    expect(warning).toContain(
      "first. No read-only tool exposes the runner's trimmed tree on Chromium"
    );
    expect(warning).not.toContain("native-find-views");
    expect(await recordedSteps("chromium")).toHaveLength(1);
  });

  // Chromium, the OTHER direction: a node the runner KEEPS. `projectChromiumNode`
  // redacts a password leaf's name to `[password]`, so the element reaches the
  // runner (an `id` selector resolves it) while no text/label selector ever can.
  // A message that only knows how to say "the runner dropped it" is false here in
  // both halves, and its "re-record with a text or label" remedy is unreachable
  // by construction.
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

    // The premise, straight off the real adapter: the node is present and
    // addressable by id, and its name is the redaction — not the placeholder
    // `describe` shows.
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
    // The verdict is right; the explanation must not be the one cause that is
    // provably not what happened here.
    expect(warning).not.toContain("never reaches the runner");
    expect(warning).toContain("`[password]`");
    expect(warning).toContain("only an `id`/`role` selector");
    // Nor may it promise `describe` is a superset the author can read the
    // runner's side off: past its shorter walk it omits nodes the runner keeps.
    expect(warning).not.toContain("full DOM the recorder read");
    expect(warning).toContain("omits nodes the runner keeps");
  });

  // Vega is the one platform whose runner tree CANNOT disagree on an unchanged
  // screen: `projectVegaNode` skips nothing and emits every node as a leaf, so
  // membership, frames and visibility are identical, and the only edit is a
  // hoisted `subtreeText` — which `evaluateCondition` treats as additional
  // evidence beside a node's own text, never as a replacement. The two
  // assertions below pin both halves: the hoist never flips a passing check,
  // and when a warning does fire the message blames the screen, not the trees.
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

    // The container's hoisted text is strictly longer than its own — the
    // divergence the earlier wording claimed could break an `equals`.
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
    // The only way a Vega probe disagrees: the screen moved on between the
    // live wait and the re-probe.
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
    expect(warning).toContain("the SCREEN changed between the live wait and this re-probe");
    expect(warning).toContain("`describe` reads the same source the runner does");
    expect(warning).not.toContain("different projections of the screen");
    // Vega is where an absolute consequence is most plainly wrong: the arm
    // below states outright that a disagreement here MEANS the screen changed,
    // and on that cause the conversion passes. So the conversion clause may not
    // decide against it — it has to leave the verdict to the cause.
    expect(warning).not.toContain("WILL fail");
    expect(warning).toContain(
      "if the SCREEN simply moved on since the live wait, this verdict is no evidence"
    );
    // The other three platforms' imperative. Here the selector is fine and the
    // screen is what moved, so nothing may send the author to rewrite it.
    expect(warning).not.toContain("retarget the DIRECTIVE");
    expect(warning).not.toContain("re-record with a selector");
    expect(warning).toContain("re-run the wait");
    expect(await recordedSteps("vega")).toHaveLength(1);
  });

  // Each platform's remedy must be its own. Pinning them only by "does this
  // string appear" lets a reworded clause collapse two platforms onto one
  // wording while every negative assertion above still passes.
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
    // And none of them may fall through to the unreachable-platform fallback.
    for (const warning of warnings.values()) {
      expect(warning).not.toContain("on this platform — keep the step raw");
    }
  }, 15_000);

  // ── Indeterminate: unknown must never be dressed up as a verdict ──────────

  it("records with a warning when the runner's tree cannot be read at all", async () => {
    // The injection-free case: the runner's tree source is unavailable on this
    // device. Indeterminate is not a verdict, so refusing here would block a
    // form the skill explicitly sanctions.
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
    // Its own rule: nothing was compared, so nothing may claim the two trees
    // differ — nor append the remedy that follows from a comparison.
    expect(warning).not.toContain("neither contains the other");
    expect(warning).not.toContain("No read-only tool");
    expect(warning).not.toContain("re-record");
    expect(await recordedSteps("blind")).toHaveLength(1);
  });

  // "the accessibility tree" is the recorder's tree only on iOS and Android. On
  // Chromium the recorder read the CDP DOM and on Vega the toolkit page source,
  // so the indeterminate message must name the READER, not a tree source
  // neither side touched.
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
  });

  // `probeWhenCondition` budgets its POLL LOOP at the 1s assert grace, but each
  // tree read inside it is awaited unbounded and the clock is only checked
  // between reads — so a slow source (10s on Chromium CDP, up to the Android
  // devtools RPC's 15s `getHierarchy` bound) stalls the recorder far past the
  // window the warning advertises. The probe must be ceilinged, and an overrun
  // reported as indeterminate rather than as a verdict.
  it("gives up on a tree read that outruns the probe budget, and stops it", async () => {
    // A read the test holds open past the ceiling and then releases — the shape
    // that exposes what "giving up" has to mean. A read that NEVER settles
    // would prove the bound and nothing else: the loop stays parked on it, so
    // it could not have issued a second read whether or not it was stopped.
    let releaseRead: () => void = () => {};
    const readLanded = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    fetchRunnerTree = async () => {
      await readLanded;
      // A tree that does NOT satisfy the condition. One that did would end the
      // loop on the spot and prove nothing: the post-deadline read only fires
      // when the read that landed left the condition unmet.
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
    expect(warning).toContain("did not answer within");
    // Never a verdict: nothing was compared, so the conversion is UNKNOWN.
    expect(warning).not.toContain("does NOT hold");
    // The ceiling is 4s; anything near a full Chromium (10s) or Android
    // devtools (15s) read means the bound is not holding. The timeout below is
    // the only generous one in the file, and only because this test waits out
    // that ceiling on purpose.
    expect(elapsed).toBeLessThan(6000);
    expect(await recordedSteps("slow")).toHaveLength(1);
    expect(fetchCount).toBe(1);

    // Now let the abandoned read land. Past its own deadline the poll loop
    // takes one more full read (`finalPoll`) unless it has been stopped — which
    // would put a second device read behind whatever step the recorder runs
    // next, relocating the stall the ceiling exists to remove instead of
    // removing it.
    releaseRead();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fetchCount).toBe(1);
  }, 15_000);

  // A `text` reason quotes the matched element's rendered content, and on the
  // flow tree that content is HOISTED — a container carries every descendant's
  // text, space-joined. Unbounded, one failed check can paste a whole log pane
  // into the tool result the agent reads in full. Before this branch a recorded
  // wait's message carried no screen content at all.
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
    // Enough of the text to be actionable, not the whole screen.
    expect(warning).toContain("Lorem ipsum");
    // Bound the ECHOED REASON, not the whole message: the fixed prose around it
    // is longer than this fixture, so `warning.length < wall.length` passes or
    // fails on how much explanation the message carries and says nothing about
    // the cap. Pin the cap itself — 200 chars kept, split head/tail — so raising
    // the constant fails here.
    const echoed = echoedReasonOf(warning);
    const [head, tail] = echoed.split(/… \(\d+ more chars\) …/);
    expect(head).toHaveLength(140);
    expect(tail).toHaveLength(60);
  });

  // The cap only ever ELIDES THE MIDDLE, because `waitForCondition` puts the
  // note recording that its final poll went dark at the END of the reason —
  // and that note qualifies the very verdict the warning is built on. Head-only
  // truncation dropped it silently.
  it("keeps the tail of an over-long reason, where the final-poll note lives", async () => {
    const wall = "Lorem ipsum dolor sit amet ".repeat(60);
    // Trusted reads that leave the condition false right up to the deadline,
    // then a source that dies on the last poll. That is the blip tier: the dark
    // tail is inside CONDITION_DARK_TAIL_TOLERANCE_MS, so the verdict stays
    // determinate and `waitForCondition` appends the failed final read to the
    // reason rather than discarding the window.
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

    expect(warning).toContain("does NOT hold against the tree the runner resolves");
    expect(warning).toContain("Lorem ipsum");
    expect(warning).toContain("more chars)");
    // The note the head-only cap threw away.
    expect(warning).toContain("native devtools went away");
  });

  // Two boundary cases the "wall of text" fixture cannot reach.
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
    // An environment error carries no screen content, and its TAIL is the
    // recovery instruction — the case where a cap costs the reader the fix.
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

  // ── Cancellation ─────────────────────────────────────────────────────────

  it("throws AbortError when the run is cancelled during the re-probe", async () => {
    // The live await-ui-element still "passes" (the mock ignores the signal), so
    // the abort lands in the re-probe — strictly after the recorded tool ran.
    // The probe must surface that as an abort and record nothing.
    await startRecording("cancel");
    const controller = new AbortController();
    controller.abort();

    await expect(
      recordWait(
        "cancel",
        { condition: "visible", selector: { text: "Continue" } },
        { signal: controller.signal }
      )
    ).rejects.toThrow(/aborted while re-probing/);

    // The abort fired before the append, so the flow still has no steps.
    expect(await recordedSteps("cancel")).toHaveLength(0);
  });

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
      assertSupported("await-ui-element", tool.capability, resolveDevice(`remote:${IOS}`))
    ).toThrow(/not supported on ios-remote/);
  });
});
