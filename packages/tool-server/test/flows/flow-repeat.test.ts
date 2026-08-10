import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Registry } from "@argent/registry";
import type { DescribeNode, DescribeTreeData } from "../../src/tools/describe/contract";
import type { WaitCondition } from "../../src/utils/ui-tree-match";

// Same tree stub as the when tests: flows resolve against the platform's
// full-hierarchy source and hard-fail rather than degrade, so the fetch itself
// is stubbed. `currentTree` is a function so a drain can watch the screen
// change underneath it as its iterations tap things away.
let currentTree: () => DescribeNode;
let currentHint: string | undefined;
vi.mock("../../src/tools/flows/flow-tree", () => ({
  fetchFlowTree: vi.fn(
    async (): Promise<DescribeTreeData> => ({
      tree: currentTree(),
      source: "native-devtools",
      ...(currentHint !== undefined ? { hint: currentHint } : {}),
    })
  ),
}));

// Mock ONLY runSnapshot, the snapshot-step suite's idiom: the load-fence tests
// below need a fragment whose snapshot must NEVER run under a repeat — the
// mock's call count is the proof — and a control where the same fragment
// outside one runs it to a cheap pass. The visual pipeline itself is
// flow-visual's suite to pin.
vi.mock("../../src/tools/flows/flow-visual", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/tools/flows/flow-visual")>()),
  runSnapshot: vi.fn(),
}));

import {
  createRunFlowTool,
  type FlowRunResult,
  type StepReport,
} from "../../src/tools/flows/flow-run";
import { serializeFlow, parseFlow, type FlowStep } from "../../src/tools/flows/flow-utils";
import { runSnapshot } from "../../src/tools/flows/flow-visual";

const DEVICE = "00000000-0000-0000-0000-0000000000ab"; // iOS UDID shape
let tmpDir: string;
/** Taps dispatched this run — a drain's exit condition is written against it. */
let tapCount: number;
/**
 * Called after each dispatched tap. The cancellation tests trip an
 * AbortController from here, which lands the abort deterministically inside an
 * iteration body (the tap itself still succeeds — no timer races).
 */
let onTap: () => void;

function n(partial: Partial<DescribeNode> & { frame: DescribeNode["frame"] }): DescribeNode {
  return { role: "AXOther", children: [], ...partial };
}

function screen(children: DescribeNode[]): DescribeNode {
  return n({ role: "AXWindow", frame: { x: 0, y: 0, width: 1, height: 1 }, children });
}

function notification(): DescribeNode {
  return n({ label: "Clear notification", frame: { x: 0.1, y: 0.1, width: 0.5, height: 0.1 } });
}

function mockRegistry(): Registry {
  return {
    invokeTool: vi.fn(async (id: string) => {
      if (id === "list-devices") return { devices: [] };
      if (id === "gesture-tap") {
        tapCount++;
        onTap();
        return { tapped: true };
      }
      return { ok: true };
    }),
    getTool: vi.fn((id: string) =>
      id === "gesture-tap" ? { inputSchema: { properties: { udid: {} } } } : undefined
    ),
  } as unknown as Registry;
}

