import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Registry } from "@argent/registry";
import { createRunFlowTool, type FlowRunResult } from "../../src/tools/flows/flow-run";
import { ArtifactStore } from "../../src/artifacts";

// The baseline key has no app component, so one run capturing the same
// snapshot name from two different apps must fail the colliding step instead
// of silently sharing a baseline file. These tests drive the real runSnapshot
// through flow-execute: the identity (owned instance's app path) comes from
// the chromium launch plumbing, so only the boot + capture edges are mocked.

let bootCount = 0;
const defaultBoot = async (opts: { appPath: string; extraArgs?: string[] }) => {
  const n = bootCount++;
  return {
    platform: "chromium" as const,
    id: `chromium-cdp-${12345 + n}`,
    port: 12345 + n,
    pid: 4242 + n,
    appPath: opts.appPath,
    booted: true as const,
  };
};
const bootElectronApp = vi.fn(defaultBoot);
vi.mock("../../src/tools/devices/boot-electron", () => ({
  bootElectronApp: (...args: unknown[]) =>
    (bootElectronApp as (...a: unknown[]) => unknown)(...args),
  killChromiumByPort: vi.fn(),
  killChromiumByPortAndWait: vi.fn(async () => {}),
}));
vi.mock("../../src/utils/chromium-discovery", () => ({ untrackChromiumPort: vi.fn() }));

// Stub the tree settle and the capture (like the flow-visual suite): every
// screenshot is a fresh fake 600x372 PNG whose trailing byte numbers the
// capture, so a baseline clobber is visible in the file's content.
const h = vi.hoisted(() => ({ shotDir: "", shotCount: 0 }));
vi.mock("../../src/tools/flows/flow-actions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/tools/flows/flow-actions")>()),
  settleTree: vi.fn(async () => ({})),
  invokeOnDevice: vi.fn(async (_env: unknown, tool: string) => {
    if (tool !== "screenshot") return {};
    const { writeFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const buf = Buffer.alloc(25);
    buf.writeUInt32BE(600, 16);
    buf.writeUInt32BE(372, 20);
    buf[24] = ++h.shotCount;
    const file = join(h.shotDir, `shot-${h.shotCount}.png`);
    await writeFile(file, buf);
    return { image: { hostPath: file } };
  }),
}));

const PROJECT_ROOT = "/proj";

// Mock registry: the CDP resolveService throws — page-fronting swallows that,
// and nothing else in these flows needs a live session.
function makeRegistry() {
  return {
    invokeTool: vi.fn(async () => ({})),
    getTool: vi.fn(() => undefined),
    resolveService: vi.fn(async () => {
      throw new Error("no cdp session in test");
    }),
    getSnapshot: vi.fn(() => ({ services: new Map() })),
    disposeService: vi.fn(async () => {}),
  } as unknown as Registry;
}

const writtenDirs: string[] = [];
// Named after the flow (the file stem IS the run's name and its baseline key)
// and realpath'd, so the canonical app paths the collision message names match
// what a test builds from the returned file — macOS's tmpdir lives behind the
// /var → /private/var symlink.
async function writeFlow(name: string, yaml: string): Promise<string> {
  const dir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "flow-snapshot-collision-"))
  );
  writtenDirs.push(dir);
  const file = path.join(dir, `${name}.yaml`);
  await fs.writeFile(file, yaml, "utf8");
  return file;
}

function asRun(r: FlowRunResult | { notice: string }): FlowRunResult {
  if (!("steps" in r)) throw new Error(`expected a FlowRunResult, got a notice: ${r.notice}`);
  return r;
}

async function runFlow(
  registry: Registry,
  params: Record<string, unknown>
): Promise<FlowRunResult> {
  // A co-located explicit flow_path (the flow file lives outside project_root),
  // plus the artifact store runSnapshot requires from ctx. Not the upload
  // route: assertUploadSelfContained refuses a snapshot step there, since an
  // uploaded flow's baselines land in a temp dir no later run can read.
  const flowPath = String(params.flow_file);
  const { name: _name, flow_file: _flowFile, ...rest } = params;
  const ctx = {
    fileInputs: {
      flow_path: {
        clientPath: flowPath,
        presentOnHost: true,
        viaUpload: false,
        statVerified: true,
      },
    },
    artifacts: new ArtifactStore(),
  };
  return asRun(
    await createRunFlowTool(registry).execute(
      {},
      { ...rest, flow_path: flowPath } as never,
      ctx as never
    )
  );
}

