import { describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { DescribeNode, DescribeTreeData } from "../../src/tools/describe/contract";

let currentTree: () => DescribeNode;
vi.mock("../../src/tools/flows/flow-tree", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/tools/flows/flow-tree")>()),
  fetchFlowTree: vi.fn(async (): Promise<DescribeTreeData> => ({
    tree: currentTree(),
    source: "native-devtools",
  })),
}));

// Replaces the runner's line lookup when set: every parsed step has a line, so
// only a replaced lookup gives a step none.
let lineLookup: ((step: FlowStep) => number | undefined) | undefined;
vi.mock("../../src/tools/flows/flow-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/tools/flows/flow-utils")>();
  return {
    ...actual,
    flowStepLine: (step: FlowStep) => (lineLookup ?? actual.flowStepLine)(step),
  };
});

// When set, the run resolves as device-free and only a step of a listed kind
// acts on a device. No real flow reaches the runner's device-free error: the
// resolution reads every step except a fragment's, and a `run:` step needs a
// device itself.
let deviceKinds: Array<FlowStep["kind"]> | undefined;
vi.mock("../../src/tools/flows/flow-device", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/tools/flows/flow-device")>();
  return {
    ...actual,
    flowRequiresDevice: (registry: Registry, steps: FlowStep[]) =>
      deviceKinds ? false : actual.flowRequiresDevice(registry, steps),
    stepRequiresDevice: (registry: Registry, step: FlowStep) =>
      deviceKinds ? deviceKinds.includes(step.kind) : actual.stepRequiresDevice(registry, step),
  };
});

import type { Registry } from "@argent/registry";
import { createFlowTestHarness, label, screen } from "./harness";
import { createRunFlowTool, type FlowRunResult } from "../../src/tools/flows/flow-run";
import {
  blockSteps,
  flowStepLine,
  parseFlow,
  serializeFlow,
  type FlowFile,
  type FlowStep,
} from "../../src/tools/flows/flow-utils";

const { run, writeFlowYaml, root } = createFlowTestHarness({
  tempDirectoryPrefix: "flow-step-lines-",
  reset: () => {
    currentTree = () => screen([label("Sign in")]);
    lineLookup = undefined;
    deviceKinds = undefined;
  },
});

const IOS_DEVICE = "00000000-0000-0000-0000-0000000000ab";

/**
 * Run `name` like the harness's `run`, with what `run` does not take: a
 * cancellation signal, or no device.
 */
async function runWith(
  name: string,
  options: { device?: string; signal?: AbortSignal }
): Promise<FlowRunResult> {
  const registry = {
    invokeTool: vi.fn(async (id: string) => (id === "list-devices" ? { devices: [] } : {})),
    getTool: vi.fn(() => ({ inputSchema: { properties: { udid: {} } } })),
  } as unknown as Registry;
  return (await createRunFlowTool(registry).execute(
    {},
    { name, project_root: root(), device: options.device },
    { signal: options.signal } as never
  )) as FlowRunResult;
}

/** A flow file's text, one argument per line, so argument N is line N. */
function yaml(...lines: string[]): string {
  return lines.join("\n") + "\n";
}

/** Each step's line, a block's steps right after it: the order a run reports them in. */
function stepLines(steps: FlowStep[]): Array<number | undefined> {
  return steps.flatMap((step) => [flowStepLine(step), ...stepLines(blockSteps(step) ?? [])]);
}

/** The fields these tests pin, per report line. */
function where(result: FlowRunResult) {
  return result.steps.map(({ kind, status, line, file }) => ({ kind, status, line, file }));
}

