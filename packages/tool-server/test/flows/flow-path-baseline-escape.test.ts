import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Registry, ToolContext } from "@argent/registry";
import { ArtifactStore } from "@argent/registry";

import { createRunFlowTool, type FlowRunResult } from "../../src/tools/flows/flow-run";

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

function asRun(result: FlowRunResult | { notice: string }): FlowRunResult {
  if (!("steps" in result)) throw new Error(`expected a run result, got notice: ${result.notice}`);
  return result;
}

/**
 * The happy-path complement: a valid stem has to ARRIVE, not just an invalid
 * one be refused. The derived name is threaded three separate ways —
 * state.baselineKey into runSnapshot's baseline directory (for a real file the
 * canonical stem it derives from IS this one), the step scope's
 * flow into every report, and runStack[0] into run: cycle detection — and only
 * a flow_path run can tell any of them apart from params.name (undefined
 * here), so each thread is pinned end-to-end through the same boundary the
 * escapes use.
 */
describe("the stem a valid flow_path derives", () => {
  it("keys the adopted baseline under __baselines__/<stem> and attributes the report to it", async () => {
    const flowPath = path.join(flowDir, "checkout.yaml");
    await fs.writeFile(
      flowPath,
      ["executionPrerequisite: ''", "steps:", "  - snapshot: shot", ""].join("\n"),
      "utf8"
    );

    const runFlow = createRunFlowTool(mockRegistry());
    const result = asRun(
      await runFlow.execute(
        {},
        {
          project_root: flowDir,
          flow_path: flowPath,
          device: IOS_DEVICE,
          updateBaselines: true,
        },
        boundaryCtx(flowPath)
      )
    );

    // The stem lands on both report levels: summarize's top `flow`, and —
    // seeded separately, through the step scope — each step's own.
    expect(result.ok).toBe(true);
    expect(result.flow).toBe("checkout");
    expect(result.steps).toEqual([
      expect.objectContaining({
        kind: "snapshot",
        status: "pass",
        flow: "checkout",
        reason: "baseline written (shot__ios-390x844.png)",
      }),
    ]);

    // The write landed at exactly <dirname(flow_path)>/__baselines__/<stem>/
    // <name>__<platform>-WxH.png, byte-for-byte the capture; the full listing
    // proves nothing landed anywhere else beside the flow.
    const baseline = path.join(flowDir, "__baselines__", "checkout", "shot__ios-390x844.png");
    expect(await fs.readFile(baseline)).toEqual(await fs.readFile(capture));
    expect((await fs.readdir(flowDir, { recursive: true })).sort()).toEqual([
      "__baselines__",
      path.join("__baselines__", "checkout"),
      path.join("__baselines__", "checkout", "shot__ios-390x844.png"),
      "checkout.yaml",
    ]);
  });

  it("seeds run: cycle detection, so a sibling cycling back to the top flow is caught", async () => {
    const flowPath = path.join(flowDir, "checkout.yaml");
    await fs.writeFile(
      flowPath,
      ["executionPrerequisite: ''", "steps:", "  - run: helper.yaml", ""].join("\n"),
      "utf8"
    );
    await fs.writeFile(
      path.join(flowDir, "helper.yaml"),
      ["executionPrerequisite: ''", "steps:", "  - run: checkout.yaml", ""].join("\n"),
      "utf8"
    );

    const runFlow = createRunFlowTool(mockRegistry());
    const result = asRun(
      await runFlow.execute(
        {},
        { project_root: flowDir, flow_path: flowPath, device: IOS_DEVICE },
        boundaryCtx(flowPath)
      )
    );

    // Exactly one hop: helper's reference back to "checkout" is already on the
    // seeded stack. A stack seeded with anything but the stem would instead
    // re-enter checkout.yaml as a fragment and only trip a hop later, on
    // "helper" — so the step sequence and the cycle spelling are both
    // load-bearing here. The offending target shares the root's stem, so it
    // renders as "./checkout" (runDisplayName's same-stem disambiguation).
    expect(result.ok).toBe(false);
    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["run:pass", "run:error"]);
    expect(result.steps[1].reason).toBe("cyclic flow reference: checkout → helper → ./checkout");
  });
});

