import { describe, it, expect, vi } from "vitest";
import { createFlowTestHarness } from "./harness";
import { runSnapshot, warmSnapshotCapture } from "../../src/tools/flows/flow-visual";

// Mock ONLY runSnapshot: these tests pin the YAML-to-execution join in
// flow-run's snapshot arm (the single line threading the parsed step into
// runSnapshot's opts), which the flow-visual suite — calling runSnapshot
// directly with hand-built opts — cannot see. Dropping `cropOn: step.cropOn`
// there would keep every other test green while a declared crop silently ran
// as a full-screen snapshot.
vi.mock("../../src/tools/flows/flow-visual", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/tools/flows/flow-visual")>()),
  runSnapshot: vi.fn(),
  warmSnapshotCapture: vi.fn(async () => {}),
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

  it("hands the snapshot the end of the last step that can change the screen", async () => {
    await writeFlow("acted", {
      executionPrerequisite: "",
      steps: [
        { kind: "wait", ms: 200 },
        { kind: "tool", name: "gesture-tap", args: { x: 0.5, y: 0.5 } },
        { kind: "echo", message: "reading only" },
        { kind: "snapshot", name: "home" },
      ],
    });
    const startedAt = Date.now();

    await run("acted");

    const env = vi.mocked(runSnapshot).mock.calls[0]![0];
    expect(env.lastActionAt! - startedAt).toBeGreaterThanOrEqual(200);
  });

  it("starts the quiet window at the run's start, and reading steps do not move it", async () => {
    await writeFlow("read-only", {
      executionPrerequisite: "",
      steps: [
        { kind: "echo", message: "reading only" },
        { kind: "wait", ms: 50 },
        { kind: "snapshot", name: "home" },
      ],
    });
    const startedAt = Date.now();

    await run("read-only");

    const lastActionAt = vi.mocked(runSnapshot).mock.calls[0]![0].lastActionAt!;
    expect(lastActionAt).toBeGreaterThanOrEqual(startedAt);
    expect(Date.now() - lastActionAt).toBeGreaterThanOrEqual(50);
  });

  it("warms the capture backend only for a run with a snapshot or run: step", async () => {
    await writeFlow("with-snapshot", {
      executionPrerequisite: "",
      steps: [{ kind: "snapshot", name: "home" }],
    });
    await writeFlow("without-snapshot", {
      executionPrerequisite: "",
      steps: [{ kind: "echo", message: "no snapshot" }],
    });
    vi.mocked(warmSnapshotCapture).mockClear();

    await run("without-snapshot");
    expect(vi.mocked(warmSnapshotCapture)).not.toHaveBeenCalled();

    await run("with-snapshot");
    expect(vi.mocked(warmSnapshotCapture)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ platform: "ios" })
    );
  });

  it("warms the capture backend for a run whose snapshot steps live in a run: fragment", async () => {
    await writeFlow("fragment", {
      executionPrerequisite: "",
      steps: [{ kind: "snapshot", name: "home" }],
    });
    await writeFlow("includes-fragment", {
      executionPrerequisite: "",
      steps: [{ kind: "run", flow: "fragment.yaml" }],
    });
    vi.mocked(warmSnapshotCapture).mockClear();

    await run("includes-fragment");

    expect(vi.mocked(warmSnapshotCapture)).toHaveBeenCalledTimes(1);
  });
});
