import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Registry } from "@argent/registry";
import { createRunFlowTool, type FlowRunResult } from "../../src/tools/flows/flow-run";

// The runner boots a Chromium e2e flow's app itself. Mock the Electron
// launcher so we can assert on how it's called + torn down without spawning a
// real process, and mock the port registry so teardown touches no on-disk state.
const bootElectronApp = vi.fn(async (opts: { appPath: string; extraArgs?: string[] }) => ({
  platform: "chromium" as const,
  id: "chromium-cdp-12345",
  port: 12345,
  pid: 4242,
  appPath: opts.appPath,
  booted: true as const,
}));
const killChromiumByPort = vi.fn();
vi.mock("../../src/tools/devices/boot-electron", () => ({
  bootElectronApp: (...args: unknown[]) =>
    (bootElectronApp as (...a: unknown[]) => unknown)(...args),
  killChromiumByPort: (...args: unknown[]) =>
    (killChromiumByPort as (...a: unknown[]) => unknown)(...args),
}));
vi.mock("../../src/utils/chromium-discovery", () => ({ untrackChromiumPort: vi.fn() }));

const PROJECT_ROOT = "/proj";

// Mock registry: invokeTool returns a canned result; the CDP resolveService
// throws by default — page-fronting swallows that, and a test that needs a
// reachable CDP api (the pinned-device attach) overrides it; getSnapshot is
// empty so teardown skips disposing a session; getTool is a stub.
function makeRegistry(invoke: (id: string, args: unknown) => Promise<unknown> = async () => ({})) {
  return {
    invokeTool: vi.fn(invoke),
    getTool: vi.fn(() => undefined),
    resolveService: vi.fn(async () => {
      throw new Error("no cdp session in test");
    }),
    getSnapshot: vi.fn(() => ({ services: new Map() })),
    disposeService: vi.fn(async () => {}),
  } as unknown as Registry;
}

const writtenFiles: string[] = [];
async function writeFlow(yaml: string): Promise<string> {
  const file = path.join(
    os.tmpdir(),
    `flow-chromium-boot-${writtenFiles.length}-${process.pid}.yaml`
  );
  await fs.writeFile(file, yaml, "utf8");
  writtenFiles.push(file);
  return file;
}

// A run: target must be a sibling named `<name>.yaml` (the runner resolves it
// against the parent flow's directory), so write it next to `parent` under a
// caller-chosen name.
async function writeSiblingFlow(parent: string, name: string, yaml: string): Promise<void> {
  const file = path.join(path.dirname(parent), `${name}.yaml`);
  await fs.writeFile(file, yaml, "utf8");
  writtenFiles.push(file);
}

function asRun(r: FlowRunResult | { notice: string }): FlowRunResult {
  if (!("steps" in r)) throw new Error(`expected a FlowRunResult, got a notice: ${r.notice}`);
  return r;
}

async function runFlow(
  registry: Registry,
  params: Record<string, unknown>
): Promise<FlowRunResult> {
  // The flow file deliberately lives outside project_root (it pins the
  // flow-relative app-path anchor), which the containment check only allows
  // for a boundary-materialized upload — mark it as one, like a remote
  // client's call would be.
  const ctx = {
    fileInputs: {
      flow_file: { clientPath: String(params.flow_file), presentOnHost: false, viaUpload: true },
    },
  };
  return asRun(await createRunFlowTool(registry).execute({}, params as never, ctx as never));
}

beforeEach(() => {
  bootElectronApp.mockClear();
  killChromiumByPort.mockClear();
});

afterEach(async () => {
  await Promise.all(writtenFiles.splice(0).map((f) => fs.rm(f, { force: true })));
});