/**
 * The baseline key follows the CANONICAL root flow (`baselineKeyFor`), because
 * the directory it joins onto — flowsDir — is canonical: two projects
 * symlinking their own `smoke.yaml` into one shared vault would otherwise both
 * key `vault/__baselines__/smoke/` and overwrite each other's committed PNGs.
 * That canonical basename is the symlink TARGET's, and it is validated by
 * nothing: assertSafeFlowName and classifyOnDiskSpelling above only ever saw
 * the as-written spelling, so a link to a file named "...yaml" re-opens exactly
 * the collapse this file exists for — `path.join(flowsDir, "__baselines__",
 * "..")` IS flowsDir — with no upstream arm left to refuse it. Like the tests
 * above, these run end-to-end with updateBaselines and assert the file the
 * adoption copy actually left on disk, not a message.
 */
describe("the baseline key a symlinked flow_path derives from its target", () => {
  /**
   * Run `flowDir/safe.yaml` — a symlink to `flowDir/vault/<targetBase>`, the
   * one-project spelling of the vault layout. The as-written name is always
   * "safe" and always valid, so the target's name is the only variable.
   */
  async function runVaultedFlow(targetBase: string): Promise<FlowRunResult> {
    const vault = path.join(flowDir, "vault");
    await fs.mkdir(vault);
    await fs.writeFile(
      path.join(vault, targetBase),
      ["executionPrerequisite: ''", "steps:", "  - snapshot: shot", ""].join("\n"),
      "utf8"
    );
    const flowPath = path.join(flowDir, "safe.yaml");
    await fs.symlink(path.join(vault, targetBase), flowPath);

    const runFlow = createRunFlowTool(mockRegistry());
    return asRun(
      await runFlow.execute(
        {},
        {
          project_root: flowDir,
          flow_path: flowPath,
          device: IOS_DEVICE,
          updateBaselines: true,
        },
        boundaryCtx(flowPath)
      )
    );
  }

  /** Every file the run left anywhere under the flow directory. */
  async function tree(): Promise<string[]> {
    return (await fs.readdir(flowDir, { recursive: true })).sort();
  }

  it("keys the store by the target's stem, so vault-sharing links can't share one", async () => {
    // The fix itself, on the write path: the adopted PNG lands under the REAL
    // file's name. A second project whose own smoke.yaml points at a different
    // vault file therefore writes a different directory, instead of replacing
    // this baseline in place.
    const result = await runVaultedFlow("real-name.yaml");

    expect(result.ok).toBe(true);
    expect(result.steps[0]).toMatchObject({
      status: "pass",
      reason: "baseline written (shot__ios-390x844.png)",
    });
    // The report keeps the as-written identity; only the store moved.
    expect(result.flow).toBe("safe");
    expect(await tree()).toEqual(
      [
        "safe.yaml",
        "vault",
        path.join("vault", "__baselines__"),
        path.join("vault", "__baselines__", "real-name"),
        path.join("vault", "__baselines__", "real-name", "shot__ios-390x844.png"),
        path.join("vault", "real-name.yaml"),
      ].sort()
    );
  });

  it.each([
    // The escape: stem "..", which path.join collapses back out — every
    // baseline would land in the vault itself, beside the flow files.
    ["...yaml", ".."],
    // Not an escape, but not a flow name either: a dotted vault filename is
    // perfectly legal on disk and must not become a path segment unchecked.
    ["my.smoke.yaml", "my.smoke"],
  ])('falls back to the as-written key when the target "%s" stems to "%s"', async (targetBase) => {
    const result = await runVaultedFlow(targetBase);

    // A run must not FAIL over an unusually named vault file — the fallback
    // key is the as-written one, which every source validated.
    expect(result.ok).toBe(true);
    expect(result.steps[0]).toMatchObject({
      status: "pass",
      reason: "baseline written (shot__ios-390x844.png)",
    });
    // The whole tree, so the assertion catches a write anywhere: under
    // __baselines__/safe/ and nowhere else — in particular nothing beside the
    // real file in vault/, which is where the collapsed ".." key would land it.
    expect(await tree()).toEqual(
      [
        "safe.yaml",
        "vault",
        path.join("vault", "__baselines__"),
        path.join("vault", "__baselines__", "safe"),
        path.join("vault", "__baselines__", "safe", "shot__ios-390x844.png"),
        path.join("vault", targetBase),
      ].sort()
    );
  });
});