describe("flowStepLine", () => {
  it("gives each step of a block list the line its entry starts on", () => {
    const flow = parseFlow(
      yaml(
        'executionPrerequisite: ""',
        "steps:",
        "  - launch: com.example.app",
        "  - type:",
        "      into: { id: email }",
        "      text: a@b.c",
        "  - tool: gesture-swipe",
        "    args:",
        "      fromX: 0.5",
        "  - echo: done"
      )
    );

    expect(stepLines(flow.steps)).toEqual([3, 4, 7, 10]);
  });

  it("counts the blank lines and the comment above steps:", () => {
    // The parser trims the file before reading it; the lines it trimmed off
    // still count.
    const commented = parseFlow(
      "\n\n" +
        yaml(
          "# Signs in from the landing screen.",
          "",
          "steps:",
          "  - tap: Sign in",
          "  - echo: in"
        )
    );
    expect(stepLines(commented.steps)).toEqual([6, 7]);

    const whitespace = parseFlow(" \t\n  \n" + yaml("steps:", "  - echo: a"));
    expect(stepLines(whitespace.steps)).toEqual([4]);

    const marked = parseFlow(yaml("---", "steps:", "  - echo: a"));
    expect(stepLines(marked.steps)).toEqual([3]);
  });

  it("counts the blank lines above steps: for the steps inside a when: block too", () => {
    const flow = parseFlow(
      "\n\n" +
        yaml("steps:", "  - when: { platform: ios }", "    steps:", "      - tap: A", "  - echo: b")
    );

    expect(stepLines(flow.steps)).toEqual([4, 6, 7]);
  });

  it("does not count the blank lines at the end of the file", () => {
    const steps = yaml("steps:", "  - echo: a", "  - tap: b");

    expect(stepLines(parseFlow(steps + "\n".repeat(8)).steps)).toEqual([2, 3]);
    expect(stepLines(parseFlow(steps + " ".repeat(8)).steps)).toEqual([2, 3]);
  });

  it("counts CRLF line endings the same as LF", () => {
    const lf = "\n" + yaml("steps:", "  - echo: a", "", "  - tap: b");
    const crlf = lf.replaceAll("\n", "\r\n");

    expect(stepLines(parseFlow(lf).steps)).toEqual([3, 5]);
    expect(stepLines(parseFlow(crlf).steps)).toEqual([3, 5]);
  });

  it("skips over comment and blank lines between steps", () => {
    const flow = parseFlow(
      yaml("steps:", "  - echo: a", "  # the button shows after the banner", "", "  - tap: b")
    );

    expect(stepLines(flow.steps)).toEqual([2, 5]);
  });

  it("gives a when: block and each step inside it their own lines", () => {
    const flow = parseFlow(
      yaml(
        "steps:",
        "  - when: { visible: What's new }",
        "    steps:",
        "      - tap: Skip",
        "      - when: { platform: android }",
        "        steps:",
        "          - tool: button",
        "            args: { button: back }",
        "  - echo: after"
      )
    );

    expect(stepLines(flow.steps)).toEqual([2, 4, 5, 7, 9]);
  });

  it("puts each step of a flow-style list on the line its entry is written on", () => {
    const oneLine = parseFlow(yaml("steps: [ {launch: a}, {tap: b} ]"));
    expect(stepLines(oneLine.steps)).toEqual([1, 1]);

    const spread = parseFlow(yaml("steps: [", "  {launch: a},", "  {tap: b}", "]"));
    expect(stepLines(spread.steps)).toEqual([2, 3]);
  });

  it("gives an entry written below a bare dash the line its body starts on", () => {
    const flow = parseFlow(yaml("steps:", "  -", "    tap: b", "  - echo: c"));

    expect(stepLines(flow.steps)).toEqual([3, 4]);
  });

  it("gives the steps of a list written as an alias the lines of the list it repeats", () => {
    // The alias has no entries of its own; its steps are written in the list
    // the anchor names.
    const flow = parseFlow(
      yaml(
        "steps:",
        "  - when: { platform: ios }",
        "    steps: &common",
        "      - tap: A",
        "  - when: { platform: android }",
        "    steps: *common"
      )
    );

    expect(stepLines(flow.steps)).toEqual([2, 4, 5, 4]);
  });

  it("gives a block written as an alias the alias's line, and its steps the lines they repeat", () => {
    const flow = parseFlow(
      yaml(
        "steps:",
        "  - &guard",
        "    when: { platform: ios }",
        "    steps:",
        "      - tap: A",
        "  - *guard"
      )
    );

    expect(stepLines(flow.steps)).toEqual([3, 5, 6, 5]);
  });

  it.each([
    ["<<", "%YAML 1.1"],
    ["!!merge <<", "%YAML 1.2"],
    ["!!str <<", "%YAML 1.1"],
  ])(
    "gives the steps that a %s merge key gives a when: block their own lines (%s)",
    (key, directive) => {
      const flow = parseFlow(
        yaml(
          directive,
          "---",
          "steps:",
          "  - echo: zero",
          `  - ${key}: &w`,
          "      when: { platform: ios }",
          "      steps:",
          "        - echo: inner1",
          "        - tap: inner2"
        )
      );

      expect(stepLines(flow.steps)).toEqual([4, 5, 8, 9]);
    }
  );

  it("reads a block's own steps: before any a merge key gives it", () => {
    const flow = parseFlow(
      yaml(
        "%YAML 1.1",
        "---",
        "steps:",
        "  - <<: { when: { platform: ios }, steps: [{ echo: merged }] }",
        "    steps:",
        "      - echo: own"
      )
    );

    expect(stepLines(flow.steps)).toEqual([4, 6]);
  });

  it("reads steps: from the first merged map that holds it, at the top level too", () => {
    const listed = parseFlow(
      yaml(
        "%YAML 1.1",
        "---",
        "steps:",
        "  - &ios",
        "    when: { platform: ios }",
        "    steps:",
        "      - echo: ios",
        "  - &android",
        "    when: { platform: android }",
        "    steps:",
        "      - echo: android",
        "  - <<: [*android, *ios]"
      )
    );
    expect(stepLines(listed.steps)).toEqual([5, 7, 9, 11, 12, 11]);

    const topLevel = parseFlow(yaml("%YAML 1.1", "---", "<<:", "  steps:", "    - echo: a"));
    expect(stepLines(topLevel.steps)).toEqual([5]);
  });

  it("gives no line to a step that was not parsed from a file", () => {
    expect(flowStepLine({ kind: "echo", message: "hi" })).toBeUndefined();
  });

  it("keeps the line out of the parsed steps themselves", () => {
    const flow: FlowFile = {
      executionPrerequisite: "On the landing screen",
      steps: [
        { kind: "echo", message: "start" },
        {
          kind: "when",
          condition: { kind: "platform", platform: "ios" },
          steps: [{ kind: "tap", selector: { text: "Sign in", loose: true } }],
        },
      ],
    };

    const parsed = parseFlow(serializeFlow(flow));

    expect(stepLines(parsed.steps).every((line) => line !== undefined)).toBe(true);
    expect(parsed).toStrictEqual(flow);
    expect(serializeFlow(parsed)).toBe(serializeFlow(flow));
    expect(parseFlow(yaml("steps:", "  - echo: a", "  - tap: b"))).toStrictEqual({
      executionPrerequisite: "",
      steps: [
        { kind: "echo", message: "a" },
        { kind: "tap", selector: { text: "b", loose: true } },
      ],
    });
  });
});

