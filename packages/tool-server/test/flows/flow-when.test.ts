import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Registry } from "@argent/registry";
import type { DescribeNode, DescribeTreeData } from "../../src/tools/describe/contract";

// Serve the flow tree directly: flows resolve selectors against the platform's
// full-hierarchy source and hard-fail rather than degrade to the AX tree, so
// these unit tests stub the tree fetch itself. `currentHint` flags the read as
// degraded — an empty tree + hint is a blind read the guard must not trust.
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

import { createRunFlowTool, type FlowRunResult } from "../../src/tools/flows/flow-run";
import { serializeFlow, parseFlow } from "../../src/tools/flows/flow-utils";

const DEVICE = "00000000-0000-0000-0000-0000000000ab"; // iOS UDID shape
let tmpDir: string;

function n(partial: Partial<DescribeNode> & { frame: DescribeNode["frame"] }): DescribeNode {
  return { role: "AXOther", children: [], ...partial };
}

function screen(children: DescribeNode[]): DescribeNode {
  return n({ role: "AXWindow", frame: { x: 0, y: 0, width: 1, height: 1 }, children });
}

function mockRegistry(taps: Array<{ x: number; y: number }>): Registry {
  return {
    invokeTool: vi.fn(async (id: string, args: Record<string, unknown>) => {
      if (id === "list-devices") return { devices: [] };
      if (id === "gesture-tap") {
        taps.push({ x: args.x as number, y: args.y as number });
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

async function run(
  name: string,
  device: string = DEVICE,
  signal?: AbortSignal
): Promise<FlowRunResult & { taps: Array<{ x: number; y: number }> }> {
  const taps: Array<{ x: number; y: number }> = [];
  const tool = createRunFlowTool(mockRegistry(taps));
  const result = asRun(
    await tool.execute(
      {},
      { name, project_root: tmpDir, device },
      (signal ? { signal } : undefined) as never
    )
  );
  return Object.assign(result, { taps });
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-when-"));
  currentTree = () => screen([]);
  currentHint = undefined;
});
afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("when: parse/serialize", () => {
  it("round-trips ui and platform guards and nested blocks", () => {
    const flow = {
      executionPrerequisite: "",
      steps: [
        {
          kind: "when" as const,
          condition: {
            kind: "ui" as const,
            condition: "visible" as const,
            selector: { text: "What's new", loose: true },
          },
          steps: [
            { kind: "tap" as const, selector: { text: "Skip", loose: true } },
            {
              kind: "when" as const,
              condition: { kind: "platform" as const, platform: "android" as const },
              steps: [{ kind: "tool" as const, name: "button", args: { button: "back" } }],
            },
          ],
        },
        {
          kind: "when" as const,
          condition: {
            kind: "ui" as const,
            condition: "text" as const,
            selector: { identifier: "banner" },
            expectedText: "Sale",
            textMatch: "contains" as const,
          },
          steps: [{ kind: "echo" as const, message: "sale banner up" }],
        },
        {
          kind: "when" as const,
          condition: {
            kind: "ui" as const,
            condition: "text" as const,
            selector: { identifier: "total" },
            expectedText: "^Total: \\$\\d+$",
            textMatch: "matches" as const,
          },
          steps: [{ kind: "echo" as const, message: "total rendered" }],
        },
      ],
    };
    expect(parseFlow(serializeFlow(flow)).steps).toEqual(flow.steps);
  });

  it("rejects an else branch with the design rationale", () => {
    expect(() =>
      parseFlow(
        "steps:\n  - when: { visible: X }\n    steps:\n      - tap: Skip\n    else:\n      - tap: Other\n"
      )
    ).toThrow(/when has no else/i);
  });

  it("rejects unknown sibling keys and a missing/empty steps list", () => {
    expect(() =>
      parseFlow("steps:\n  - when: { visible: X }\n    steps: [{ tap: A }]\n    retries: 2\n")
    ).toThrow(/takes exactly \{ when: <condition>, steps: \[\.\.\.\] \}/i);
    expect(() => parseFlow("steps:\n  - when: { visible: X }\n")).toThrow(/non-empty steps list/i);
    expect(() => parseFlow("steps:\n  - when: { visible: X }\n    steps: []\n")).toThrow(
      /non-empty steps list/i
    );
  });

  it("requires exactly one condition key and no timeout", () => {
    expect(() => parseFlow("steps:\n  - when: {}\n    steps: [{ tap: A }]\n")).toThrow(
      /exactly one condition key \(exists, visible, hidden, text, platform\)/i
    );
    expect(() =>
      parseFlow("steps:\n  - when: { visible: X, hidden: Y }\n    steps: [{ tap: A }]\n")
    ).toThrow(/exactly one condition key/i);
    expect(() =>
      parseFlow("steps:\n  - when: { visible: X, timeout: 5000 }\n    steps: [{ tap: A }]\n")
    ).toThrow(/when takes no timeout/i);
  });

  it("validates the platform guard value", () => {
    expect(() =>
      parseFlow("steps:\n  - when: { platform: windows }\n    steps: [{ tap: A }]\n")
    ).toThrow(/when\.platform must be one of ios, android, chromium, vega/i);
    expect(() =>
      parseFlow("steps:\n  - when: { platform: ios, foo: 1 }\n    steps: [{ tap: A }]\n")
    ).toThrow(/no other keys/i);
  });

  it("rejects a cyclic YAML alias on when steps with a structured error", () => {
    // The yaml library materializes `steps: *s` as a cyclic object; without
    // the depth cap the parser would recurse forever and escape as a raw
    // RangeError instead of a flow parse error.
    expect(() => parseFlow("steps: &s\n  - when: { visible: X }\n    steps: *s\n")).toThrow(
      /nest deeper than 20 levels/i
    );
  });

  it("rejects a per-step optional key, pointing at when:", () => {
    // No silent drop: an ignored `optional: true` would leave a step the
    // author believes can't fail hard-stopping the flow.
    expect(() => parseFlow("steps:\n  - tap: A\n    optional: true\n")).toThrow(
      /optional is not supported — guard the step with a when: block/i
    );
    expect(() => parseFlow("steps:\n  - await: { visible: X }\n    optional: false\n")).toThrow(
      /optional is not supported/i
    );
  });

  it("rejects a {{secret:…}} placeholder in a guard's expected text", () => {
    // Placeholders resolve only in the text-entry tools; condition evaluation
    // sees the literal placeholder, so the guard degenerates into a constant —
    // permanently false here (vacuously true for hidden) — same silently-wrong
    // class as optional:.
    expect(() =>
      parseFlow(
        'steps:\n  - when: { text: { in: account, equals: "{{secret:USERNAME}}" } }\n    steps: [{ tap: A }]\n'
      )
    ).toThrow(/when takes no \{\{secret:…\}\} placeholder/i);
    expect(() =>
      parseFlow(
        'steps:\n  - when: { text: { in: banner, contains: "{{secret:PROMO}}" } }\n    steps: [{ tap: A }]\n'
      )
    ).toThrow(/never in condition evaluation/i);
  });

  it("rejects a {{secret:…}} placeholder in a guard's selector", () => {
    // Same degenerate-constant class as the expected-text case: the tree
    // probe would look for the literal placeholder string on screen — and a
    // hidden guard would flip the failure to always-run instead of never-run.
    expect(() =>
      parseFlow('steps:\n  - when: { exists: "{{secret:TOKEN}}" }\n    steps: [{ tap: A }]\n')
    ).toThrow(/when takes no \{\{secret:…\}\} placeholder/i);
    expect(() =>
      parseFlow(
        'steps:\n  - when: { visible: { id: "{{secret:TOKEN}}" } }\n    steps: [{ tap: A }]\n'
      )
    ).toThrow(/use the literal on-screen text instead/i);
    expect(() =>
      parseFlow('steps:\n  - when: { hidden: "{{secret:TOKEN}}" }\n    steps: [{ tap: A }]\n')
    ).toThrow(/vacuously true/i);
    expect(() =>
      parseFlow(
        'steps:\n  - when: { text: { in: "{{secret:FIELD}}", equals: ok } }\n    steps: [{ tap: A }]\n'
      )
    ).toThrow(/when takes no \{\{secret:…\}\} placeholder/i);
  });

  it("still parses a type: step carrying a placeholder (resolved by the keyboard tool)", () => {
    const flow = parseFlow('steps:\n  - type: { into: password, text: "{{secret:PASSWORD}}" }\n');
    expect(flow.steps).toEqual([
      { kind: "type", into: { text: "password", loose: true }, text: "{{secret:PASSWORD}}" },
    ]);
  });

  it("still parses assert: and await: conditions carrying a placeholder (they fail loudly at runtime)", () => {
    // The rejection is when-only by design: an assert/await comparing the
    // literal placeholder fails loudly on the first run, unlike a guard's
    // silent degeneration. A refactor hoisting the check into parseWaitFields
    // must trip this test.
    expect(() =>
      parseFlow('steps:\n  - assert: { text: { in: account, equals: "{{secret:USERNAME}}" } }\n')
    ).not.toThrow();
    expect(() => parseFlow('steps:\n  - await: { visible: "{{secret:TOKEN}}" }\n')).not.toThrow();
  });
});

describe("when: execution", () => {
  it("runs the guarded steps when the condition holds, then continues", async () => {
    currentTree = () =>
      screen([
        n({ label: "What's new", frame: { x: 0.1, y: 0.1, width: 0.8, height: 0.2 } }),
        n({ label: "Skip", frame: { x: 0.4, y: 0.8, width: 0.2, height: 0.1 } }),
      ]);
    await writeFlow("dismiss", {
      executionPrerequisite: "",
      steps: [
        {
          kind: "when",
          condition: {
            kind: "ui",
            condition: "visible",
            selector: { text: "What's new", loose: true },
          },
          steps: [{ kind: "tap", selector: { text: "Skip", loose: true } }],
        },
        { kind: "echo", message: "after block" },
      ],
    });

    const result = await run("dismiss");

    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual([
      "when:pass",
      "tap:pass",
      "echo:pass",
    ]);
    expect(result.steps[0].reason).toMatch(/condition met \(visible text="What's new"\)/);
    expect(result.taps).toHaveLength(1);
    expect(result.ok).toBe(true);
  });

  it("skips the whole block — one line per authored step — when the condition is unmet", async () => {
    currentTree = () =>
      screen([n({ label: "Home", frame: { x: 0, y: 0, width: 1, height: 0.1 } })]);
    await writeFlow("clean-run", {
      executionPrerequisite: "",
      steps: [
        {
          kind: "when",
          condition: {
            kind: "ui",
            condition: "visible",
            selector: { text: "What's new", loose: true },
          },
          steps: [
            { kind: "tap", selector: { text: "Skip", loose: true } },
            {
              kind: "when",
              condition: { kind: "platform", platform: "ios" },
              steps: [{ kind: "echo", message: "nested" }],
            },
          ],
        },
        { kind: "echo", message: "after block" },
      ],
    });

    const result = await run("clean-run");

    // The block marker + every guarded step (nested when expanded) skip; the
    // flow continues and stays green.
    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual([
      "when:skip",
      "tap:skip",
      "when:skip",
      "echo:skip",
      "echo:pass",
    ]);
    expect(result.steps[0].reason).toMatch(/condition not met .*block skipped \(2 steps\)/);
    expect(result.steps[1].reason).toBe("when block skipped");
    // The skipped nested echo keeps its message so the renderer marks it
    // skipped rather than printing it as if it had run.
    expect(result.steps[3].message).toBe("nested");
    expect(result.taps).toHaveLength(0);
    expect(result.ok).toBe(true);
  });

  it("stamps nesting depth identically whether a block enters or skips", async () => {
    // Depth is display metadata for the renderers' indentation. Two invariants:
    // top-level steps omit the field entirely (a flat flow's report stays
    // byte-identical to the pre-depth shape), and a skipped block reports the
    // same depths as an entered one, so runs stay comparable run-to-run.
    await writeFlow("depths", {
      executionPrerequisite: "",
      steps: [
        {
          kind: "when",
          condition: {
            kind: "ui",
            condition: "visible",
            selector: { text: "What's new", loose: true },
          },
          steps: [
            { kind: "tap", selector: { text: "Skip", loose: true } },
            {
              kind: "when",
              condition: { kind: "platform", platform: "ios" },
              steps: [{ kind: "echo", message: "nested" }],
            },
          ],
        },
        { kind: "echo", message: "after block" },
      ],
    });

    currentTree = () =>
      screen([
        n({ label: "What's new", frame: { x: 0.1, y: 0.1, width: 0.8, height: 0.2 } }),
        n({ label: "Skip", frame: { x: 0.4, y: 0.8, width: 0.2, height: 0.1 } }),
      ]);
    const entered = await run("depths");
    expect(entered.steps.map((s) => `${s.kind}:${s.status}:${s.depth ?? 0}`)).toEqual([
      "when:pass:0",
      "tap:pass:1",
      "when:pass:1",
      "echo:pass:2",
      "echo:pass:0",
    ]);
    // Top level omits the field, not depth: 0.
    expect(entered.steps[0].depth).toBeUndefined();
    expect(entered.steps[4].depth).toBeUndefined();

    currentTree = () =>
      screen([n({ label: "Home", frame: { x: 0, y: 0, width: 1, height: 0.1 } })]);
    const skipped = await run("depths");
    expect(skipped.steps.map((s) => `${s.kind}:${s.status}:${s.depth ?? 0}`)).toEqual([
      "when:skip:0",
      "tap:skip:1",
      "when:skip:1",
      "echo:skip:2",
      "echo:pass:0",
    ]);
    expect(skipped.steps.map((s) => `${s.kind}:${s.depth ?? 0}`)).toEqual(
      entered.steps.map((s) => `${s.kind}:${s.depth ?? 0}`)
    );
    // The skip path, too, omits the field at top level rather than emitting 0
    // (the ?? 0 maps above cannot tell the two apart).
    expect(skipped.steps[0].depth).toBeUndefined();
    expect(skipped.steps[4].depth).toBeUndefined();
  });

  it("stamps depth on a run: inside a when block — expanded entered, one line skipped", async () => {
    await writeFlow("dismiss", {
      executionPrerequisite: "",
      steps: [{ kind: "tap", selector: { text: "Skip", loose: true } }],
    });
    await writeFlow("run-in-when", {
      executionPrerequisite: "",
      steps: [
        {
          kind: "when",
          condition: {
            kind: "ui",
            condition: "visible",
            selector: { text: "What's new", loose: true },
          },
          steps: [{ kind: "run", flow: "dismiss" }],
        },
        { kind: "echo", message: "after block" },
      ],
    });

    currentTree = () =>
      screen([
        n({ label: "What's new", frame: { x: 0.1, y: 0.1, width: 0.8, height: 0.2 } }),
        n({ label: "Skip", frame: { x: 0.4, y: 0.8, width: 0.2, height: 0.1 } }),
      ]);
    const entered = await run("run-in-when");
    // when marker at top level, run marker one deep, the fragment's steps two.
    expect(entered.steps.map((s) => `${s.kind}:${s.status}:${s.depth ?? 0}`)).toEqual([
      "when:pass:0",
      "run:pass:1",
      "tap:pass:2",
      "echo:pass:0",
    ]);

    currentTree = () =>
      screen([n({ label: "Home", frame: { x: 0, y: 0, width: 1, height: 0.1 } })]);
    const skipped = await run("run-in-when");
    // A skipped block's run: line stays single (the fragment is never loaded),
    // at the block's child depth via reportBlockSkipped.
    expect(skipped.steps.map((s) => `${s.kind}:${s.status}:${s.depth ?? 0}`)).toEqual([
      "when:skip:0",
      "run:skip:1",
      "echo:pass:0",
    ]);
  });

  it("treats a failure inside an entered block as a real failure (hard stop)", async () => {
    currentTree = () =>
      screen([n({ label: "What's new", frame: { x: 0.1, y: 0.1, width: 0.8, height: 0.2 } })]);
    await writeFlow("bad-dismiss", {
      executionPrerequisite: "",
      steps: [
        {
          kind: "when",
          condition: {
            kind: "ui",
            condition: "visible",
            selector: { text: "What's new", loose: true },
          },
          // The asserted element never exists — the step must FAIL, not skip.
          // An assert fails at the short grace; a tap on a missing element
          // would burn the full action retry budget for the same hard stop.
          steps: [
            {
              kind: "assert",
              condition: "visible",
              selector: { text: "No such button", loose: true },
            },
          ],
        },
        { kind: "echo", message: "never reached" },
      ],
    });

    const result = await run("bad-dismiss");

    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual([
      "when:pass",
      "assert:fail",
      "echo:skip",
    ]);
    // The trailing top-level echo is skipped by the hard stop but keeps its
    // message, so the renderer can mark it skipped instead of dropping the
    // line (or, worse, printing it as if it had run).
    expect(result.steps[2].message).toBe("never reached");
    expect(result.ok).toBe(false);
  });

  it("expands a when block skipped by a hard stop — one line per authored step, no abort", async () => {
    // The hard-stop test above places an echo after the failure; here a when
    // BLOCK sits there instead, so the stopped-run branch must expand the
    // block's authored steps rather than collapse it to one line. And a hard
    // stop is not a cancellation: `aborted` stays unset and the skip lines
    // carry no "run aborted" reason.
    currentTree = () =>
      screen([n({ label: "Home", frame: { x: 0, y: 0, width: 1, height: 0.1 } })]);
    await writeFlow("hard-stop-when", {
      executionPrerequisite: "",
      steps: [
        {
          kind: "assert",
          condition: "visible",
          selector: { text: "No such button", loose: true },
        },
        {
          kind: "when",
          condition: {
            kind: "ui",
            condition: "visible",
            selector: { text: "What's new", loose: true },
          },
          steps: [
            { kind: "tap", selector: { text: "Skip", loose: true } },
            { kind: "echo", message: "inside" },
          ],
        },
      ],
    });

    const result = await run("hard-stop-when");

    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual([
      "assert:fail",
      "when:skip",
      "tap:skip",
      "echo:skip",
    ]);
    // The hard-stop expansion keeps the block's depths: marker at top level
    // (field omitted), authored steps one deeper — same as an executed block.
    expect(result.steps.map((s) => s.depth)).toEqual([undefined, undefined, 1, 1]);
    expect(result.steps[1].reason).toBeUndefined();
    expect(result.steps[3].message).toBe("inside");
    expect(result.taps).toHaveLength(0);
    expect(result.ok).toBe(false);
    expect(result.aborted).toBeUndefined();
  });

  it("evaluates a platform guard statically against the resolved device", async () => {
    await writeFlow("per-platform", {
      executionPrerequisite: "",
      steps: [
        {
          kind: "when",
          condition: { kind: "platform", platform: "ios" },
          steps: [{ kind: "echo", message: "ios only" }],
        },
        {
          kind: "when",
          condition: { kind: "platform", platform: "android" },
          steps: [{ kind: "tool", name: "button", args: { button: "back" } }],
        },
      ],
    });

    const result = await run("per-platform"); // DEVICE is an iOS UDID

    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual([
      "when:pass",
      "echo:pass",
      "when:skip",
      "tool:skip",
    ]);
    expect(result.steps[2].reason).toMatch(/platform android/);
    expect(result.ok).toBe(true);
  });

  it("folds ios-remote to ios: a platform guard matches on a remote simulator", async () => {
    // A `remote:`-prefixed udid resolves as platform "ios-remote" (shape-based,
    // see classifyDevice), a spelling the parser deliberately rejects in
    // guards — execWhenStep folds it to "ios" at evaluation time. Without the
    // fold no guard could ever match on a remote sim: every
    // `when: { platform: ios }` block would silently skip there while the run
    // stays green — the same silent-no-op class the indeterminate-guard
    // handling exists to prevent. This test pins the fold at runtime.
    currentTree = () =>
      screen([n({ label: "Skip", frame: { x: 0.4, y: 0.8, width: 0.2, height: 0.1 } })]);
    await writeFlow("remote-sim", {
      executionPrerequisite: "",
      steps: [
        {
          kind: "when",
          condition: { kind: "platform", platform: "ios" },
          steps: [{ kind: "tap", selector: { text: "Skip", loose: true } }],
        },
        {
          kind: "when",
          condition: { kind: "platform", platform: "android" },
          steps: [{ kind: "tool", name: "button", args: { button: "back" } }],
        },
      ],
    });

    const result = await run("remote-sim", `remote:${DEVICE}`);

    // The run really targeted the remote-prefixed id (platform "ios-remote"),
    // not a local iOS udid — so entering the ios block below IS the fold.
    expect(result.device).toBe(`remote:${DEVICE}`);
    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual([
      "when:pass",
      "tap:pass",
      "when:skip",
      "tool:skip",
    ]);
    expect(result.steps[0].reason).toMatch(/condition met \(platform ios\)/);
    expect(result.steps[2].reason).toMatch(/platform android/);
    expect(result.taps).toHaveLength(1);
    expect(result.ok).toBe(true);
  });

  it("matches a platform guard positively on an android device and skips the ios block", async () => {
    // The inverse orientation of the iOS-udid test above: an android serial
    // (any id that is not a UUID / remote: / chromium-cdp- / amazon- shape
    // resolves as android) must ENTER the android block. Pins that guard
    // matching works from a non-iOS device too, not only as
    // ios-matches / android-skips seen from an iOS udid.
    currentTree = () =>
      screen([n({ label: "Allow", frame: { x: 0.4, y: 0.8, width: 0.2, height: 0.1 } })]);
    await writeFlow("android-run", {
      executionPrerequisite: "",
      steps: [
        {
          kind: "when",
          condition: { kind: "platform", platform: "android" },
          steps: [{ kind: "tap", selector: { text: "Allow", loose: true } }],
        },
        {
          kind: "when",
          condition: { kind: "platform", platform: "ios" },
          steps: [{ kind: "echo", message: "ios only" }],
        },
      ],
    });

    const result = await run("android-run", "emulator-5554");

    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual([
      "when:pass",
      "tap:pass",
      "when:skip",
      "echo:skip",
    ]);
    expect(result.steps[0].reason).toMatch(/condition met \(platform android\)/);
    expect(result.steps[2].reason).toMatch(/platform ios/);
    expect(result.taps).toHaveLength(1);
    expect(result.ok).toBe(true);
  });

  it("matches a platform guard positively on a vega device", async () => {
    // Vega resolves by the amazon- serial prefix. Touch directives are
    // rejected upfront on vega (it is remote-driven), so the guarded step is
    // an echo — the guard entering at all is what's under test.
    await writeFlow("vega-run", {
      executionPrerequisite: "",
      steps: [
        {
          kind: "when",
          condition: { kind: "platform", platform: "vega" },
          steps: [{ kind: "echo", message: "vega only" }],
        },
        {
          kind: "when",
          condition: { kind: "platform", platform: "ios" },
          steps: [{ kind: "echo", message: "ios only" }],
        },
      ],
    });

    const result = await run("vega-run", "amazon-4a27df03c9777152");

    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual([
      "when:pass",
      "echo:pass",
      "when:skip",
      "echo:skip",
    ]);
    expect(result.steps[0].reason).toMatch(/condition met \(platform vega\)/);
    expect(result.ok).toBe(true);
  });

  it("errors the when step when the guard cannot be evaluated (unreadable tree)", async () => {
    currentTree = () => {
      throw new Error("native devtools disconnected");
    };
    await writeFlow("blind", {
      executionPrerequisite: "",
      steps: [
        {
          kind: "when",
          condition: {
            kind: "ui",
            condition: "visible",
            selector: { text: "What's new", loose: true },
          },
          steps: [{ kind: "tap", selector: { text: "Skip", loose: true } }],
        },
        { kind: "echo", message: "never reached" },
      ],
    });

    const result = await run("blind");

    // "Could not evaluate" is not "condition false" — a broken tree source
    // must not silently turn a guarded dismissal into a green no-op. The
    // guarded steps still expand: one skip line per authored step, same
    // report shape as an unmet guard.
    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual([
      "when:error",
      "tap:skip",
      "echo:skip",
    ]);
    expect(result.steps[0].reason).toMatch(/could not evaluate when guard/i);
    expect(result.steps[1].reason).toBe("when guard errored");
    expect(result.ok).toBe(false);
  });

  it("expands a nested when block when the guard errors", async () => {
    currentTree = () => {
      throw new Error("native devtools disconnected");
    };
    await writeFlow("blind-nested", {
      executionPrerequisite: "",
      steps: [
        {
          kind: "when",
          condition: {
            kind: "ui",
            condition: "visible",
            selector: { text: "What's new", loose: true },
          },
          steps: [
            { kind: "tap", selector: { text: "Skip", loose: true } },
            {
              kind: "when",
              condition: { kind: "platform", platform: "ios" },
              steps: [{ kind: "echo", message: "nested" }],
            },
          ],
        },
        { kind: "echo", message: "never reached" },
      ],
    });

    const result = await run("blind-nested");

    // An errored guard reports the same shape as an unmet one — the block
    // marker errors, then one skip line per authored step with the nested
    // when's subtree expanded.
    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual([
      "when:error",
      "tap:skip",
      "when:skip",
      "echo:skip",
      "echo:skip",
    ]);
    // The errored-guard expansion keeps the entered-block depths: marker and
    // trailing echo at top level (field omitted), authored steps one deeper.
    expect(result.steps.map((s) => s.depth)).toEqual([undefined, 1, 1, 2, undefined]);
    expect(result.steps[2].reason).toBe("when guard errored");
    expect(result.errored).toBe(1);
    expect(result.skipped).toBe(2); // tap + nested when marker; echo is narration
    expect(result.ok).toBe(false);
  });

  it("errors — not skips — when every read in the window is blind (empty tree + hint)", async () => {
    // A detached tree source (e.g. Vega toolkit) surfaces as SUCCESSFUL
    // fetches returning an empty tree with a degraded-read hint. That is not
    // evidence the condition is false, for any condition kind.
    currentTree = () => screen([]);
    currentHint = "automation toolkit not attached — relaunch the app";
    await writeFlow("degraded", {
      executionPrerequisite: "",
      steps: [
        {
          kind: "when",
          condition: {
            kind: "ui",
            condition: "visible",
            selector: { text: "Got it", loose: true },
          },
          steps: [{ kind: "tap", selector: { text: "Got it", loose: true } }],
        },
        { kind: "echo", message: "never reached" },
      ],
    });

    const result = await run("degraded");

    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual([
      "when:error",
      "tap:skip",
      "echo:skip",
    ]);
    expect(result.steps[0].reason).toMatch(/could not evaluate when guard/i);
    expect(result.taps).toHaveLength(0);
    expect(result.ok).toBe(false);
  });

  it("errors a hidden guard that ends on blind reads after the element matched", async () => {
    // First read: trusted, element visible. Every later read: empty tree,
    // blind because the selector had matched. Gone-ness can't be confirmed —
    // unknown must not be treated as "condition false".
    let reads = 0;
    currentTree = () =>
      reads++ === 0
        ? screen([n({ label: "Spinner", frame: { x: 0.4, y: 0.4, width: 0.2, height: 0.2 } })])
        : screen([]);
    await writeFlow("spinner-gone", {
      executionPrerequisite: "",
      steps: [
        {
          kind: "when",
          condition: {
            kind: "ui",
            condition: "hidden",
            selector: { text: "Spinner", loose: true },
          },
          steps: [{ kind: "echo", message: "cleanup" }],
        },
        { kind: "echo", message: "never reached" },
      ],
    });

    const result = await run("spinner-gone");

    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual([
      "when:error",
      "echo:skip",
      "echo:skip",
    ]);
    expect(result.steps[0].reason).toMatch(/could not confirm the element is hidden/i);
    expect(result.ok).toBe(false);
  });

  it("errors a hidden guard whose later reads throw after the element matched", async () => {
    // The same evidence gap as the blind-read case, surfaced as a THROW: read
    // 1 is trusted and sees the spinner, then the tree source disconnects and
    // every later fetch rejects. The visible match left over from read 1 must
    // not stand in as current evidence and turn the guard into a determinate
    // "condition not met" skip — gone-ness is unconfirmable, so error.
    let reads = 0;
    currentTree = () => {
      if (reads++ === 0) {
        return screen([
          n({ label: "Spinner", frame: { x: 0.4, y: 0.4, width: 0.2, height: 0.2 } }),
        ]);
      }
      throw new Error("native devtools disconnected");
    };
    await writeFlow("spinner-dark", {
      executionPrerequisite: "",
      steps: [
        {
          kind: "when",
          condition: {
            kind: "ui",
            condition: "hidden",
            selector: { text: "Spinner", loose: true },
          },
          steps: [{ kind: "echo", message: "cleanup" }],
        },
        { kind: "echo", message: "never reached" },
      ],
    });

    const result = await run("spinner-dark");

    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual([
      "when:error",
      "echo:skip",
      "echo:skip",
    ]);
    expect(result.steps[0].reason).toMatch(/could not confirm the element is hidden/i);
    expect(result.steps[0].reason).toMatch(/native devtools disconnected/);
    expect(result.ok).toBe(false);
  });

  it("keeps a clean skip when trusted reads showed a non-hidden condition false and only the final polls throw", async () => {
    // The trailing-blip tolerance for every condition except `hidden`:
    // trusted reads showed "What's new" absent until ~one poll before the
    // 1s guard deadline, so a disconnect on the trailing polls is a blip,
    // not doubt — the skip stays clean and the run green. (Appending the
    // failed-read note is an assert/await report feature; the when skip
    // reason carries only the guard label.)
    let firstReadAt: number | undefined;
    currentTree = () => {
      firstReadAt ??= Date.now();
      if (Date.now() - firstReadAt >= 950) throw new Error("native devtools disconnected");
      return screen([n({ label: "Home", frame: { x: 0, y: 0, width: 1, height: 0.1 } })]);
    };
    await writeFlow("blip-skip", {
      executionPrerequisite: "",
      steps: [
        {
          kind: "when",
          condition: {
            kind: "ui",
            condition: "visible",
            selector: { text: "What's new", loose: true },
          },
          steps: [{ kind: "tap", selector: { text: "Skip", loose: true } }],
        },
        { kind: "echo", message: "after block" },
      ],
    });

    const result = await run("blip-skip");

    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual([
      "when:skip",
      "tap:skip",
      "echo:pass",
    ]);
    expect(result.steps[0].reason).toMatch(/condition not met/);
    expect(result.taps).toHaveLength(0);
    expect(result.ok).toBe(true);
  });

  it("errors — not skips — a guard whose reads go dark for the tail of the window", async () => {
    // The unbounded dark tail: one trusted read shows "What's new" absent,
    // then the tree source dies for the REST of the 1s window. That early
    // read is the expected starting state of a wait, not evidence about the
    // deadline — a determinate "condition not met" skip here would let a
    // dying tree source turn a guarded dismissal into a silent green no-op
    // while the dialog may well be on screen. Unknown is not false: error.
    let reads = 0;
    currentTree = () => {
      if (reads++ === 0) {
        return screen([n({ label: "Home", frame: { x: 0, y: 0, width: 1, height: 0.1 } })]);
      }
      throw new Error("native devtools disconnected");
    };
    await writeFlow("dark-tail-guard", {
      executionPrerequisite: "",
      steps: [
        {
          kind: "when",
          condition: {
            kind: "ui",
            condition: "visible",
            selector: { text: "What's new", loose: true },
          },
          steps: [{ kind: "tap", selector: { text: "Skip", loose: true } }],
        },
        { kind: "echo", message: "never reached" },
      ],
    });

    const result = await run("dark-tail-guard");

    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual([
      "when:error",
      "tap:skip",
      "echo:skip",
    ]);
    expect(result.steps[0].reason).toMatch(/could not evaluate when guard/i);
    expect(result.steps[0].reason).toMatch(/unreadable for the final \d+ms/i);
    expect(result.steps[0].reason).toMatch(/native devtools disconnected/);
    expect(result.taps).toHaveLength(0);
    expect(result.ok).toBe(false);
  });

  it("streams every when-related report line to the live progress consumer", async () => {
    // All when reports go through pushReport — the progress stream and the
    // final report must contain the same lines.
    currentTree = () =>
      screen([n({ label: "Home", frame: { x: 0, y: 0, width: 1, height: 0.1 } })]);
    await writeFlow("stream", {
      executionPrerequisite: "",
      steps: [
        {
          kind: "when",
          condition: {
            kind: "ui",
            condition: "visible",
            selector: { text: "What's new", loose: true },
          },
          steps: [
            { kind: "tap", selector: { text: "Skip", loose: true } },
            { kind: "echo", message: "inside" },
          ],
        },
        { kind: "echo", message: "after block" },
      ],
    });

    const events: unknown[] = [];
    const tool = createRunFlowTool(mockRegistry([]));
    const ctx = {
      emitProgress: (e: unknown) => {
        events.push(e);
      },
    } as unknown as Parameters<typeof tool.execute>[2];
    const result = asRun(
      await tool.execute({}, { name: "stream", project_root: tmpDir, device: DEVICE }, ctx)
    );

    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual([
      "when:skip",
      "tap:skip",
      "echo:skip",
      "echo:pass",
    ]);
    expect(events).toEqual(result.steps);
  });
});

describe("when: as tap-if-present", () => {
  const coachMark = (): Parameters<typeof writeFlow>[1] => ({
    executionPrerequisite: "",
    steps: [
      {
        kind: "when",
        condition: { kind: "ui", condition: "visible", selector: { text: "Got it", loose: true } },
        steps: [{ kind: "tap", selector: { text: "Got it", loose: true } }],
      },
      { kind: "echo", message: "after" },
    ],
  });

  it("taps when the target is visible", async () => {
    currentTree = () =>
      screen([n({ label: "Got it", frame: { x: 0.4, y: 0.8, width: 0.2, height: 0.1 } })]);
    await writeFlow("coach-mark", coachMark());

    const result = await run("coach-mark");

    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual([
      "when:pass",
      "tap:pass",
      "echo:pass",
    ]);
    expect(result.taps).toHaveLength(1);
    expect(result.ok).toBe(true);
  });

  it("skips — and keeps the run green — when the target is absent", async () => {
    currentTree = () =>
      screen([n({ label: "Home", frame: { x: 0, y: 0, width: 1, height: 0.1 } })]);
    await writeFlow("no-coach-mark", coachMark());

    const result = await run("no-coach-mark");

    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual([
      "when:skip",
      "tap:skip",
      "echo:pass",
    ]);
    expect(result.taps).toHaveLength(0);
    expect(result.ok).toBe(true);
  });
});

describe("when: run cancellation", () => {
  // Same abort injection as flow-abort.test.ts: trip an AbortController from
  // inside the mocked tree fetch, landing the cancellation deterministically
  // inside a poll (no timer races).

  it("skips the block with the abort reason — not a determinate skip — when the guard probe is cancelled", async () => {
    const controller = new AbortController();
    // The guard's target is absent and the cancellation lands inside the
    // probe's first tree read. ABORTED_OUTCOME carries no `indeterminate`, so
    // without execWhenStep's dedicated probe.aborted branch the cancelled
    // probe would fall through to met=false and claim the determinate
    // "condition not met (...) — block skipped" for a screen it never
    // finished reading — the assertions below pin the abort reason instead.
    currentTree = () => {
      controller.abort();
      return screen([n({ label: "Home", frame: { x: 0, y: 0, width: 1, height: 0.1 } })]);
    };
    await writeFlow("cancelled-guard", {
      executionPrerequisite: "",
      steps: [
        {
          kind: "when",
          condition: {
            kind: "ui",
            condition: "visible",
            selector: { text: "What's new", loose: true },
          },
          steps: [
            { kind: "tap", selector: { text: "Skip", loose: true } },
            { kind: "echo", message: "inside" },
          ],
        },
        { kind: "echo", message: "after block" },
      ],
    });

    const result = await run("cancelled-guard", DEVICE, controller.signal);

    // The block marker + every authored step skip with the uniform abort
    // reason, and the guarded tap never dispatches.
    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual([
      "when:skip",
      "tap:skip",
      "echo:skip",
      "echo:skip",
    ]);
    expect(result.steps[0].reason).toBe("run aborted");
    expect(result.steps[0].reason).not.toMatch(/condition not met/);
    expect(result.steps[1].reason).toBe("run aborted");
    expect(result.taps).toHaveLength(0);
    expect(result.ok).toBe(false);
    expect(result.aborted).toBe(true);
  });

  it("expands a when block — nested block included — when the run was cancelled before it", async () => {
    const controller = new AbortController();
    // The tap's target never appears; the run is cancelled on the third tree
    // read, while the tap's auto-wait is still polling. The when block after
    // it then hits the pre-step abort guard: one skip line for the marker AND
    // one per authored step, with the nested when's subtree expanded.
    let reads = 0;
    currentTree = () => {
      reads++;
      if (reads >= 3) controller.abort();
      return screen([n({ label: "Home", frame: { x: 0, y: 0, width: 1, height: 0.1 } })]);
    };
    await writeFlow("aborted-before-when", {
      executionPrerequisite: "",
      steps: [
        { kind: "tap", selector: { text: "Checkout", loose: true } },
        {
          kind: "when",
          condition: {
            kind: "ui",
            condition: "visible",
            selector: { text: "What's new", loose: true },
          },
          steps: [
            { kind: "tap", selector: { text: "Skip", loose: true } },
            {
              kind: "when",
              condition: { kind: "platform", platform: "ios" },
              steps: [{ kind: "echo", message: "nested" }],
            },
          ],
        },
      ],
    });

    const result = await run("aborted-before-when", DEVICE, controller.signal);

    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual([
      "tap:skip",
      "when:skip",
      "tap:skip",
      "when:skip",
      "echo:skip",
    ]);
    expect(result.steps.map((s) => s.reason)).toEqual(Array(5).fill("run aborted"));
    // Abort skips keep the block's depths — top-level markers omit the field,
    // authored steps sit one deeper — same shape as a clean run.
    expect(result.steps.map((s) => s.depth)).toEqual([undefined, undefined, 1, 1, 2]);
    // The skipped nested echo keeps its message, matching reportBlockSkipped.
    expect(result.steps[4].message).toBe("nested");
    expect(result.taps).toHaveLength(0);
    expect(result.ok).toBe(false);
    expect(result.aborted).toBe(true);
  });

  it("leaves the aborted field unset on a clean green run", async () => {
    // Control for the cancellation cases: summarize spreads the flag in only
    // when the signal tripped (`...(aborted ? { aborted: true } : {})`), so a
    // completed run must not carry the key at all.
    currentTree = () =>
      screen([n({ label: "Got it", frame: { x: 0.4, y: 0.8, width: 0.2, height: 0.1 } })]);
    await writeFlow("green-run", {
      executionPrerequisite: "",
      steps: [
        {
          kind: "when",
          condition: {
            kind: "ui",
            condition: "visible",
            selector: { text: "Got it", loose: true },
          },
          steps: [{ kind: "tap", selector: { text: "Got it", loose: true } }],
        },
        { kind: "echo", message: "after" },
      ],
    });

    const result = await run("green-run");

    expect(result.ok).toBe(true);
    expect(result.aborted).toBeUndefined();
    expect("aborted" in result).toBe(false);
  });
});
