/**
 * The failure taxonomy, proven from both ends.
 *
 * 1. `FLOW_FAILURE_CATEGORY` is TOTAL over `FlowFailureCode` and carries no
 *    extra keys, and `determinacyOf` marks exactly the tier that means "argent
 *    could not see the screen" (a CI operator reads that to decide retry vs.
 *    fix, so it must not drift).
 * 2. Every code is actually PRODUCED by the site that owns it — driven through
 *    the real runner rather than asserted against the constant, because a code
 *    that no site emits is a renderer branch that never runs.
 * 3. `failure.message` is byte-identical to `StepReport.reason` on every one of
 *    those runs. That is the whole wire-compat guarantee: a renderer that
 *    ignores `failure` prints exactly what it printed before.
 * 4. At most ONE step per run carries `failure` (the runner hard-stops at the
 *    first non-passing leaf), so the capture cost is per RUN, not per step.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { DeviceInfo, Registry } from "@argent/registry";
import type { DescribeNode, DescribeTreeData } from "../../src/tools/describe/contract";

// Serve the flow tree directly (flows hard-fail rather than degrade to the AX
// tree) so each test can script exactly what the failing step saw.
let currentFetch: () => DescribeTreeData | Promise<DescribeTreeData>;
vi.mock("../../src/tools/flows/flow-tree", () => ({
  fetchFlowTree: vi.fn(async (): Promise<DescribeTreeData> => currentFetch()),
}));

import { createRunFlowTool, type FlowRunResult } from "../../src/tools/flows/flow-run";
import {
  runDirective,
  type ActionEnv,
  type DirectiveStep,
} from "../../src/tools/flows/flow-actions";
import {
  attachFailureDiagnostics,
  type LeafOutcome,
} from "../../src/tools/flows/flow-failure-report";
import { serializeFlow } from "../../src/tools/flows/flow-utils";
import {
  determinacyOf,
  FLOW_FAILURE_CATEGORY,
  type FlowFailureCategory,
  type FlowFailureCode,
  type FlowStepFailure,
} from "../../src/tools/flows/flow-failure";

const DEVICE = "00000000-0000-0000-0000-0000000000ab"; // iOS UDID shape
const VEGA_DEVICE = "amazon-4a27df03c9777152"; // Vega serial shape
let tmpDir: string;

function n(partial: Partial<DescribeNode> & { frame: DescribeNode["frame"] }): DescribeNode {
  return { role: "AXOther", children: [], ...partial };
}

function screen(children: DescribeNode[]): DescribeNode {
  return n({ role: "AXWindow", frame: { x: 0, y: 0, width: 1, height: 1 }, children });
}

const HOME: DescribeTreeData = {
  tree: screen([n({ label: "Home", frame: { x: 0, y: 0, width: 1, height: 0.1 } })]),
  source: "native-devtools",
};

/**
 * `onInvoke` scripts one tool: return a value to override the default
 * `{ ok: true }`, or throw to make the sub-tool reject.
 */
function mockRegistry(onInvoke?: (id: string, args: Record<string, unknown>) => unknown): Registry {
  return {
    invokeTool: vi.fn(async (id: string, args: Record<string, unknown> = {}) => {
      if (id === "list-devices") return { devices: [] };
      const scripted = onInvoke?.(id, args);
      return scripted === undefined ? { ok: true } : scripted;
    }),
    getTool: vi.fn(() => ({ inputSchema: { properties: { udid: {} } } })),
  } as unknown as Registry;
}