describe("where a run reports each step is written", () => {
  it("reports a failing step of the flow at its line, with no file", async () => {
    await writeFlowYaml(
      "checkout.yaml",
      yaml(
        'executionPrerequisite: ""',
        "steps:",
        "  # Signed out, on the landing screen.",
        "  - echo: start",
        "  - tap: Sign in",
        "",
        "  - assert: { visible: Welcome }",
        "  - echo: never"
      )
    );

    const result = await run("checkout");

    expect(where(result)).toEqual([
      { kind: "echo", status: "pass", line: 4, file: undefined },
      { kind: "tap", status: "pass", line: 5, file: undefined },
      { kind: "assert", status: "fail", line: 7, file: undefined },
      { kind: "echo", status: "skip", line: 8, file: undefined },
    ]);
  });

  it("reports a step inside a when: block at its own line", async () => {
    await writeFlowYaml(
      "guarded.yaml",
      yaml(
        "steps:",
        "  - echo: start",
        "  - when: { platform: ios }",
        "    steps:",
        "      - echo: inside",
        "      - assert: { visible: Welcome }"
      )
    );

    const result = await run("guarded");

    expect(where(result)).toEqual([
      { kind: "echo", status: "pass", line: 2, file: undefined },
      { kind: "when", status: "pass", line: 3, file: undefined },
      { kind: "echo", status: "pass", line: 5, file: undefined },
      { kind: "assert", status: "fail", line: 6, file: undefined },
    ]);
  });

  it("reports a failing step of a when: block whose steps: is an alias at the line it repeats", async () => {
    await writeFlowYaml(
      "aliased.yaml",
      yaml(
        "steps:",
        "  - when: { platform: android }",
        "    steps: &checks",
        "      - assert: { visible: Welcome }",
        "  - when: { platform: ios }",
        "    steps: *checks"
      )
    );

    const result = await run("aliased");

    expect(where(result)).toEqual([
      { kind: "when", status: "skip", line: 2, file: undefined },
      { kind: "assert", status: "skip", line: 4, file: undefined },
      { kind: "when", status: "pass", line: 5, file: undefined },
      { kind: "assert", status: "fail", line: 4, file: undefined },
    ]);
  });

  it("reports each step of a skipped when: block at its line", async () => {
    await writeFlowYaml(
      "unmet.yaml",
      yaml(
        "steps:",
        "  - when: { platform: android }",
        "    steps:",
        "      - tap: Back",
        "      - when: { visible: Dialog }",
        "        steps:",
        "          - tap: Close",
        "  - echo: after"
      )
    );

    const result = await run("unmet");

    expect(where(result)).toEqual([
      { kind: "when", status: "skip", line: 2, file: undefined },
      { kind: "tap", status: "skip", line: 4, file: undefined },
      { kind: "when", status: "skip", line: 5, file: undefined },
      { kind: "tap", status: "skip", line: 7, file: undefined },
      { kind: "echo", status: "pass", line: 8, file: undefined },
    ]);
  });

  it("reports a fragment's steps at their lines in the fragment, and the run: step in the flow", async () => {
    await writeFlowYaml(
      "main.yaml",
      yaml("steps:", "  - echo: start", "", "  - run: shared/login.yaml", "  - echo: never")
    );
    const login = await writeFlowYaml(
      "shared/login.yaml",
      yaml(
        "# Signs in from the landing screen.",
        "steps:",
        "  - tap: Sign in",
        "  - assert: { visible: Welcome }",
        "  - tap: Continue"
      )
    );

    const result = await run("main");

    expect(where(result)).toEqual([
      { kind: "echo", status: "pass", line: 2, file: undefined },
      { kind: "run", status: "pass", line: 4, file: undefined },
      { kind: "tap", status: "pass", line: 3, file: login },
      { kind: "assert", status: "fail", line: 4, file: login },
      { kind: "tap", status: "skip", line: 5, file: login },
      { kind: "echo", status: "skip", line: 5, file: undefined },
    ]);
  });

  it("names a fragment reached through a symlink by the file the link points to", async () => {
    const main = await writeFlowYaml("main.yaml", yaml("steps:", "  - run: login.yaml"));
    const login = await writeFlowYaml("shared/login.yaml", yaml("steps:", "  - echo: signing in"));
    await fs.symlink(login, path.join(path.dirname(main), "login.yaml"));

    const result = await run("main");

    expect(where(result)).toEqual([
      { kind: "run", status: "pass", line: 2, file: undefined },
      { kind: "echo", status: "pass", line: 2, file: login },
    ]);
  });

  it("names no file for a fragment step whose line is not known", async () => {
    // `file` says which file `line` is in, so a step with no line has neither.
    await writeFlowYaml("main.yaml", yaml("steps:", "  - run: login.yaml"));
    await writeFlowYaml("login.yaml", yaml("steps:", "  - echo: signing in"));
    lineLookup = (step) => (step.kind === "run" ? 2 : undefined);

    const result = await run("main");

    expect(where(result)).toEqual([
      { kind: "run", status: "pass", line: 2, file: undefined },
      { kind: "echo", status: "pass", line: undefined, file: undefined },
    ]);
    expect(Object.keys(result.steps[1])).not.toContain("line");
  });

  it("reports a run: step inside a fragment in that fragment's file", async () => {
    await writeFlowYaml("main.yaml", yaml("steps:", "  - run: shared/checkout.yaml"));
    const checkout = await writeFlowYaml(
      "shared/checkout.yaml",
      yaml(
        "steps:",
        "  - echo: checkout",
        "  - when: { platform: ios }",
        "    steps:",
        "      - run: pay.yaml"
      )
    );
    const pay = await writeFlowYaml(
      "shared/pay.yaml",
      yaml("steps:", "", "  - assert: { visible: Paid }")
    );

    const result = await run("main");

    expect(where(result)).toEqual([
      { kind: "run", status: "pass", line: 2, file: undefined },
      { kind: "echo", status: "pass", line: 2, file: checkout },
      { kind: "when", status: "pass", line: 3, file: checkout },
      { kind: "run", status: "pass", line: 5, file: checkout },
      { kind: "assert", status: "fail", line: 3, file: pay },
    ]);
  });

  it("reports a run: step whose fragment cannot be loaded at the run: step", async () => {
    await writeFlowYaml("main.yaml", yaml("steps:", "  - run: shared/outer.yaml"));
    const outer = await writeFlowYaml(
      "shared/outer.yaml",
      yaml("steps:", "  - echo: outer", "  - run: broken.yaml")
    );
    await writeFlowYaml("shared/broken.yaml", yaml("steps:", "  - tap: ["));

    const result = await run("main");

    expect(where(result)).toEqual([
      { kind: "run", status: "pass", line: 2, file: undefined },
      { kind: "echo", status: "pass", line: 2, file: outer },
      { kind: "run", status: "error", line: 3, file: outer },
    ]);
    expect(result.steps[2].reason).toMatch(/could not load fragment "broken\.yaml"/);
  });

  it("keeps the nested run's lines and files in a tool: flow-execute step's result", async () => {
    // The step's result is the nested run's whole report, which MCP prints as
    // JSON, so the nested steps carry their lines there too. The report names
    // only the nested flow, so each of its steps also names its file.
    const inner = await writeFlowYaml(
      "inner.yaml",
      yaml("steps:", "  - echo: inner", "  - run: helpers/frag.yaml")
    );
    const frag = await writeFlowYaml("helpers/frag.yaml", yaml("steps:", "", "  - echo: frag"));
    const projectRoot = path.dirname(path.dirname(path.dirname(inner)));
    await writeFlowYaml(
      "outer.yaml",
      yaml(
        "steps:",
        "  - echo: outer",
        "  - tool: flow-execute",
        `    args: { name: inner, project_root: ${JSON.stringify(projectRoot)} }`
      )
    );
    const registry = {
      // The options become the nested run's context, as the registry passes
      // them: the nested run's `run:` chain starts with the outer run's.
      invokeTool: vi.fn(async (id: string, args: Record<string, unknown>, options?: unknown) =>
        id === "flow-execute" ? runFlow.execute({}, args as never, options as never) : { ok: true }
      ),
      // `device` is a bind key, so the nested run drives the outer run's device.
      getTool: vi.fn(() => ({ inputSchema: { properties: { name: {}, device: {} } } })),
    } as unknown as Registry;
    const runFlow = createRunFlowTool(registry);

    const result = (await runFlow.execute(
      {},
      { name: "outer", project_root: projectRoot, device: "DEVICE" }
    )) as FlowRunResult;

    expect(where(result)).toEqual([
      { kind: "echo", status: "pass", line: 2, file: undefined },
      { kind: "tool", status: "pass", line: 3, file: undefined },
    ]);
    expect(where(result.steps[1].result as FlowRunResult)).toEqual([
      { kind: "echo", status: "pass", line: 2, file: inner },
      { kind: "run", status: "pass", line: 3, file: inner },
      { kind: "echo", status: "pass", line: 3, file: frag },
    ]);
  });

  it("names each nested run's file and line at every level of a tool: e2e-execute chain", async () => {
    const inner2 = await writeFlowYaml(
      "inner2.yaml",
      yaml("steps:", "  - echo: inner2", "  - assert: { visible: Welcome }", "  - echo: never")
    );
    const projectRoot = path.dirname(path.dirname(path.dirname(inner2)));
    const inner = await writeFlowYaml(
      "inner.yaml",
      yaml(
        "steps:",
        "",
        "  - tool: e2e-execute",
        `    args: { name: inner2, project_root: ${JSON.stringify(projectRoot)} }`
      )
    );
    await writeFlowYaml(
      "outer.yaml",
      yaml(
        "steps:",
        "  - echo: outer",
        "  - tool: flow-execute",
        `    args: { name: inner, project_root: ${JSON.stringify(projectRoot)} }`
      )
    );
    const registry = {
      invokeTool: vi.fn(async (id: string, args: Record<string, unknown>, options?: unknown) =>
        id === "flow-execute" || id === "e2e-execute"
          ? runFlow.execute({}, args as never, options as never)
          : { ok: true }
      ),
      getTool: vi.fn(() => ({ inputSchema: { properties: { name: {}, device: {} } } })),
    } as unknown as Registry;
    const runFlow = createRunFlowTool(registry);

    const result = (await runFlow.execute(
      {},
      { name: "outer", project_root: projectRoot, device: "DEVICE" }
    )) as FlowRunResult;

    // The run's own flow is the file the caller named, so its steps name none.
    expect(where(result)).toEqual([
      { kind: "echo", status: "pass", line: 2, file: undefined },
      { kind: "tool", status: "fail", line: 3, file: undefined },
    ]);
    const innerRun = result.steps[1].result as FlowRunResult;
    expect(where(innerRun)).toEqual([{ kind: "tool", status: "fail", line: 3, file: inner }]);
    expect(where(innerRun.steps[0].result as FlowRunResult)).toEqual([
      { kind: "echo", status: "pass", line: 2, file: inner2 },
      { kind: "assert", status: "fail", line: 3, file: inner2 },
      { kind: "echo", status: "skip", line: 4, file: inner2 },
    ]);
  });

  it("reports the steps skipped after a hard stop at their lines", async () => {
    // The fragment is never loaded, so it need not exist.
    await writeFlowYaml(
      "stopped.yaml",
      yaml(
        "steps:",
        "  - assert: { visible: Welcome }",
        "  - echo: skipped",
        "  - when: { platform: ios }",
        "    steps:",
        "      - tap: Skip",
        "  - run: shared/login.yaml"
      )
    );

    const result = await run("stopped");

    expect(where(result)).toEqual([
      { kind: "assert", status: "fail", line: 2, file: undefined },
      { kind: "echo", status: "skip", line: 3, file: undefined },
      { kind: "when", status: "skip", line: 4, file: undefined },
      { kind: "tap", status: "skip", line: 6, file: undefined },
      { kind: "run", status: "skip", line: 7, file: undefined },
    ]);
  });

  it("reports a when: guard that cannot be evaluated at its line", async () => {
    // The guard is the run's first failing step, so its line is the one the
    // CLI recap shows.
    currentTree = () => {
      throw new Error("native devtools disconnected");
    };
    await writeFlowYaml(
      "blind.yaml",
      yaml(
        "steps:",
        "  - echo: start",
        "  - when: { visible: Dialog }",
        "    steps:",
        "      - tap: Close",
        "  - echo: never"
      )
    );

    const result = await run("blind");

    expect(where(result)).toEqual([
      { kind: "echo", status: "pass", line: 2, file: undefined },
      { kind: "when", status: "error", line: 3, file: undefined },
      { kind: "tap", status: "skip", line: 5, file: undefined },
      { kind: "echo", status: "skip", line: 6, file: undefined },
    ]);
  });

  it("reports a when: guard in a fragment that cannot be evaluated in the fragment's file", async () => {
    currentTree = () => {
      throw new Error("native devtools disconnected");
    };
    await writeFlowYaml(
      "main.yaml",
      yaml("steps:", "  - run: shared/dismiss.yaml", "  - echo: never")
    );
    const dismiss = await writeFlowYaml(
      "shared/dismiss.yaml",
      yaml(
        "# Closes the dialog when it shows.",
        "steps:",
        "  - echo: dismissing",
        "  - when: { visible: Dialog }",
        "    steps:",
        "      - tap: Close",
        "  - echo: dismissed"
      )
    );

    const result = await run("main");

    expect(where(result)).toEqual([
      { kind: "run", status: "pass", line: 2, file: undefined },
      { kind: "echo", status: "pass", line: 3, file: dismiss },
      { kind: "when", status: "error", line: 4, file: dismiss },
      { kind: "tap", status: "skip", line: 6, file: dismiss },
      { kind: "echo", status: "skip", line: 7, file: dismiss },
      { kind: "echo", status: "skip", line: 3, file: undefined },
    ]);
  });

  it("reports each step of a skipped when: block in a fragment in the fragment's file", async () => {
    await writeFlowYaml("main.yaml", yaml("steps:", "  - run: shared/back.yaml"));
    const back = await writeFlowYaml(
      "shared/back.yaml",
      yaml(
        "steps:",
        "  - when: { platform: android }",
        "    steps:",
        "      - tap: Back",
        "      - when: { visible: Dialog }",
        "        steps:",
        "          - tap: Close",
        "  - echo: after"
      )
    );

    const result = await run("main");

    expect(where(result)).toEqual([
      { kind: "run", status: "pass", line: 2, file: undefined },
      { kind: "when", status: "skip", line: 2, file: back },
      { kind: "tap", status: "skip", line: 4, file: back },
      { kind: "when", status: "skip", line: 5, file: back },
      { kind: "tap", status: "skip", line: 7, file: back },
      { kind: "echo", status: "pass", line: 8, file: back },
    ]);
  });

  it("reports the steps a cancelled run skips in a fragment in the fragment's file", async () => {
    // The run is cancelled during the guard's first tree read. The guard and
    // its steps skip as cancelled, the next block skips before it starts, and
    // the steps after it skip on the hard stop that follows.
    const controller = new AbortController();
    currentTree = () => {
      controller.abort();
      return screen([label("Sign in")]);
    };
    await writeFlowYaml("main.yaml", yaml("steps:", "  - run: shared/dismiss.yaml"));
    const dismiss = await writeFlowYaml(
      "shared/dismiss.yaml",
      yaml(
        "steps:",
        "  - when: { visible: Dialog }",
        "    steps:",
        "      - tap: Close",
        "  - when: { platform: ios }",
        "    steps:",
        "      - echo: inside",
        "  - echo: never"
      )
    );

    const result = await runWith("main", { device: IOS_DEVICE, signal: controller.signal });

    expect(result.aborted).toBe(true);
    expect(where(result)).toEqual([
      { kind: "run", status: "pass", line: 2, file: undefined },
      { kind: "when", status: "skip", line: 2, file: dismiss },
      { kind: "tap", status: "skip", line: 4, file: dismiss },
      { kind: "when", status: "skip", line: 5, file: dismiss },
      { kind: "echo", status: "skip", line: 7, file: dismiss },
      { kind: "echo", status: "skip", line: 8, file: dismiss },
    ]);
  });

  it("reports a step that needs a device in a device-free run in the fragment's file", async () => {
    deviceKinds = ["when", "tap"];
    await writeFlowYaml("main.yaml", yaml("steps:", "  - run: shared/dismiss.yaml"));
    const dismiss = await writeFlowYaml(
      "shared/dismiss.yaml",
      yaml(
        "steps:",
        "  - echo: dismissing",
        "  - when: { visible: Dialog }",
        "    steps:",
        "      - tap: Close",
        "  - echo: never"
      )
    );

    const result = await runWith("main", {});

    expect(result.steps[2].reason).toMatch(/step needs a device/);
    expect(where(result)).toEqual([
      { kind: "run", status: "pass", line: 2, file: undefined },
      { kind: "echo", status: "pass", line: 2, file: dismiss },
      { kind: "when", status: "error", line: 3, file: dismiss },
      { kind: "tap", status: "skip", line: 5, file: dismiss },
      { kind: "echo", status: "skip", line: 6, file: dismiss },
    ]);
  });
});