describe("flow-execute chromium boot", () => {
  it("boots a fresh instance for a chromium-only e2e flow and tears it down", async () => {
    const flowFile = await writeFlow("steps:\n  - launch: { chromium: ./app }\n  - echo: done\n");
    const registry = makeRegistry();

    const result = await runFlow(registry, {
      name: "chromium-e2e",
      project_root: PROJECT_ROOT,
      flow_file: flowFile,
    });

    // Booted once, from the app path resolved against the flow file's directory —
    // NOT project_root (they differ here: project_root is "/proj", the flow lives
    // in os.tmpdir()), so this pins the flow-relative anchor.
    expect(bootElectronApp).toHaveBeenCalledTimes(1);
    expect(bootElectronApp.mock.calls[0][0]).toEqual({
      appPath: path.join(path.dirname(flowFile), "app"),
      extraArgs: undefined,
    });
    expect(bootElectronApp.mock.calls[0][0].appPath).not.toBe(path.join(PROJECT_ROOT, "app"));

    // The run targets the freshly-booted device; the launch step passes without
    // relaunching through a tool (it just settles the fresh window).
    expect(result.device).toBe("chromium-cdp-12345");
    expect(result.ok).toBe(true);
    expect(result.steps[0]).toMatchObject({ kind: "launch", status: "pass" });
    const invokedTools = (registry.invokeTool as any).mock.calls.map((c: unknown[]) => c[0]);
    expect(invokedTools).not.toContain("launch-app");
    expect(invokedTools).not.toContain("restart-app");

    // Teardown kills the instance the runner booted — port first (the handle
    // registry key), pid as the raw fallback.
    expect(killChromiumByPort).toHaveBeenCalledWith(12345, 4242);
  });

  it("forwards extra CLI args and boots when --platform chromium disambiguates a multi-platform launch", async () => {
    const flowFile = await writeFlow(
      "steps:\n  - launch: { ios: com.acme.app, chromium: { path: ./app, args: [--e2e] } }\n"
    );
    const registry = makeRegistry();

    const result = await runFlow(registry, {
      name: "multi",
      project_root: PROJECT_ROOT,
      flow_file: flowFile,
      platform: "chromium",
    });

    expect(bootElectronApp).toHaveBeenCalledTimes(1);
    expect(bootElectronApp.mock.calls[0][0]).toEqual({
      appPath: path.join(path.dirname(flowFile), "app"),
      extraArgs: ["--e2e"],
    });
    expect(result.ok).toBe(true);
    expect(killChromiumByPort).toHaveBeenCalledWith(12345, 4242);
  });

  it("takes an absolute launch path as-is", async () => {
    const flowFile = await writeFlow("steps:\n  - launch: { chromium: /abs/app }\n");
    const registry = makeRegistry();

    await runFlow(registry, { name: "abs", project_root: PROJECT_ROOT, flow_file: flowFile });

    expect(bootElectronApp.mock.calls[0][0]).toMatchObject({ appPath: "/abs/app" });
  });

  it("does not boot or tear down when an explicit --device pins an existing instance", async () => {
    const flowFile = await writeFlow("steps:\n  - launch: { chromium: ./app }\n");
    const registry = makeRegistry();
    const refreshViewport = vi.fn(async () => ({ width: 800, height: 600 }));
    (registry.resolveService as any).mockImplementation(async () => ({
      refreshViewport,
      cdp: { send: vi.fn(async () => ({})) },
    }));

    const result = await runFlow(registry, {
      name: "pinned",
      project_root: PROJECT_ROOT,
      flow_file: flowFile,
      device: "chromium-cdp-9999",
    });

    // Explicit device: attach, never boot/teardown.
    expect(bootElectronApp).not.toHaveBeenCalled();
    expect(killChromiumByPort).not.toHaveBeenCalled();
    expect(result.device).toBe("chromium-cdp-9999");

    // The launch step attaches in place over CDP (viewport refresh). It must
    // NOT route the launch value through launch-app: on chromium that value is
    // an app *path*, which launch-app's bundleId grammar rejects under the real
    // registry's input validation.
    const invokedTools = (registry.invokeTool as any).mock.calls.map((c: unknown[]) => c[0]);
    expect(invokedTools).not.toContain("launch-app");
    expect(refreshViewport).toHaveBeenCalled();
    expect(result.ok).toBe(true);
    expect(result.steps[0]).toMatchObject({ kind: "launch", status: "pass" });
  });

  it("errors a nested e2e flow's launch (chromium boots only the top-level app) and keeps the first working", async () => {
    // Parent chromium e2e flow that runs a nested chromium e2e flow. Chromium
    // boots exactly one app for the run (the parent's), so the nested launch
    // can't boot its own instance — it must fail loudly, not silently pass
    // against the already-launched app. The parent's own launch still works.
    const parent = await writeFlow(
      "steps:\n  - launch: { chromium: ./app-a }\n  - run: nested-chromium\n"
    );
    await writeSiblingFlow(
      parent,
      "nested-chromium",
      "steps:\n  - launch: { chromium: ./app-b }\n  - echo: should never run\n"
    );
    const registry = makeRegistry();

    const result = await runFlow(registry, {
      name: "parent-chromium",
      project_root: PROJECT_ROOT,
      flow_file: parent,
    });

    // Only the parent's app booted — the nested launch never spawned a second
    // instance.
    expect(bootElectronApp).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(false);
    // parent launch passes; run marker passes; nested launch errors; the rest skip.
    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual([
      "launch:pass",
      "run:pass",
      "launch:error",
      "echo:skip",
    ]);
    const nestedLaunch = result.steps[2];
    expect(nestedLaunch.flow).toBe("nested-chromium");
    expect(nestedLaunch.reason).toMatch(/chromium launches only the top-level flow's app/i);

    // The one booted instance is still torn down cleanly on the failing run.
    expect(killChromiumByPort).toHaveBeenCalledWith(12345, 4242);
  });

  it("still honors the first launch when a fragment run:s an e2e flow (the common composition)", async () => {
    // Fragment B (no leading launch) that run:s e2e flow A (launch + setup).
    // A's launch is the FIRST launch of the run, so the once-per-run guard does
    // not fire — it attaches to the pinned instance and passes. Only a *second*
    // launch is rejected. Uses a pinned device: a fragment top-level means the
    // runner boots nothing itself, so an already-running instance is required.
    const fragmentB = await writeFlow("steps:\n  - run: setup-a\n  - echo: B after A\n");
    await writeSiblingFlow(
      fragmentB,
      "setup-a",
      "steps:\n  - launch: { chromium: ./app }\n  - echo: A setup done\n"
    );
    const registry = makeRegistry();
    const refreshViewport = vi.fn(async () => ({ width: 800, height: 600 }));
    (registry.resolveService as any).mockImplementation(async () => ({
      refreshViewport,
      cdp: { send: vi.fn(async () => ({})) },
    }));

    const result = await runFlow(registry, {
      name: "fragment-b",
      project_root: PROJECT_ROOT,
      flow_file: fragmentB,
      device: "chromium-cdp-9999",
    });

    // Fragment top-level: the runner never boots (nor tears down) an instance;
    // A's launch attaches to the pinned one instead.
    expect(bootElectronApp).not.toHaveBeenCalled();
    expect(killChromiumByPort).not.toHaveBeenCalled();
    expect(refreshViewport).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
    // run marker, then A's launch (honored) + echo, then B's trailing echo.
    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual([
      "run:pass",
      "launch:pass",
      "echo:pass",
      "echo:pass",
    ]);
  });

  it("errors the launch step (and skips the rest) when the pinned instance is unreachable", async () => {
    const flowFile = await writeFlow("steps:\n  - launch: { chromium: ./app }\n  - echo: after\n");
    const registry = makeRegistry(); // resolveService throws: no CDP session behind the pinned id

    const result = await runFlow(registry, {
      name: "pinned-dead",
      project_root: PROJECT_ROOT,
      flow_file: flowFile,
      device: "chromium-cdp-9999",
    });

    expect(result.ok).toBe(false);
    expect(result.steps[0]).toMatchObject({ kind: "launch", status: "error" });
    expect(result.steps[0].reason).toContain(
      'could not attach to chromium instance "chromium-cdp-9999"'
    );
    expect(result.steps[1]).toMatchObject({ kind: "echo", status: "skip" });
  });
});