async function writeFlow(name: string, flow: Parameters<typeof serializeFlow>[0]): Promise<void> {
  const dir = path.join(tmpDir, ".argent", "flows");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${name}.yaml`), serializeFlow(flow), "utf8");
}

async function run(
  name: string,
  opts: { device?: string; registry?: Registry; deviceless?: boolean } = {}
): Promise<FlowRunResult> {
  const tool = createRunFlowTool(opts.registry ?? mockRegistry());
  const result = await tool.execute(
    {},
    {
      name,
      project_root: tmpDir,
      // `deviceless` omits the key entirely — a flow that touches no device
      // resolves to none, which is a distinct state from "a device was named".
      ...(opts.deviceless ? {} : { device: opts.device ?? DEVICE }),
    }
  );
  if (!("steps" in result)) throw new Error(`expected a run result, got notice: ${result.notice}`);
  return result;
}

/**
 * The single failure a run may carry, with the invariants every failure shares
 * asserted on the way through — so each code test below re-proves them for free:
 *
 * - exactly one step carries `failure` (the one-failure-per-run invariant);
 * - `failure.message` is byte-identical to that step's `reason`;
 * - `category` and `determinacy` agree with the taxonomy's own derivation.
 */
function singleFailure(result: FlowRunResult): FlowStepFailure {
  const carrying = result.steps.filter((s) => s.failure !== undefined);
  expect(
    carrying.map((s) => `${s.index}:${s.kind}:${s.status}`),
    "exactly one step per run may carry failure diagnostics"
  ).toHaveLength(1);
  const step = carrying[0]!;
  const failure = step.failure!;
  expect(failure.version).toBe(1);
  expect(failure.message).toBe(step.reason);
  expect(Buffer.from(failure.message, "utf8").equals(Buffer.from(step.reason ?? "", "utf8"))).toBe(
    true
  );
  expect(failure.category).toBe(FLOW_FAILURE_CATEGORY[failure.code]);
  expect(failure.determinacy).toBe(determinacyOf(failure.code));
  return failure;
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-failure-taxonomy-"));
  currentFetch = () => HOME;
});
afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ── The map itself ─────────────────────────────────────────────────────────

/**
 * Hand-written, deliberately: `Record<FlowFailureCode, …>` already makes a code
 * without a category a COMPILE error, so the only remaining hole is a code
 * added to both the union and the map with no site producing it and no test
 * naming it. Cross-checking the map's keys against this list closes the first
 * half: a new code fails here until it is listed.
 *
 * The second half — every code DRIVEN from a real run — is the individual
 * tests below, plus one code driven from a sibling file. Exactly ONE member is
 * a defensive branch no fixture can produce honestly:
 *
 * - `step-kind-unsupported` is `execLeafStep`'s `default:` arm, and every
 *   `FlowStep` kind has a case. It exists so a step kind added to the parser
 *   and not to the runner fails loudly instead of silently. (The device-free
 *   guard in `execSteps` reports it too, and is unreachable for the same
 *   reason: it and the run-level decision share `stepRequiresDevice`.)
 *
 * `gesture-geometry-unsatisfiable` used to be listed here as a second one, on
 * the reasoning that it needs a pinch whose finger travel rounds to EXACTLY
 * zero on both axes. That is true of the PINCH arm — but the code has a second
 * production site, the rotate arm, which needs only a target with no fitting
 * on-screen orbit, and `flow-rotate.test.ts` already drives it.
 *
 * Say so here rather than leave the claim standing: a comment that promises
 * coverage the file does not have is worse than the gap it hides — and one
 * that claims a gap the suite does not have sends the next reader looking for
 * a fixture that already exists.
 */
const ALL_CODES: FlowFailureCode[] = [
  "selector-not-found",
  "selector-not-visible",
  "selector-scope-unresolved",
  "target-missing",
  "assert-hidden-unmet",
  "text-mismatch",
  "text-no-match",
  "condition-never-readable",
  "condition-hidden-unconfirmable",
  "condition-dark-tail",
  "when-guard-indeterminate",
  "scroll-target-not-found",
  "scroll-container-not-visible",
  "gesture-geometry-unsatisfiable",
  "directive-unsupported",
  "launch-failed",
  "tree-source-not-ready",
  "tree-source-unavailable",
  "run-cyclic",
  "run-depth-exceeded",
  "run-fragment-load-failed",
  "snapshot-diff",
  "snapshot-baseline-missing",
  "snapshot-dimension-mismatch",
  "snapshot-crop-empty",
  "tool-ui-wait-unmet",
  "tool-step-failed",
  "directive-threw",
  "step-kind-unsupported",
  "unclassified",
];

const CATEGORIES: FlowFailureCategory[] = [
  "selector",
  "assertion",
  "indeterminate",
  "scroll",
  "gesture",
  "snapshot",
  "launch",
  "environment",
  "composition",
  "tool",
];

/**
 * The tier that means "the check could not be evaluated", not "the check
 * failed". Note it is NOT the same set as the `indeterminate` CATEGORY: the two
 * tree-source codes are categorized as `environment` but are just as
 * unevaluable, and folding them in is what lets CI branch on determinacy alone.
 */
const INDETERMINATE: FlowFailureCode[] = [
  "condition-never-readable",
  "condition-hidden-unconfirmable",
  "condition-dark-tail",
  "when-guard-indeterminate",
  "tree-source-unavailable",
  "tree-source-not-ready",
];

describe("FLOW_FAILURE_CATEGORY", () => {
  it("is total over FlowFailureCode and carries no extra keys", () => {
    const mapped = Object.keys(FLOW_FAILURE_CATEGORY).sort();
    expect(new Set(ALL_CODES).size, "duplicate entry in the hand-written code list").toBe(
      ALL_CODES.length
    );
    expect(mapped).toEqual([...ALL_CODES].sort());
  });

  it("maps every code to a declared category", () => {
    for (const code of ALL_CODES) {
      expect(CATEGORIES, `${code} has an unknown category`).toContain(FLOW_FAILURE_CATEGORY[code]);
    }
  });

  it("keeps each family under one heading", () => {
    // Spot-pins for the groupings a renderer's section headings depend on.
    for (const code of ALL_CODES) {
      if (code.startsWith("snapshot-")) expect(FLOW_FAILURE_CATEGORY[code]).toBe("snapshot");
      if (code.startsWith("condition-")) expect(FLOW_FAILURE_CATEGORY[code]).toBe("indeterminate");
      if (code.startsWith("run-")) expect(FLOW_FAILURE_CATEGORY[code]).toBe("composition");
      if (code.startsWith("tree-source-")) expect(FLOW_FAILURE_CATEGORY[code]).toBe("environment");
    }
  });
});

describe("determinacyOf", () => {
  it("marks exactly the indeterminate tier", () => {
    const actual = ALL_CODES.filter((c) => determinacyOf(c) === "indeterminate").sort();
    expect(actual).toEqual([...INDETERMINATE].sort());
  });

  it("calls every other code determinate", () => {
    for (const code of ALL_CODES) {
      if (INDETERMINATE.includes(code)) continue;
      expect(determinacyOf(code), `${code} must be determinate`).toBe("determinate");
    }
  });

  it("does not equate the indeterminate tier with the indeterminate category", () => {
    // tree-source-* are environment failures AND unevaluable — a renderer that
    // read determinacy off the category would call them failed assertions.
    expect(FLOW_FAILURE_CATEGORY["tree-source-unavailable"]).toBe("environment");
    expect(determinacyOf("tree-source-unavailable")).toBe("indeterminate");
  });
});

// ── Every code, from the site that produces it ─────────────────────────────

describe("selector codes", () => {
  it("selector-not-found: a condition whose selector matched nothing", async () => {
    await writeFlow("miss", {
      executionPrerequisite: "",
      steps: [{ kind: "assert", condition: "exists", selector: { text: "Done" } }],
    });

    const failure = singleFailure(await run("miss"));

    expect(failure.code).toBe("selector-not-found");
    expect(failure.category).toBe("selector");
    expect(failure.determinacy).toBe("determinate");
  });

  it("selector-not-visible: matches exist but every frame has zero area", async () => {
    currentFetch = () => ({
      tree: screen([n({ identifier: "ghost", frame: { x: 0.5, y: 0.5, width: 0, height: 0 } })]),
      source: "native-devtools",
    });
    await writeFlow("ghost", {
      executionPrerequisite: "",
      steps: [{ kind: "assert", condition: "visible", selector: { identifier: "ghost" } }],
    });

    const failure = singleFailure(await run("ghost"));

    expect(failure.code).toBe("selector-not-visible");
    expect(failure.actual?.matchCount).toBe(1);
    expect(failure.actual?.visibleMatchCount).toBe(0);
    // The zero-area match IS the diagnosis, and belongs out of `candidates`.
    expect(failure.actual?.invisibleMatches?.[0]?.identifier).toBe("ghost");
  });

  it("does not tell the operator to scroll to something scrolling cannot reveal", async () => {
    // The reason came from `offscreenHint` unconditionally — "if it is
    // off-screen, add a scroll-to step" — while the hint printed two lines
    // lower said the frame has zero area, which a scroll cannot change. Both
    // rendered adjacently, so the block advised the one thing it had just
    // explained could not work. `scrollReachedEnd` already rewrites its own
    // prose for exactly this split.
    currentFetch = () => ({
      tree: screen([n({ identifier: "ghost", frame: { x: 0.5, y: 0.5, width: 0, height: 0 } })]),
      source: "native-devtools",
    });
    await writeFlow("ghost-tap", {
      executionPrerequisite: "",
      steps: [{ kind: "tap", selector: { identifier: "ghost" } }],
    });

    const failure = singleFailure(await run("ghost-tap"));

    expect(failure.code).toBe("selector-not-visible");
    expect(failure.message).toContain("zero area");
    expect(failure.message).not.toContain("scroll-to");
    expect(failure.hint).toContain("zero area");
    // A tap auto-waits the full action timeout before it can conclude the
    // frame never appeared.
  }, 20_000);

  it("target-missing: a gesture step carrying neither a selector nor x/y", async () => {
    // Unreachable through a parsed flow — `parseTap` rejects a targetless tap —
    // so the production site is driven directly. Every other code below goes
    // through the full runner.
    const env: ActionEnv = {
      registry: mockRegistry(),
      device: { id: DEVICE, platform: "ios", kind: "simulator" } as DeviceInfo,
    };

    const outcome = await runDirective(env, { kind: "tap" } as DirectiveStep);

    expect(outcome.ok).toBe(false);
    expect(outcome.evidence?.code).toBe("target-missing");
    expect(FLOW_FAILURE_CATEGORY["target-missing"]).toBe("selector");
  });
});

describe("assertion codes", () => {
  it("assert-hidden-unmet: the element was still visible at the deadline", async () => {
    currentFetch = () => ({
      tree: screen([
        n({ identifier: "spinner", frame: { x: 0.4, y: 0.4, width: 0.2, height: 0.2 } }),
      ]),
      source: "native-devtools",
    });
    await writeFlow("stuck", {
      executionPrerequisite: "",
      steps: [{ kind: "assert", condition: "hidden", selector: { identifier: "spinner" } }],
    });

    const failure = singleFailure(await run("stuck"));

    expect(failure.code).toBe("assert-hidden-unmet");
    expect(failure.determinacy).toBe("determinate");
    expect(failure.message).toMatch(/still visible/);
    // The element that WAS there is the whole diagnosis, and it is the shape
    // both renderers document their `match:` slot for. `buildObservation` only
    // populated `actual.element` for a `text` condition, so this failure
    // carried `{matchCount:1, visibleMatchCount:1}` and nothing else —
    // candidates are deliberately suppressed here and bare counts render
    // nowhere, so the block had no element evidence at all.
    expect(failure.actual?.element).toMatchObject({ identifier: "spinner" });
    // No `text`, though: quoting one would invent an expectation this step
    // never had.
    expect(failure.actual?.text).toBeUndefined();
    expect(failure.candidates).toEqual([]);
  });

  it("text-mismatch: a literal text expectation that did not hold", async () => {
    currentFetch = () => ({
      tree: screen([
        n({
          identifier: "banner",
          label: "Loading",
          frame: { x: 0.1, y: 0.1, width: 0.8, height: 0.1 },
        }),
      ]),
      source: "native-devtools",
    });
    await writeFlow("text-literal", {
      executionPrerequisite: "",
      steps: [
        {
          kind: "assert",
          condition: "text",
          selector: { identifier: "banner" },
          expectedText: "Done",
          textMatch: "contains",
        },
      ],
    });

    const failure = singleFailure(await run("text-literal"));

    expect(failure.code).toBe("text-mismatch");
    expect(failure.actual?.text).toBe("Loading");
    expect(failure.expected).toMatchObject({ kind: "condition", condition: "text", text: "Done" });
  });

  it("text-no-match: a regex expectation that never fired", async () => {
    currentFetch = () => ({
      tree: screen([
        n({
          identifier: "total",
          label: "Subtotal 3",
          frame: { x: 0.1, y: 0.1, width: 0.8, height: 0.1 },
        }),
      ]),
      source: "native-devtools",
    });
    await writeFlow("text-regex", {
      executionPrerequisite: "",
      steps: [
        {
          kind: "assert",
          condition: "text",
          selector: { identifier: "total" },
          expectedText: "^Total: \\$\\d+$",
          textMatch: "matches",
        },
      ],
    });

    const failure = singleFailure(await run("text-regex"));

    // A regex that did not fire and a literal that differed are different
    // authoring mistakes, so they must not share a code.
    expect(failure.code).toBe("text-no-match");
  });
});

describe("indeterminate codes", () => {
  it("condition-never-readable: no read in the whole window was trustworthy", async () => {
    currentFetch = () => {
      throw new Error("native devtools disconnected");
    };
    await writeFlow("dark", {
      executionPrerequisite: "",
      steps: [{ kind: "assert", condition: "exists", selector: { text: "Done" } }],
    });

    const failure = singleFailure(await run("dark"));

    expect(failure.code).toBe("condition-never-readable");
    expect(failure.determinacy).toBe("indeterminate");
    expect(failure.hint).toMatch(/re-run/i);
  });

  it("condition-hidden-unconfirmable: gone-ness could not be confirmed", async () => {
    let reads = 0;
    currentFetch = () => ({
      tree:
        reads++ === 0
          ? screen([
              n({ identifier: "spinner", frame: { x: 0.4, y: 0.4, width: 0.2, height: 0.2 } }),
            ])
          : screen([]),
      source: "native-devtools",
    });
    await writeFlow("blank-hidden", {
      executionPrerequisite: "",
      steps: [{ kind: "assert", condition: "hidden", selector: { identifier: "spinner" } }],
    });

    const failure = singleFailure(await run("blank-hidden"));

    expect(failure.code).toBe("condition-hidden-unconfirmable");
    expect(failure.determinacy).toBe("indeterminate");
  });

  it("condition-dark-tail: the window went dark before the deadline", async () => {
    let reads = 0;
    currentFetch = () => {
      if (reads++ === 0) return HOME;
      throw new Error("native devtools disconnected");
    };
    await writeFlow("dark-tail", {
      executionPrerequisite: "",
      steps: [{ kind: "assert", condition: "exists", selector: { text: "Done" } }],
    });

    const failure = singleFailure(await run("dark-tail"));

    expect(failure.code).toBe("condition-dark-tail");
    expect(failure.determinacy).toBe("indeterminate");
    expect(failure.timing.darkTailMs).toBeGreaterThan(0);
  });

  it("when-guard-indeterminate: the guard itself could not be evaluated", async () => {
    currentFetch = () => {
      throw new Error("native devtools disconnected");
    };
    await writeFlow("guard", {
      executionPrerequisite: "",
      steps: [
        {
          kind: "when",
          condition: { kind: "ui", condition: "visible", selector: { identifier: "modal" } },
          steps: [{ kind: "tap", selector: { text: "Skip", loose: true } }],
        },
      ],
    });

    const result = await run("guard");
    const failure = singleFailure(result);

    // "could not evaluate the guard" is a distinct failure from the same probe
    // failing as a bare assert — a broken tree source must not green-skip a
    // guarded block.
    expect(failure.code).toBe("when-guard-indeterminate");
    expect(failure.determinacy).toBe("indeterminate");
    expect(result.steps[0]!.status).toBe("error");
  });
});

describe("scroll codes", () => {
  it("scroll-target-not-found: the scroll reached its end without the target", async () => {
    currentFetch = () => ({
      tree: screen([n({ label: "Row 1", frame: { x: 0.1, y: 0.1, width: 0.8, height: 0.1 } })]),
      source: "native-devtools",
    });
    await writeFlow("scroll-miss", {
      executionPrerequisite: "",
      steps: [{ kind: "scroll-to", target: { text: "Order #1234" }, direction: "down" }],
    });

    const failure = singleFailure(await run("scroll-miss"));

    expect(failure.code).toBe("scroll-target-not-found");
    expect(failure.expected).toMatchObject({ kind: "scroll", direction: "down" });
  });

  it("selector-not-visible: the scroll target IS on the tree, with no frame", async () => {
    // Scrolling cannot reveal a zero-area element, so `scroll-target-not-found`
    // ("keep looking further down the list") is the wrong instruction — it is
    // the same state `selectorMissEvidence` classifies as a visibility problem
    // on a `tap`, and it deserves the same code and the same hint.
    currentFetch = () => ({
      tree: screen([
        n({ label: "Row 1", frame: { x: 0.1, y: 0.1, width: 0.8, height: 0.1 } }),
        n({ label: "Order #1234", frame: { x: 0.1, y: 0.5, width: 0, height: 0 } }),
      ]),
      source: "native-devtools",
    });
    await writeFlow("scroll-invisible", {
      executionPrerequisite: "",
      steps: [{ kind: "scroll-to", target: { text: "Order #1234" }, direction: "down" }],
    });

    const failure = singleFailure(await run("scroll-invisible"));

    expect(failure.code).toBe("selector-not-visible");
    expect(failure.category).toBe("selector");
    expect(failure.hint).toContain("zero area");
    // The REASON is rewritten with the code. `failure.message` is pinned
    // byte-identical to `reason`, so end-of-scroll prose beside a visibility
    // code would ship the contradiction to every renderer.
    expect(failure.message).toContain("zero area");
    expect(failure.message).not.toContain("reached the end of the scroll");
    // The element the operator asked for, named rather than hunted for.
    expect(failure.actual?.matchCount).toBe(1);
    expect(failure.actual?.visibleMatchCount).toBe(0);
    expect(failure.actual?.invisibleMatches?.[0]?.label).toBe("Order #1234");
    // The scroll expectation still rides along — that IS what the step asked.
    expect(failure.expected).toMatchObject({ kind: "scroll", direction: "down" });
  });

  it("keeps scroll-target-not-found when the scroll ran out of ITERATIONS", async () => {
    // The container was still producing new content on the last round, so
    // nothing can say whether more scrolling would have revealed the target —
    // reclassifying to a visibility problem there would assert "scrolling
    // cannot reveal it" about a list that was demonstrably still scrolling.
    // Keyed to the SCROLL count, not the read count: the tree must hold still
    // within a round (or `settleTree` never settles and the test runs for
    // minutes) while differing BETWEEN rounds, so the fingerprint never
    // repeats and the loop exits on the iteration cap.
    let scrolls = 0;
    const registry = mockRegistry((id) => {
      if (id !== "list-devices" && id !== "screenshot") scrolls++;
      return undefined;
    });
    currentFetch = () => ({
      tree: screen([
        n({ label: `Row ${scrolls}`, frame: { x: 0.1, y: 0.1, width: 0.8, height: 0.1 } }),
        n({ label: "Order #1234", frame: { x: 0.1, y: 0.5, width: 0, height: 0 } }),
      ]),
      source: "native-devtools",
    });
    await writeFlow("scroll-capped", {
      executionPrerequisite: "",
      steps: [{ kind: "scroll-to", target: { text: "Order #1234" }, direction: "down" }],
    });

    const failure = singleFailure(await run("scroll-capped", { registry }));

    expect(failure.code).toBe("scroll-target-not-found");
    expect(failure.category).toBe("scroll");
    expect(failure.message).toContain("scroll attempts");
  }, 30000);

  it("scroll-container-not-visible: the `within` container never resolved", async () => {
    currentFetch = () => ({
      tree: screen([n({ label: "Row 1", frame: { x: 0.1, y: 0.1, width: 0.8, height: 0.1 } })]),
      source: "native-devtools",
    });
    await writeFlow("scroll-container", {
      executionPrerequisite: "",
      steps: [
        {
          kind: "scroll-to",
          target: { text: "Order #1234" },
          direction: "down",
          within: { identifier: "orders-list" },
        },
      ],
    });

    const failure = singleFailure(await run("scroll-container"));

    expect(failure.code).toBe("scroll-container-not-visible");
    // The failing selector is the CONTAINER, not the target — a report naming
    // the target would send the operator to the wrong step.
    expect(failure.selector?.described).toContain("orders-list");
  });
});

describe("gesture / environment codes", () => {
  it("directive-unsupported: a touch directive on a remote-driven target", async () => {
    await writeFlow("vega-tap", {
      executionPrerequisite: "",
      steps: [{ kind: "tap", selector: { text: "Play", loose: true } }],
    });

    const failure = singleFailure(await run("vega-tap", { device: VEGA_DEVICE }));

    expect(failure.code).toBe("directive-unsupported");
    expect(failure.category).toBe("gesture");
  });

  it("launch-failed: restart-app rejected", async () => {
    const registry = mockRegistry((id) => {
      if (id === "restart-app") throw new Error("app not installed");
      return undefined;
    });
    // Counted locally rather than off the module mock, which is shared by
    // every test in this file and never reset.
    let reads = 0;
    currentFetch = () => {
      reads++;
      return HOME;
    };
    await writeFlow("launch-broken", {
      executionPrerequisite: "",
      steps: [{ kind: "launch", app: "com.acme.app" }],
    });

    const failure = singleFailure(await run("launch-broken", { registry }));

    expect(failure.code).toBe("launch-failed");
    expect(failure.category).toBe("launch");
    expect(failure.message).toContain("app not installed");
    // The point of classifying it: the app never started, so there is no
    // screen to read — and on chromium the read would attach to the very
    // instance the launch just declined to attach to.
    expect(failure.screen).toMatchObject({
      state: "unavailable",
      reason: "never-readable",
      hint: "the app never started, so there was no screen to read",
    });
    // ...so the post-hoc read is never ATTEMPTED, and no tree is registered.
    expect(reads).toBe(0);
    expect(failure.tree).toBeUndefined();
  });

  it("tree-source-not-ready: the launch gate never saw a readable tree source", async () => {
    // The mock registry exposes no `resolveService`, so the native-devtools
    // probe reports "not connected" — exactly the shape the gate exists for.
    await writeFlow("gate", {
      executionPrerequisite: "",
      steps: [{ kind: "launch", app: "com.acme.app" }],
    });

    const failure = singleFailure(await run("gate"));

    expect(failure.code).toBe("tree-source-not-ready");
    expect(failure.determinacy).toBe("indeterminate");
    expect(failure.hint).toMatch(/do not edit the flow/i);
  }, 15000);

  it("tree-source-unavailable: every read of a directive's window failed", async () => {
    currentFetch = () => {
      throw new Error("native devtools disconnected");
    };
    await writeFlow("tap-dark", {
      executionPrerequisite: "",
      steps: [{ kind: "tap", selector: { text: "Checkout", loose: true } }],
    });

    const result = await run("tap-dark");
    const failure = singleFailure(result);

    // The directive THREW (settleTree's sustained-outage throw), so this rides
    // the error path, not a reported outcome.
    expect(result.steps[0]!.status).toBe("error");
    expect(failure.code).toBe("tree-source-unavailable");
    expect(failure.determinacy).toBe("indeterminate");
  }, 15000);

  it("directive-threw: a gesture dispatch that rejected for a non-tree reason", async () => {
    currentFetch = () => ({
      tree: screen([n({ label: "Checkout", frame: { x: 0.1, y: 0.1, width: 0.8, height: 0.1 } })]),
      source: "native-devtools",
    });
    const registry = mockRegistry((id) => {
      if (id === "gesture-tap") throw new Error("simulator-server not reachable");
      return undefined;
    });
    await writeFlow("tap-throws", {
      executionPrerequisite: "",
      steps: [{ kind: "tap", selector: { text: "Checkout", loose: true } }],
    });

    const failure = singleFailure(await run("tap-throws", { registry }));

    // Not classified as a tree-source outage: the tree was fine, the dispatch
    // was not — and the two call for opposite responses.
    expect(failure.code).toBe("directive-threw");
    expect(failure.determinacy).toBe("determinate");
  });
});

describe("codes the assembler derives rather than a directive reporting them", () => {
  it("selector-scope-unresolved: a `within` scope that matched nothing", async () => {
    // The rewrite that turns a confusing report into an actionable one: the
    // message is about the TARGET, but the target was never looked for — the
    // scope naming where to look is what is broken.
    currentFetch = () => ({
      tree: screen([
        n({ identifier: "checkout-cta", frame: { x: 0.1, y: 0.8, width: 0.8, height: 0.08 } }),
      ]),
      source: "native-devtools",
    });
    await writeFlow("scope-missing", {
      executionPrerequisite: "",
      steps: [
        {
          kind: "assert",
          condition: "visible",
          selector: { identifier: "checkout-cta", within: { identifier: "profile-card" } },
        },
      ],
    });

    const failure = singleFailure(await run("scope-missing"));

    expect(failure.code).toBe("selector-scope-unresolved");
    expect(failure.category).toBe("selector");
    expect(failure.selector?.unresolvedScope).toBe("within");
    expect(failure.hint).toContain("was never");
    expect(failure.hint).toContain("fix the scope selector first");
  });

  it("leaves an INDETERMINATE verdict alone even when a scope matched nothing", async () => {
    // The guard: an indeterminate verdict means argent could not see the
    // screen, so "your scope matched nothing" is a claim about a tree nobody
    // trusts. Rewriting code, category and determinacy together left the three
    // self-consistent while contradicting the message — and turned "re-run"
    // into "your flow is wrong" on exactly the mid-run devtools drop the tier
    // exists for.
    // The shape that actually exercises the guard: a TRUSTED first read whose
    // tree is missing the scope (so `diagnoseScope` has something to say),
    // followed by a window that goes dark (so the verdict is indeterminate).
    // With no tree at all the scope is never diagnosed and the guard is never
    // reached — a version of this test that threw on every read proved nothing.
    let reads = 0;
    currentFetch = () => {
      if (reads++ === 0) {
        return {
          tree: screen([
            n({ identifier: "checkout-cta", frame: { x: 0.1, y: 0.8, width: 0.8, height: 0.08 } }),
          ]),
          source: "native-devtools" as const,
        };
      }
      throw new Error("native devtools disconnected");
    };
    await writeFlow("scope-indeterminate", {
      executionPrerequisite: "",
      steps: [
        {
          kind: "assert",
          condition: "visible",
          selector: { identifier: "checkout-cta", within: { identifier: "profile-card" } },
        },
      ],
    });

    const failure = singleFailure(await run("scope-indeterminate"));

    expect(failure.determinacy).toBe("indeterminate");
    expect(failure.code).toBe("condition-dark-tail");
    expect(failure.code).not.toBe("selector-scope-unresolved");
    // The scope IS still reported as unresolved — that observation is honest
    // and useful. What must not happen is code, category and determinacy being
    // rewritten around it.
    expect(failure.selector?.unresolvedScope).toBe("within");
    expect(failure.category).toBe("indeterminate");
  });

  it("unclassified: a failure the assembler received with no evidence code", async () => {
    // The catch-all is a real wire value, not a type-system placeholder — and
    // it was asserted NOWHERE in the repo. Both its production sites are an
    // absent code (`baseFailure`'s `evidence?.code ?? "unclassified"`) and an
    // assertion arm no parsed condition reaches, so it is driven at the
    // assembler, which is the site that decides it.
    //
    // This replaces a test that asserted nothing. Its body was
    // `if (failure) { expect(ALL_CODES).toContain(code) }` — vacuous when the
    // failure is absent, satisfied by any of the thirty codes, and its second
    // line compared production's own lookup against itself. Its fixture (a
    // `button` tool answering `{ ok: false }`) produces a PASSING step, so the
    // guard never opened at all, and `tool-ui-wait-unmet` — what it would have
    // yielded with a real await-ui-element — is already pinned below.
    const report: LeafOutcome = {
      index: 0,
      kind: "assert",
      status: "fail",
      flow: "bare",
      reason: "something went wrong",
    };

    await attachFailureDiagnostics({ registry: mockRegistry(), device: null }, report, {
      startedAt: Date.now(),
      ordinal: 1,
    });

    expect(report.failure?.code).toBe("unclassified");
    // A code with no category would render under no heading at all.
    expect(report.failure?.category).toBe("tool");
    expect(report.failure?.determinacy).toBe("determinate");
    // The message still mirrors the reason, which is the whole wire-compat
    // guarantee — a renderer that ignores `failure` prints what it always did.
    expect(report.failure?.message).toBe("something went wrong");
  });
});

describe("composition codes", () => {
  it("run-cyclic: a fragment that references itself", async () => {
    await writeFlow("cycle-a", {
      executionPrerequisite: "",
      steps: [{ kind: "run", flow: "main" }],
    });
    await writeFlow("main", {
      executionPrerequisite: "",
      steps: [{ kind: "run", flow: "cycle-a" }],
    });

    const failure = singleFailure(await run("main"));

    expect(failure.code).toBe("run-cyclic");
    expect(failure.category).toBe("composition");
  });

  it("no-device: a flow that touches no device reports having no screen", async () => {
    // A flow whose steps declare no device argument resolves to no device at
    // all, and its failure is fully explained by its code and reason. The
    // report must say "there was never a screen" rather than degrade through
    // the read-failed path, which reads as a broken tree source.
    const registry = {
      invokeTool: vi.fn(async (id: string) => {
        if (id === "list-devices") return { devices: [] };
        throw new Error("the deviceless tool refused");
      }),
      // No `udid`/`serial` property, so `stepRequiresDevice` says no.
      getTool: vi.fn(() => ({ inputSchema: { properties: {} } })),
    } as unknown as Registry;
    let reads = 0;
    currentFetch = () => {
      reads++;
      return HOME;
    };
    await writeFlow("headless", {
      executionPrerequisite: "",
      steps: [{ kind: "tool", name: "stop-metro", args: {} }],
    });

    const failure = singleFailure(await run("headless", { registry, deviceless: true }));

    expect(failure.code).toBe("tool-step-failed");
    expect(failure.screen).toEqual({
      state: "unavailable",
      reason: "no-device",
      hint: "this flow ran without a device, so there was no screen to read",
    });
    // No device means nothing to read and nothing to capture — and no platform
    // to report either, which is omitted rather than faked.
    expect(reads).toBe(0);
    expect(failure.data?.platform).toBeUndefined();
    expect(failure.screenshot).toBeUndefined();
  });

  it("run-depth-exceeded: a chain deeper than the run-stack cap", async () => {
    // MAX_RUN_DEPTH is 20 and the top-level flow occupies the first slot, so
    // the run step inside depth-19 is the first one to trip the cap.
    for (let i = 0; i <= 19; i++) {
      await writeFlow(`depth-${i}`, {
        executionPrerequisite: "",
        steps: [{ kind: "run", flow: `depth-${i + 1}` }],
      });
    }

    const failure = singleFailure(await run("depth-0"));

    expect(failure.code).toBe("run-depth-exceeded");
  });

  it("run-fragment-load-failed: the named fragment could not be read", async () => {
    await writeFlow("composed", {
      executionPrerequisite: "",
      steps: [{ kind: "run", flow: "not-on-disk" }],
    });

    const failure = singleFailure(await run("composed"));

    expect(failure.code).toBe("run-fragment-load-failed");
    expect(failure.message).toContain("not-on-disk");
  });
});

describe("tool codes", () => {
  it("tool-ui-wait-unmet: an await-ui-element step whose condition never held", async () => {
    const registry = mockRegistry((id) =>
      id === "await-ui-element" ? { success: false, note: "never appeared" } : undefined
    );
    await writeFlow("ui-wait", {
      executionPrerequisite: "",
      steps: [
        {
          kind: "tool",
          name: "await-ui-element",
          args: { condition: "visible", selector: { text: "Done" } },
        },
      ],
    });

    const result = await run("ui-wait", { registry });
    const failure = singleFailure(result);

    expect(result.steps[0]!.status).toBe("fail");
    expect(failure.code).toBe("tool-ui-wait-unmet");
    expect(failure.category).toBe("tool");
  });

  it("tool-step-failed: a tool step whose invocation rejected", async () => {
    const registry = mockRegistry((id) => {
      if (id === "button") throw new Error("no such button");
      return undefined;
    });
    await writeFlow("tool-throws", {
      executionPrerequisite: "",
      steps: [{ kind: "tool", name: "button", args: { button: "back" } }],
    });

    const result = await run("tool-throws", { registry });
    const failure = singleFailure(result);

    expect(result.steps[0]!.status).toBe("error");
    expect(failure.code).toBe("tool-step-failed");
  });
});

describe("one failure per run", () => {
  it("attaches diagnostics to the failing step only, never to the skips after it", async () => {
    currentFetch = () => ({
      tree: screen([n({ label: "Home", frame: { x: 0, y: 0, width: 1, height: 0.1 } })]),
      source: "native-devtools",
    });
    await writeFlow("stops", {
      executionPrerequisite: "",
      steps: [
        { kind: "echo", message: "checking" },
        { kind: "assert", condition: "exists", selector: { text: "Done" } },
        { kind: "assert", condition: "exists", selector: { text: "Also missing" } },
        { kind: "wait", ms: 5 },
      ],
    });

    const result = await run("stops");

    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual([
      "echo:pass",
      "assert:fail",
      "assert:skip",
      "wait:skip",
    ]);
    const failure = singleFailure(result); // asserts the "exactly one" invariant
    expect(failure.step.index).toBe(1);
    // `index` counts every report; `ordinal` is what a renderer PRINTS, and
    // echo narration is not numbered — so the failing step is index 1, step 1.
    expect(failure.step.ordinal).toBe(1);
    expect(failure.step.kind).toBe("assert");
    // Skips did no work: no timing, no diagnostics, byte-identical to before.
    for (const skipped of result.steps.filter((s) => s.status === "skip")) {
      expect(skipped.failure).toBeUndefined();
      expect(skipped.durationMs).toBeUndefined();
    }
    expect(result.steps[1]!.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.ok).toBe(false);
  });
});
