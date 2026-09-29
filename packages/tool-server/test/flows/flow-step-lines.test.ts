import { describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { DescribeNode, DescribeTreeData } from "../../src/tools/describe/contract";

let currentTree: () => DescribeNode;
vi.mock("../../src/tools/flows/flow-tree", () => ({
  fetchFlowTree: vi.fn(
    async (): Promise<DescribeTreeData> => ({ tree: currentTree(), source: "native-devtools" })
  ),
}));

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

const { run, writeFlowYaml } = createFlowTestHarness({
  tempDirectoryPrefix: "flow-step-lines-",
  reset: () => {
    currentTree = () => screen([label("Sign in")]);
  },
});

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

  it("gives no line to the steps of a list written as an alias", () => {
    // The alias repeats a list written elsewhere; its steps have no entry of
    // their own to point at.
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

    expect(stepLines(flow.steps)).toEqual([2, 4, 5, undefined]);
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

  it("keeps the nested run's lines and fragment files in a tool: flow-execute step's result", async () => {
    // The step's result is the nested run's whole report, which MCP prints as
    // JSON, so the nested steps carry their lines there too.
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
      invokeTool: vi.fn(async (id: string, args: Record<string, unknown>) =>
        id === "flow-execute" ? runFlow.execute({}, args as never) : { ok: true }
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
      { kind: "echo", status: "pass", line: 2, file: undefined },
      { kind: "run", status: "pass", line: 3, file: undefined },
      { kind: "echo", status: "pass", line: 3, file: frag },
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
});