const baselineDir = (flowFile: string, flowName: string) =>
  path.join(path.dirname(flowFile), "__baselines__", flowName);

/** The capture-numbering byte of a stored baseline (see the screenshot stub). */
async function baselineMarker(file: string): Promise<number> {
  const buf = await fs.readFile(file);
  return buf[24]!;
}

beforeEach(async () => {
  bootCount = 0;
  h.shotCount = 0;
  h.shotDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-snapshot-collision-shots-"));
  writtenDirs.push(h.shotDir);
  bootElectronApp.mockReset().mockImplementation(defaultBoot);
});

afterEach(async () => {
  await Promise.all(writtenDirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

describe("flow-execute cross-app snapshot collision", () => {
  it("fails the second app's capture of a shared key and keeps the first app's baseline", async () => {
    const flowFile = await writeFlow(
      "cross-app",
      "steps:\n" +
        "  - launch: { chromium: ./app-a }\n" +
        "  - snapshot: shot\n" +
        "  - launch: { chromium: ./app-b }\n" +
        "  - snapshot: shot\n"
    );

    const result = await runFlow(makeRegistry(), {
      name: "cross-app",
      project_root: PROJECT_ROOT,
      flow_file: flowFile,
      updateBaselines: true,
    });

    expect(result.ok).toBe(false);
    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual([
      "launch:pass",
      "snapshot:pass",
      "launch:pass",
      "snapshot:fail",
    ]);
    const collided = result.steps[3]!;
    expect(collided.reason).toContain(
      'snapshot "shot" was already captured in this run from a different app'
    );
    // Names the app the key was first captured from, and the shared file.
    expect(collided.reason).toContain(path.join(path.dirname(flowFile), "app-a"));
    expect(collided.reason).toContain("shot__chromium-600x372.png");

    // App A's baseline survived — the second capture wrote nothing.
    const dir = baselineDir(flowFile, "cross-app");
    await expect(fs.readdir(dir)).resolves.toEqual(["shot__chromium-600x372.png"]);
    await expect(baselineMarker(path.join(dir, "shot__chromium-600x372.png"))).resolves.toBe(1);
  });

  it("does not fire for a relaunch of the same app, even on a new instance", async () => {
    const flowFile = await writeFlow(
      "same-app",
      "steps:\n" +
        "  - launch: { chromium: ./app }\n" +
        "  - snapshot: shot\n" +
        "  - launch: { chromium: ./app }\n" +
        "  - snapshot: shot\n"
    );

    const result = await runFlow(makeRegistry(), {
      name: "same-app",
      project_root: PROJECT_ROOT,
      flow_file: flowFile,
      updateBaselines: true,
    });

    // The relaunch moved the run onto a new device id, but the canonical app
    // path — the identity — is unchanged, so the refresh is a legal update.
    expect(result.ok).toBe(true);
    expect(bootElectronApp).toHaveBeenCalledTimes(2);
    expect(result.steps[3]).toMatchObject({ kind: "snapshot", status: "pass" });
    expect(result.steps[3]!.reason).toContain("baseline updated");
    const dir = baselineDir(flowFile, "same-app");
    await expect(baselineMarker(path.join(dir, "shot__chromium-600x372.png"))).resolves.toBe(2);
  });

  it("does not fire when a pinned-device attach precedes a boot of the same app", async () => {
    // The reviewer's repro: pinned to a hand-started instance, the first launch
    // ATTACHES (no boot); the relaunch boots. Both captures are the same app,
    // so the attach-declared path must equal the booted instance's identity.
    const flowFile = await writeFlow(
      "pinned-same-app",
      "steps:\n" +
        "  - launch: { chromium: ./app }\n" +
        "  - snapshot: shot\n" +
        "  - launch: { chromium: ./app }\n" +
        "  - snapshot: shot\n"
    );
    const registry = makeRegistry();
    (registry.resolveService as ReturnType<typeof vi.fn>).mockImplementation(async () => ({
      refreshViewport: vi.fn(async () => ({ width: 800, height: 600 })),
      cdp: { send: vi.fn(async () => ({})) },
    }));

    const result = await runFlow(registry, {
      name: "pinned-same-app",
      project_root: PROJECT_ROOT,
      flow_file: flowFile,
      device: "chromium-cdp-21456",
      updateBaselines: true,
    });

    expect(bootElectronApp).toHaveBeenCalledTimes(1);
    expect(result.steps[3]!.reason).toContain("baseline updated");
    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual([
      "launch:pass",
      "snapshot:pass",
      "launch:pass",
      "snapshot:pass",
    ]);
    expect(result.ok).toBe(true);
    const dir = baselineDir(flowFile, "pinned-same-app");
    await expect(baselineMarker(path.join(dir, "shot__chromium-600x372.png"))).resolves.toBe(2);
  });

  it("still fires when a pinned-device attach to one app precedes a boot of another", async () => {
    // The true-positive twin of the pinned repro above: the attach declares
    // app-a, so a later boot of app-b recapturing the key is a real collision
    // and must name the attach-declared app, not the anonymous device id.
    const flowFile = await writeFlow(
      "pinned-cross-app",
      "steps:\n" +
        "  - launch: { chromium: ./app-a }\n" +
        "  - snapshot: shot\n" +
        "  - launch: { chromium: ./app-b }\n" +
        "  - snapshot: shot\n"
    );
    const registry = makeRegistry();
    (registry.resolveService as ReturnType<typeof vi.fn>).mockImplementation(async () => ({
      refreshViewport: vi.fn(async () => ({ width: 800, height: 600 })),
      cdp: { send: vi.fn(async () => ({})) },
    }));

    const result = await runFlow(registry, {
      name: "pinned-cross-app",
      project_root: PROJECT_ROOT,
      flow_file: flowFile,
      device: "chromium-cdp-21456",
      updateBaselines: true,
    });

    expect(result.ok).toBe(false);
    expect(bootElectronApp).toHaveBeenCalledTimes(1);
    const collided = result.steps[3]!;
    expect(collided.status).toBe("fail");
    expect(collided.reason).toContain(
      'snapshot "shot" was already captured in this run from a different app'
    );
    expect(collided.reason).toContain(path.join(path.dirname(flowFile), "app-a"));
  });

  it("re-attributes a pre-launch capture on the attached instance to the declared app", async () => {
    // A snapshot BEFORE the first launch is recorded under the anonymous
    // attached identity; the attach then names the app. Attaching restarts
    // nothing — same process, same app — so the recapture must stay legal.
    const flowFile = await writeFlow(
      "pre-launch",
      "steps:\n" +
        "  - snapshot: shot\n" +
        "  - launch: { chromium: ./app }\n" +
        "  - snapshot: shot\n"
    );
    const registry = makeRegistry();
    (registry.resolveService as ReturnType<typeof vi.fn>).mockImplementation(async () => ({
      refreshViewport: vi.fn(async () => ({ width: 800, height: 600 })),
      cdp: { send: vi.fn(async () => ({})) },
    }));

    const result = await runFlow(registry, {
      name: "pre-launch",
      project_root: PROJECT_ROOT,
      flow_file: flowFile,
      device: "chromium-cdp-21456",
      updateBaselines: true,
    });

    expect(result.ok).toBe(true);
    expect(bootElectronApp).not.toHaveBeenCalled();
    expect(result.steps[2]!.reason).toContain("baseline updated");
  });

  it("does not fire for the same key captured twice without moving", async () => {
    const flowFile = await writeFlow(
      "repeat",
      "steps:\n" +
        "  - launch: { chromium: ./app }\n" +
        "  - snapshot: shot\n" +
        "  - snapshot: shot\n"
    );

    const result = await runFlow(makeRegistry(), {
      name: "repeat",
      project_root: PROJECT_ROOT,
      flow_file: flowFile,
      updateBaselines: true,
    });

    expect(result.ok).toBe(true);
    expect(result.steps[1]!.reason).toContain("baseline written");
    expect(result.steps[2]!.reason).toContain("baseline updated");
  });
});
