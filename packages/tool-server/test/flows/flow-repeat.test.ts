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

  it("rejects a zero, fractional, oversized, or non-numeric bound at every spelling", () => {
    // The bound check is reached from three sites — the bare-integer sugar,
    // `{ times: N }`, and a drain's `max: N` — so each spelling is pinned on
    // its own, against the message naming its own field. `max` is the drain's
    // only exit besides convergence: unvalidated, `max: 0` or a non-number is
    // an uncapped run, not a parse error.
    for (const bad of ["0", "1.5", "101"]) {
      expect(() => parseFlow(`steps:\n  - repeat: ${bad}\n    steps: [{ tap: A }]\n`)).toThrow(
        /repeat\.times must be a literal integer between 1 and 100/i
      );
    }
    for (const bad of ["0", "1.5", "1000000000", "ab"]) {
      expect(() =>
        parseFlow(`steps:\n  - repeat: { times: ${bad} }\n    steps: [{ tap: A }]\n`)
      ).toThrow(/repeat\.times must be a literal integer between 1 and 100/i);
    }
    for (const bad of ["0", "1.5", "101", "ab"]) {
      expect(() =>
        parseFlow(
          `steps:\n  - repeat: { until: { hidden: Toast }, max: ${bad} }\n    steps: [{ tap: A }]\n`
        )
      ).toThrow(/repeat\.max must be a literal integer between 1 and 100/i);
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

  it("rejects a timeout on the until guard, pointing at the body's own await", () => {
    // The refusal carries the remedy: an author who wants to widen the settling
    // widens the body, since the guard's own window is not theirs to set.
    expect(() =>
      parseFlow(
        "steps:\n  - repeat: { until: { hidden: X, timeout: 5000 } }\n    steps: [{ tap: A }]\n"
      )
    ).toThrow(/repeat\.until takes no timeout.*end the block's steps with an `await:`/is);
  });

  it("rejects a {{secret:…}} placeholder in the until guard", () => {
    expect(() =>
      parseFlow(
        "steps:\n  - repeat: { until: { hidden: '{{secret:APP_PASSWORD}}' } }\n    steps: [{ tap: A }]\n"
      )
    ).toThrow(/repeat\.until takes no \{\{secret/i);
  });

  it("points every until error at the repeat bound the author wrote", () => {
    // The guard is not a step: an error echoing it alone would show a
    // `{"until":…}` entry that appears nowhere in the file, so the echo is the
    // `{ repeat: … }` wrap — a key the author wrote, and bounded by the bound
    // rather than the step's body (the truncation test below). Each message
    // names `repeat.until` to point inside that wrap.
    for (const guard of [
      "{ platform: ios }",
      "{}",
      "{ hidden: X, timeout: 5000 }",
      "{ hidden: '{{secret:APP_PASSWORD}}' }",
      "{ text: { in: A, contain: x } }",
      // One guard per until-reachable error site inside parseWaitFields (the
      // selector-shaped ones echo their own fragment and are pinned in the test
      // below): stray guard key, non-map text body, comparator count, empty
      // comparator, invalid regex pattern.
      "{ visible: A, bogus: 1 }",
      "{ text: nope }",
      "{ text: { in: A } }",
      "{ text: { in: A, contains: '' } }",
      "{ text: { in: A, matches: '[' } }",
    ]) {
      expect(
        () => parseFlow(`steps:\n  - repeat: { until: ${guard} }\n    steps: [{ tap: A }]\n`),
        guard
      ).toThrow(/repeat\.until\b.*: \{"repeat":\{"until":\{.*\}\}\}$/s);
    }
  });

  it("echoes the bound untruncated when a long steps-first body precedes it", () => {
    // YAML mapping keys are unordered: with `steps:` written first, an echo of
    // the whole step would hit the 200-char render cap before reaching
    // `repeat`, truncating away the very part the message names. The
    // `{ repeat: … }` wrap is bounded by the bound, so the `$`-anchored full
    // echo below cannot be pushed off by the body at either error site.
    const longBody = [
      '      - tap: { text: "Load more results from the server and then some more" }',
      '      - await: { visible: "Results loaded successfully after a long wait" }',
      '      - tap: { text: "Dismiss the notification banner at the top of screen" }',
    ].join("\n");
    expect(() =>
      parseFlow(`steps:\n  - steps:\n${longBody}\n    repeat: { until: { visible: A, zzz: 1 } }\n`)
    ).toThrow(
      /repeat\.until has unknown key `zzz`.*: \{"repeat":\{"until":\{"visible":"A","zzz":1\}\}\}$/s
    );
    expect(() => parseFlow(`steps:\n  - steps:\n${longBody}\n    repeat: 0\n`)).toThrow(
      /repeat\.times must be a literal integer between 1 and 100.*: \{"repeat":0\}$/s
    );
  });

  it("names repeat.until at every until-reachable error site in the guard parser", () => {
    // The guard shares parseWaitFields with await/assert, and every error site
    // in there spells its label through directiveLabel — one exact-message
    // sample per reachable site, so a single site reverting to the bare
    // directive name (`until …`) fails here instead of hiding behind the sites
    // the entry-echo loop above happens to hit first.
    const cases: [string, RegExp][] = [
      // top-level unknown key — rejectUnknownKeys(entry, b, …, label); the
      // allowed-keys list doubles as proof `until` offers no `timeout`
      [
        "{ visible: A, bogus: 1 }",
        /repeat\.until has unknown key `bogus` — allowed keys: exists, visible, hidden, text/,
      ],
      // text-body unknown key — the `${label}.text` spelling
      [
        "{ text: { in: A, contain: x } }",
        /repeat\.until\.text has unknown key `contain` \(did you mean `contains`\?\)/,
      ],
      // text-condition field checks — badEntry(entry, `${label} text …`)
      [
        "{ text: nope }",
        /repeat\.until text needs \{ in: <selector>, contains\|equals\|matches: <string> \}/,
      ],
      [
        "{ text: { in: A } }",
        /repeat\.until text needs exactly one of `contains`, `equals`, or `matches`/,
      ],
      ["{ text: { in: A, contains: '' } }", /repeat\.until text needs a non-empty `contains`/],
      [
        "{ text: { in: A, matches: '[' } }",
        /repeat\.until text `matches` is not a valid regular expression/,
      ],
    ];
    for (const [guard, message] of cases) {
      expect(
        () => parseFlow(`steps:\n  - repeat: { until: ${guard} }\n    steps: [{ tap: A }]\n`),
        guard
      ).toThrow(message);
    }
    // Selector-shaped errors go through parseSelector, whose two call sites
    // spell the label `${label}.<condition>` and `${label}.text.in`. Unlike the
    // sites above it echoes the selector fragment it was handed, not the whole
    // repeat step — the label carries the path back to the step, so both parts
    // are pinned together here.
    expect(() =>
      parseFlow("steps:\n  - repeat: { until: { visible: { txt: A } } }\n    steps: [{ tap: A }]\n")
    ).toThrow(
      /repeat\.until\.visible: selector has unknown key `txt` \(did you mean `text`\?\).*: \{"txt":"A"\}$/s
    );
    expect(() =>
      parseFlow(
        "steps:\n  - repeat: { until: { text: { in: { idd: list }, contains: x } } }\n    steps: [{ tap: A }]\n"
      )
    ).toThrow(
      /repeat\.until\.text\.in: selector has unknown key `idd` \(did you mean `id`\?\).*: \{"idd":"list"\}$/s
    );
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

  it("echoes the bound untruncated when a long steps-first body holds the snapshot", () => {
    // Same unordered-keys hazard as the bound errors above: an echo of the
    // whole step hits the 200-char render cap inside the body, so the
    // `{ repeat: … }` wrap is what identifies the block the message refuses.
    // The message already names the snapshot, so the `$`-anchored match is what
    // proves the echo survived rather than being elided into `…(+N chars)`.
    const longBody = [
      '      - tap: { text: "Load more results from the server and then some more" }',
      '      - await: { visible: "Results loaded successfully after a long wait" }',
      '      - tap: { text: "Dismiss the notification banner at the top of screen" }',
      "      - snapshot: home",
    ].join("\n");
    expect(() => parseFlow(`steps:\n  - steps:\n${longBody}\n    repeat: 2\n`)).toThrow(
      /snapshot "home" cannot run inside a repeat block.*: \{"repeat":2\}$/s
    );
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

  it("spells the remedy against the step the file actually has", () => {
    // The refusal is only actionable if it names something to delete. Wrapped,
    // the flow's own first step is the block, so "drop the leading launch" —
    // the unwrapped spelling's remedy, and the one this reached before —
    // sends the author looking for a top-level launch that is not there. The
    // message also travels to flow-add-step, flow-add-echo and
    // flow-finish-recording, which show it verbatim.
    const wrapped = (): void => {
      parseFlow(
        "executionPrerequisite: nope\nsteps:\n  - repeat: 1\n    steps: [{ launch: com.acme.app }]\n"
      );
    };
    // Both halves the comment called untrue: the opener claimed a launch STEP
    // the file has not got, and the remedy named one to delete.
    expect(wrapped).toThrow(/A flow that starts by launching an app/);
    expect(wrapped).not.toThrow(/starts with a launch step/i);
    expect(wrapped).toThrow(/out of the repeat block around it/i);
    expect(wrapped).not.toThrow(/Drop the leading launch to make it a fragment/i);

    // Which block is not claimed, only that there is one: the launch-bearing
    // block need not be the flow's first step, and naming the opening block
    // would send the author into an all-echo one that holds no launch.
    const behindNarration = (): void => {
      parseFlow(
        "executionPrerequisite: nope\n" +
          "steps:\n" +
          "  - repeat: 2\n" +
          "    steps: [{ echo: warming up }]\n" +
          "  - repeat: 2\n" +
          "    steps: [{ launch: com.acme.app }]\n"
      );
    };
    expect(behindNarration).toThrow(/out of the repeat block around it/i);

    // The unwrapped spelling keeps the direct remedy: there the leading launch
    // IS a top-level step, and naming the block would be the mirror error.
    const direct = (): void => {
      parseFlow("executionPrerequisite: nope\nsteps:\n  - launch: com.acme.app\n");
    };
    expect(direct).toThrow(/Drop the leading launch to make it a fragment/i);
    expect(direct).not.toThrow(/repeat block/i);
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
    // The scan's "false" arm through the descent: the body's tap is the flow's
    // first executable step, so the launch after the block no longer leads and
    // the flow is an ordinary fragment.
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

  // The run-time twin of the same rule. Parse validates one file, so a chain
  // that only reaches its launch across a `run:` hop is the runner's to refuse
  // — and its refusal has to spell the remedy against the same reading, or the
  // wrapped spelling is told to delete a step the named fragment has not got.
  it("spells the block remedy when the launch a run: hop reaches is wrapped in a times block", async () => {
    await writeFlow("blocked-launch", {
      executionPrerequisite: "",
      steps: [
        {
          kind: "repeat",
          spec: { mode: "times", times: 1 },
          steps: [{ kind: "launch", app: "com.acme.app" }],
        },
      ],
    });
    await writeFlow("gated-blocked", {
      executionPrerequisite: "on the profile screen",
      steps: [{ kind: "run", flow: "blocked-launch.yaml" }],
    });

    const refusal = run("gated-blocked");

    await expect(refusal).rejects.toThrow(/must not declare executionPrerequisite/i);
    // The fragment that carries the launch is still what the message names —
    // the block reading tells the author what to do once that file is open.
    await expect(refusal).rejects.toThrow(/leading launch in "blocked-launch"/);
    await expect(refusal).rejects.toThrow(
      /in "blocked-launch" out of the repeat block around it \(or drop the block\) to make it a fragment/
    );
  });

  it("keeps the direct remedy when the fragment's own first step is the launch", async () => {
    // The control the wording above is only distinguishable against: same
    // cross-file chain, unwrapped launch. Naming a repeat block here would be
    // the mirror error, and the phrasing is what flow-add-step and the CLI
    // print verbatim, so it is pinned whole.
    await writeFlow("direct-launch", {
      executionPrerequisite: "",
      steps: [{ kind: "launch", app: "com.acme.app" }],
    });
    await writeFlow("gated-direct", {
      executionPrerequisite: "on the profile screen",
      steps: [{ kind: "run", flow: "direct-launch.yaml" }],
    });

    const refusal = run("gated-direct");

    await expect(refusal).rejects.toThrow(
      /Drop the leading launch in "direct-launch" to make it a fragment, or drop executionPrerequisite from "gated-direct"\./
    );
    await expect(refusal).rejects.not.toThrow(/repeat block/i);
  });

  it("reads the block against the file the message names, not the chain into it", async () => {
    // A `run:` hop is a file hop, not a block: the fragment's launch is its own
    // top-level step, and whatever wrapped the `run:` that reached it is in a
    // different file from the one the author is being sent to. Carrying the
    // wrap across the hop would send them looking for a repeat block that file
    // has not got — the same misdirection, one hop over.
    await writeFlow("direct-launch", {
      executionPrerequisite: "",
      steps: [{ kind: "launch", app: "com.acme.app" }],
    });
    await writeFlow("gated-wrapping-run", {
      executionPrerequisite: "on the profile screen",
      steps: [
        {
          kind: "repeat",
          spec: { mode: "times", times: 1 },
          steps: [{ kind: "run", flow: "direct-launch.yaml" }],
        },
      ],
    });

    const refusal = run("gated-wrapping-run");

    await expect(refusal).rejects.toThrow(
      /Drop the leading launch in "direct-launch" to make it a fragment/
    );
    await expect(refusal).rejects.not.toThrow(/repeat block/i);
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
    // Each stand-in says WHY it was skipped, and it is this branch's own
    // reason. Pinned on `reason` directly: {@link shape} folds
    // `target ?? message ?? reason`, so on a line with a target — every
    // stand-in above — it renders the target and the reason is invisible to
    // it. Swapped with the errored branch's string, a PASSING zero-iteration
    // drain would tell the operator its body was skipped because the "until
    // guard errored".
    expect(result.steps.slice(1, 3).map((s) => s.reason)).toEqual([
      "until guard already met",
      "until guard already met",
    ]);
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

  it("names the failed final read on the cap verdict when the last probe blipped", async () => {
    // The trailing-blip tolerance, met at the cap. The tree source disconnects
    // inside the LAST probe only, ~one poll before that probe's 1s deadline:
    // trusted reads carry the whole window bar its tail, so the probe answers
    // "still unmet" determinately instead of erroring the block — and the read
    // that failed under that answer belongs on the line the answer produces.
    // Dropped, the report tells the author the app never reached the state and
    // says nothing about the runner having gone blind while concluding it,
    // which is the one fact that would send them to the tree source rather
    // than to the app.
    //
    // `visible`, not this suite's usual `hidden`: gone-ness is unconfirmable
    // over ANY failed final read, so a `hidden` drain has no determinate-unmet
    // blip to carry — it errors on the evidence gap instead (flow-when covers
    // that bar). The guard element never appears, so the drain runs to its cap.
    let darkFrom: number | undefined;
    currentTree = () => {
      // The taps resolve their target at `tapCount` 0 and 1, so only the third
      // probe — the one that finds `done >= max` — ever sees the dark branch.
      if (tapCount < 2) return screen([notification()]);
      darkFrom ??= Date.now();
      if (Date.now() - darkFrom >= 950) throw new Error("native devtools disconnected");
      return screen([notification()]);
    };
    await writeFlow("dark-at-the-cap", {
      executionPrerequisite: "",
      steps: [
        {
          kind: "repeat",
          spec: {
            mode: "until",
            until: { kind: "ui", condition: "visible", selector: { text: "All caught up" } },
            max: 2,
          },
          steps: [TAP],
        },
      ],
    });

    const result = await run("dark-at-the-cap");

    // A fail, not an error: the verdict stayed determinate.
    expect(result.ok).toBe(false);
    expect(result.failed).toBe(1);
    expect(result.errored).toBe(0);
    expect(tapCount).toBe(2);
    // Pinned on `reason` directly — the string the renderers print, cap tag and
    // failed read both.
    expect(result.steps.at(-1)?.status).toBe("fail");
    expect(result.steps.at(-1)?.reason).toBe(
      'still not visible text="All caught up" after 2 iterations (max) ' +
        "(the final poll could not read the UI tree: native devtools disconnected)"
    );
  }, 20000);

  it("passes a drain that converges on exactly its max-th iteration", async () => {
    // Three items, `max: 3` — the bound set to the number of items the author
    // expects, the cap's common shape. The third tap empties the list, so the
    // probe that finds the guard met is the same one at which `done >= max`
    // first holds. Convergence wins: the cap fires only while the guard is
    // still unmet, which makes `max` an inclusive bound — tested cap-first,
    // this exact run would flip to the fail above with the same three taps.
    currentTree = () => (tapCount >= 3 ? screen([]) : screen([notification()]));
    await writeFlow("exact-max", {
      executionPrerequisite: "",
      steps: [
        {
          kind: "repeat",
          spec: {
            mode: "until",
            until: { kind: "ui", condition: "hidden", selector: { text: "Clear notification" } },
            max: 3,
          },
          steps: [TAP],
        },
      ],
    });

    const result = await run("exact-max");

    expect(result.ok).toBe(true);
    expect(tapCount).toBe(3);
    // The converged pass, no `(max)` tag — pinned on `reason` directly, so the
    // string is the very one the renderers print.
    expect(result.steps.at(-1)?.status).toBe("pass");
    expect(result.steps.at(-1)?.reason).toBe('hidden text="Clear notification" after 3 iterations');
    // Three taps plus the drain's own verdict; nothing failed at the cap.
    expect(counts(result)).toEqual({ ok: true, passed: 4, failed: 0, skipped: 0, errored: 0 });
  }, 20000);

  it("says `after 1 iteration`, singular, when one pass converges or a max of 1 caps", async () => {
    // The count in a drain's terminal reason can be exactly 1 in both
    // directions: a one-item list converges after a single pass, and `max: 1`
    // is a legal bound (the range starts at 1). The `times` marker pins its
    // `1 time` twice; these are the drain verdicts' — asserted on `reason`
    // directly, so the string is the very one the renderers print.
    currentTree = () => (tapCount >= 1 ? screen([]) : screen([notification()]));
    await writeFlow("drains-in-one", {
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
    await writeFlow("capped-at-one", {
      executionPrerequisite: "",
      steps: [
        {
          kind: "repeat",
          spec: {
            mode: "until",
            until: { kind: "ui", condition: "hidden", selector: { text: "Clear notification" } },
            max: 1,
          },
          steps: [TAP],
        },
      ],
    });

    const converged = await run("drains-in-one");
    tapCount = 0;
    currentTree = () => screen([notification()]); // never drains
    const capped = await run("capped-at-one");

    expect(converged.ok).toBe(true);
    expect(converged.steps.at(-1)?.reason).toBe(
      'hidden text="Clear notification" after 1 iteration'
    );
    expect(capped.ok).toBe(false);
    expect(capped.steps.at(-1)?.reason).toBe(
      'still not hidden text="Clear notification" after 1 iteration (max)'
    );
    // Both drains really made exactly one pass — the singular is the truth,
    // not a happened-to-match template.
    expect(tapCount).toBe(1);
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
        { kind: "echo", message: "after" },
      ],
    });

    const result = await run("blind");

    expect(result.ok).toBe(false);
    expect(result.errored).toBe(1);
    expect(tapCount).toBe(0);
    // No iteration ran, so the body reports one skip line — inside the block,
    // between the opening marker and the guard's error, which closes it. The
    // stand-in carries this branch's own reason, pinned directly for the same
    // cause as the converged branch's "until guard already met": {@link shape}
    // renders a skipped tap's target, never its reason — and swapped, an
    // errored drain would explain its un-run body with an already-met guard.
    expect(result.steps[1]?.status).toBe("skip");
    expect(result.steps[1]?.depth).toBe(1);
    expect(result.steps[1]?.reason).toBe("until guard errored");
    expect(result.steps[2]?.status).toBe("error");
    expect(result.steps[2]?.reason).toMatch(/could not evaluate until guard/i);
    // Same rule as the cap: the guard's error is an outcome and stays counted,
    // while the opening marker above it contributes no pass.
    expect(result.steps[2]?.structural).toBeUndefined();
    expect(result.passed).toBe(0);
    // An unevaluable guard is a hard stop, exactly like the cap's fail above:
    // the step after the block skips instead of running against a screen the
    // runner just said it cannot read. A bare skip, not a stand-in — the
    // hard-stop branch stamps no reason.
    expect(shape(result.steps).at(-1)).toBe("echo skip after @0");
    expect(result.steps.at(-1)?.reason).toBeUndefined();
  }, 20000);

  it("errors a later probe without re-listing the body — one iteration already reported", async () => {
    // The `done === 0` bracketing above is for a body that never got to say
    // anything. Here the first probe sees the notification (a trusted, unmet
    // read) and the body runs; the tap flips the screen to the blind read that
    // makes the SECOND probe indeterminate. The authored steps must NOT come
    // back as stand-in skips — their lines are already in the report — and the
    // guard's error still hard-stops the flow, carrying the trailing step to a
    // skip: iterating on against an unreadable screen is the one thing this
    // branch exists to prevent.
    currentTree = () => (tapCount >= 1 ? screen([]) : screen([notification()]));
    onTap = () => {
      currentHint = "native-devtools disconnected";
    };
    await writeFlow("blind-later", {
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
        { kind: "echo", message: "after" },
      ],
    });

    const result = await run("blind-later");

    expect(result.ok).toBe(false);
    expect(tapCount).toBe(1);
    // Strict equality is the proof: no skip line stands in for the tap between
    // its executed pass and the error verdict that closes the block.
    expect(shape(result.steps)).toEqual([
      'repeat pass until hidden "Clear notification" (max 5) @0',
      "repeat pass iteration 1 @1",
      'tap pass "Clear notification" @1',
      'repeat error could not evaluate until guard (hidden text="Clear notification"): ' +
        "could not evaluate the condition — every read of the UI tree was empty or degraded @0",
      "echo skip after @0",
    ]);
    expect(counts(result)).toEqual({ ok: false, passed: 1, failed: 0, skipped: 0, errored: 1 });
  }, 20000);

  /**
   * Reads the list stays torn down for after a tap. Sized above what one guard
   * probe can spend — it polls its ~1s grace every 300ms, six reads at the very
   * most — so the gap outlasts any probe of the screen and only a step that
   * WAITS for the rebuilt list gets past it. At one read wide it would instead
   * be consumed by any step that reads the tree once, whatever that step's
   * polarity, and the tests below would agree by accident rather than by the
   * property they are about.
   */
  const GAP_READS = 8;

  /**
   * A three-row list that rebuilds asynchronously: the next {@link GAP_READS}
   * reads after each tap find the list gone, every read after those finds the
   * rows that are left. That is refetch-after-mutate (equally a key-less
   * re-render, or a list data change) modelled off the READ SEQUENCE rather
   * than off the wall clock, so the three tests below differ in the flow they
   * run and in nothing else.
   *
   * The page chrome outlives the gap, as it does in a real re-render. Nothing
   * marks those reads as suspect either — no degraded hint, and the selector
   * has not matched earlier in the same probe — so the drain trusts them and
   * concludes `hidden` from them, which is exactly the hazard below.
   */
  function useRebuildingList(): void {
    let gapReads = 0;
    onTap = () => {
      gapReads = GAP_READS;
    };
    currentTree = () => {
      const mid = gapReads > 0;
      if (mid) gapReads--;
      const left = Math.max(0, 3 - tapCount);
      return screen([
        n({ label: `${left} left`, frame: { x: 0.1, y: 0.8, width: 0.5, height: 0.05 } }),
        ...(mid
          ? []
          : [
              n({ identifier: "notification-list", frame: { x: 0, y: 0, width: 1, height: 0.7 } }),
              ...Array.from({ length: left }, notification),
            ]),
      ]);
    };
  }

  /** Rows on screen once the list has finished rebuilding. */
  function rowsLeft(): number {
    // Absorbs however much of a re-render gap the run left pending.
    for (let i = 0; i < GAP_READS; i++) currentTree();
    return currentTree().children.filter((c) => c.label === "Clear notification").length;
  }

  it("takes the body's own re-render gap for convergence — recorded, not endorsed", async () => {
    // A REAL HAZARD, pinned as it stands rather than as a nicety: `hidden` is
    // satisfied by the first poll that finds no match, and the guard is probed
    // directly after the body mutated the screen — so a body that tears its
    // list down and rebuilds it asynchronously is read inside its own gap, and
    // the drain absorbs that gap as convergence: one iteration, a green pass,
    // two thirds of the list still on screen.
    //
    // Deliberately unguarded — do not "fix" this. No signal in a read separates
    // a re-render gap from a converged drain, so a confirming hold could only
    // be a guess: it would cost every clean drain its length and still miss a
    // gap longer than it. And the probe is `when:`/`assert:`'s own
    // (`probeWhenCondition`), so reading the screen differently under `until`
    // would give one condition two meanings in one file. The settling belongs
    // to the body instead, which is what the next test writes.
    useRebuildingList();
    await writeFlow("gap-drain", {
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

    const result = await run("gap-drain");

    expect(result.ok).toBe(true);
    expect(tapCount).toBe(1);
    expect(shape(result.steps)).toEqual([
      'repeat pass until hidden "Clear notification" (max 15) @0',
      "repeat pass iteration 1 @1",
      'tap pass "Clear notification" @1',
      'repeat pass hidden text="Clear notification" after 1 iteration @0',
    ]);
    // The verdict line is true about the instant it was taken and the run is
    // green, so with no trailing assertion nothing in the report says the list
    // the drain existed to empty is still two thirds full.
    expect(counts(result)).toEqual({ ok: true, passed: 2, failed: 0, skipped: 0, errored: 0 });
    expect(rowsLeft()).toBe(2);
  }, 20000);

  it("drains that same list correctly when the body waits for the rebuild", async () => {
    // The remedy, on the identical fixture: the body ends with an `await:` for
    // the state the next probe must read. What clears the gap is POLARITY, not
    // budget. A negative condition — the guard, and an `await: { hidden }`
    // alike — returns on the first read that finds no match, and inside a
    // teardown that is its very first read, so no window of any size outlasts
    // the gap (the test below gives one a 10s budget and it still returns
    // mid-gap). An `await:` for the rebuilt list polls a POSITIVE condition and
    // cannot return until it sees the rebuild, so it holds the iteration open
    // across all GAP_READS reads and the probe after it lands on a rebuilt
    // list. Three taps, an empty list, `after 3 iterations`.
    //
    // Sensitivity is the tests either side: drop this one step and the very
    // same fixture converges after ONE iteration with two rows left; keep the
    // step but flip its polarity and it does the same. The awaited element is
    // the list container, not a row, because the last iteration legitimately
    // leaves no rows — a `visible` await on a row would fail the run exactly
    // when the drain is finally right.
    //
    // ~11s of wall clock: three waits of GAP_READS polls 300ms apart, plus the
    // three guard probes that come back unmet at ~1s each and the taps' own
    // settle on top. The gap is read-driven, so load moves the clock and
    // nothing else — hence the 40s budget it shares with the settled cart
    // below.
    useRebuildingList();
    await writeFlow("settled-drain", {
      executionPrerequisite: "",
      steps: [
        {
          kind: "repeat",
          spec: {
            mode: "until",
            until: { kind: "ui", condition: "hidden", selector: { text: "Clear notification" } },
            max: 15,
          },
          steps: [
            TAP,
            { kind: "await", condition: "visible", selector: { identifier: "notification-list" } },
          ],
        },
      ],
    });

    const result = await run("settled-drain");

    expect(result.ok).toBe(true);
    expect(tapCount).toBe(3);
    const iteration = (nth: number): string[] => [
      `repeat pass iteration ${nth} @1`,
      'tap pass "Clear notification" @1',
      "await pass visible id=notification-list @1",
    ];
    expect(shape(result.steps)).toEqual([
      'repeat pass until hidden "Clear notification" (max 15) @0',
      ...iteration(1),
      ...iteration(2),
      ...iteration(3),
      'repeat pass hidden text="Clear notification" after 3 iterations @0',
    ]);
    expect(rowsLeft()).toBe(0);
  }, 40000);

  it("takes the gap all the same when the body's wait is negative — polarity, not budget", async () => {
    // The polarity claim above, pinned rather than asserted. Same fixture, same
    // body shape, one `await: { hidden }` where the test above has the positive
    // wait, and a 10s budget where the guard gets ~1s: `hidden` is satisfied by
    // the first read that finds no match, so the wait returns on read 1 of
    // GAP_READS having held nothing open, and the probe after it reads the same
    // torn-down list the hazard test read. One iteration, a green pass, two
    // rows left — the hazard intact, with a wait in the body and a budget ten
    // times the guard's that it never needs to spend.
    //
    // This also pins the fixture's gap WIDTH against a regression to one read:
    // at one read this body's own wait would consume the whole teardown, the
    // drain would empty the list, and the remedy test above would pass for a
    // reason that has nothing to do with the settling it is about.
    useRebuildingList();
    await writeFlow("gap-await", {
      executionPrerequisite: "",
      steps: [
        {
          kind: "repeat",
          spec: {
            mode: "until",
            until: { kind: "ui", condition: "hidden", selector: { text: "Clear notification" } },
            max: 15,
          },
          steps: [
            TAP,
            {
              kind: "await",
              condition: "hidden",
              selector: { text: "Clear notification" },
              timeout: 10000,
            },
          ],
        },
      ],
    });

    const result = await run("gap-await");

    expect(result.ok).toBe(true);
    expect(tapCount).toBe(1);
    expect(shape(result.steps)).toEqual([
      'repeat pass until hidden "Clear notification" (max 15) @0',
      "repeat pass iteration 1 @1",
      'tap pass "Clear notification" @1',
      'await pass hidden "Clear notification" @1',
      'repeat pass hidden text="Clear notification" after 1 iteration @0',
    ]);
    expect(counts(result)).toEqual({ ok: true, passed: 3, failed: 0, skipped: 0, errored: 0 });
    expect(rowsLeft()).toBe(2);
  }, 20000);

  /**
   * Reads a tap's effect stays invisible for. Sized above what one guard probe
   * can spend: the probe polls its ~1s grace every 300ms, which is six reads at
   * the very most, so an effect landing on the eighth read is one the guard
   * structurally cannot wait for and an `await:` (a full action timeout, ~25
   * polls) comfortably can. Counted in READS rather than slept in milliseconds
   * so the starvation is a property of the two budgets and not of how loaded
   * the machine running this is.
   */
  const EFFECT_READS = 8;

  /**
   * A cart whose taps are acknowledged late: each tap goes in flight, shows a
   * `Syncing` indicator, and only bumps the counter {@link EFFECT_READS} reads
   * later. Nothing is ever dropped, so every extra tap the drain fires is an
   * extra item the app eventually holds. Returns a reader for the counter once
   * everything outstanding has landed — the state a run leaves behind.
   */
  function useSlowCart(): () => string {
    let reads = 0;
    const dispatchedAt: number[] = [];
    onTap = () => dispatchedAt.push(reads);
    currentTree = () => {
      reads++;
      const landed = dispatchedAt.filter((at) => reads - at >= EFFECT_READS).length;
      return screen([
        n({ label: "Add to cart", frame: { x: 0.1, y: 0.1, width: 0.5, height: 0.1 } }),
        n({
          identifier: "cart",
          label: `${landed} items`,
          frame: { x: 0.1, y: 0.3, width: 0.5, height: 0.1 },
        }),
        ...(landed < dispatchedAt.length
          ? [n({ label: "Syncing", frame: { x: 0.1, y: 0.5, width: 0.5, height: 0.1 } })]
          : []),
      ]);
    };
    return () => {
      for (let i = 0; i < EFFECT_READS; i++) currentTree();
      return currentTree().children.find((c) => c.identifier === "cart")?.label ?? "";
    };
  }

  const CART_TAP: FlowStep = { kind: "tap", selector: { text: "Add to cart", loose: true } };
  const CART_AT_THREE = {
    kind: "ui",
    condition: "text",
    selector: { identifier: "cart" },
    expectedText: "3 items",
    textMatch: "equals",
  } as const;

  it("over-fires a body whose effect lands after the grace, overshooting its target", async () => {
    // The other direction of the same one-probe reading, pinned for the same
    // reason. The guard reads what the app has ACKNOWLEDGED, not what it has
    // been asked to do, so an effect slower than the grace leaves every probe
    // on stale state: the drain fires again with an effect already in flight
    // and converges on a count it then walks straight past. The verdict is true
    // about the instant it was taken and the run is green, while the app is
    // left in a state the flow never asserted and a later correct step takes
    // the blame.
    const settledCart = useSlowCart();
    await writeFlow("slow-cart", {
      executionPrerequisite: "",
      steps: [
        {
          kind: "repeat",
          spec: { mode: "until", until: CART_AT_THREE, max: 10 },
          steps: [CART_TAP],
        },
      ],
    });

    const result = await run("slow-cart");

    expect(result.ok).toBe(true);
    expect(result.steps.at(-1)?.reason).toBe('id="cart" equals "3 items" after 4 iterations');
    // Four taps for a target of three, and nothing was dropped: the drain
    // asserted "3 items" on a screen that owed it a fourth.
    expect(tapCount).toBe(4);
    expect(settledCart()).toBe("4 items");
  }, 20000);

  it("converges without overshooting when the body waits for its effect", async () => {
    // Same fixture, same target, one authored wait: `await: { hidden: Syncing }`
    // holds the iteration open until the app has acknowledged the tap, so the
    // next probe reads a settled counter and the drain stops on the tap that
    // actually reached three. Sensitivity is the test above: drop this step and
    // the same fixture fires four taps and leaves the cart at four.
    //
    // ~10s of wall clock, and the waits are not all of it: three waits, each up
    // to EFFECT_READS polls 300ms apart, plus an unmet 1s guard probe at every
    // iteration boundary and the taps' own settle on top. The counts are
    // read-driven, so load moves the clock and nothing else — hence the 40s
    // budget this and the settled drain above take where the rest of the file
    // takes 20s, which is what keeps a slow box from turning the cost into a
    // flake.
    const settledCart = useSlowCart();
    await writeFlow("settled-cart", {
      executionPrerequisite: "",
      steps: [
        {
          kind: "repeat",
          spec: { mode: "until", until: CART_AT_THREE, max: 10 },
          steps: [CART_TAP, { kind: "await", condition: "hidden", selector: { text: "Syncing" } }],
        },
      ],
    });

    const result = await run("settled-cart");

    expect(result.ok).toBe(true);
    expect(result.steps.at(-1)?.reason).toBe('id="cart" equals "3 items" after 3 iterations');
    expect(tapCount).toBe(3);
    // The app is left holding exactly what the flow asserted.
    expect(settledCart()).toBe("3 items");
  }, 40000);
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

  it("attributes a fragment drain's converged and cap verdicts to the fragment", async () => {
    // A drain's verdict is pushed by the repeat block itself, not by the run:
    // step, so its `flow` stamp is the only thing telling the CLI which file
    // the verdict came from (the `[frag]` suffix reads exactly this field).
    // The two tests above pin the stamp on the markers; the drain suite pins
    // the verdicts, but only at top level — where the stamp equals the root
    // flow — and through {@link shape}, which never reads `flow`. Two
    // fragments in one run put both evaluated verdicts across the boundary:
    // the first drain converges, the second runs into its cap.
    currentTree = () =>
      screen([
        notification(),
        n({
          label: "Done",
          frame:
            tapCount >= 1
              ? { x: 0.1, y: 0.5, width: 0.5, height: 0.1 }
              : { x: 0.1, y: 0.5, width: 0, height: 0 },
        }),
      ]);
    await writeFlow("drainer", {
      executionPrerequisite: "",
      steps: [
        {
          kind: "repeat",
          spec: {
            mode: "until",
            until: { kind: "ui", condition: "visible", selector: { text: "Done" } },
            max: 5,
          },
          steps: [TAP],
        },
      ],
    });
    await writeFlow("capper", {
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
      ],
    });
    await writeFlow("verdicts", {
      executionPrerequisite: "",
      steps: [
        { kind: "run", flow: "drainer.yaml" },
        { kind: "run", flow: "capper.yaml" },
      ],
    });

    const result = await run("verdicts");

    expect(result.ok).toBe(false);
    expect(tapCount).toBe(3);
    expect(attributed(result.steps)).toEqual([
      "run pass drainer drainer.yaml @0",
      'repeat pass drainer until visible "Done" (max 5) @1',
      "repeat pass drainer iteration 1 @2",
      'tap pass drainer "Clear notification" @2',
      'repeat pass drainer visible text="Done" after 1 iteration @1',
      "run pass capper capper.yaml @0",
      'repeat pass capper until hidden "Clear notification" (max 2) @1',
      "repeat pass capper iteration 1 @2",
      'tap pass capper "Clear notification" @2',
      "repeat pass capper iteration 2 @2",
      'tap pass capper "Clear notification" @2',
      'repeat fail capper still not hidden text="Clear notification" after 2 iterations (max) @1',
    ]);
  }, 20000);

  it("attributes a fragment drain's guard-error and cancellation lines to the fragment", async () => {
    // The block's other two terminal lines — the guard's error and the shared
    // cancellation line — are hard stops, so each needs its own run; one
    // fragment serves both. Like the verdicts above they are pushed from
    // inside the fragment's repeat, and only their `flow` stamp keeps them
    // from reading as the caller's own.
    await writeFlow("frag", {
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
    await writeFlow("caller", {
      executionPrerequisite: "",
      steps: [{ kind: "run", flow: "frag.yaml" }],
    });

    // A blind probe before any iteration: the stand-in skip and the guard's
    // error verdict close the block, both saying `frag`.
    currentTree = () => screen([]);
    currentHint = "native-devtools disconnected";
    const blind = await run("caller");

    expect(blind.ok).toBe(false);
    expect(attributed(blind.steps)).toEqual([
      "run pass frag frag.yaml @0",
      'repeat pass frag until hidden "Clear notification" (max 5) @1',
      'tap skip frag "Clear notification" @2',
      'repeat error frag could not evaluate until guard (hidden text="Clear notification"): ' +
        "could not evaluate the condition — every read of the UI tree was empty or degraded @1",
    ]);

    // The same fragment cancelled mid-drain: the abort lands after the second
    // tap and the block's cancellation line closes it, still saying `frag`.
    currentHint = undefined;
    currentTree = () => screen([notification()]); // nothing clears it; only the abort ends this
    tapCount = 0;
    const controller = new AbortController();
    onTap = () => {
      if (tapCount === 2) controller.abort();
    };
    const cancelled = await run("caller", controller.signal);

    expect(cancelled.aborted).toBe(true);
    expect(attributed(cancelled.steps)).toEqual([
      "run pass frag frag.yaml @0",
      'repeat pass frag until hidden "Clear notification" (max 5) @1',
      "repeat pass frag iteration 1 @2",
      'tap pass frag "Clear notification" @2',
      "repeat pass frag iteration 2 @2",
      'tap pass frag "Clear notification" @2',
      'repeat skip frag until hidden "Clear notification" (max 5) @1',
    ]);
    expect(cancelled.steps.at(-1)?.reason).toBe("run aborted");
  }, 30000);

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
 * refusal must land on the `run:` step, before any fragment step runs: one
 * baseline for a body written to be re-run is the shape the parser refuses, and
 * under --update-baselines it silently leaves the last iteration's pixels as
 * the baseline for the first iteration's screen.
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
        "block — a snapshot name maps to one baseline, but a repeat body is written to be " +
        "re-run, and a later iteration's legitimately different screen would still compare " +
        "against that one baseline; the refusal is on the construct, not the count, a block " +
        "bounded at 1 being one edit from N; move the snapshot after the block, or out of the " +
        "fragment"
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
 * The third composition route into a repeat body — a raw `tool: flow-execute`
 * step, the form flow-add-step keeps when the target is not a resolvable
 * sibling and always produces for a remote recording. The dispatching run
 * stamps the invocation (inRepeatFlowScope), invokeSubTool forwards it, and
 * the nested flow-execute refuses a snapshot-bearing flow at entry — before
 * any device work — then seeds its own run's scope so deeper hops, `run:` or
 * `tool:`, keep refusing.
 */
describe("repeat: snapshot smuggled in through a nested tool: flow-execute", () => {
  const SNAPSHOT: FlowStep = { kind: "snapshot", name: "home" };

  /**
   * A registry whose flow-execute is the real tool, invoked the way the real
   * registry would invoke it: the caller's options become the nested ctx
   * (ToolContext extends InvokeToolOptions) — the exact channel the
   * repeat-scope flag rides. getTool declares `device` for it, like the real
   * schema, so bindDeviceArgs hands the run device to each nested hop (#607).
   * Everything else keeps the shared mock's behavior.
   */
  function nestedRunRegistry(): Registry {
    const registry = {
      invokeTool: vi.fn(async (id: string, args?: unknown, opts?: unknown) => {
        if (id === "list-devices") return { devices: [] };
        if (id === "gesture-tap") {
          tapCount++;
          onTap();
          return { tapped: true };
        }
        if (id === "flow-execute") return flowTool.execute({}, args as never, opts as never);
        return { ok: true };
      }),
      getTool: vi.fn((id: string) => {
        if (id === "gesture-tap") return { inputSchema: { properties: { udid: {} } } };
        if (id === "flow-execute") {
          return { inputSchema: { properties: { name: {}, project_root: {}, device: {} } } };
        }
        return undefined;
      }),
    } as unknown as Registry;
    const flowTool = createRunFlowTool(registry);
    return registry;
  }

  async function runNested(name: string): Promise<FlowRunResult> {
    const tool = createRunFlowTool(nestedRunRegistry());
    return asRun(await tool.execute({}, { name, project_root: tmpDir, device: DEVICE }));
  }

  it("errors the tool step at nested-flow entry, before any nested step or device work", async () => {
    currentTree = () => screen([notification()]);
    await writeFlow("snapper", { executionPrerequisite: "", steps: [TAP, SNAPSHOT] });
    await writeFlow("smuggler", {
      executionPrerequisite: "",
      steps: [
        {
          kind: "repeat",
          spec: { mode: "times", times: 2 },
          steps: [
            { kind: "tool", name: "flow-execute", args: { name: "snapper", project_root: tmpDir } },
          ],
        },
        { kind: "echo", message: "after" },
      ],
    });

    const result = await runNested("smuggler");

    // The fence fires at the nested flow's entry: no tap dispatched, no
    // comparison made — nothing of the composed flow started.
    expect(result.ok).toBe(false);
    expect(tapCount).toBe(0);
    expect(vi.mocked(runSnapshot)).not.toHaveBeenCalled();
    expect(shape(result.steps.slice(0, 2))).toEqual([
      "repeat pass 2 times @0",
      "repeat pass iteration 1/2 @1",
    ]);
    expect(result.steps[2]).toMatchObject({
      kind: "tool",
      status: "error",
      tool: "flow-execute",
      depth: 1,
    });
    expect(result.steps[2]?.reason).toBe(
      'flow "snapper" contains snapshot "home", and this flow-execute runs inside a repeat ' +
        "block — a snapshot name maps to one baseline, but a repeat body is written to be " +
        "re-run, and a later iteration's legitimately different screen would still compare " +
        "against that one baseline; the refusal is on the construct, not the count, a block " +
        "bounded at 1 being one edit from N; move the snapshot after the block, or out of the " +
        "composed flow"
    );
    expect(result.steps[3]).toMatchObject({ kind: "echo", status: "skip" });
    expect(counts(result)).toEqual({ ok: false, passed: 0, failed: 0, skipped: 0, errored: 1 });
  });

  it("still nests the same flow-execute outside any repeat — the fence is the block's, not the tool's", async () => {
    currentTree = () => screen([notification()]);
    await writeFlow("snapper", { executionPrerequisite: "", steps: [TAP, SNAPSHOT] });
    await writeFlow("straight", {
      executionPrerequisite: "",
      steps: [
        { kind: "tool", name: "flow-execute", args: { name: "snapper", project_root: tmpDir } },
      ],
    });

    const result = await runNested("straight");

    expect(result.ok).toBe(true);
    expect(tapCount).toBe(1);
    expect(vi.mocked(runSnapshot)).toHaveBeenCalledTimes(1);
    expect(result.steps[0]).toMatchObject({ kind: "tool", status: "pass", tool: "flow-execute" });
  }, 15000);

  it("stays fenced across a run: hop inside the nested flow — the seeded scope refuses at fragment load", async () => {
    currentTree = () => screen([notification()]);
    await writeFlow("frag", { executionPrerequisite: "", steps: [SNAPSHOT] });
    await writeFlow("hopper", {
      executionPrerequisite: "",
      steps: [{ kind: "run", flow: "frag.yaml" }],
    });
    await writeFlow("run-hop-smuggler", {
      executionPrerequisite: "",
      steps: [
        {
          kind: "repeat",
          spec: { mode: "times", times: 2 },
          // hopper passes the entry check (no literal snapshot among its
          // steps) and starts executing; frag's load then hits execRunStep's
          // fence because the nested run's root scope was seeded.
          steps: [
            { kind: "tool", name: "flow-execute", args: { name: "hopper", project_root: tmpDir } },
          ],
        },
      ],
    });

    const result = await runNested("run-hop-smuggler");

    expect(result.ok).toBe(false);
    expect(vi.mocked(runSnapshot)).not.toHaveBeenCalled();
    expect(result.steps[2]).toMatchObject({ kind: "tool", status: "fail", tool: "flow-execute" });
    expect(result.steps[2]?.reason).toContain('flow "hopper" failed');
    expect(result.steps[2]?.reason).toContain('fragment "frag.yaml" contains snapshot "home"');
  }, 15000);

  it("stays fenced across a tool hop — the flag re-propagates into the deeper invocation", async () => {
    await writeFlow("deep-snapper", { executionPrerequisite: "", steps: [SNAPSHOT] });
    await writeFlow("relay", {
      executionPrerequisite: "",
      steps: [
        {
          kind: "tool",
          name: "flow-execute",
          args: { name: "deep-snapper", project_root: tmpDir },
        },
      ],
    });
    await writeFlow("tool-hop-smuggler", {
      executionPrerequisite: "",
      steps: [
        {
          kind: "repeat",
          spec: { mode: "times", times: 2 },
          steps: [
            { kind: "tool", name: "flow-execute", args: { name: "relay", project_root: tmpDir } },
          ],
        },
      ],
    });

    const result = await runNested("tool-hop-smuggler");

    expect(result.ok).toBe(false);
    expect(vi.mocked(runSnapshot)).not.toHaveBeenCalled();
    expect(result.steps[2]).toMatchObject({ kind: "tool", status: "fail", tool: "flow-execute" });
    expect(result.steps[2]?.reason).toContain('flow "relay" failed');
    expect(result.steps[2]?.reason).toContain('flow "deep-snapper" contains snapshot "home"');
  }, 15000);

  /**
   * The chain the two prerequisite tests below compose: a fragment whose
   * snapshot the seeded repeat scope refuses at load — behind a launch — and a
   * prerequisite-bearing flow whose only step hops to it.
   */
  async function writeGatedChain(): Promise<void> {
    await writeFlow("frag", {
      executionPrerequisite: "",
      steps: [{ kind: "launch", app: "com.acme.app" }, SNAPSHOT],
    });
    await writeFlow("gated", {
      executionPrerequisite: "logged in",
      steps: [{ kind: "run", flow: "frag.yaml" }],
    });
  }

  /** The outer flow: one `tool: flow-execute` of "gated" inside a times block. */
  async function writeGatedSmuggler(name: string, args: Record<string, unknown>): Promise<void> {
    await writeFlow(name, {
      executionPrerequisite: "",
      steps: [
        {
          kind: "repeat",
          spec: { mode: "times", times: 2 },
          steps: [{ kind: "tool", name: "flow-execute", args: { project_root: tmpDir, ...args } }],
        },
      ],
    });
  }

  it("takes the prerequisite handshake when the nested flow's leading run: reaches a snapshot-bearing fragment", async () => {
    // The nested run's leading-launch scan reads the same seeded repeat scope
    // execSteps does, so it stops at frag's load exactly where the executor
    // would: the launch behind that hop can never run, and refusing the
    // composition for declaring executionPrerequisite would send the author to
    // drop a launch that was never what fails the run. Scan-blind to the scope,
    // this walked straight through to the launch and refused.
    await writeGatedChain();
    await writeGatedSmuggler("gated-smuggler", { name: "gated" });

    const result = await runNested("gated-smuggler");

    expect(result.ok).toBe(false);
    expect(vi.mocked(runSnapshot)).not.toHaveBeenCalled();
    expect(result.steps[2]).toMatchObject({ kind: "tool", status: "error", tool: "flow-execute" });
    expect(result.steps[2]?.reason).toContain(
      'flow "gated" did not run — its execution prerequisite was not acknowledged: logged in'
    );
    expect(result.steps[2]?.reason).not.toContain("must not declare executionPrerequisite");
  }, 15000);

  it("then errors that fragment's load once the prerequisite is acknowledged", async () => {
    // What the handshake above hands the caller through to: the acknowledged
    // run reaches the fence itself, which is the proof the guard was right to
    // stand aside — the run fails on the snapshot composition, not on the
    // launch it was told to drop.
    await writeGatedChain();
    await writeGatedSmuggler("gated-ack-smuggler", {
      name: "gated",
      prerequisiteAcknowledged: true,
    });

    const result = await runNested("gated-ack-smuggler");

    expect(result.ok).toBe(false);
    expect(vi.mocked(runSnapshot)).not.toHaveBeenCalled();
    expect(result.steps[2]).toMatchObject({ kind: "tool", status: "fail", tool: "flow-execute" });
    expect(result.steps[2]?.reason).toContain('flow "gated" failed');
    expect(result.steps[2]?.reason).toContain('fragment "frag.yaml" contains snapshot "home"');
    expect(result.steps[2]?.reason).not.toContain("must not declare executionPrerequisite");
  }, 15000);
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

  it("adds no line when the cancellation lands on the last step of the last iteration", async () => {
    // The line stands in for iterations the block promised and will never
    // start, so it takes more than a live abort: the block has to still owe
    // one. Three runs of the same shape, all cancelled from the second tap,
    // separate a block with an iteration left from two without one — including
    // the case whose body the abort cut in half, where the abandoned step
    // reports its own skip and the block still owes nothing.
    currentTree = () => screen([notification()]);
    const ECHO: FlowStep = { kind: "echo", message: "after" };
    await writeFlow("abort-on-last-step", {
      executionPrerequisite: "",
      steps: [{ kind: "repeat", spec: { mode: "times", times: 2 }, steps: [TAP] }],
    });
    await writeFlow("abort-mid-last-body", {
      executionPrerequisite: "",
      steps: [{ kind: "repeat", spec: { mode: "times", times: 2 }, steps: [TAP, ECHO] }],
    });
    await writeFlow("abort-with-iterations-left", {
      executionPrerequisite: "",
      steps: [{ kind: "repeat", spec: { mode: "times", times: 3 }, steps: [TAP] }],
    });

    const complete = await run("abort-on-last-step", abortDuringTap(2).signal);
    tapCount = 0;
    const midBody = await run("abort-mid-last-body", abortDuringTap(2).signal);
    tapCount = 0;
    const left = await run("abort-with-iterations-left", abortDuringTap(2).signal);

    // Every promised iteration ran, and every step in them ran: the block owes
    // nothing, so it closes silently and the run-level `aborted` is the whole
    // account of the cancellation.
    expect(shape(complete.steps)).toEqual([
      "repeat pass 2 times @0",
      "repeat pass iteration 1/2 @1",
      'tap pass "Clear notification" @1',
      "repeat pass iteration 2/2 @1",
      'tap pass "Clear notification" @1',
    ]);
    expect(complete.steps.some((s) => s.reason === "run aborted")).toBe(false);
    expect(complete.aborted).toBe(true);
    // The block leaves `skipped` where it found it: the line is deliberately
    // not structural, so one pushed here would take a step number and a skip
    // for a block that delivered everything its marker promised.
    expect(counts(complete)).toEqual({ ok: false, passed: 2, failed: 0, skipped: 0, errored: 0 });

    // The same final iteration, one step short of its end: the echo never
    // runs, and it says so itself. The block's answer does not change — it
    // still promised two iterations and delivered two — so it closes silently
    // here as well, and the abandoned echo is accounted for exactly once.
    expect(shape(midBody.steps)).toEqual([
      "repeat pass 2 times @0",
      "repeat pass iteration 1/2 @1",
      'tap pass "Clear notification" @1',
      "echo pass after @1",
      "repeat pass iteration 2/2 @1",
      'tap pass "Clear notification" @1',
      "echo skip after @1",
    ]);
    expect(midBody.steps.at(-1)?.reason).toBe("run aborted");
    expect(midBody.steps.filter((s) => s.kind === "repeat" && s.status === "skip")).toEqual([]);
    expect(midBody.aborted).toBe(true);
    expect(counts(midBody)).toEqual({ ok: false, passed: 2, failed: 0, skipped: 0, errored: 0 });

    // The one thing that does earn the line: the abort lands on the last step
    // of iteration 2, exactly as in the first run, but a third iteration the
    // marker promised will now never start and nothing else would say so.
    expect(shape(left.steps)).toEqual([
      "repeat pass 3 times @0",
      "repeat pass iteration 1/3 @1",
      'tap pass "Clear notification" @1',
      "repeat pass iteration 2/3 @1",
      'tap pass "Clear notification" @1',
      "repeat skip 3 times @0",
    ]);
    expect(left.steps.at(-1)?.reason).toBe("run aborted");
    expect(left.aborted).toBe(true);
    expect(counts(left)).toEqual({ ok: false, passed: 2, failed: 0, skipped: 1, errored: 0 });
  }, 25000);

  it("closes every enclosing block with its own line when the abort cuts a nested repeat short", async () => {
    // One cancellation, and both blocks still owe iterations when it lands —
    // the inner its third, the outer its second: the inner repeat closes
    // itself, the leftover body step skips on its own account, then the outer
    // block closes too. Each line carries its own block's bound, so the two
    // `run aborted` entries are told apart by target, not just by the depth
    // indent — and `skipped` carries one per level, each level's unstarted
    // iterations being its own loss to report: a level without its line would
    // read as an all-pass block whose marker promised iterations that never
    // ran.
    currentTree = () => screen([notification()]);
    const controller = abortDuringTap(2);
    await writeFlow("cancelled-in-nested", {
      executionPrerequisite: "",
      steps: [
        {
          kind: "repeat",
          spec: { mode: "times", times: 2 },
          steps: [
            { kind: "repeat", spec: { mode: "times", times: 3 }, steps: [TAP] },
            { kind: "wait", ms: 1 },
          ],
        },
      ],
    });

    const result = await run("cancelled-in-nested", controller.signal);

    expect(tapCount).toBe(2);
    expect(shape(result.steps)).toEqual([
      "repeat pass 2 times @0",
      "repeat pass iteration 1/2 @1",
      "repeat pass 3 times @1",
      "repeat pass iteration 1/3 @2",
      'tap pass "Clear notification" @2',
      "repeat pass iteration 2/3 @2",
      'tap pass "Clear notification" @2',
      "repeat skip 3 times @1",
      "wait skip run aborted @1",
      "repeat skip 2 times @0",
    ]);
    for (const line of [result.steps.at(-3), result.steps.at(-1)]) {
      expect(line?.reason).toBe("run aborted");
      expect(line?.structural).toBeUndefined();
    }
    expect(result.aborted).toBe(true);
    // Two taps ran; the skips are the wait's stand-in plus one cancellation
    // line per enclosing level.
    expect(counts(result)).toEqual({ ok: false, passed: 2, failed: 0, skipped: 3, errored: 0 });
  }, 15000);

  it("closes only the enclosing blocks that still owed an iteration", async () => {
    // Which levels close is decided by the iterations each level has left, and
    // by nothing else — least of all by whether the abort happened to land on
    // the body's last step. Four runs of the same nested pair: cancelled from
    // the last tap of the last iteration of both blocks, no level owes an
    // iteration and no level says anything; cancelled on the inner block's
    // last tap under the outer's FIRST iteration, only the outer owes one and
    // only the outer says so; cancelled early, both levels owe one and both
    // say so. The mixed run is what pins each level answering for itself: the
    // condition reads that block's own bound, so an inner block that finished
    // cannot silence an outer one that did not.
    //
    // The middle run is the point of the rule. It is the first flow with a
    // trailing `echo:` inside the inner body, so the abort leaves an authored
    // step undone — and the answer must not move: the echo reports its own
    // `run aborted` skip, which is the whole of what the cancellation cost,
    // and a closing line at either level would be a second account of it,
    // charged as a skip to a block that ran every iteration it promised.
    currentTree = () => screen([notification()]);
    const ECHO: FlowStep = { kind: "echo", message: "after" };
    const nested = (steps: FlowStep[]): FlowStep => ({
      kind: "repeat",
      spec: { mode: "times", times: 2 },
      steps: [{ kind: "repeat", spec: { mode: "times", times: 3 }, steps }],
    });
    await writeFlow("nested-tail-exact", {
      executionPrerequisite: "",
      steps: [nested([TAP])],
    });
    await writeFlow("nested-tail-trailing", {
      executionPrerequisite: "",
      steps: [nested([TAP, ECHO])],
    });

    // The same flow throughout, cancelled at three different taps: the sixth
    // is the run's last (the inner block's last iteration inside the outer's
    // last), the third is the inner block's last inside the outer's first, and
    // the second leaves an iteration owed at both levels.
    const exact = await run("nested-tail-exact", abortDuringTap(6).signal);
    tapCount = 0;
    const trailing = await run("nested-tail-trailing", abortDuringTap(6).signal);
    tapCount = 0;
    const innerDone = await run("nested-tail-exact", abortDuringTap(3).signal);
    tapCount = 0;
    const owed = await run("nested-tail-exact", abortDuringTap(2).signal);

    /** The closing lines a run emitted, innermost first — one per block that owed. */
    const closings = (r: FlowRunResult): string[] =>
      shape(r.steps.filter((s) => s.kind === "repeat" && s.status === "skip"));

    // The trailing echo changes what the report says about the echo, and
    // nothing about the blocks: neither run closes a level.
    expect(closings(exact)).toEqual([]);
    expect(closings(trailing)).toEqual([]);
    // Each level answers for itself: the inner block delivered all three of its
    // iterations, the outer still owes its second.
    expect(closings(innerDone)).toEqual(["repeat skip 2 times @0"]);
    expect(closings(owed)).toEqual(["repeat skip 3 times @1", "repeat skip 2 times @0"]);

    // Both blocks delivered every iteration they promised and every step in
    // them, so neither says anything: the run-level `aborted` is the whole
    // account of a cancellation that left nothing unstarted.
    expect(shape(exact.steps)).toEqual([
      "repeat pass 2 times @0",
      "repeat pass iteration 1/2 @1",
      "repeat pass 3 times @1",
      "repeat pass iteration 1/3 @2",
      'tap pass "Clear notification" @2',
      "repeat pass iteration 2/3 @2",
      'tap pass "Clear notification" @2',
      "repeat pass iteration 3/3 @2",
      'tap pass "Clear notification" @2',
      "repeat pass iteration 2/2 @1",
      "repeat pass 3 times @1",
      "repeat pass iteration 1/3 @2",
      'tap pass "Clear notification" @2',
      "repeat pass iteration 2/3 @2",
      'tap pass "Clear notification" @2',
      "repeat pass iteration 3/3 @2",
      'tap pass "Clear notification" @2',
    ]);
    expect(exact.steps.some((s) => s.reason === "run aborted")).toBe(false);
    expect(exact.aborted).toBe(true);
    // The lines are deliberately not structural, so one pushed here would take
    // a step number and a skip — at every level — for blocks that owe nothing.
    expect(counts(exact)).toEqual({ ok: false, passed: 6, failed: 0, skipped: 0, errored: 0 });

    // One authored step abandoned, at depth 2, and it is the one line the
    // cancellation adds: the echo speaks for itself, and the blocks that
    // finished around it stay silent.
    expect(shape(trailing.steps)).toEqual([
      "repeat pass 2 times @0",
      "repeat pass iteration 1/2 @1",
      "repeat pass 3 times @1",
      "repeat pass iteration 1/3 @2",
      'tap pass "Clear notification" @2',
      "echo pass after @2",
      "repeat pass iteration 2/3 @2",
      'tap pass "Clear notification" @2',
      "echo pass after @2",
      "repeat pass iteration 3/3 @2",
      'tap pass "Clear notification" @2',
      "echo pass after @2",
      "repeat pass iteration 2/2 @1",
      "repeat pass 3 times @1",
      "repeat pass iteration 1/3 @2",
      'tap pass "Clear notification" @2',
      "echo pass after @2",
      "repeat pass iteration 2/3 @2",
      'tap pass "Clear notification" @2',
      "echo pass after @2",
      "repeat pass iteration 3/3 @2",
      'tap pass "Clear notification" @2',
      "echo skip after @2",
    ]);
    expect(trailing.steps.at(-1)?.reason).toBe("run aborted");
    expect(trailing.aborted).toBe(true);
    // The same six taps and the same totals as the run without the echo: the
    // abandoned narration is no test step, and no block was charged a skip.
    expect(counts(trailing)).toEqual({ ok: false, passed: 6, failed: 0, skipped: 0, errored: 0 });

    // The mixed run in full: the inner block closes nothing after its third
    // tap, and the outer's line is the only account of the iteration it owes.
    expect(shape(innerDone.steps)).toEqual([
      "repeat pass 2 times @0",
      "repeat pass iteration 1/2 @1",
      "repeat pass 3 times @1",
      "repeat pass iteration 1/3 @2",
      'tap pass "Clear notification" @2',
      "repeat pass iteration 2/3 @2",
      'tap pass "Clear notification" @2',
      "repeat pass iteration 3/3 @2",
      'tap pass "Clear notification" @2',
      "repeat skip 2 times @0",
    ]);
    expect(innerDone.steps.at(-1)?.reason).toBe("run aborted");
    expect(counts(innerDone)).toEqual({ ok: false, passed: 3, failed: 0, skipped: 1, errored: 0 });

    // Cancelled with iterations still to come at both levels — the inner block
    // owes its third, the outer its second — and each says so for itself, at
    // its own depth and under its own bound.
    expect(shape(owed.steps)).toEqual([
      "repeat pass 2 times @0",
      "repeat pass iteration 1/2 @1",
      "repeat pass 3 times @1",
      "repeat pass iteration 1/3 @2",
      'tap pass "Clear notification" @2',
      "repeat pass iteration 2/3 @2",
      'tap pass "Clear notification" @2',
      "repeat skip 3 times @1",
      "repeat skip 2 times @0",
    ]);
    for (const line of [owed.steps.at(-2), owed.steps.at(-1)]) {
      expect(line?.reason).toBe("run aborted");
      expect(line?.structural).toBeUndefined();
    }
    expect(owed.aborted).toBe(true);
    expect(counts(owed)).toEqual({ ok: false, passed: 2, failed: 0, skipped: 2, errored: 0 });
  }, 40000);

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

  it("adds no stand-in skips when the cancellation lands at a later guard probe", async () => {
    // Same probe boundary, one iteration in. The trigger still fires from
    // inside a tree fetch, but only once the first body has run: the first
    // probe's whole window and the tap's own settle reads all see tapCount 0,
    // and the tap dispatches before incrementing it, so the first fetch that
    // aborts is the second probe's. The body's lines are already in the
    // report, so nothing is re-listed — the cancellation line alone closes
    // the block, exactly as when the abort is caught after the body.
    const controller = new AbortController();
    currentTree = () => {
      if (tapCount >= 1) controller.abort();
      return screen([notification()]);
    };
    await writeFlow("cancelled-at-later-probe", {
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

    const result = await run("cancelled-at-later-probe", controller.signal);

    expect(tapCount).toBe(1);
    // Strict equality is the proof: no skip line stands in for the tap between
    // its executed pass and the cancellation line.
    expect(shape(result.steps)).toEqual([
      'repeat pass until hidden "Clear notification" (max 10) @0',
      "repeat pass iteration 1 @1",
      'tap pass "Clear notification" @1',
      'repeat skip until hidden "Clear notification" (max 10) @0',
    ]);
    expect(result.steps.at(-1)?.reason).toBe("run aborted");
    expect(result.aborted).toBe(true);
    expect(counts(result)).toEqual({ ok: false, passed: 1, failed: 0, skipped: 1, errored: 0 });
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
        { kind: "echo", message: "after" },
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
      // Silent at the block, not at the flow: the failure still hard-stops —
      // the step after the drain skips, exactly as after a times block's
      // failure (the `fails-inside` test).
      "echo skip after @0",
    ]);
    for (const result of [times, drain]) {
      expect(result.steps.some((s) => s.reason === "run aborted")).toBe(false);
      expect(result.aborted).toBeUndefined();
      expect(counts(result)).toEqual({ ok: false, passed: 0, failed: 1, skipped: 0, errored: 0 });
    }
  }, 20000);
});
