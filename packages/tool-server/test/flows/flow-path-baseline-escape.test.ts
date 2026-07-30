import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Registry, ToolContext } from "@argent/registry";
import { ArtifactStore } from "@argent/registry";

import { createRunFlowTool } from "../../src/tools/flows/flow-run";

/**
 * The flow_path branch derives its logical flow name from the YAML basename,
 * and that name is the only thing keeping one flow's baselines out of another
 * directory: flow-visual joins it as `<flowsDir>/__baselines__/<flowName>`.
 * A dotted basename clears the extension arm — path.extname("...yaml") really
 * is ".yaml" — and then path.basename strips the extension down to a relative
 * segment (".." or "."), which path.join collapses back out of the joined
 * path. assertSafeFlowName is the whole of what stops that here: unlike the
 * `name` branch, where getFlowPath re-runs the same assert, nothing downstream
 * re-checks the derived name. So these run end-to-end with updateBaselines and
 * pin the write the assert prevents, not the message it prints.
 */

// Stub only the settle: the run has to reach the REAL runSnapshot and its REAL
// baseline copy — that copy is the consequence under test — but the mock
// registry below serves no describe tree, so an unstubbed settle would poll to
// its own deadline before the capture.
vi.mock("../../src/tools/flows/flow-actions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/tools/flows/flow-actions")>()),
  settleTree: vi.fn(async () => ({})),
}));

const IOS_DEVICE = "00000000-0000-0000-0000-0000000000ab";

let flowDir: string;
let captureDir: string;
let capture: string;

beforeEach(async () => {
  flowDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-path-baseline-"));
  // The capture lives outside flowDir so the directory assertion below sees
  // only what the run itself put next to the flow.
  captureDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-path-capture-"));
  capture = path.join(captureDir, "capture.png");
  // runSnapshot reads only the IHDR width/height bytes off the capture.
  const ihdr = Buffer.alloc(24);
  ihdr.writeUInt32BE(390, 16);
  ihdr.writeUInt32BE(844, 20);
  await fs.writeFile(capture, ihdr);
});

afterEach(async () => {
  await fs.rm(flowDir, { recursive: true, force: true });
  await fs.rm(captureDir, { recursive: true, force: true });
});

function mockRegistry(): Registry {
  return {
    invokeTool: vi.fn(async (id: string) => {
      if (id === "list-devices") return { devices: [] };
      if (id === "screenshot") return { image: { hostPath: capture } };
      return { ok: true };
    }),
    getTool: vi.fn(() => ({ inputSchema: { properties: { udid: {} } } })),
  } as unknown as Registry;
}

/** The ctx the flow_path boundary produces for a co-located, stat-matched path. */
function boundaryCtx(flowPath: string): ToolContext {
  return {
    artifacts: new ArtifactStore(),
    fileInputs: {
      flow_path: {
        clientPath: flowPath,
        presentOnHost: true,
        viaUpload: false,
        statVerified: true,
      },
    },
  };
}

describe("flow_path stems that would collapse the baseline directory", () => {
  it.each([
    // path.join(flowsDir, "__baselines__", "..") IS flowsDir, so an adopted
    // baseline lands beside the flow file itself rather than under a
    // per-flow subdirectory — the escape.
    ["..", "...yaml"],
    // One level less, but still not a directory of its own: every such flow's
    // baselines would pile into the shared __baselines__ root.
    [".", "..yaml"],
  ])('refuses the "%s" stem a "%s" flow_path derives', async (stem, basename) => {
    const flowPath = path.join(flowDir, basename);
    await fs.writeFile(
      flowPath,
      ["executionPrerequisite: ''", "steps:", "  - snapshot: shot", ""].join("\n"),
      "utf8"
    );

    const runFlow = createRunFlowTool(mockRegistry());
    const failure = await runFlow
      .execute(
        {},
        {
          project_root: flowDir,
          flow_path: flowPath,
          device: IOS_DEVICE,
          updateBaselines: true,
        },
        boundaryCtx(flowPath)
      )
      .then(
        () => null,
        (err: unknown) => err as Error
      );

    // Asserted before the message: updateBaselines adopts the capture by
    // copying it into the joined baseline dir, so a run that got this far
    // leaves the PNG in the collapsed location. Nothing may have been written.
    expect((await fs.readdir(flowDir, { recursive: true })).sort()).toEqual([basename]);
    expect(failure?.message).toContain(`Invalid flow name "${stem}"`);
  });
});
