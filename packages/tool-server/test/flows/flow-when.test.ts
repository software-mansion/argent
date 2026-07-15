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
  name: string
): Promise<FlowRunResult & { taps: Array<{ x: number; y: number }> }> {
  const taps: Array<{ x: number; y: number }> = [];
  const tool = createRunFlowTool(mockRegistry(taps));
  const result = asRun(await tool.execute({}, { name, project_root: tmpDir, device: DEVICE }));
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
    expect(result.taps).toHaveLength(0);
    expect(result.ok).toBe(true);
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
    expect(result.ok).toBe(false);
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
