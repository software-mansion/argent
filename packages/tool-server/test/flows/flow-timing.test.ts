import { afterEach, describe, expect, it, vi } from "vitest";
import type { DescribeNode, DescribeTreeData } from "../../src/tools/describe/contract";

// Only Date is faked, and it moves only when the runner does work: every tree
// read costs `readMs` and every flow file read `FILE_MS`. Timers stay real so
// the poll loops still sleep, but each reported duration is an exact sum of
// those costs.
const T0 = 1_700_000_000_000;
const READ_MS = 250;
const FILE_MS = 40;
const advance = (ms: number) => vi.setSystemTime(Date.now() + ms);

let currentTree: () => DescribeNode;
let readMs = READ_MS;
vi.mock("../../src/tools/flows/flow-tree", () => ({
  fetchFlowTree: vi.fn(async (): Promise<DescribeTreeData> => {
    advance(readMs);
    return { tree: currentTree(), source: "native-devtools" };
  }),
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const readFile = (file: unknown, ...rest: unknown[]) => {
    if (String(file).endsWith(".yaml")) advance(FILE_MS);
    return (actual.readFile as (...args: unknown[]) => Promise<unknown>)(file, ...rest);
  };
  return { ...actual, readFile };
});

import type { FlowRunResult } from "../../src/tools/flows/flow-run";
import type { FlowStep } from "../../src/tools/flows/flow-utils";
import { createFlowTestHarness, label, screen } from "./harness";

const { run, writeFlow } = createFlowTestHarness({
  tempDirectoryPrefix: "flow-timing-",
  reset: () => {
    vi.useFakeTimers({ toFake: ["Date"], now: T0 });
    currentTree = () => screen([label("Ready")]);
    readMs = READ_MS;
  },
});
afterEach(() => {
  vi.useRealTimers();
});

const selector = (text: string) => ({ text, loose: true });
const assertOn = (text: string): FlowStep => ({
  kind: "assert",
  condition: "visible",
  selector: selector(text),
});
const tapOn = (text: string): FlowStep => ({ kind: "tap", selector: selector(text) });
const echo = (message: string): FlowStep => ({ kind: "echo", message });
const whenOn = (text: string, steps: FlowStep[]): FlowStep => ({
  kind: "when",
  condition: { kind: "ui", condition: "visible", selector: selector(text) },
  steps,
});
const flow = (steps: FlowStep[]) => ({ executionPrerequisite: "", steps });
const failingTree = () => {
  throw new Error("tree source down");
};
const lines = (result: FlowRunResult) =>
  result.steps.map((s) => `${s.kind}:${s.status}:${s.durationMs ?? "-"}`);

describe("flow step timing", () => {
  it("times every step that ran and none of the steps skipped after a failure", async () => {
    // A found assert costs one read, a tap two (the settle), and an unmet
    // assert the whole 1000ms grace plus its final poll: five reads.
    const steps = [echo("start"), assertOn("Ready"), tapOn("Ready"), assertOn("Missing")];
    await writeFlow("main", flow([...steps, echo("after"), tapOn("Ready")]));
    expect(lines(await run("main"))).toEqual([
      "echo:pass:0",
      "assert:pass:250",
      "tap:pass:500",
      "assert:fail:1250",
      "echo:skip:-",
      "tap:skip:-",
    ]);
  });

  it("times a step that errors", async () => {
    // Every read throws, so the settle gives up once the 3000ms window has
    // closed after its two minimum reads.
    readMs = 1500;
    currentTree = failingTree;
    await writeFlow("broken", flow([tapOn("Ready"), assertOn("Ready")]));
    expect(lines(await run("broken"))).toEqual(["tap:error:3000", "assert:skip:-"]);
  });

  it("times a when: guard alone and lets the guarded steps time themselves", async () => {
    await writeFlow(
      "guards",
      flow([
        whenOn("Ready", [assertOn("Ready"), assertOn("Ready")]),
        whenOn("Missing", [tapOn("Ready")]),
        { kind: "when", condition: { kind: "platform", platform: "android" }, steps: [echo("a")] },
      ])
    );
    expect(lines(await run("guards"))).toEqual([
      "when:pass:250",
      "assert:pass:250",
      "assert:pass:250",
      "when:skip:1250",
      "tap:skip:-",
      "when:skip:0",
      "echo:skip:-",
    ]);
  });

  it("times a when: guard that cannot read the tree", async () => {
    currentTree = failingTree;
    await writeFlow("blind", flow([whenOn("Ready", [echo("inside")]), echo("after")]));
    expect(lines(await run("blind"))).toEqual(["when:error:1250", "echo:skip:-", "echo:skip:-"]);
  });

  it("times a run: marker as the fragment load only, on success and on a missing fragment", async () => {
    await writeFlow("frag", flow([assertOn("Ready")]));
    await writeFlow("composed", flow([{ kind: "run", flow: "frag.yaml" }, echo("done")]));
    await writeFlow("dangling", flow([{ kind: "run", flow: "gone.yaml" }, echo("done")]));

    expect(lines(await run("composed"))).toEqual(["run:pass:40", "assert:pass:250", "echo:pass:0"]);
    const dangling = await run("dangling");
    expect(lines(dangling)).toEqual(["run:error:40", "echo:skip:-"]);
    expect(dangling.steps[0]?.reason).toMatch(/could not load fragment "gone\.yaml"/);
  });

  it("reports when the run started and a total covering the flow file read and every step", async () => {
    await writeFlow("total", flow([assertOn("Ready"), tapOn("Ready")]));
    const result = await run("total");
    const durations = result.steps.map((s) => s.durationMs ?? 0);
    const sum = durations.reduce((a, b) => a + b, 0);

    expect(result.startedAt).toBe(T0);
    expect(durations).toEqual([250, 500]);
    expect(result.durationMs).toBe(FILE_MS + sum);
  });
});