async function writeFlow(name: string, yaml: Parameters<typeof serializeFlow>[0]): Promise<void> {
  const dir = path.join(tmpDir, ".argent", "flows");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${name}.yaml`), serializeFlow(yaml), "utf8");
}

function asRun(r: FlowRunResult | { notice: string }): FlowRunResult {
  if (!("steps" in r)) throw new Error(`expected a run result, got notice: ${r.notice}`);
  return r;
}

async function run(name: string, signal?: AbortSignal): Promise<FlowRunResult> {
  const tool = createRunFlowTool(mockRegistry());
  return asRun(
    await tool.execute(
      {},
      { name, project_root: tmpDir, device: DEVICE },
      (signal ? { signal } : undefined) as never
    )
  );
}

/** A compact `kind status target|reason @depth` view — what the renderers show. */
function shape(steps: StepReport[]): string[] {
  return steps.map(
    (s) => `${s.kind} ${s.status} ${s.target ?? s.message ?? s.reason ?? ""} @${s.depth ?? 0}`
  );
}

/**
 * {@link shape} plus the fragment each line is attributed to — `kind status
 * flow target @depth`. Only the composition tests need it: everywhere else the
 * whole report belongs to the one flow under test.
 */
function attributed(steps: StepReport[]): string[] {
  return steps.map((s) => {
    const what = s.target ?? s.message ?? s.reason ?? "";
    return `${`${s.kind} ${s.status} ${s.flow ?? ""} ${what}`.trimEnd()} @${s.depth ?? 0}`;
  });
}

/**
 * The lines the CLI numbers, each with the number it gets — renderReport's rule
 * (echo is narration, a `structural` line is block scaffolding; everything else
 * takes the next number). Mirrored here because step numbering is the property
 * the structural-marker tests are about and {@link shape} cannot see it: it
 * renders `kind status target @depth` and never looks at `structural`.
 */
function numbered(steps: StepReport[]): string[] {
  let n = 0;
  return steps
    .filter((s) => s.kind !== "echo" && !s.structural)
    .map((s) => `${++n} ${s.kind} ${s.status} ${s.target ?? ""}`.trimEnd());
}

/** Just the verdict and the counters — what the CLI's summary line prints. */
function counts(r: FlowRunResult): Record<string, unknown> {
  const { ok, passed, failed, skipped, errored } = r;
  return { ok, passed, failed, skipped, errored };
}

const TAP: FlowStep = { kind: "tap", selector: { text: "Clear notification", loose: true } };

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-repeat-"));
  currentTree = () => screen([]);
  currentHint = undefined;
  tapCount = 0;
  onTap = () => {};
  vi.mocked(runSnapshot).mockReset();
  vi.mocked(runSnapshot).mockResolvedValue({ status: "pass", reason: "diff 0.00% ≤ 0.5%" });
});
afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("repeat: parse/serialize", () => {
  it("round-trips the bare count and the until drain, including nested blocks", () => {
    const flow = {
      executionPrerequisite: "",
      steps: [
        { kind: "repeat", spec: { mode: "times", times: 3 }, steps: [TAP] },
        {
          kind: "repeat",
          spec: {
            mode: "until",
            until: { kind: "ui", condition: "hidden", selector: { text: "Toast" } },
            max: 15,
          },
          steps: [
            {
              kind: "when",
              condition: { kind: "platform", platform: "ios" },
              steps: [{ kind: "repeat", spec: { mode: "times", times: 2 }, steps: [TAP] }],
            },
          ],
        },
      ] as FlowStep[],
    };
    expect(parseFlow(serializeFlow(flow))).toEqual(flow);
  });

  it("emits the bare-integer sugar and accepts the { times } map form as its inverse", () => {
    expect(
      serializeFlow({
        executionPrerequisite: "",
        steps: [{ kind: "repeat", spec: { mode: "times", times: 3 }, steps: [TAP] }],
      })
    ).toContain("repeat: 3");
    // The map form is accepted on input and normalizes to the same flow.
    expect(parseFlow("steps:\n  - repeat: { times: 3 }\n    steps: [{ tap: A }]\n")).toEqual(
      parseFlow("steps:\n  - repeat: 3\n    steps: [{ tap: A }]\n")
    );
  });

  it("normalizes a default max to absent and keeps an explicit one", () => {
    const drain = (max?: number): string =>
      `steps:\n  - repeat: { until: { hidden: Toast }${max === undefined ? "" : `, max: ${max}`} }\n    steps: [{ tap: A }]\n`;
    // Omitted and explicitly-default `max` are the same flow, and serialize
    // back without the knob — the tap.times normalization doctrine.
    expect(parseFlow(drain())).toEqual(parseFlow(drain(10)));
    expect(serializeFlow(parseFlow(drain(10)))).not.toContain("max");
    expect(serializeFlow(parseFlow(drain(15)))).toContain("max: 15");
  });

  it("requires exactly one of times | until", () => {
    expect(() => parseFlow("steps:\n  - repeat: {}\n    steps: [{ tap: A }]\n")).toThrow(
      /exactly one of `times`.*or `until`/i
    );
    expect(() =>
      parseFlow("steps:\n  - repeat: { times: 2, until: { hidden: X } }\n    steps: [{ tap: A }]\n")
    ).toThrow(/exactly one of `times`.*or `until`/i);
  });

  it("rejects max beside times — a count is already bounded", () => {
    expect(() =>
      parseFlow("steps:\n  - repeat: { times: 2, max: 5 }\n    steps: [{ tap: A }]\n")
    ).toThrow(/max applies only to `until`/i);
  });

  it("rejects a zero, fractional, or oversized count", () => {
    for (const bad of ["0", "1.5", "101"]) {
      expect(() => parseFlow(`steps:\n  - repeat: ${bad}\n    steps: [{ tap: A }]\n`)).toThrow(
        /must be a literal integer between 1 and 100/i
      );
    }
    // A quoted count is neither the integer sugar nor a bound map — it fails on
    // the shape, before any range check.
    expect(() => parseFlow("steps:\n  - repeat: '3'\n    steps: [{ tap: A }]\n")).toThrow(
      /repeat needs a count.*or a drain/is
    );
  });

  it("refuses to serialize a bound the parser would reject, in either mode", () => {
    // The serialization boundary holds the same bound as parseRepeatCount, so a
    // hand-built spec cannot write a flow file that no longer loads — the
    // gesture-target doctrine, applied to the repeat bound.
    const times = (n: number): FlowStep[] => [
      { kind: "repeat", spec: { mode: "times", times: n }, steps: [TAP] },
    ];
    const drain = (max: number): FlowStep[] => [
      {
        kind: "repeat",
        spec: {
          mode: "until",
          until: { kind: "ui", condition: "hidden", selector: { text: "Toast" } },
          max,
        },
        steps: [TAP],
      },
    ];
    for (const steps of [times(0), times(1.5), times(101), drain(0), drain(101)]) {
      expect(() => serializeFlow({ executionPrerequisite: "", steps })).toThrow(
        /Cannot serialize flow repeat bound.*between 1 and 100/i
      );
    }
    // Both edges of the range still serialize, and back.
    for (const steps of [times(1), times(100), drain(1), drain(100)]) {
      expect(parseFlow(serializeFlow({ executionPrerequisite: "", steps })).steps).toEqual(steps);
    }
  });

  /**
   * One sample per condition kind an `until` guard should accept, keyed on the
   * exported {@link WaitCondition} union: a condition kind added to the shared
   * vocabulary is a COMPILE error here until it is sampled, and the tests below
   * then fail unless it reaches both guard directives.
   */
  const UNTIL_GUARDS: Record<WaitCondition, string[]> = {
    exists: ["{ exists: A }"],
    visible: ["{ visible: A }", "{ visible: { text: A, within: { id: list } } }"],
    hidden: ["{ hidden: A }"],
    text: [
      "{ text: { in: Counter, contains: done } }",
      "{ text: { in: Counter, equals: '3' } }",
      "{ text: { in: Counter, matches: '^3$' } }",
    ],
  };

  /**
   * The condition keys a guard directive lists in its own "needs exactly one"
   * error — read back out of the parser rather than restated here, so this
   * cannot quietly agree with a stale copy of the vocabulary.
   */
  function vocabulary(directive: "when" | "until"): string[] {
    const yaml =
      directive === "when"
        ? "steps:\n  - when: {}\n    steps: [{ tap: A }]\n"
        : "steps:\n  - repeat: { until: {} }\n    steps: [{ tap: A }]\n";
    let message = "";
    try {
      parseFlow(yaml);
    } catch (err) {
      message = (err as Error).message;
    }
    const listed = /needs exactly one condition key \(([^)]*)\)/.exec(message);
    expect(listed, `no condition-key list in: ${message}`).not.toBeNull();
    return listed![1]!.split(", ");
  }

  it("takes exactly the when guard vocabulary, minus platform", () => {
    // The one difference between the two guard directives is `platform` (the
    // test below). Comparing the vocabularies themselves — rather than one
    // sample each — is what makes a condition kind that reaches only one of
    // them a failure instead of a silently untested spelling.
    expect(vocabulary("until")).toEqual(Object.keys(UNTIL_GUARDS));
    expect(vocabulary("when")).toEqual([...vocabulary("until"), "platform"]);
  });

  it("parses each of those guards into the very condition when: builds, and round-trips it", () => {
    for (const guard of Object.values(UNTIL_GUARDS).flat()) {
      const asWhen = parseFlow(`steps:\n  - when: ${guard}\n    steps: [{ tap: A }]\n`);
      const asUntil = parseFlow(
        `steps:\n  - repeat: { until: ${guard} }\n    steps: [{ tap: A }]\n`
      );
      const when = asWhen.steps[0] as Extract<FlowStep, { kind: "when" }>;
      const repeat = asUntil.steps[0] as Extract<FlowStep, { kind: "repeat" }>;
      // Not merely "both parse": the SAME condition object, so a guard field
      // added on one path cannot go missing on the other — plus the default
      // `max` the drain gets for free.
      expect(repeat.spec, guard).toEqual({ mode: "until", until: when.condition, max: 10 });
      expect(parseFlow(serializeFlow(asUntil)), guard).toEqual(asUntil);
    }
  });

  it("rejects a platform guard in until, pointing at when", () => {
    // The platform never changes between iterations: infinite or empty by
    // construction, so it fails at parse rather than at `max`.
    expect(() =>
      parseFlow("steps:\n  - repeat: { until: { platform: ios } }\n    steps: [{ tap: A }]\n")
    ).toThrow(/repeat\.until takes no platform.*when: \{ platform/is);
  });

  it("rejects a timeout on the until guard", () => {
    expect(() =>
      parseFlow(
        "steps:\n  - repeat: { until: { hidden: X, timeout: 5000 } }\n    steps: [{ tap: A }]\n"
      )
    ).toThrow(/repeat\.until takes no timeout/i);
  });

  it("rejects a {{secret:…}} placeholder in the until guard", () => {
    expect(() =>
      parseFlow(
        "steps:\n  - repeat: { until: { hidden: '{{secret:APP_PASSWORD}}' } }\n    steps: [{ tap: A }]\n"
      )
    ).toThrow(/repeat\.until takes no \{\{secret/i);
  });

  it("points every until error at the repeat step the author wrote", () => {
    // The guard is not a step: an error echoing it alone would show a
    // `{"until":…}` entry that appears nowhere in the file, unlike every other
    // repeat error. Each message names `repeat.until` for the same reason — the
    // entry shown carries both `repeat:` and `steps:`, so a bare `until` would
    // leave the author to work out which key is being complained about.
    for (const guard of [
      "{ platform: ios }",
      "{}",
      "{ hidden: X, timeout: 5000 }",
      "{ hidden: '{{secret:APP_PASSWORD}}' }",
      "{ text: { in: A, contain: x } }",
    ]) {
      expect(() =>
        parseFlow(`steps:\n  - repeat: { until: ${guard} }\n    steps: [{ tap: A }]\n`)
      ).toThrow(/repeat\.until\b.*: \{"repeat":\{"until":.*"steps":\[\{"tap":"A"\}\]\}$/s);
    }
  });

  it("rejects unknown keys in the bound and unknown siblings on the step", () => {
    expect(() =>
      parseFlow("steps:\n  - repeat: { untl: { hidden: X } }\n    steps: [{ tap: A }]\n")
    ).toThrow(/unknown key/i);
    expect(() =>
      parseFlow("steps:\n  - repeat: 2\n    steps: [{ tap: A }]\n    else: []\n")
    ).toThrow(/takes exactly \{ repeat: <count \| \{ until, max\? \}>, steps: \[\.\.\.\] \}/i);
  });

  it("needs a non-empty steps list", () => {
    expect(() => parseFlow("steps:\n  - repeat: 2\n")).toThrow(/non-empty steps list/i);
    expect(() => parseFlow("steps:\n  - repeat: 2\n    steps: []\n")).toThrow(
      /non-empty steps list/i
    );
  });

  it("rejects a snapshot inside a repeat body, at any nesting", () => {
    expect(() => parseFlow("steps:\n  - repeat: 2\n    steps: [{ snapshot: home }]\n")).toThrow(
      /snapshot "home" cannot run inside a repeat block/i
    );
    // Nested inside a when inside the repeat — reached through blockSteps.
    expect(() =>
      parseFlow(
        "steps:\n  - repeat: 2\n    steps:\n      - when: { visible: X }\n        steps: [{ snapshot: home }]\n"
      )
    ).toThrow(/snapshot "home" cannot run inside a repeat block/i);
  });

  it("shares one depth cap with when — an alternating chain cannot evade it", () => {
    // A per-directive counter would let this nest forever. Build 12 repeat/when
    // pairs: 24 levels, over the shared cap of 20, under either alone.
    let inner = "steps: [{ tap: A }]";
    for (let i = 0; i < 12; i++) {
      inner = `steps:\n${" ".repeat(2)}- repeat: 2\n    ${inner.replace(/\n/g, "\n    ")}`;
      inner = `steps:\n${" ".repeat(2)}- when: { visible: X }\n    ${inner.replace(/\n/g, "\n    ")}`;
    }
    expect(() => parseFlow(inner)).toThrow(/nest deeper than 20 levels/i);
  });

  it("rejects a cyclic YAML alias on repeat steps", () => {
    expect(() => parseFlow("steps: &s\n  - repeat: 2\n    steps: *s\n")).toThrow(
      /nest deeper than 20 levels/i
    );
  });
});

describe("repeat: e2e classification", () => {
  // isE2eFlow judges "begins by launching" on the flow as it would EXECUTE: a
  // times block is its body pasted N times, so wrapping the leading launch in
  // `repeat: 1` must not turn an e2e flow into a fragment that may declare the
  // executionPrerequisite validateFlow exists to refuse.
  it("refuses executionPrerequisite behind a times-wrapped leading launch, like the unwrapped form", () => {
    // The same rejection the unwrapped spelling gets (flow-composition's
    // "rejects an e2e flow that declares executionPrerequisite"): pasted out,
    // `repeat: 1` IS that flow, marker line aside — the launch still runs
    // unconditionally at step 1 and wipes the state the prerequisite demands.
    expect(() =>
      parseFlow(
        "executionPrerequisite: nope\nsteps:\n  - repeat: 1\n    steps: [{ launch: com.acme.app }]\n"
      )
    ).toThrow(/must not declare executionPrerequisite/i);
  });

  it("sees through nested times blocks and echo narration at every level", () => {
    // Arbitrary nesting and interleaved echoes are still the pasted flow: the
    // first executable step remains the launch, however many wrappers and
    // narration lines sit in front of it.
    expect(() =>
      parseFlow(
        "executionPrerequisite: nope\n" +
          "steps:\n" +
          "  - echo: starting\n" +
          "  - repeat: 2\n" +
          "    steps:\n" +
          "      - repeat: 3\n" +
          "        steps: [{ echo: inner }, { launch: com.acme.app }]\n"
      )
    ).toThrow(/must not declare executionPrerequisite/i);
  });

  it("continues past an all-echo times body to the launch after the block", () => {
    // Pasted out, `repeat: 2` over narration is just two echoes — and echoes
    // never hid a launch from this check. Giving up at the block instead would
    // make the wrapped spelling parse a prerequisite the inlined one refuses.
    expect(() =>
      parseFlow(
        "executionPrerequisite: nope\n" +
          "steps:\n" +
          "  - repeat: 2\n" +
          "    steps: [{ echo: warming up }]\n" +
          "  - launch: com.acme.app\n"
      )
    ).toThrow(/must not declare executionPrerequisite/i);
  });

  it("does not call a flow e2e for a launch behind an until drain", () => {
    // The transparency is times-only. A drain's guard is checked BEFORE each
    // iteration, so an already-satisfied guard runs the body — launch included
    // — zero times: a launch that may never happen controls no start state,
    // and the prerequisite stays legal.
    expect(() =>
      parseFlow(
        "executionPrerequisite: on the profile screen\n" +
          "steps:\n" +
          "  - repeat: { until: { hidden: Busy } }\n" +
          "    steps: [{ launch: com.acme.app }]\n"
      )
    ).not.toThrow();
  });

  it("stops at the first real step inside the block — a tap-first body is a fragment", () => {
    // The three-state scan's "false" arm through the descent: the body's tap is
    // the flow's first executable step, so the launch after the block no longer
    // leads and the flow is an ordinary fragment.
    expect(() =>
      parseFlow(
        "executionPrerequisite: nope\n" +
          "steps:\n" +
          "  - repeat: 2\n" +
          "    steps: [{ tap: A }]\n" +
          "  - launch: com.acme.app\n"
      )
    ).not.toThrow();
  });
});

describe("repeat: times", () => {
  it("runs the body N times, one iteration marker each", async () => {
    currentTree = () => screen([notification()]);
    await writeFlow("thrice", {
      executionPrerequisite: "",
      steps: [{ kind: "repeat", spec: { mode: "times", times: 3 }, steps: [TAP] }],
    });

    const result = await run("thrice");

    expect(result.ok).toBe(true);
    expect(tapCount).toBe(3);
    // Block marker at the enclosing depth; iteration markers and the steps they
    // introduce one level deeper — the same place a when: block puts its steps.
    expect(shape(result.steps)).toEqual([
      "repeat pass 3 times @0",
      "repeat pass iteration 1/3 @1",
      'tap pass "Clear notification" @1',
      "repeat pass iteration 2/3 @1",
      'tap pass "Clear notification" @1',
      "repeat pass iteration 3/3 @1",
      'tap pass "Clear notification" @1',
    ]);
    // The markers are block structure, so they are reported but not counted —
    // only the taps are steps.
    expect(result.steps.filter((s) => s.structural).map((s) => s.target)).toEqual([
      "3 times",
      "iteration 1/3",
      "iteration 2/3",
      "iteration 3/3",
    ]);
    // The bound is the whole marker: no `reason` restating it, so the renderers
    // do not join the two into `repeat 3 times — 3 iterations`. Read explicitly
    // because no other assertion here can see it — {@link shape} folds
    // `target ?? message ?? reason`, so a marker's reason is invisible to every
    // shape line in this file for as long as the marker carries a target.
    expect(result.steps[0]?.reason).toBeUndefined();
    expect(result.passed).toBe(3);
  });

  it("says `1 time` for a single-iteration block, `N times` for any other", async () => {
    // `repeat: 1` is a legal bound — the range starts at 1 — and this label is
    // what every line naming the block carries (the opening marker, the
    // cancellation line, a skip standing in for a block that never ran), so an
    // unpluralized count would read `repeat 1 times` on all of them.
    currentTree = () => screen([notification()]);
    await writeFlow("once", {
      executionPrerequisite: "",
      steps: [{ kind: "repeat", spec: { mode: "times", times: 1 }, steps: [TAP] }],
    });
    await writeFlow("twice", {
      executionPrerequisite: "",
      steps: [{ kind: "repeat", spec: { mode: "times", times: 2 }, steps: [TAP] }],
    });

    const once = await run("once");
    tapCount = 0;
    const twice = await run("twice");

    expect(shape(once.steps)[0]).toBe("repeat pass 1 time @0");
    expect(shape(twice.steps)[0]).toBe("repeat pass 2 times @0");
  }, 15000);

  it("counts exactly what the same steps pasted out count", async () => {
    // The directive's whole promise is that `repeat: 3` IS the block written
    // three times. If its markers were counted the summary would say 7 passed
    // for three taps — and scale with N — so the equivalence has to hold in
    // the counters, not just in what the device saw.
    currentTree = () => screen([notification()]);
    await writeFlow("looped", {
      executionPrerequisite: "",
      steps: [{ kind: "repeat", spec: { mode: "times", times: 3 }, steps: [TAP] }],
    });
    await writeFlow("pasted", { executionPrerequisite: "", steps: [TAP, TAP, TAP] });

    const looped = await run("looped");
    tapCount = 0;
    const pasted = await run("pasted");

    expect(counts(looped)).toEqual(counts(pasted));
    expect(counts(looped)).toEqual({ ok: true, passed: 3, failed: 0, skipped: 0, errored: 0 });
    // Uncounted, not dropped: the block still reports its four marker lines.
    expect(looped.steps).toHaveLength(pasted.steps.length + 4);
  }, 15000);

  it("hard-stops on a failure inside an iteration without padding the rest", async () => {
    currentTree = () => screen([]);
    await writeFlow("fails-inside", {
      executionPrerequisite: "",
      steps: [
        {
          kind: "repeat",
          spec: { mode: "times", times: 3 },
          steps: [{ kind: "assert", condition: "visible", selector: { text: "Nope" } }],
        },
        { kind: "echo", message: "after" },
      ],
    });

    const result = await run("fails-inside");

    expect(result.ok).toBe(false);
    expect(result.failed).toBe(1);
    // Iteration 1 fails; iterations 2 and 3 are NOT reported — they would be
    // duplicate lines, not authored steps left undone. The trailing top-level
    // step still reports skipped, as after any hard stop.
    expect(shape(result.steps)).toEqual([
      "repeat pass 3 times @0",
      "repeat pass iteration 1/3 @1",
      'assert fail visible "Nope" @1',
      "echo skip after @0",
    ]);
  });

  it("is not retry — a mid-run failure stops the flow rather than going around", async () => {
    // Iteration 1 taps; iteration 2's assert fails. A retry-flavored directive
    // would run iteration 3; repeat must not.
    currentTree = () => (tapCount === 0 ? screen([notification()]) : screen([]));
    await writeFlow("no-retry", {
      executionPrerequisite: "",
      steps: [
        {
          kind: "repeat",
          spec: { mode: "times", times: 3 },
          steps: [
            { kind: "assert", condition: "visible", selector: { text: "Clear notification" } },
            TAP,
          ],
        },
      ],
    });

    const result = await run("no-retry");

    expect(result.ok).toBe(false);
    expect(tapCount).toBe(1);
    expect(shape(result.steps).filter((s) => s.startsWith("repeat"))).toEqual([
      "repeat pass 3 times @0",
      "repeat pass iteration 1/3 @1",
      "repeat pass iteration 2/3 @1",
    ]);
  }, 15000);
});

describe("repeat: until", () => {
  it("drains until the guard holds and reports the iteration count", async () => {
    // Three notifications: each tap clears one, the fourth probe finds none.
    currentTree = () => (tapCount >= 3 ? screen([]) : screen([notification()]));
    await writeFlow("drain", {
      executionPrerequisite: "",
      steps: [
        {
          kind: "repeat",
          spec: {
            mode: "until",
            until: { kind: "ui", condition: "hidden", selector: { text: "Clear notification" } },
            max: 15,
          },
          steps: [TAP],
        },
      ],
    });

    const result = await run("drain");

    expect(result.ok).toBe(true);
    expect(tapCount).toBe(3);
    expect(shape(result.steps)).toEqual([
      'repeat pass until hidden "Clear notification" (max 15) @0',
      "repeat pass iteration 1 @1",
      'tap pass "Clear notification" @1',
      "repeat pass iteration 2 @1",
      'tap pass "Clear notification" @1',
      "repeat pass iteration 3 @1",
      'tap pass "Clear notification" @1',
      // Terminal line — what CI compares. The count is honest variability of
      // the world, not authored divergence.
      'repeat pass hidden text="Clear notification" after 3 iterations @0',
    ]);
    // As on a times marker, the bound is the whole opening line — and here a
    // `reason` would restate it in a SECOND spelling, since the target is built
    // with `selectorLabel` and the terminal line above with `describeSelector`.
    // Explicit for the same reason as there: {@link shape} shows a line's
    // reason only when it has no target, so it cannot see this one.
    expect(result.steps[0]?.reason).toBeUndefined();
    // That terminal line is an evaluated outcome, not structure: it counts.
    // Three taps plus the drain's own verdict — the markers count for nothing.
    expect(result.steps.at(-1)?.structural).toBeUndefined();
    expect(result.passed).toBe(4);
  }, 20000);

  it("converges the same way on a visible and on a text guard", async () => {
    // `hidden` is the drain's headline shape (clear a list until it is empty),
    // but the bound takes the whole guard vocabulary: a drain can equally run
    // until something APPEARS, or until an element READS a given value. Same
    // probe, same terminal line — only the label differs.
    //
    // The banner is IN the tree throughout and only gains a frame on the second
    // tap, so the drain converges on `visible` and would converge instantly on
    // `exists` — the guard's own condition is what ends it, not the selector.
    currentTree = () =>
      screen([
        notification(),
        n({
          label: `Remaining: ${Math.max(0, 2 - tapCount)}`,
          frame: { x: 0.1, y: 0.5, width: 0.5, height: 0.1 },
        }),
        n({
          label: "All done",
          frame:
            tapCount >= 2
              ? { x: 0.1, y: 0.7, width: 0.5, height: 0.1 }
              : { x: 0.1, y: 0.7, width: 0, height: 0 },
        }),
      ]);
    await writeFlow("until-visible", {
      executionPrerequisite: "",
      steps: [
        {
          kind: "repeat",
          spec: {
            mode: "until",
            until: { kind: "ui", condition: "visible", selector: { text: "All done" } },
            max: 5,
          },
          steps: [TAP],
        },
      ],
    });
    await writeFlow("until-text", {
      executionPrerequisite: "",
      steps: [
        {
          kind: "repeat",
          spec: {
            mode: "until",
            until: {
              kind: "ui",
              condition: "text",
              selector: { text: "Remaining" },
              expectedText: "Remaining: 0",
              textMatch: "equals",
            },
            max: 5,
          },
          steps: [TAP],
        },
      ],
    });

    const visible = await run("until-visible");
    tapCount = 0;
    const text = await run("until-text");

    expect(shape(visible.steps)).toEqual([
      'repeat pass until visible "All done" (max 5) @0',
      "repeat pass iteration 1 @1",
      'tap pass "Clear notification" @1',
      "repeat pass iteration 2 @1",
      'tap pass "Clear notification" @1',
      'repeat pass visible text="All done" after 2 iterations @0',
    ]);
    expect(shape(text.steps)).toEqual([
      'repeat pass until "Remaining" equals "Remaining: 0" (max 5) @0',
      "repeat pass iteration 1 @1",
      'tap pass "Clear notification" @1',
      "repeat pass iteration 2 @1",
      'tap pass "Clear notification" @1',
      'repeat pass text="Remaining" equals "Remaining: 0" after 2 iterations @0',
    ]);
    for (const result of [visible, text]) {
      // Two taps and the converged verdict — the drain's counting rule does not
      // depend on which condition kind ended it.
      expect(result.steps.at(-1)?.structural).toBeUndefined();
      expect(counts(result)).toEqual({ ok: true, passed: 3, failed: 0, skipped: 0, errored: 0 });
    }
  }, 20000);

  it("runs zero iterations when the guard already holds — a pass, with skip lines", async () => {
    currentTree = () => screen([]); // nothing to drain
    await writeFlow("already-drained", {
      executionPrerequisite: "",
      steps: [
        {
          kind: "repeat",
          spec: {
            mode: "until",
            until: { kind: "ui", condition: "hidden", selector: { text: "Clear notification" } },
            max: 10,
          },
          steps: [TAP, { kind: "await", condition: "hidden", selector: { text: "Toast" } }],
        },
      ],
    });

    const result = await run("already-drained");

    // An already-empty list is a converged drain, not a skipped block: the
    // terminal marker PASSES. The authored steps still report one skip line
    // each, at the depth they would have run at and between the block's opening
    // marker and its verdict — the bracketing a drain with work to do produces,
    // so the block brackets the same way whether or not there was work.
    expect(result.ok).toBe(true);
    expect(tapCount).toBe(0);
    expect(shape(result.steps)).toEqual([
      'repeat pass until hidden "Clear notification" (max 10) @0',
      'tap skip "Clear notification" @1',
      'await skip hidden "Toast" @1',
      'repeat pass hidden text="Clear notification" after 0 iterations @0',
    ]);
    expect(result.skipped).toBe(2);
    // The converged verdict is the only pass here — the opening marker is not.
    expect(result.passed).toBe(1);
  });

  it("fails when the cap is reached with the guard unmet", async () => {
    currentTree = () => screen([notification()]); // never drains
    await writeFlow("never-drains", {
      executionPrerequisite: "",
      steps: [
        {
          kind: "repeat",
          spec: {
            mode: "until",
            until: { kind: "ui", condition: "hidden", selector: { text: "Clear notification" } },
            max: 2,
          },
          steps: [TAP],
        },
        { kind: "echo", message: "after" },
      ],
    });

    const result = await run("never-drains");

    // A drain that did not converge asserts nothing if it passes.
    expect(result.ok).toBe(false);
    expect(result.failed).toBe(1);
    expect(tapCount).toBe(2);
    // No padding to `max` beyond the iterations that actually ran.
    expect(shape(result.steps).at(-2)).toBe(
      'repeat fail still not hidden text="Clear notification" after 2 iterations (max) @0'
    );
    expect(shape(result.steps).at(-1)).toBe("echo skip after @0");
    // The cap's fail is the verdict, never structure. Were it flagged it would
    // leave the counters, `failed === 0` would make `ok` true, and a drain that
    // never converged would report PASS — the one way this rule can do damage.
    expect(result.steps.at(-2)?.structural).toBeUndefined();
    expect(counts(result)).toEqual({ ok: false, passed: 2, failed: 1, skipped: 0, errored: 0 });
  }, 20000);

  it("errors the step when the guard cannot be evaluated", async () => {
    // A blind read is unknown, not false: it must not end a drain early NOR
    // keep it spinning.
    currentTree = () => screen([]);
    currentHint = "native-devtools disconnected";
    await writeFlow("blind", {
      executionPrerequisite: "",
      steps: [
        {
          kind: "repeat",
          spec: {
            mode: "until",
            until: { kind: "ui", condition: "hidden", selector: { text: "Clear notification" } },
            max: 5,
          },
          steps: [TAP],
        },
      ],
    });

    const result = await run("blind");

    expect(result.ok).toBe(false);
    expect(result.errored).toBe(1);
    expect(tapCount).toBe(0);
    // No iteration ran, so the body reports one skip line — inside the block,
    // between the opening marker and the guard's error, which closes it. The
    // error is the LAST line here, not the middle one.
    expect(result.steps[1]?.status).toBe("skip");
    expect(result.steps[1]?.depth).toBe(1);
    expect(result.steps[2]?.status).toBe("error");
    expect(result.steps[2]?.reason).toMatch(/could not evaluate until guard/i);
    // Same rule as the cap: the guard's error is an outcome and stays counted,
    // while the opening marker above it contributes no pass.
    expect(result.steps[2]?.structural).toBeUndefined();
    expect(result.passed).toBe(0);
  }, 20000);
});

describe("repeat: composition", () => {
  it("nests with when in both directions, stamping depth for the renderers", async () => {
    currentTree = () => screen([notification()]);
    await writeFlow("nested", {
      executionPrerequisite: "",
      steps: [
        {
          kind: "when",
          condition: { kind: "platform", platform: "ios" },
          steps: [
            {
              kind: "repeat",
              spec: { mode: "times", times: 2 },
              steps: [
                {
                  kind: "when",
                  condition: {
                    kind: "ui",
                    condition: "visible",
                    selector: { text: "Clear notification" },
                  },
                  steps: [TAP],
                },
              ],
            },
          ],
        },
      ],
    });

    const result = await run("nested");

    expect(result.ok).toBe(true);
    expect(tapCount).toBe(2);
    expect(shape(result.steps)).toEqual([
      "when pass platform ios @0",
      "repeat pass 2 times @1",
      "repeat pass iteration 1/2 @2",
      'when pass visible "Clear notification" @2',
      'tap pass "Clear notification" @3',
      "repeat pass iteration 2/2 @2",
      'when pass visible "Clear notification" @2',
      'tap pass "Clear notification" @3',
    ]);
  }, 15000);

  it("nests directly under itself, re-running the whole inner block per outer pass", async () => {
    // The multiplication the MAX_REPEAT_ITERATIONS docstring reasons about —
    // the bound is per-block and nested blocks multiply — at the smallest
    // product that shows it: one authored tap, 2 × 2 = 4 dispatched. The
    // parse/serialize round-trip covers repeat-in-repeat as data only; this is
    // the executing case, so it also pins where each line lands: the inner
    // block's marker sits inside the outer iteration that re-introduced it,
    // and its own iterations one level deeper again.
    currentTree = () => screen([notification()]);
    await writeFlow("squared", {
      executionPrerequisite: "",
      steps: [
        {
          kind: "repeat",
          spec: { mode: "times", times: 2 },
          steps: [{ kind: "repeat", spec: { mode: "times", times: 2 }, steps: [TAP] }],
        },
      ],
    });

    const result = await run("squared");

    expect(result.ok).toBe(true);
    expect(tapCount).toBe(4);
    const innerBlock = [
      "repeat pass 2 times @1",
      "repeat pass iteration 1/2 @2",
      'tap pass "Clear notification" @2',
      "repeat pass iteration 2/2 @2",
      'tap pass "Clear notification" @2',
    ];
    expect(shape(result.steps)).toEqual([
      "repeat pass 2 times @0",
      "repeat pass iteration 1/2 @1",
      ...innerBlock,
      "repeat pass iteration 2/2 @1",
      ...innerBlock,
    ]);
    // Outer and inner markers alike are block structure — only the taps count,
    // on both sides of the nesting boundary.
    expect(result.steps.filter((s) => s.structural)).toEqual(
      result.steps.filter((s) => s.kind === "repeat")
    );
    expect(counts(result)).toEqual({ ok: true, passed: 4, failed: 0, skipped: 0, errored: 0 });
  }, 15000);

  it("re-runs a run: fragment once per iteration, attributed to the fragment", async () => {
    // Both directions at once: a fragment invoked from inside a repeat body,
    // and a repeat block inside that fragment. The fragment is loaded and
    // expanded per iteration — it is not hoisted or expanded once — so the
    // inner block's two taps happen on every outer pass: 2 × 2 = 4.
    currentTree = () => screen([notification()]);
    await writeFlow("frag", {
      executionPrerequisite: "",
      steps: [{ kind: "repeat", spec: { mode: "times", times: 2 }, steps: [TAP] }],
    });
    await writeFlow("outer", {
      executionPrerequisite: "",
      steps: [
        {
          kind: "repeat",
          spec: { mode: "times", times: 2 },
          steps: [{ kind: "run", flow: "frag.yaml" }],
        },
      ],
    });

    const result = await run("outer");

    expect(result.ok).toBe(true);
    expect(tapCount).toBe(4);
    // Attribution follows the fragment boundary, not the block: everything from
    // the `run:` line inward says `frag`, so a reader can tell which file to
    // open — and depth keeps accumulating across it (the fragment's steps are
    // one deeper than the composition point, its own block one deeper again),
    // rather than restarting at the fragment's top level.
    const pass = [
      "repeat pass outer iteration N/2 @1",
      "run pass frag frag.yaml @1",
      "repeat pass frag 2 times @2",
      "repeat pass frag iteration 1/2 @3",
      'tap pass frag "Clear notification" @3',
      "repeat pass frag iteration 2/2 @3",
      'tap pass frag "Clear notification" @3',
    ];
    expect(attributed(result.steps)).toEqual([
      "repeat pass outer 2 times @0",
      ...pass.map((l) => l.replace("N/2", "1/2")),
      ...pass.map((l) => l.replace("N/2", "2/2")),
    ]);
    // Four taps and two composition points; every repeat line in the report is
    // a marker, so the block structure adds nothing to the totals on either
    // side of the fragment boundary.
    expect(counts(result)).toEqual({ ok: true, passed: 6, failed: 0, skipped: 0, errored: 0 });
    expect(result.steps.filter((s) => s.structural)).toEqual(
      result.steps.filter((s) => s.kind === "repeat")
    );
  }, 20000);

  it("stamps a fragment's repeat block from the composition point's depth", async () => {
    // The other direction on its own: no enclosing block, so the fragment's
    // repeat has only the `run:` to nest under — and the caller's next step
    // returns to depth 0 and to the caller's own name.
    currentTree = () => screen([notification()]);
    await writeFlow("frag", {
      executionPrerequisite: "",
      steps: [{ kind: "repeat", spec: { mode: "times", times: 2 }, steps: [TAP] }],
    });
    await writeFlow("caller", {
      executionPrerequisite: "",
      steps: [
        { kind: "run", flow: "frag.yaml" },
        { kind: "echo", message: "after" },
      ],
    });

    const result = await run("caller");

    expect(result.ok).toBe(true);
    expect(tapCount).toBe(2);
    expect(attributed(result.steps)).toEqual([
      "run pass frag frag.yaml @0",
      "repeat pass frag 2 times @1",
      "repeat pass frag iteration 1/2 @2",
      'tap pass frag "Clear notification" @2',
      "repeat pass frag iteration 2/2 @2",
      'tap pass frag "Clear notification" @2',
      "echo pass caller after @0",
    ]);
  }, 15000);

  it("expands a repeat block's authored steps once when a hard stop precedes it", async () => {
    currentTree = () => screen([]);
    await writeFlow("stopped-before", {
      executionPrerequisite: "",
      steps: [
        { kind: "assert", condition: "visible", selector: { text: "Nope" } },
        { kind: "repeat", spec: { mode: "times", times: 3 }, steps: [TAP] },
      ],
    });

    const result = await run("stopped-before");

    // One line per AUTHORED step, not per would-be iteration — the block never
    // ran, so its shape is what it was written as.
    expect(shape(result.steps)).toEqual([
      'assert fail visible "Nope" @0',
      "repeat skip 3 times @0",
      'tap skip "Clear notification" @1',
    ]);
  });

  it("reports a repeat block as skipped when the run is cancelled before it", async () => {
    currentTree = () => screen([]);
    const controller = new AbortController();
    controller.abort();
    await writeFlow("cancelled", {
      executionPrerequisite: "",
      steps: [{ kind: "repeat", spec: { mode: "times", times: 2 }, steps: [TAP] }],
    });

    const result = await run("cancelled", controller.signal);

    expect(result.aborted).toBe(true);
    expect(result.ok).toBe(false);
    expect(shape(result.steps)).toEqual([
      "repeat skip 2 times @0",
      'tap skip "Clear notification" @1',
    ]);
  });
});

/**
 * The parse fence rejects a literal `snapshot:` in a repeat body; these pin
 * the runtime fence for the composed spelling of the same flow, which parse
 * cannot see — a fragment resolves only at load, inside execRunStep. The
 * refusal must land on the `run:` step, before any fragment step runs: N
 * comparisons against one baseline is the shape the parser refuses, and under
 * --update-baselines it silently leaves the last iteration's pixels as the
 * baseline for the first iteration's screen.
 */
describe("repeat: snapshot smuggled in through a run: fragment", () => {
  const SNAPSHOT: FlowStep = { kind: "snapshot", name: "home" };
  const RUN_FRAG: FlowStep = { kind: "run", flow: "frag.yaml" };

  it("fails the run: step at fragment load, before any fragment step executes", async () => {
    currentTree = () => screen([notification()]);
    await writeFlow("frag", { executionPrerequisite: "", steps: [TAP, SNAPSHOT] });
    await writeFlow("smuggler", {
      executionPrerequisite: "",
      steps: [
        { kind: "repeat", spec: { mode: "times", times: 2 }, steps: [RUN_FRAG] },
        { kind: "echo", message: "after" },
      ],
    });

    const result = await run("smuggler");

    // The fence fires at load: no tap dispatched, no comparison made — the
    // fragment's steps never started.
    expect(result.ok).toBe(false);
    expect(tapCount).toBe(0);
    expect(vi.mocked(runSnapshot)).not.toHaveBeenCalled();
    // Marker, iteration 1, the failing run: line — then the hard stop carries
    // the trailing step to a skip. Iteration 2 is never reported: it would be
    // a re-run of a step already reported, not an authored step left undone.
    expect(attributed(result.steps)).toEqual([
      "repeat pass smuggler 2 times @0",
      "repeat pass smuggler iteration 1/2 @1",
      "run error frag frag.yaml @1",
      "echo skip smuggler after @0",
    ]);
    expect(result.steps[2]?.reason).toBe(
      'fragment "frag.yaml" contains snapshot "home", and this run: executes inside a repeat ' +
        "block — a snapshot name maps to one baseline, but the step would compare against it " +
        "once per iteration, and each iteration's screen legitimately differs; move the " +
        "snapshot after the block, or out of the fragment"
    );
    expect(counts(result)).toEqual({ ok: false, passed: 0, failed: 0, skipped: 0, errored: 1 });
  });

  it("still composes the same fragment outside any repeat — the fence is the block's, not the fragment's", async () => {
    currentTree = () => screen([notification()]);
    await writeFlow("frag", { executionPrerequisite: "", steps: [TAP, SNAPSHOT] });
    await writeFlow("straight", { executionPrerequisite: "", steps: [RUN_FRAG] });

    const result = await run("straight");

    expect(result.ok).toBe(true);
    expect(tapCount).toBe(1);
    expect(vi.mocked(runSnapshot)).toHaveBeenCalledTimes(1);
    expect(attributed(result.steps)).toEqual([
      "run pass frag frag.yaml @0",
      'tap pass frag "Clear notification" @1',
      'snapshot pass frag "home" @1',
    ]);
  }, 15000);

  it("propagates across a fragment chain — the nested fragment's own load refuses", async () => {
    // repeat → frag1 → frag2(snapshot): frag1 loads clean (no snapshot among
    // ITS steps) and starts executing; frag2's load fails frag1's run: step,
    // because inRepeat rode childScope's spread across the first composition
    // hop. The case a one-hop walk at the repeat boundary would miss.
    currentTree = () => screen([notification()]);
    await writeFlow("frag2", { executionPrerequisite: "", steps: [SNAPSHOT] });
    await writeFlow("frag1", {
      executionPrerequisite: "",
      steps: [{ kind: "run", flow: "frag2.yaml" }],
    });
    await writeFlow("nested-smuggler", {
      executionPrerequisite: "",
      steps: [
        {
          kind: "repeat",
          spec: { mode: "times", times: 2 },
          steps: [{ kind: "run", flow: "frag1.yaml" }],
        },
      ],
    });

    const result = await run("nested-smuggler");

    expect(result.ok).toBe(false);
    expect(vi.mocked(runSnapshot)).not.toHaveBeenCalled();
    expect(attributed(result.steps)).toEqual([
      "repeat pass nested-smuggler 2 times @0",
      "repeat pass nested-smuggler iteration 1/2 @1",
      "run pass frag1 frag1.yaml @1",
      "run error frag2 frag2.yaml @2",
    ]);
    expect(result.steps[3]?.reason).toContain('fragment "frag2.yaml" contains snapshot "home"');
  });

  it("finds a snapshot behind a when: inside the fragment — the walk descends blocks", async () => {
    // Same blockSteps descent the parse fence does: a guard around the
    // snapshot changes nothing about the one-baseline/N-comparisons shape.
    currentTree = () => screen([notification()]);
    await writeFlow("guarded-snap", {
      executionPrerequisite: "",
      steps: [
        {
          kind: "when",
          condition: { kind: "ui", condition: "visible", selector: { text: "X" } },
          steps: [SNAPSHOT],
        },
      ],
    });
    await writeFlow("guarded-smuggler", {
      executionPrerequisite: "",
      steps: [
        {
          kind: "repeat",
          spec: { mode: "times", times: 2 },
          steps: [{ kind: "run", flow: "guarded-snap.yaml" }],
        },
      ],
    });

    const result = await run("guarded-smuggler");

    expect(result.ok).toBe(false);
    expect(vi.mocked(runSnapshot)).not.toHaveBeenCalled();
    expect(result.steps[2]).toMatchObject({ kind: "run", status: "error" });
    expect(result.steps[2]?.reason).toContain('contains snapshot "home"');
  });
});

/**
 * A `repeat:` marker is scaffolding because of what the line IS, not because of
 * the path that reported it. Four sites report a block that will not run — a
 * hard stop, a cancellation, an enclosing block skipped, and the device-free
 * error the runner deliberately leaves counted (a structural line is dropped
 * from the counts whatever its status, so stamping an `error` would zero
 * `errored` and turn a broken run green). If only the executing site stamps
 * `structural`, the same block takes no step number when it runs and a number
 * when it is skipped over: every later step shifts by one between two runs of
 * one flow, and the skipped run's counts gain a step nobody wrote. {@link shape}
 * is blind to this (it never reads the flag), so these tests assert on
 * `structural`, on {@link numbered} and on the counters.
 */
describe("repeat: the block marker is structure wherever it is reported", () => {
  /**
   * The leading assert decides everything: with the notification on screen it
   * passes and the block runs, without it the assert fails and the hard stop
   * carries the block and the trailing step to the skip branch. Same flow file
   * both times, so any numbering difference is the runner's, not the author's.
   *
   * `times: 1` deliberately: the invariant is that the MARKER consumes no step
   * number, not that a block's followers are numbered alike whatever it does. A
   * `times: 3` block genuinely numbers three taps when it runs and one skipped
   * tap when it doesn't — one line per authored step is the promise, and the
   * body is authored once. At one iteration the two runs have the same counted
   * lines, so any shift left is the marker's alone.
   */
  const GUARDED: FlowStep[] = [
    { kind: "assert", condition: "visible", selector: { text: "Clear notification" } },
    { kind: "repeat", spec: { mode: "times", times: 1 }, steps: [TAP] },
    { kind: "wait", ms: 1 },
  ];

  it("gives the marker no step number whether the block ran or was skipped over", async () => {
    await writeFlow("guarded", { executionPrerequisite: "", steps: GUARDED });

    currentTree = () => screen([notification()]);
    const ran = await run("guarded");
    tapCount = 0;
    currentTree = () => screen([]);
    const stopped = await run("guarded");

    // Both reports open the block with the same line, and it is structure in
    // both — the executed marker has always been, the skipped one is the fix.
    expect(shape(ran.steps)[1]).toBe("repeat pass 1 time @0");
    expect(shape(stopped.steps)[1]).toBe("repeat skip 1 time @0");
    expect(ran.steps[1]?.structural).toBe(true);
    expect(stopped.steps[1]?.structural).toBe(true);
    // The point of the flag: `wait` is step 3 in both runs. Numbered, the
    // skipped marker would push it to 4 and no two runs of this flow could be
    // compared line for line.
    expect(numbered(ran.steps)).toEqual([
      '1 assert pass visible "Clear notification"',
      '2 tap pass "Clear notification"',
      "3 wait pass",
    ]);
    expect(numbered(stopped.steps)).toEqual([
      '1 assert fail visible "Clear notification"',
      '2 tap skip "Clear notification"',
      "3 wait skip",
    ]);
    // Three authored steps, three counted lines, in both runs — the marker adds
    // to neither total.
    expect(counts(ran)).toEqual({ ok: true, passed: 3, failed: 0, skipped: 0, errored: 0 });
    expect(counts(stopped)).toEqual({ ok: false, passed: 0, failed: 1, skipped: 2, errored: 0 });
  }, 15000);

  it("keeps the marker structural when the run is cancelled before the block", async () => {
    // The abort branch synthesizes its own line rather than reusing the
    // hard-stop one, so it needs its own proof. Aborting up front lands every
    // step there (the block) or on the hard-stop branch it sets (the wait).
    currentTree = () => screen([]);
    const controller = new AbortController();
    controller.abort();
    await writeFlow("cancelled-before", {
      executionPrerequisite: "",
      steps: [
        { kind: "repeat", spec: { mode: "times", times: 2 }, steps: [TAP] },
        { kind: "wait", ms: 1 },
      ],
    });

    const result = await run("cancelled-before", controller.signal);

    expect(shape(result.steps)).toEqual([
      "repeat skip 2 times @0",
      'tap skip "Clear notification" @1',
      "wait skip  @0",
    ]);
    expect(result.steps[0]?.structural).toBe(true);
    expect(numbered(result.steps)).toEqual(['1 tap skip "Clear notification"', "2 wait skip"]);
    // Two authored steps could not run; the marker is not a third.
    expect(counts(result)).toEqual({ ok: false, passed: 0, failed: 0, skipped: 2, errored: 0 });
  });

  it("keeps the marker structural for a block nested in a skipped when", async () => {
    // The fourth producer: an unmet guard expands its block through
    // reportBlockSkipped, which recurses into nested blocks — so a repeat only
    // ever reported from inside another block's skip must be structure too.
    currentTree = () => screen([]);
    await writeFlow("nested-in-when", {
      executionPrerequisite: "",
      steps: [
        {
          kind: "when",
          condition: { kind: "platform", platform: "android" }, // DEVICE is an iOS UDID
          steps: [{ kind: "repeat", spec: { mode: "times", times: 2 }, steps: [TAP] }],
        },
        { kind: "wait", ms: 1 },
      ],
    });

    const result = await run("nested-in-when");

    expect(shape(result.steps)).toEqual([
      "when skip platform android @0",
      "repeat skip 2 times @1",
      'tap skip "Clear notification" @2',
      "wait pass  @0",
    ]);
    // The `when:` marker is NOT structure — its guard really was evaluated, and
    // the skip it reports is the block's outcome. Only the repeat line is.
    expect(result.steps.map((s) => s.structural)).toEqual([undefined, true, undefined, undefined]);
    expect(numbered(result.steps)).toEqual([
      "1 when skip platform android",
      '2 tap skip "Clear notification"',
      "3 wait pass",
    ]);
    // An unmet guard is a successful omission, so the run still passes — and
    // the skips are the guard and the one authored step under it, not three.
    expect(counts(result)).toEqual({ ok: true, passed: 1, failed: 0, skipped: 2, errored: 0 });
  });
});

describe("repeat: cancellation inside the block", () => {
  /** Cancel the run from inside the Nth tap, so the abort lands mid-body. */
  function abortDuringTap(nth: number): AbortController {
    const controller = new AbortController();
    onTap = () => {
      if (tapCount === nth) controller.abort();
    };
    return controller;
  }

  it("says the block stopped when a times block is cancelled inside an iteration", async () => {
    currentTree = () => screen([notification()]);
    const controller = abortDuringTap(2);
    await writeFlow("cancelled-mid-times", {
      executionPrerequisite: "",
      steps: [{ kind: "repeat", spec: { mode: "times", times: 5 }, steps: [TAP] }],
    });

    const result = await run("cancelled-mid-times", controller.signal);

    // Iterations 3-5 never run — and the terminal line is the only thing in the
    // block saying so: without it this reads as five promised iterations, two
    // all-pass taps, and no account of the missing three. It carries the
    // block's bound, so it names what it closes rather than reading as a bare
    // `repeat — run aborted` (the reason itself says only that the run ended).
    expect(tapCount).toBe(2);
    expect(shape(result.steps)).toEqual([
      "repeat pass 5 times @0",
      "repeat pass iteration 1/5 @1",
      'tap pass "Clear notification" @1',
      "repeat pass iteration 2/5 @1",
      'tap pass "Clear notification" @1',
      "repeat skip 5 times @0",
    ]);
    expect(result.steps.at(-1)?.reason).toBe("run aborted");
    // The cancellation is the block's outcome, not scaffolding — and a skip,
    // never a fail: the caller gave up, the taps did nothing wrong.
    expect(result.steps.at(-1)?.structural).toBeUndefined();
    expect(result.aborted).toBe(true);
    expect(counts(result)).toEqual({ ok: false, passed: 2, failed: 0, skipped: 1, errored: 0 });
  }, 15000);

  it("says it the same way when a drain is cancelled inside an iteration", async () => {
    currentTree = () => screen([notification()]); // nothing clears it; only the abort ends this
    const controller = abortDuringTap(2);
    await writeFlow("cancelled-mid-drain", {
      executionPrerequisite: "",
      steps: [
        {
          kind: "repeat",
          spec: {
            mode: "until",
            until: { kind: "ui", condition: "hidden", selector: { text: "Clear notification" } },
            max: 10,
          },
          steps: [TAP],
        },
      ],
    });

    const result = await run("cancelled-mid-drain", controller.signal);

    // Byte-for-byte the line the probe boundary pushes below — where the abort
    // was noticed is an implementation detail, not something a report should
    // spell two ways.
    expect(tapCount).toBe(2);
    expect(shape(result.steps)).toEqual([
      'repeat pass until hidden "Clear notification" (max 10) @0',
      "repeat pass iteration 1 @1",
      'tap pass "Clear notification" @1',
      "repeat pass iteration 2 @1",
      'tap pass "Clear notification" @1',
      'repeat skip until hidden "Clear notification" (max 10) @0',
    ]);
    expect(result.steps.at(-1)?.reason).toBe("run aborted");
    expect(result.steps.at(-1)?.structural).toBeUndefined();
    expect(result.aborted).toBe(true);
    expect(counts(result)).toEqual({ ok: false, passed: 2, failed: 0, skipped: 1, errored: 0 });
  }, 20000);

  it("still says it when the abort lands with steps left in the body, in either bound", async () => {
    // The one-step bodies above cannot tell the block's two exits apart: the
    // abort lands on the body's last step, so `execSteps` runs out of steps
    // without entering its own abort branch and `stopped` stays false either
    // way. Leave a step behind the tap — the shape most flows have — and both
    // flags are true on return: `execSteps` skips the leftover as `run aborted`
    // and sets `stopped`. Only testing the abort first still reaches the
    // block's line; checking the cheap `stopped` first would drop it.
    currentTree = () => screen([notification()]);
    const ECHO: FlowStep = { kind: "echo", message: "after" };
    await writeFlow("cut-mid-body-times", {
      executionPrerequisite: "",
      steps: [{ kind: "repeat", spec: { mode: "times", times: 5 }, steps: [TAP, ECHO] }],
    });
    await writeFlow("cut-mid-body-drain", {
      executionPrerequisite: "",
      steps: [
        {
          kind: "repeat",
          spec: {
            mode: "until",
            until: { kind: "ui", condition: "hidden", selector: { text: "Clear notification" } },
            max: 10,
          },
          steps: [TAP, ECHO],
        },
      ],
    });

    const times = await run("cut-mid-body-times", abortDuringTap(2).signal);
    tapCount = 0;
    const drain = await run("cut-mid-body-drain", abortDuringTap(2).signal);

    // The leftover step reports its own skip one level in, then the block's
    // verdict closes the report at the enclosing depth — depth-1 skips under a
    // depth-0 line, never the other way round and never without it.
    expect(shape(times.steps)).toEqual([
      "repeat pass 5 times @0",
      "repeat pass iteration 1/5 @1",
      'tap pass "Clear notification" @1',
      "echo pass after @1",
      "repeat pass iteration 2/5 @1",
      'tap pass "Clear notification" @1',
      "echo skip after @1",
      "repeat skip 5 times @0",
    ]);
    expect(shape(drain.steps)).toEqual([
      'repeat pass until hidden "Clear notification" (max 10) @0',
      "repeat pass iteration 1 @1",
      'tap pass "Clear notification" @1',
      "echo pass after @1",
      "repeat pass iteration 2 @1",
      'tap pass "Clear notification" @1',
      "echo skip after @1",
      'repeat skip until hidden "Clear notification" (max 10) @0',
    ]);
    for (const result of [times, drain]) {
      // One shape for both bounds: the same reason, and the block's own bound
      // as the target — so the line that closes the block names the block the
      // opening marker announced, whichever way it was bounded.
      expect(result.steps.at(-1)?.reason).toBe("run aborted");
      expect(result.steps.at(-1)?.target).toBe(result.steps[0]?.target);
      expect(result.steps.at(-1)?.structural).toBeUndefined();
      expect(result.aborted).toBe(true);
      // Same totals as the one-step bodies: the skipped narration is not a test
      // step, so the block's verdict is still the only skip that counts.
      expect(counts(result)).toEqual({ ok: false, passed: 2, failed: 0, skipped: 1, errored: 0 });
    }
  }, 20000);

  it("reports a cancellation caught at the drain's guard probe unchanged", async () => {
    const controller = new AbortController();
    // Abort from inside the tree fetch, so the run is cancelled while the guard
    // is still polling — the other place this block can notice.
    currentTree = () => {
      controller.abort();
      return screen([notification()]);
    };
    await writeFlow("cancelled-at-probe", {
      executionPrerequisite: "",
      steps: [
        {
          kind: "repeat",
          spec: {
            mode: "until",
            until: { kind: "ui", condition: "hidden", selector: { text: "Clear notification" } },
            max: 10,
          },
          steps: [TAP],
        },
      ],
    });

    const result = await run("cancelled-at-probe", controller.signal);

    // No iteration ran, so the authored steps still report one skip line each,
    // bracketed by the block the way a cancellation caught mid-body brackets
    // its leftovers: opening marker, children one level deeper, then the shared
    // cancellation line closing the block at the enclosing depth.
    expect(tapCount).toBe(0);
    expect(shape(result.steps)).toEqual([
      'repeat pass until hidden "Clear notification" (max 10) @0',
      'tap skip "Clear notification" @1',
      'repeat skip until hidden "Clear notification" (max 10) @0',
    ]);
    expect(result.steps[2]?.reason).toBe("run aborted");
    // Same rule as the converged, capped and errored verdicts above: an
    // outcome, so it stays counted and out of the structural markers.
    expect(result.steps[2]?.structural).toBeUndefined();
    expect(result.aborted).toBe(true);
    expect(result.ok).toBe(false);
  }, 15000);

  it("adds no cancellation line when an iteration merely fails, in either bound", async () => {
    // `stopped` is set by an ordinary failure too. That exit stays silent: the
    // failing step's own line is the whole explanation, and "run aborted"
    // beside it would name a cancellation that never happened.
    currentTree = () => screen([notification()]);
    const FAILS: FlowStep = { kind: "assert", condition: "visible", selector: { text: "Nope" } };
    await writeFlow("fails-in-times", {
      executionPrerequisite: "",
      steps: [{ kind: "repeat", spec: { mode: "times", times: 3 }, steps: [FAILS] }],
    });
    await writeFlow("fails-in-drain", {
      executionPrerequisite: "",
      steps: [
        {
          kind: "repeat",
          spec: {
            mode: "until",
            until: { kind: "ui", condition: "hidden", selector: { text: "Clear notification" } },
            max: 5,
          },
          steps: [FAILS],
        },
      ],
    });

    const times = await run("fails-in-times");
    const drain = await run("fails-in-drain");

    expect(shape(times.steps)).toEqual([
      "repeat pass 3 times @0",
      "repeat pass iteration 1/3 @1",
      'assert fail visible "Nope" @1',
    ]);
    expect(shape(drain.steps)).toEqual([
      'repeat pass until hidden "Clear notification" (max 5) @0',
      "repeat pass iteration 1 @1",
      'assert fail visible "Nope" @1',
    ]);
    for (const result of [times, drain]) {
      expect(result.steps.some((s) => s.reason === "run aborted")).toBe(false);
      expect(result.aborted).toBeUndefined();
      expect(counts(result)).toEqual({ ok: false, passed: 0, failed: 1, skipped: 0, errored: 0 });
    }
  }, 20000);
});
