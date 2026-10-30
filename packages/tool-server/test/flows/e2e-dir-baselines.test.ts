import { describe, it, expect, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createFlowTestHarness } from "./harness";
import { runSnapshot } from "../../src/tools/flows/flow-visual";

// Only the call into runSnapshot is observed: the directory a run keys its
// baselines under (`<flowsDir>/__baselines__/<flowName>/`) is the directory of
// its test, whichever of the two it is saved in.
vi.mock("../../src/tools/flows/flow-visual", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/tools/flows/flow-visual")>()),
  runSnapshot: vi.fn(),
}));

const reset = () => {
  vi.mocked(runSnapshot).mockReset();
  vi.mocked(runSnapshot).mockResolvedValue({ status: "pass", reason: "baseline matched" });
};
const legacy = createFlowTestHarness({ tempDirectoryPrefix: "e2e-baselines-flows-", reset });
const current = createFlowTestHarness({
  tempDirectoryPrefix: "e2e-baselines-e2e-",
  reset,
  dir: "e2e",
});

const snapshotFlow = {
  executionPrerequisite: "",
  steps: [{ kind: "snapshot" as const, name: "home" }],
};

describe("snapshot baselines", () => {
  it.each([
    ["flows", legacy],
    ["e2e", current],
  ] as const)("stay beside a test saved in .argent/%s", async (dir, harness) => {
    await harness.writeFlow("home", snapshotFlow);

    const result = await harness.run("home");

    expect(result.ok).toBe(true);
    expect(vi.mocked(runSnapshot)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        flowsDir: path.join(await fs.realpath(harness.root()), ".argent", dir),
        flowName: "home",
      })
    );
  });
});
