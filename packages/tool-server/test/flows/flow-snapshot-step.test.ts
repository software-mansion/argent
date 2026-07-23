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
