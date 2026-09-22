import { describe, it, expect, vi } from "vitest";
import { createFlowTestHarness } from "./harness";
import { runSnapshot } from "../../src/tools/flows/flow-visual";

// Mock ONLY runSnapshot: these tests pin the YAML-to-execution join in
// flow-run's snapshot arm (the single line threading the parsed step into
// runSnapshot's opts), which the flow-visual suite — calling runSnapshot
// directly with hand-built opts — cannot see. Dropping `cropOn: step.cropOn`
// there would keep every other test green while a declared crop silently ran
// as a full-screen snapshot.
vi.mock("../../src/tools/flows/flow-visual", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/tools/flows/flow-visual")>()),
  runSnapshot: vi.fn(),
}));

const { writeFlow, run } = createFlowTestHarness({
  tempDirectoryPrefix: "flow-snapshot-step-",
  reset: () => {
    vi.mocked(runSnapshot).mockReset();
    vi.mocked(runSnapshot).mockResolvedValue({
      status: "pass",
      reason: "diff 0.00% ≤ 0.5% (row__ios-390x844.png)",
    });
  },
});

describe("snapshot step wiring", () => {
  it("threads the parsed step — name, maxMismatch, cropOn — into runSnapshot", async () => {
    await writeFlow("crop", {
      executionPrerequisite: "",
      steps: [{ kind: "snapshot", name: "row", maxMismatch: 1.5, cropOn: { identifier: "hdr" } }],
    });

    const result = await run("crop");

    expect(result.steps).toEqual([expect.objectContaining({ status: "pass" })]);
    expect(vi.mocked(runSnapshot)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        name: "row",
        maxMismatch: 1.5,
        cropOn: expect.objectContaining({ identifier: "hdr" }),
      })
    );
  });

  it("passes no cropOn for a plain snapshot step", async () => {
    await writeFlow("plain", {
      executionPrerequisite: "",
      steps: [{ kind: "snapshot", name: "home" }],
    });

    await run("plain");

    expect(vi.mocked(runSnapshot)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ name: "home", cropOn: undefined })
    );
  });
});

// The other join: runSnapshot's hint, expected and actual must reach the step
// report. The flow-visual suite pins those values on runSnapshot's own return,
// which says nothing about what the run reports. Each mock below returns the
// shape runSnapshot builds for that failure.
describe("snapshot step report", () => {
  const ADOPT_HINT =
    "run with updateBaselines (--update-baselines) to adopt the current screen, then review and commit it";

  it("reports the adopt hint for a missing baseline, and no expected or actual", async () => {
    vi.mocked(runSnapshot).mockResolvedValue({
      status: "fail",
      reason: 'no baseline for "home" on this device class, nothing was compared',
      hint: ADOPT_HINT,
      snapshotKey: "home__ios-390x844",
    });
    await writeFlow("missing", {
      executionPrerequisite: "",
      steps: [{ kind: "snapshot", name: "home" }],
    });

    const result = await run("missing");

    expect(result.ok).toBe(false);
    expect(result.steps[0]).toMatchObject({ kind: "snapshot", status: "fail", hint: ADOPT_HINT });
    expect(result.steps[0].expected).toBeUndefined();
    expect(result.steps[0].actual).toBeUndefined();
    expect(result.steps[0].indeterminate).toBeUndefined();
  });

  it("reports the tolerance and the measured diff of a diff over maxMismatch", async () => {
    vi.mocked(runSnapshot).mockResolvedValue({
      status: "fail",
      reason: "diff 3.10% > 1.5% (home__ios-390x844.png)",
      expected: "≤ 1.5%",
      actual: "3.10%",
      snapshotKey: "home__ios-390x844",
    });
    await writeFlow("over", {
      executionPrerequisite: "",
      steps: [{ kind: "snapshot", name: "home", maxMismatch: 1.5 }],
    });

    const result = await run("over");

    expect(result.steps[0]).toMatchObject({
      kind: "snapshot",
      status: "fail",
      expected: "≤ 1.5%",
      actual: "3.10%",
    });
    expect(result.steps[0].hint).toBeUndefined();
  });

  it("reports both sizes and the drift hint of a cropOn size mismatch", async () => {
    const hint =
      "the element's size drifted; crop a fixed-size container, or re-adopt with updateBaselines";
    vi.mocked(runSnapshot).mockResolvedValue({
      status: "fail",
      reason:
        "baseline is 50x60 but the cropOn region is 50x50 (row__ios-390x844-crop-1a2b3c4d.png)",
      expected: "50x60",
      actual: "50x50",
      hint,
      snapshotKey: "row__ios-390x844-crop-1a2b3c4d",
    });
    await writeFlow("size", {
      executionPrerequisite: "",
      steps: [{ kind: "snapshot", name: "row", cropOn: { identifier: "hdr" } }],
    });

    const result = await run("size");

    expect(result.steps[0]).toMatchObject({
      kind: "snapshot",
      status: "fail",
      expected: "50x60",
      actual: "50x50",
      hint,
    });
  });
});
