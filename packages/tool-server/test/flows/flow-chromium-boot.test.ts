import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { FAILURE_CODES, FailureError, getFailureSignal, type Registry } from "@argent/registry";
import { createRunFlowTool, type FlowRunResult } from "../../src/tools/flows/flow-run";

// The runner boots a Chromium e2e flow's app itself. Mock the Electron
// launcher so we can assert on how it's called + torn down without spawning a
// real process, and mock the port registry so teardown touches no on-disk state.
// Each boot lands on its own port, as the real launcher does — and the device
// id IS the port, so every boot is a new device id.
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
const killChromiumByPort = vi.fn();
const killChromiumByPortAndWait = vi.fn(async () => {});
vi.mock("../../src/tools/devices/boot-electron", () => ({
  bootElectronApp: (...args: unknown[]) =>
    (bootElectronApp as (...a: unknown[]) => unknown)(...args),
  killChromiumByPort: (...args: unknown[]) =>
    (killChromiumByPort as (...a: unknown[]) => unknown)(...args),
  killChromiumByPortAndWait: (...args: unknown[]) =>
    (killChromiumByPortAndWait as (...a: unknown[]) => unknown)(...args),
}));
vi.mock("../../src/utils/chromium-discovery", () => ({ untrackChromiumPort: vi.fn() }));

// The single-instance-lock hint re-probes every suspect instance's CDP endpoint
// before naming it. Mock only that probe (live by default) so no test does a
// real HTTP fetch; everything else in the blueprint stays real. Typed on the
// port so a test can decide liveness per instance — several suspects are probed
// in parallel, so call order is not a handle to grab any one of them by.
const ensureCdpReachable = vi.fn(async (_port: number, _signal?: AbortSignal) => ({
  Browser: "TestApp/1.0",
}));
vi.mock("../../src/blueprints/chromium-cdp", async () => {
  const actual = await vi.importActual<typeof import("../../src/blueprints/chromium-cdp")>(
    "../../src/blueprints/chromium-cdp"
  );
  return {
    ...actual,
    ensureCdpReachable: (...args: unknown[]) =>
      (ensureCdpReachable as (...a: unknown[]) => unknown)(...args),
  };
});

// The exact failure shape a second copy losing to a single-instance lock
// produces: early exit, clean code 0 (see bootElectronApp's onExit).
function lockShapedBootError(port: number): FailureError {
  return new FailureError(
    `Electron boot: child process exited with code 0 before CDP was ready. Inspect [chromium-cdp-${port}] stderr above for the cause.`,
    {
      error_code: FAILURE_CODES.CHROMIUM_ELECTRON_EXITED_BEFORE_READY,
      failure_stage: "electron_early_exit",
      failure_area: "tool_server",
      error_kind: "subprocess",
      failure_command: "electron",
      failure_exit_code: 0,
    }
  );
}

// Passthrough counter on fs.readFile: the cyclic-chain test asserts how many
// files the leading-run: walk read, which an ESM namespace spy can't observe.
const { readFileCalls } = vi.hoisted(() => ({ readFileCalls: vi.fn() }));
vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return {
    ...actual,
    readFile: (...args: Parameters<typeof actual.readFile>) => {
      readFileCalls(...args);
      return actual.readFile(...args);
    },
  };
});

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

// Each flow gets its own directory: `run:` targets are siblings named
// `<name>.yaml`, so two tests using the same fragment name would otherwise
// clobber each other's file in a shared tmpdir.
const writtenDirs: string[] = [];
async function writeFlow(yaml: string): Promise<string> {
  // realpath'd so path math on the returned file matches the runner's
  // canonical root anchor: macOS's tmpdir lives behind the /var → /private/var
  // symlink, which would otherwise skew the appPath equalities for reasons
  // unrelated to what a test pins.
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "flow-chromium-boot-")));
  writtenDirs.push(dir);
  const file = path.join(dir, "flow.yaml");
  await fs.writeFile(file, yaml, "utf8");
  return file;
}

// A run: target must be a sibling named `<name>.yaml` (the runner resolves it
// against the parent flow's directory), so write it next to `parent` under a
// caller-chosen name.
async function writeSiblingFlow(parent: string, name: string, yaml: string): Promise<void> {
  await fs.writeFile(path.join(path.dirname(parent), `${name}.yaml`), yaml, "utf8");
}

function asRun(r: FlowRunResult | { notice: string }): FlowRunResult {
  if (!("steps" in r)) throw new Error(`expected a FlowRunResult, got a notice: ${r.notice}`);
  return r;
}

async function runFlowRaw(
  registry: Registry,
  params: Record<string, unknown>,
  signal?: AbortSignal
): Promise<FlowRunResult | { notice: string }> {
  // The flow file deliberately lives outside project_root (it pins the
  // flow-relative app-path anchor). Run it as a co-located explicit flow_path
  // verified by the file-input boundary — an uploaded flow would reject the
  // run: composition some of these flows use.
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
    ...(signal ? { signal } : {}),
  };
  return (await createRunFlowTool(registry).execute(
    {},
    { ...rest, flow_path: flowPath } as never,
    ctx as never
  )) as FlowRunResult | { notice: string };
}

async function runFlow(
  registry: Registry,
  params: Record<string, unknown>,
  signal?: AbortSignal
): Promise<FlowRunResult> {
  return asRun(await runFlowRaw(registry, params, signal));
}

beforeEach(() => {
  bootCount = 0;
  // Reset, not clear: mockClear leaves queued mockImplementationOnce handlers
  // in place, so a test that failed early would leak one into the next.
  bootElectronApp.mockReset().mockImplementation(defaultBoot);
  killChromiumByPort.mockReset();
  killChromiumByPortAndWait.mockReset();
  ensureCdpReachable.mockReset().mockImplementation(async () => ({ Browser: "TestApp/1.0" }));
});

afterEach(async () => {
  await Promise.all(writtenDirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
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
    // relaunching through a tool (it just settles the fresh window), and names
    // the boot — reason presence is the owned-vs-attached signal.
    expect(result.device).toBe("chromium-cdp-12345");
    expect(result.ok).toBe(true);
    expect(result.steps[0]).toMatchObject({
      kind: "launch",
      status: "pass",
      reason: "booted chromium instance chromium-cdp-12345",
    });
    const invokedTools = (registry.invokeTool as any).mock.calls.map((c: unknown[]) => c[0]);
    expect(invokedTools).not.toContain("launch-app");
    expect(invokedTools).not.toContain("restart-app");

    // Teardown kills the instance the runner booted — port first (the handle
    // registry key), pid as the raw fallback — through the awaiting kill: a
    // back-to-back run of the same app must not race the dying instance's
    // single-instance lock.
    expect(killChromiumByPortAndWait).toHaveBeenCalledWith(12345, 4242);
    expect(killChromiumByPort).not.toHaveBeenCalled();
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
    expect(killChromiumByPortAndWait).toHaveBeenCalledWith(12345, 4242);
  });

  it("auto-detects instead of booting when that same launch has no chromium hint", async () => {
    // The negative twin: with neither --platform nor a lone chromium key, the
    // launch names a phone as readily as a desktop app, so the hoist must stand
    // down and let device detection pick — booting Electron here would run the
    // wrong platform's app against a booted simulator.
    const flowFile = await writeFlow(
      "steps:\n  - launch: { ios: com.acme.app, chromium: ./app }\n"
    );
    // A real UDID shape: the runner reads the platform off the id.
    const udid = "1A2B3C4D-5E6F-4A8B-9C0D-1E2F3A4B5C6D";
    const registry = makeRegistry(async (id: string) =>
      id === "list-devices" ? { devices: [{ platform: "ios", udid, state: "Booted" }] } : {}
    );
    // The ios launch waits on native devtools; hand it a connected one.
    (registry.resolveService as any).mockImplementation(async () => ({ isConnected: () => true }));

    const result = await runFlow(registry, {
      name: "ambiguous",
      project_root: PROJECT_ROOT,
      flow_file: flowFile,
    });

    expect(bootElectronApp).not.toHaveBeenCalled();
    expect(result.device).toBe(udid);
    expect(result.steps[0]).toMatchObject({ kind: "launch", status: "pass" });
    // The run went to the phone, not the desktop app: the launch restarted the
    // ios app id it declared.
    expect((registry.invokeTool as any).mock.calls).toContainEqual([
      "restart-app",
      { bundleId: "com.acme.app" },
    ]);
  });

  it("takes an absolute launch path as-is", async () => {
    const flowFile = await writeFlow("steps:\n  - launch: { chromium: /abs/app }\n");
    const registry = makeRegistry();

    await runFlow(registry, { name: "abs", project_root: PROJECT_ROOT, flow_file: flowFile });

    expect(bootElectronApp.mock.calls[0][0]).toMatchObject({ appPath: "/abs/app" });
  });

  it("resolves a symlinked root flow's relative app path beside the real file, not the symlink", async () => {
    // proj/.argent/flows/main.yaml is a symlink to shared/flows/main.yaml, and
    // the flow references ../app — the app lives beside the REAL file
    // (shared/app); nothing exists under proj/.argent/. Only the canonical
    // root anchor — the one `run:` targets already use — finds it; the
    // as-written dirname would boot a path in a tree the author never wrote.
    const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "flow-chromium-link-")));
    writtenDirs.push(base);
    const sharedFlows = path.join(base, "shared", "flows");
    const linkDir = path.join(base, "proj", ".argent", "flows");
    await fs.mkdir(sharedFlows, { recursive: true });
    await fs.mkdir(linkDir, { recursive: true });
    await fs.writeFile(
      path.join(sharedFlows, "main.yaml"),
      "steps:\n  - launch: { chromium: ../app }\n  - echo: done\n",
      "utf8"
    );
    const linkPath = path.join(linkDir, "main.yaml");
    await fs.symlink(path.join(sharedFlows, "main.yaml"), linkPath);
    const registry = makeRegistry();

    const result = await runFlow(registry, {
      name: "main",
      project_root: PROJECT_ROOT,
      flow_file: linkPath,
    });

    expect(result.ok).toBe(true);
    expect(bootElectronApp).toHaveBeenCalledTimes(1);
    expect(bootElectronApp.mock.calls[0][0]).toMatchObject({
      appPath: path.join(base, "shared", "app"),
    });
    expect(bootElectronApp.mock.calls[0][0].appPath).not.toBe(
      path.join(base, "proj", ".argent", "app")
    );
  });

  it("rejects a relative app path when the flow was uploaded (temp-dir anchor)", async () => {
    // An uploaded flow's materialized temp file is not the anchor its author
    // wrote the relative path against — booting from there would ENOENT or,
    // worse, launch a same-named host path.
    const flowFile = await writeFlow("steps:\n  - launch: { chromium: ./app }\n  - echo: done\n");
    const registry = makeRegistry();

    await expect(
      createRunFlowTool(registry).execute(
        {},
        { name: "uploaded", project_root: PROJECT_ROOT, flow_file: flowFile } as never,
        {
          fileInputs: {
            flow_file: {
              clientPath: "/client/.argent/flows/uploaded.yaml",
              presentOnHost: false,
              viaUpload: true,
            },
          },
        } as never
      )
    ).rejects.toThrow(/co-located/i);
    expect(bootElectronApp).not.toHaveBeenCalled();
  });

  it("boots an uploaded flow's absolute app path (valid on the tool-server host)", async () => {
    const flowFile = await writeFlow("steps:\n  - launch: { chromium: /abs/app }\n");
    const registry = makeRegistry();

    const result = asRun(
      await createRunFlowTool(registry).execute(
        {},
        { name: "uploaded-abs", project_root: PROJECT_ROOT, flow_file: flowFile } as never,
        {
          fileInputs: {
            flow_file: {
              clientPath: "/client/.argent/flows/uploaded-abs.yaml",
              presentOnHost: false,
              viaUpload: true,
            },
          },
        } as never
      )
    );

    expect(bootElectronApp.mock.calls[0][0]).toMatchObject({ appPath: "/abs/app" });
    expect(result.ok).toBe(true);
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
    expect(killChromiumByPortAndWait).not.toHaveBeenCalled();
    expect(result.device).toBe("chromium-cdp-9999");

    // The launch step attaches in place over CDP (viewport refresh). It must
    // NOT route the launch value through launch-app: on chromium that value is
    // an app *path*, which launch-app's bundleId grammar rejects under the real
    // registry's input validation.
    const invokedTools = (registry.invokeTool as any).mock.calls.map((c: unknown[]) => c[0]);
    expect(invokedTools).not.toContain("launch-app");
    expect(refreshViewport).toHaveBeenCalled();
    expect(result.ok).toBe(true);
    // No reason on an attach — its presence would misreport the instance as
    // runner-owned (and about to be killed at run end).
    expect(result.steps[0]!.reason).toBeUndefined();
    expect(result.steps[0]).toMatchObject({ kind: "launch", status: "pass" });
  });

  it("boots a second instance for a nested e2e flow's launch and tears both down in reverse", async () => {
    // The chromium analog of the in-place `restart-app` native nesting gets:
    // the process IS the device, so the nested launch boots its own.
    const parent = await writeFlow(
      "steps:\n  - launch: { chromium: ./app-a }\n  - run: nested-chromium.yaml\n"
    );
    await writeSiblingFlow(
      parent,
      "nested-chromium",
      "steps:\n  - launch: { chromium: ./app-b }\n  - echo: in nested\n"
    );
    const registry = makeRegistry();

    const result = await runFlow(registry, {
      name: "parent-chromium",
      project_root: PROJECT_ROOT,
      flow_file: parent,
    });

    // Both paths resolve against the same flow directory.
    expect(bootElectronApp).toHaveBeenCalledTimes(2);
    expect(bootElectronApp.mock.calls.map((c) => c[0].appPath)).toEqual([
      path.join(path.dirname(parent), "app-a"),
      path.join(path.dirname(parent), "app-b"),
    ]);
    expect(result.ok).toBe(true);
    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual([
      "launch:pass",
      "run:pass",
      "launch:pass",
      "echo:pass",
    ]);
    // The nested launch says it moved the run onto a new device — and marks the
    // move off the parent's instance, so a green report shows the switch.
    const nestedLaunch = result.steps[2];
    expect(nestedLaunch.flow).toBe("nested-chromium");
    expect(nestedLaunch.reason).toBe(
      "booted chromium instance chromium-cdp-12346 — run moved off chromium-cdp-12345"
    );
    // The report names the device the run STARTED on; the switch is on the step.
    expect(result.device).toBe("chromium-cdp-12345");

    // Both are torn down, nested first — a parent instance outlives its child —
    // each awaited to its exit.
    expect(killChromiumByPortAndWait.mock.calls).toEqual([
      [12346, 4243],
      [12345, 4242],
    ]);
    expect(killChromiumByPort).not.toHaveBeenCalled();
  });

  it("binds the newly booted device into the steps after a nested launch", async () => {
    // The point of booting: the run MOVES onto the new instance, so a step
    // after the nested launch dispatches against the new id.
    const parent = await writeFlow(
      "steps:\n" +
        "  - launch: { chromium: ./app-a }\n" +
        "  - tool: screenshot\n" +
        "  - run: nested-chromium\n" +
        "  - tool: screenshot\n"
    );
    await writeSiblingFlow(
      parent,
      "nested-chromium",
      "steps:\n  - launch: { chromium: ./app-b }\n"
    );
    const registry = makeRegistry();
    // The runner injects the device id only for the keys a tool's schema
    // declares, so give `screenshot` a udid.
    (registry.getTool as any).mockImplementation(() => ({
      inputSchema: { properties: { udid: {} } },
    }));

    const result = await runFlow(registry, {
      name: "rebind",
      project_root: PROJECT_ROOT,
      flow_file: parent,
    });

    expect(result.ok).toBe(true);
    const udids = (registry.invokeTool as any).mock.calls
      .filter((c: unknown[]) => c[0] === "screenshot")
      .map((c: any) => c[1].udid);
    expect(udids).toEqual(["chromium-cdp-12345", "chromium-cdp-12346"]);
  });

  it("retires the instance it owns for the same app before relaunching it", async () => {
    // Kill first, then boot: an Electron app holding a single-instance lock
    // would make the second process quit before its CDP endpoint came up.
    const flowFile = await writeFlow(
      "steps:\n  - launch: { chromium: ./app }\n  - echo: mid\n  - launch: { chromium: ./app }\n"
    );
    const registry = makeRegistry();

    const result = await runFlow(registry, {
      name: "relaunch",
      project_root: PROJECT_ROOT,
      flow_file: flowFile,
    });

    expect(result.ok).toBe(true);
    expect(bootElectronApp).toHaveBeenCalledTimes(2);
    // The relaunch step marks the retire: the run's own instance was killed.
    expect(result.steps[2]!.reason).toBe(
      "booted chromium instance chromium-cdp-12346 — retired chromium-cdp-12345 (same app relaunched)"
    );
    // The retire goes through the awaiting kill — the replacement must not race
    // the dying process's lock — and lands before the second boot; only the
    // replacement is left for run-end teardown (awaited too).
    expect(killChromiumByPortAndWait.mock.calls).toEqual([
      [12345, 4242],
      [12346, 4243],
    ]);
    expect(killChromiumByPortAndWait.mock.invocationCallOrder[0]).toBeLessThan(
      bootElectronApp.mock.invocationCallOrder[1]!
    );
    expect(killChromiumByPort).not.toHaveBeenCalled();
  });

  it("recognises a symlink alias of the app it owns and retires it before the relaunch", async () => {
    // A lexical path.resolve leaves two spellings of one app unequal — the
    // retire would be skipped and the replacement would trip the original's
    // single-instance lock.
    const flowFile = await writeFlow(
      "steps:\n  - launch: { chromium: ./real-app }\n  - launch: { chromium: ./alias }\n"
    );
    const dir = path.dirname(flowFile);
    await fs.mkdir(path.join(dir, "real-app"));
    await fs.symlink(path.join(dir, "real-app"), path.join(dir, "alias"));
    // os.tmpdir() sits behind a symlink on macOS, so derive the canonical
    // spelling instead of assuming the lexical join is it.
    const canonical = await fs.realpath(path.join(dir, "real-app"));
    const registry = makeRegistry();

    const result = await runFlow(registry, {
      name: "aliased-relaunch",
      project_root: PROJECT_ROOT,
      flow_file: flowFile,
    });

    expect(result.ok).toBe(true);
    // Both spellings boot from the one canonical path — the key the retire
    // compare (and the stored appPath) carries.
    expect(bootElectronApp.mock.calls.map((c) => c[0].appPath)).toEqual([canonical, canonical]);
    // The alias is the same app: its owned instance is retired (awaited)
    // before the replacement boots; only the replacement is left for run-end
    // teardown (awaited too).
    expect(killChromiumByPortAndWait.mock.calls).toEqual([
      [12345, 4242],
      [12346, 4243],
    ]);
    expect(killChromiumByPortAndWait.mock.invocationCallOrder[0]).toBeLessThan(
      bootElectronApp.mock.invocationCallOrder[1]!
    );
    expect(killChromiumByPort).not.toHaveBeenCalled();
  });

  it("does not kill the retired instance twice when the relaunch boot then fails", async () => {
    // The retire tears down the run's only instance of that app before the
    // replacement exists, so a failing boot leaves the run holding none of it —
    // and the run-end sweep must not reach the one already killed.
    const flowFile = await writeFlow(
      "steps:\n  - launch: { chromium: ./app }\n  - launch: { chromium: ./app }\n  - echo: after\n"
    );
    const registry = makeRegistry();
    bootElectronApp.mockImplementationOnce(defaultBoot).mockImplementationOnce(async () => {
      throw new Error("Electron boot: failed to spawn electron: EACCES");
    });

    const result = await runFlow(registry, {
      name: "retire-then-fail",
      project_root: PROJECT_ROOT,
      flow_file: flowFile,
    });

    expect(result.ok).toBe(false);
    // The failed launch hard-stops the run, so nothing runs on the dead instance.
    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual([
      "launch:pass",
      "launch:error",
      "echo:skip",
    ]);
    expect(result.steps[1]!.reason).toBe(
      "could not boot the chromium app: Electron boot: failed to spawn electron: EACCES"
    );
    // The retire is the only kill: the instance left state.owned when it was
    // retired, and the boot that would have replaced it never landed there.
    expect(killChromiumByPortAndWait.mock.calls).toEqual([[12345, 4242]]);
    expect(killChromiumByPort).not.toHaveBeenCalled();
  });

  it("marks the instance the run left and the older one it retired, on a cross-app relaunch", async () => {
    // Relaunching app-a while the run sits on app-b's instance retires app-a's
    // OLD instance but moves the run off app-b's — "retired" would be false for
    // the instance the run left (it stays alive until run end), and naming only
    // the move would leave the kill unreported.
    const flowFile = await writeFlow(
      "steps:\n  - launch: { chromium: ./app-a }\n  - launch: { chromium: ./app-b }\n  - launch: { chromium: ./app-a }\n"
    );
    const registry = makeRegistry();

    const result = await runFlow(registry, {
      name: "cross-app-relaunch",
      project_root: PROJECT_ROOT,
      flow_file: flowFile,
    });

    expect(result.ok).toBe(true);
    expect(bootElectronApp).toHaveBeenCalledTimes(3);
    expect(result.steps[2]!.reason).toBe(
      "booted chromium instance chromium-cdp-12347 — run moved off chromium-cdp-12346, " +
        "retired chromium-cdp-12345 (same app relaunched)"
    );
    // app-a's old instance was retired before the third boot; the two the run
    // still owns go down at run end, newest first.
    expect(killChromiumByPortAndWait.mock.calls).toEqual([
      [12345, 4242],
      [12347, 4244],
      [12346, 4243],
    ]);
  });

  it("boots an instance of its own for a second launch against a pinned device", async () => {
    // The runner never kills a process it didn't start, which is what makes the
    // first launch an attach; a later one still means "from scratch".
    const flowFile = await writeFlow(
      "steps:\n  - launch: { chromium: ./app-a }\n  - launch: { chromium: ./app-b }\n"
    );
    const registry = makeRegistry();
    const refreshViewport = vi.fn(async () => ({ width: 800, height: 600 }));
    (registry.resolveService as any).mockImplementation(async () => ({
      refreshViewport,
      cdp: { send: vi.fn(async () => ({})) },
    }));

    const result = await runFlow(registry, {
      name: "pinned-then-boot",
      project_root: PROJECT_ROOT,
      flow_file: flowFile,
      device: "chromium-cdp-9999",
    });

    expect(result.ok).toBe(true);
    expect(refreshViewport).toHaveBeenCalledTimes(1); // first launch attached
    expect(bootElectronApp).toHaveBeenCalledTimes(1); // second launch booted
    expect(bootElectronApp.mock.calls[0][0]).toMatchObject({
      appPath: path.join(path.dirname(flowFile), "app-b"),
    });
    // The boot marks the move off the attached instance — "moved off", never
    // "retired": the pinned instance stays alive.
    expect(result.steps[1]!.reason).toBe(
      "booted chromium instance chromium-cdp-12345 — run moved off chromium-cdp-9999"
    );
    // Only the instance the runner booted is torn down — never the pinned one.
    expect(killChromiumByPortAndWait.mock.calls).toEqual([[12345, 4242]]);
  });

  it("tears down an instance booted just as the run was cancelled", async () => {
    // The boot resolves after the cancel lands — the instance is real, so it is
    // recorded before the step can bail out.
    const controller = new AbortController();
    const parent = await writeFlow(
      "steps:\n  - launch: { chromium: ./app-a }\n  - run: nested-chromium\n"
    );
    await writeSiblingFlow(
      parent,
      "nested-chromium",
      "steps:\n  - launch: { chromium: ./app-b }\n"
    );
    const registry = makeRegistry();
    bootElectronApp.mockImplementationOnce(async (opts) => ({
      platform: "chromium" as const,
      id: "chromium-cdp-12345",
      port: 12345,
      pid: 4242,
      appPath: opts.appPath,
      booted: true as const,
    }));
    // The nested boot: cancel the run while it is in flight.
    bootElectronApp.mockImplementationOnce(async (opts) => {
      controller.abort();
      return {
        platform: "chromium" as const,
        id: "chromium-cdp-12346",
        port: 12346,
        pid: 4243,
        appPath: opts.appPath,
        booted: true as const,
      };
    });

    const result = await runFlow(
      registry,
      { name: "cancelled", project_root: PROJECT_ROOT, flow_file: parent },
      controller.signal
    );

    expect(result.aborted).toBe(true);
    expect(result.ok).toBe(false);
    // A cancelled launch is a skip, never a step failure — the app did nothing wrong.
    expect(result.steps[2]).toMatchObject({ kind: "launch", status: "skip" });
    // Both instances reclaimed, nested first.
    expect(killChromiumByPortAndWait.mock.calls).toEqual([
      [12346, 4243],
      [12345, 4242],
    ]);
  });

  it("boots for a fragment whose first step run:s a chromium e2e flow", async () => {
    // The run begins with a launch even though the TOP-LEVEL flow doesn't: the
    // runner needs a device before step 1, so the leading `run:` chain is
    // followed to find the launch it has to boot for.
    const fragment = await writeFlow("steps:\n  - run: setup\n  - tool: screenshot\n");
    await writeSiblingFlow(
      fragment,
      "setup",
      "steps:\n  - echo: launching\n  - launch: { native: com.acme.app, chromium: ./app }\n"
    );
    const registry = makeRegistry();
    (registry.getTool as any).mockImplementation(() => ({
      inputSchema: { properties: { udid: {} } },
    }));

    const result = await runFlow(registry, {
      name: "leads-with-run",
      project_root: PROJECT_ROOT,
      flow_file: fragment,
      platform: "chromium",
    });

    // --platform chromium disambiguates the multi-platform launch, and the app
    // path resolves against the flows directory the chain was read from.
    expect(bootElectronApp).toHaveBeenCalledTimes(1);
    expect(bootElectronApp.mock.calls[0][0]).toMatchObject({
      appPath: path.join(path.dirname(fragment), "app"),
    });
    expect(result.ok).toBe(true);
    expect(result.device).toBe("chromium-cdp-12345");
    // The nested launch settles the hoisted boot instead of booting again.
    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual([
      "run:pass",
      "echo:pass",
      "launch:pass",
      "tool:pass",
    ]);
    expect(killChromiumByPortAndWait).toHaveBeenCalledWith(12345, 4242);
  });

  it("boots past a leading run: hop that contributes nothing but echoes", async () => {
    // execRunStep inlines an echo-only fragment and carries straight on with
    // the parent's NEXT step, so the run's first executable step is still the
    // e2e flow's launch. A walk that stopped at the hop would leave the run to
    // attach to whatever chromium instance happens to be up — a green launch
    // step against someone else's browser.
    const fragment = await writeFlow("steps:\n  - run: narrate\n  - run: e2e-chromium\n");
    await writeSiblingFlow(fragment, "narrate", "steps:\n  - echo: about to launch\n");
    await writeSiblingFlow(fragment, "e2e-chromium", "steps:\n  - launch: { chromium: ./app }\n");
    const registry = makeRegistry();

    const result = await runFlow(registry, {
      name: "hop-then-e2e",
      project_root: PROJECT_ROOT,
      flow_file: fragment,
    });

    expect(bootElectronApp).toHaveBeenCalledTimes(1);
    expect(bootElectronApp.mock.calls[0][0]).toMatchObject({
      appPath: path.join(path.dirname(fragment), "app"),
    });
    expect(result.ok).toBe(true);
    expect(result.device).toBe("chromium-cdp-12345");
    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual([
      "run:pass",
      "echo:pass",
      "run:pass",
      "launch:pass",
    ]);
    // The e2e launch settled the hoisted instance instead of attaching: a
    // reason naming the instance is the owned-vs-attached signal.
    expect(result.steps[3].reason).toBe("booted chromium instance chromium-cdp-12345");
    expect(killChromiumByPortAndWait).toHaveBeenCalledWith(12345, 4242);
  });

  it("boots identically when that narration is inline rather than behind the hop", async () => {
    // The control the hop case must match: same run, one file fewer.
    const fragment = await writeFlow("steps:\n  - echo: about to launch\n  - run: e2e-chromium\n");
    await writeSiblingFlow(fragment, "e2e-chromium", "steps:\n  - launch: { chromium: ./app }\n");
    const registry = makeRegistry();

    const result = await runFlow(registry, {
      name: "inline-then-e2e",
      project_root: PROJECT_ROOT,
      flow_file: fragment,
    });

    expect(bootElectronApp).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
    expect(result.device).toBe("chromium-cdp-12345");
    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual([
      "echo:pass",
      "run:pass",
      "launch:pass",
    ]);
    expect(result.steps[2].reason).toBe("booted chromium instance chromium-cdp-12345");
  });

  it("boots past a leading run: hop into a fragment with no steps at all", async () => {
    // `steps: []` executes as nothing at all, which is the same "contributes
    // nothing" case as the echo-only fragment — not the end of the chain.
    const fragment = await writeFlow("steps:\n  - run: placeholder\n  - run: e2e-chromium\n");
    await writeSiblingFlow(fragment, "placeholder", "steps: []\n");
    await writeSiblingFlow(fragment, "e2e-chromium", "steps:\n  - launch: { chromium: ./app }\n");
    const registry = makeRegistry();

    const result = await runFlow(registry, {
      name: "empty-hop-then-e2e",
      project_root: PROJECT_ROOT,
      flow_file: fragment,
    });

    expect(bootElectronApp).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual([
      "run:pass",
      "run:pass",
      "launch:pass",
    ]);
  });

  it("boots when the same do-nothing fragment is hopped through twice in a row", async () => {
    // Siblings are not a cycle: execRunStep's runStack pops after each hop, so
    // it runs this happily — the walk must track the ancestor chain only, or it
    // would refuse a chain the executor accepts and skip the boot.
    const fragment = await writeFlow(
      "steps:\n  - run: narrate\n  - run: narrate\n  - run: e2e-chromium\n"
    );
    await writeSiblingFlow(fragment, "narrate", "steps:\n  - echo: about to launch\n");
    await writeSiblingFlow(fragment, "e2e-chromium", "steps:\n  - launch: { chromium: ./app }\n");
    const registry = makeRegistry();

    const result = await runFlow(registry, {
      name: "twice-hopped",
      project_root: PROJECT_ROOT,
      flow_file: fragment,
    });

    expect(bootElectronApp).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual([
      "run:pass",
      "echo:pass",
      "run:pass",
      "echo:pass",
      "run:pass",
      "launch:pass",
    ]);
  });

  it("does not boot past a leading run: hop whose fragment contributes a real step", async () => {
    // Only echoes are transparent. The tool step runs against the device
    // first, so the launch behind it is not the run's leading one — and a
    // non-leading chromium launch boots itself mid-run rather than being
    // hoisted (here the run never gets that far: there is no device to start on).
    const fragment = await writeFlow("steps:\n  - run: probe\n  - run: e2e-chromium\n");
    await writeSiblingFlow(fragment, "probe", "steps:\n  - tool: screenshot\n");
    await writeSiblingFlow(fragment, "e2e-chromium", "steps:\n  - launch: { chromium: ./app }\n");
    const registry = makeRegistry(async (id: string) =>
      id === "list-devices" ? { devices: [] } : {}
    );

    await expect(
      runFlow(registry, {
        name: "real-step-hop",
        project_root: PROJECT_ROOT,
        flow_file: fragment,
      })
    ).rejects.toThrow(/No booted device found/);
    expect(bootElectronApp).not.toHaveBeenCalled();
  });

  it("fails the settling launch when the hoisted instance is not the app the step names", async () => {
    // The hoist and the launch step read a leading run: chain's flow file
    // independently, so the instance the settle inherits can be another app's
    // (the file rewritten between the reads). Simulate that end state directly:
    // the boot reports a canonical appPath differing from what the step resolves.
    const fragment = await writeFlow("steps:\n  - run: setup\n");
    await writeSiblingFlow(
      fragment,
      "setup",
      "steps:\n  - launch: { chromium: ./app }\n  - echo: after\n"
    );
    bootElectronApp.mockImplementationOnce(async (opts) => ({
      ...(await defaultBoot(opts)),
      appPath: "/elsewhere/other-app",
    }));
    const registry = makeRegistry();

    const result = await runFlow(registry, {
      name: "hoist-mismatch",
      project_root: PROJECT_ROOT,
      flow_file: fragment,
    });

    // Fails loudly, naming both apps — never a green "boot" of the wrong app —
    // and no second boot papers over the mismatch.
    expect(result.ok).toBe(false);
    expect(bootElectronApp).toHaveBeenCalledTimes(1);
    const launch = result.steps.find((s) => s.kind === "launch")!;
    expect(launch.status).toBe("error");
    expect(launch.reason).toContain(path.join(path.dirname(fragment), "app"));
    expect(launch.reason).toContain("/elsewhere/other-app");
    expect(result.steps.at(-1)).toMatchObject({ kind: "echo", status: "skip" });
    // The wrong-app instance is still the run's to reclaim at teardown.
    expect(killChromiumByPortAndWait).toHaveBeenCalledWith(12345, 4242);
  });

  it("fails the settling launch when the flow was rewritten mid-run to declare no chromium app", async () => {
    // The real trigger, end to end: setup.yaml changes between the hoist's read
    // and execRunStep's re-read. The passthrough observer runs synchronously
    // before each read, so a rewrite on the second read hands the executor the
    // new file while the hoist booted from the old one.
    const fragment = await writeFlow("steps:\n  - run: setup\n");
    await writeSiblingFlow(fragment, "setup", "steps:\n  - launch: { chromium: ./app }\n");
    const setupPath = path.join(path.dirname(fragment), "setup.yaml");
    let setupReads = 0;
    readFileCalls.mockImplementation((p: unknown) => {
      if (String(p) === setupPath && ++setupReads === 2) {
        writeFileSync(setupPath, "steps:\n  - launch: { ios: com.acme.app }\n", "utf8");
      }
    });
    try {
      const registry = makeRegistry();

      const result = await runFlow(registry, {
        name: "rewritten-mid-run",
        project_root: PROJECT_ROOT,
        flow_file: fragment,
      });

      expect(result.ok).toBe(false);
      expect(bootElectronApp).toHaveBeenCalledTimes(1); // the hoisted boot only
      const launch = result.steps.find((s) => s.kind === "launch")!;
      expect(launch.status).toBe("error");
      expect(launch.reason).toContain("no chromium app declared");
    } finally {
      readFileCalls.mockReset();
    }
  });

  it("follows the leading run: chain through several fragments", async () => {
    const top = await writeFlow("steps:\n  - run: middle\n");
    await writeSiblingFlow(top, "middle", "steps:\n  - run: inner\n");
    await writeSiblingFlow(top, "inner", "steps:\n  - launch: { chromium: ./app }\n");
    const registry = makeRegistry();

    const result = await runFlow(registry, {
      name: "chained",
      project_root: PROJECT_ROOT,
      flow_file: top,
    });

    expect(bootElectronApp).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
  });

  it("does not boot when the leading run: chain is cyclic", async () => {
    // The chain walk gives up on a repeat rather than re-reading the loop up to
    // the depth bound; execRunStep reports the cycle when it executes.
    const top = await writeFlow("steps:\n  - run: loop-a\n");
    await writeSiblingFlow(top, "loop-a", "steps:\n  - run: loop-b\n");
    await writeSiblingFlow(top, "loop-b", "steps:\n  - run: loop-a\n");
    const registry = makeRegistry(async (id: string) =>
      id === "list-devices" ? { devices: [] } : {}
    );
    readFileCalls.mockClear();

    await expect(
      runFlow(registry, { name: "cyclic", project_root: PROJECT_ROOT, flow_file: top })
    ).rejects.toThrow(/No booted device found/);
    expect(bootElectronApp).not.toHaveBeenCalled();
    // One read each for the top flow and the two loop files — a walk that only
    // the depth bound stops would re-read the loop many times over.
    expect(readFileCalls).toHaveBeenCalledTimes(3);
  });

  it("does not boot when a cyclic leading run: precedes a launch-bearing one", async () => {
    // The shape that tells the walk's two stop conditions apart. A hop that
    // merely contributes nothing is transparent — the scan resumes at the
    // parent's next step, as execRunStep does. A hop the executor REFUSES is a
    // dead end: it errors that step and hard-stops, so the launch behind the
    // cycle never runs and must not be booted for. With `run: loop-a` alone
    // (the test above) the two are indistinguishable — nothing follows to boot.
    const top = await writeFlow("steps:\n  - run: loop-a\n  - run: e2e\n");
    await writeSiblingFlow(top, "loop-a", "steps:\n  - run: loop-b\n");
    await writeSiblingFlow(top, "loop-b", "steps:\n  - run: loop-a\n");
    await writeSiblingFlow(top, "e2e", "steps:\n  - launch: { chromium: ./app }\n");
    const registry = makeRegistry(async (id: string) =>
      id === "list-devices" ? { devices: [] } : {}
    );

    await expect(
      runFlow(registry, { name: "cyclic-then-e2e", project_root: PROJECT_ROOT, flow_file: top })
    ).rejects.toThrow(/No booted device found/);
    expect(bootElectronApp).not.toHaveBeenCalled();
  });

  // The hoist must accept exactly the chains execRunStep accepts (both walk
  // MAX_RUN_DEPTH deep, cycle-checked), or a boot could precede a run the
  // executor then refuses for depth. The tests below pin the bound from both
  // sides: 19 run-hops is the deepest chain the executor runs, 20 is refused —
  // and a refused chain ends the walk rather than being stepped over.
  // `topTail` appends further steps after the chain's `run:` in the top flow.
  async function writeRunChain(hops: number, topTail = ""): Promise<string> {
    const top = await writeFlow(`steps:\n  - run: chain-1\n${topTail}`);
    for (let i = 1; i < hops; i++) {
      await writeSiblingFlow(top, `chain-${i}`, `steps:\n  - run: chain-${i + 1}\n`);
    }
    await writeSiblingFlow(top, `chain-${hops}`, "steps:\n  - launch: { chromium: ./app }\n");
    return top;
  }

  it("boots for the deepest leading run: chain the executor accepts", async () => {
    const top = await writeRunChain(19);
    const registry = makeRegistry();

    const result = await runFlow(registry, {
      name: "deep-ok",
      project_root: PROJECT_ROOT,
      flow_file: top,
    });

    expect(bootElectronApp).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
  });

  it("does not boot for a leading run: chain the executor refuses for depth", async () => {
    const top = await writeRunChain(20);
    const registry = makeRegistry(async (id: string) =>
      id === "list-devices" ? { devices: [] } : {}
    );

    await expect(
      runFlow(registry, { name: "deep-refused", project_root: PROJECT_ROOT, flow_file: top })
    ).rejects.toThrow(/No booted device found/);
    expect(bootElectronApp).not.toHaveBeenCalled();
  });

  it("does not boot when a leading run: chain refused for depth precedes a launch-bearing hop", async () => {
    // Same distinction as the cyclic pair: the executor errors at the depth
    // bound and hard-stops, so neither the chain's own launch nor e2e's runs.
    // A walk that treated the over-deep hop as contributing nothing would carry
    // on to e2e and boot for a launch this run can never reach.
    const top = await writeRunChain(20, "  - run: e2e\n");
    await writeSiblingFlow(top, "e2e", "steps:\n  - launch: { chromium: ./app }\n");
    const registry = makeRegistry(async (id: string) =>
      id === "list-devices" ? { devices: [] } : {}
    );

    await expect(
      runFlow(registry, { name: "deep-then-e2e", project_root: PROJECT_ROOT, flow_file: top })
    ).rejects.toThrow(/No booted device found/);
    expect(bootElectronApp).not.toHaveBeenCalled();
  });

  it("follows a leading run: out of the flow's own directory, as the executor does", async () => {
    // A `..` target is a sanctioned layout (a fragment shared sideways), not an
    // escape: execRunStep applies no path fence beyond what the tool-server user
    // can already read. The hoist has to reach exactly as far, or a run the
    // executor happily launches would start attached to whatever happens to be
    // up instead of the app its leading chain names.
    const top = await writeFlow("steps:\n  - run: ../shared\n");
    const shared = path.join(path.dirname(top), "..", "shared.yaml");
    await fs.writeFile(shared, "steps:\n  - launch: { chromium: /abs/shared-app }\n", "utf8");
    try {
      const registry = makeRegistry();

      const result = await runFlow(registry, {
        name: "sideways",
        project_root: PROJECT_ROOT,
        flow_file: top,
      });

      expect(bootElectronApp).toHaveBeenCalledTimes(1);
      expect(bootElectronApp.mock.calls[0][0]).toMatchObject({ appPath: "/abs/shared-app" });
      expect(result.ok).toBe(true);
      expect(killChromiumByPortAndWait).toHaveBeenCalledWith(12345, 4242);
    } finally {
      await fs.rm(shared, { force: true });
    }
  });

  it("treats an unreadable leading run: as a dead end rather than scanning past it", async () => {
    // The third refusal kind, alongside the cyclic and over-deep pairs above: a
    // target the executor cannot load errors that step and hard-stops, so e2e's
    // launch never runs. Treating the missing hop as merely contributing
    // nothing would boot an instance this run can never launch anything on.
    const top = await writeFlow("steps:\n  - run: missing\n  - run: e2e\n");
    await writeSiblingFlow(top, "e2e", "steps:\n  - launch: { chromium: ./app }\n");
    const registry = makeRegistry(async (id: string) =>
      id === "list-devices" ? { devices: [] } : {}
    );

    await expect(
      runFlow(registry, { name: "missing-then-e2e", project_root: PROJECT_ROOT, flow_file: top })
    ).rejects.toThrow(/No booted device found/);
    expect(bootElectronApp).not.toHaveBeenCalled();

    // The executor's verdict on the same chain, attached to a device so it
    // actually runs: errored at the missing hop, everything after it skipped.
    const result = await runFlow(registry, {
      name: "missing-then-e2e",
      project_root: PROJECT_ROOT,
      flow_file: top,
      device: "chromium-cdp-9999",
    });

    expect(result.ok).toBe(false);
    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["run:error", "run:skip"]);
    expect(result.steps[0].reason).toContain('could not load fragment "missing.yaml"');
    expect(bootElectronApp).not.toHaveBeenCalled();
  });

  it("does not boot when a leading run: chain reaches no launch", async () => {
    // A plain fragment composition: nothing to boot — and the walk read the
    // whole chain, so a narration-only one needs no device either and runs on
    // a machine with nothing booted, exactly as its inline spelling would.
    const top = await writeFlow("steps:\n  - run: helper\n");
    await writeSiblingFlow(top, "helper", "steps:\n  - echo: nothing to launch\n");
    const registry = makeRegistry(async (id: string) =>
      id === "list-devices" ? { devices: [] } : {}
    );

    const result = await runFlow(registry, {
      name: "no-launch",
      project_root: PROJECT_ROOT,
      flow_file: top,
    });

    expect(result.ok).toBe(true);
    expect(result.device).toBe("");
    expect(bootElectronApp).not.toHaveBeenCalled();
  });

  it("errors a nested launch that declares no chromium app while the run is on chromium", async () => {
    // The mirror of the native check: on chromium a launch with no chromium
    // target has nothing to boot. Passing it as a no-op would leave every later
    // step running against the previous app — a green run against the wrong one.
    const parent = await writeFlow(
      "steps:\n  - launch: { chromium: ./app-a }\n  - run: nested\n  - echo: parent tail\n"
    );
    await writeSiblingFlow(
      parent,
      "nested",
      "steps:\n  - launch: { ios: com.acme.app }\n  - echo: in nested\n"
    );
    const registry = makeRegistry();

    const result = await runFlow(registry, {
      name: "nested-no-chromium",
      project_root: PROJECT_ROOT,
      flow_file: parent,
    });

    expect(result.ok).toBe(false);
    expect(bootElectronApp).toHaveBeenCalledTimes(1); // the hoisted boot only
    expect(result.steps[2]).toMatchObject({ kind: "launch", status: "error" });
    expect(result.steps[2].reason).toContain("no chromium app declared");
    expect(result.steps[2].reason).toContain("chromium-cdp-12345");
    expect(result.steps.slice(3).every((s) => s.status === "skip")).toBe(true);
  });

  it("reclaims every instance it booted when a step fails mid-run", async () => {
    // A failing run stops executing steps, but run-end teardown must still
    // sweep state.owned (awaited) — otherwise every failure leaks the booted apps.
    const parent = await writeFlow(
      "steps:\n  - launch: { chromium: ./app-a }\n  - run: nested\n  - launch: { ios: com.acme.app }\n  - echo: never reached\n"
    );
    await writeSiblingFlow(parent, "nested", "steps:\n  - launch: { chromium: ./app-b }\n");
    const registry = makeRegistry();

    const result = await runFlow(registry, {
      name: "failing-reclaim",
      project_root: PROJECT_ROOT,
      flow_file: parent,
    });

    expect(result.ok).toBe(false);
    expect(bootElectronApp).toHaveBeenCalledTimes(2); // hoisted app-a + nested app-b
    // Both owned instances go down despite the failure, newest first, awaited.
    expect(killChromiumByPortAndWait.mock.calls).toEqual([
      [12346, 4243],
      [12345, 4242],
    ]);
    expect(killChromiumByPort).not.toHaveBeenCalled();
  });

  it("reclaims the instances behind one whose teardown throws", async () => {
    // Teardown is best-effort by contract, and the run-end sweep is a bare loop
    // — a throw on one instance would strand every instance under it, from
    // inside a finally that would also mask the run's own outcome.
    const flowFile = await writeFlow(
      "steps:\n  - launch: { chromium: ./app-a }\n  - launch: { chromium: ./app-b }\n"
    );
    const registry = makeRegistry();
    killChromiumByPortAndWait.mockImplementationOnce(async () => {
      throw new Error("kill wedged");
    });

    const result = await runFlow(registry, {
      name: "wedged-teardown",
      project_root: PROJECT_ROOT,
      flow_file: flowFile,
    });

    expect(result.ok).toBe(true);
    // The newest instance's teardown threw; the older one's still ran.
    expect(killChromiumByPortAndWait.mock.calls).toEqual([
      [12346, 4243],
      [12345, 4242],
    ]);
  });

  it("errors the first launch when it declares no chromium app on a pinned instance", async () => {
    const flowFile = await writeFlow(
      "steps:\n  - launch: { ios: com.acme.app }\n  - echo: after\n"
    );
    const registry = makeRegistry();
    const refreshViewport = vi.fn(async () => ({ width: 800, height: 600 }));
    (registry.resolveService as any).mockImplementation(async () => ({
      refreshViewport,
      cdp: { send: vi.fn(async () => ({})) },
    }));

    const result = await runFlow(registry, {
      name: "pinned-no-chromium",
      project_root: PROJECT_ROOT,
      flow_file: flowFile,
      device: "chromium-cdp-9999",
    });

    expect(result.ok).toBe(false);
    expect(bootElectronApp).not.toHaveBeenCalled();
    expect(result.steps[0]).toMatchObject({ kind: "launch", status: "error" });
    expect(result.steps[0].reason).toContain("no chromium app declared");
    expect(result.steps[0].reason).toContain("chromium-cdp-9999");
    // Errored before attaching, rather than passing a no-op launch.
    expect(refreshViewport).not.toHaveBeenCalled();
  });

  it("errors rather than booting when a launch declares no app id for the run's platform", async () => {
    // A chromium entry does not make a launch runnable on android: the missing
    // android id is a declaration gap to report, not a cue to boot a desktop app.
    const flowFile = await writeFlow(
      "steps:\n  - launch: { ios: com.acme.app, chromium: ./desktop }\n  - echo: after\n"
    );
    const registry = makeRegistry();
    // isReady: the Android launch gate probes the devtools helper.
    (registry.resolveService as any).mockImplementation(async () => ({
      isReady: () => true,
      cdp: { send: vi.fn(async () => ({})) },
    }));

    const result = await runFlow(registry, {
      name: "multi-platform",
      project_root: PROJECT_ROOT,
      flow_file: flowFile,
      device: "emulator-5554",
    });

    expect(bootElectronApp).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.steps[0]).toMatchObject({ kind: "launch", status: "error" });
    expect(result.steps[0].reason).toContain('no app id declared for platform "android"');
  });

  it("names the single-instance lock when a lock-shaped boot failure has a live un-owned instance", async () => {
    // The one boot failure the underlying error can't explain — and the runner
    // may not kill the foreign instance to make room.
    const flowFile = await writeFlow(
      "steps:\n  - launch: { chromium: ./app }\n  - launch: { chromium: ./app }\n"
    );
    const registry = makeRegistry();
    (registry.resolveService as any).mockImplementation(async () => ({
      refreshViewport: vi.fn(async () => ({ width: 800, height: 600 })),
      cdp: { send: vi.fn(async () => ({})) },
    }));
    bootElectronApp.mockImplementationOnce(async () => {
      throw lockShapedBootError(12345);
    });

    const result = await runFlow(registry, {
      name: "locked",
      project_root: PROJECT_ROOT,
      flow_file: flowFile,
      device: "chromium-cdp-9999",
    });

    expect(result.ok).toBe(false);
    const failed = result.steps[1];
    expect(failed).toMatchObject({ kind: "launch", status: "error" });
    expect(failed.reason).toContain("exited with code 0 before CDP was ready");
    expect(failed.reason).toMatch(/single-instance lock/i);
    expect(failed.reason).toContain("chromium-cdp-9999");
    // The hint joins as its own sentence — never run into the base error's tail.
    expect(failed.reason).toMatch(/for the cause\. A clean exit/);
    // "is running" was verified, not assumed: the attached port got re-probed.
    expect(ensureCdpReachable).toHaveBeenCalledWith(9999, expect.anything());
    // Nothing was booted, so nothing is torn down — least of all the pinned one.
    expect(killChromiumByPort).not.toHaveBeenCalled();
    expect(killChromiumByPortAndWait).not.toHaveBeenCalled();
  });

  it("does not claim the attached instance is running when its CDP endpoint is gone", async () => {
    // The suspect may have exited since the run attached — asserting "is
    // running" then would send the agent chasing a ghost, so the hint falls
    // back to the generalized cause.
    const flowFile = await writeFlow(
      "steps:\n  - launch: { chromium: ./app }\n  - launch: { chromium: ./app }\n"
    );
    const registry = makeRegistry();
    (registry.resolveService as any).mockImplementation(async () => ({
      refreshViewport: vi.fn(async () => ({ width: 800, height: 600 })),
      cdp: { send: vi.fn(async () => ({})) },
    }));
    bootElectronApp.mockImplementationOnce(async () => {
      throw lockShapedBootError(12345);
    });
    ensureCdpReachable.mockImplementationOnce(async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:9999");
    });

    const result = await runFlow(registry, {
      name: "locked-dead-suspect",
      project_root: PROJECT_ROOT,
      flow_file: flowFile,
      device: "chromium-cdp-9999",
    });

    expect(result.ok).toBe(false);
    const failed = result.steps[1];
    expect(failed.reason).toMatch(/single-instance lock/i);
    expect(failed.reason).not.toContain("chromium-cdp-9999 is running");
  });

  it("names the foreign instance AND the run's own after the run has moved onto one it owns", async () => {
    // Both are suspects and neither subsumes the other: the foreign instance
    // outlives every launch (the runner never kills it) and is the one a reader
    // can actually close, while the owned one is the holder no rerun can escape.
    const flowFile = await writeFlow(
      "steps:\n  - launch: { chromium: ./app-lock }\n  - launch: { chromium: ./app-b }\n  - launch: { chromium: ./app-lock }\n"
    );
    const registry = makeRegistry();
    (registry.resolveService as any).mockImplementation(async () => ({
      refreshViewport: vi.fn(async () => ({ width: 800, height: 600 })),
      cdp: { send: vi.fn(async () => ({})) },
    }));
    // app-b's boot succeeds (moving the run onto an owned instance); app-lock's fails.
    bootElectronApp.mockImplementationOnce(defaultBoot).mockImplementationOnce(async () => {
      throw lockShapedBootError(12346);
    });

    const result = await runFlow(registry, {
      name: "locked-after-move",
      project_root: PROJECT_ROOT,
      flow_file: flowFile,
      device: "chromium-cdp-9999",
    });

    expect(result.ok).toBe(false);
    const failed = result.steps[2];
    expect(failed).toMatchObject({ kind: "launch", status: "error" });
    expect(failed.reason).toMatch(/single-instance lock/i);
    expect(failed.reason).toContain("chromium-cdp-9999 is running and this run does not own it");
    // The owned app-b instance is named too, with the path that makes the name
    // collision checkable — and the closable advice is withdrawn for it.
    expect(failed.reason).toContain(
      `chromium-cdp-12345 (${path.join(path.dirname(flowFile), "app-b")})`
    );
    expect(failed.reason).toContain("closing it is not on offer and a rerun fails identically");
    // Only the instance the runner booted for app-b is torn down.
    expect(killChromiumByPortAndWait.mock.calls).toEqual([[12345, 4242]]);
  });

  it("names the run's OWN instance as the holder when the lock beats a later launch", async () => {
    // Hoist-booted run: it never attached, so the only thing that can hold the
    // lock is the instance the run itself booted — the case two app directories
    // sharing one Electron `name` (a v1/v2 build pair) produces, since the
    // path-equality retire in bootChromiumForLaunch can't see they are one app.
    // "Close it and rerun" is unactionable here: the runner kills that holder at
    // run end, so there is nothing to close and the rerun fails identically.
    const flowFile = await writeFlow(
      "steps:\n  - launch: { chromium: ./app-a }\n  - launch: { chromium: ./app-b }\n"
    );
    const registry = makeRegistry();
    // The hoisted boot succeeds; app-b's fails lock-shaped.
    bootElectronApp.mockImplementationOnce(defaultBoot).mockImplementationOnce(async () => {
      throw lockShapedBootError(12346);
    });

    const result = await runFlow(registry, {
      name: "hoisted-locked",
      project_root: PROJECT_ROOT,
      flow_file: flowFile,
    });

    expect(result.ok).toBe(false);
    const failed = result.steps[1];
    expect(failed).toMatchObject({ kind: "launch", status: "error" });
    expect(failed.reason).toContain("could not boot the chromium app");
    expect(failed.reason).toMatch(/single-instance lock/i);
    // The holder is named with the app path that makes the shared `name`
    // checkable — app-a, which no retire could match against app-b.
    expect(failed.reason).toContain(
      `This run booted chromium-cdp-12345 (${path.join(path.dirname(flowFile), "app-a")})`
    );
    expect(failed.reason).toContain("alive until run end");
    expect(failed.reason).toContain("shares an Electron `name`");
    expect(failed.reason).toContain("closing it is not on offer and a rerun fails identically");
    // Both the misleading advice and the un-owned wording stay off a holder the
    // run owns: one is impossible to act on, the other is simply false.
    expect(failed.reason).not.toContain("close it and rerun");
    expect(failed.reason).not.toContain("is running and this run does not own it");
    // "alive until run end" was verified, not assumed from the boot record.
    expect(ensureCdpReachable).toHaveBeenCalledWith(12345, expect.anything());
    // The hoisted instance is still reclaimed at run end.
    expect(killChromiumByPortAndWait.mock.calls).toEqual([[12345, 4242]]);
  });

  it("lists every instance the run owns, since it cannot tell which one shares the name", async () => {
    // Two live owned instances of different apps: the failing path matched
    // neither (or one would have been retired), and the colliding Electron
    // `name` is only in the app manifests the runner never reads — so naming a
    // single guess would point at the wrong app half the time.
    const flowFile = await writeFlow(
      "steps:\n  - launch: { chromium: ./app-a }\n  - launch: { chromium: ./app-b }\n  - launch: { chromium: ./app-c }\n"
    );
    const registry = makeRegistry();
    // Hoist (app-a) and app-b boot; app-c's is the one the lock quits.
    bootElectronApp
      .mockImplementationOnce(defaultBoot)
      .mockImplementationOnce(defaultBoot)
      .mockImplementationOnce(async () => {
        throw lockShapedBootError(12347);
      });

    const result = await runFlow(registry, {
      name: "locked-two-owned",
      project_root: PROJECT_ROOT,
      flow_file: flowFile,
    });

    expect(result.ok).toBe(false);
    const dir = path.dirname(flowFile);
    expect(result.steps[2].reason).toContain(
      `This run booted chromium-cdp-12345 (${path.join(dir, "app-a")}), chromium-cdp-12346 (${path.join(dir, "app-b")})`
    );
  });

  it("does not name an owned instance whose CDP endpoint is gone", async () => {
    // Owning a process is not evidence it lives — it can crash or be closed
    // after its boot, and a dead one holds no lock. Same ghost rule as the
    // attached suspect: with nothing live left to name, the hint generalizes.
    const flowFile = await writeFlow(
      "steps:\n  - launch: { chromium: ./app-a }\n  - launch: { chromium: ./app-b }\n"
    );
    const registry = makeRegistry();
    bootElectronApp.mockImplementationOnce(defaultBoot).mockImplementationOnce(async () => {
      throw lockShapedBootError(12346);
    });
    // Keyed on the port, not call order: the suspects are probed in parallel, so
    // a `once` handler would attach to whichever probe happened to run first.
    ensureCdpReachable.mockImplementation(async (port: number) => {
      if (port === 12345) throw new Error("connect ECONNREFUSED 127.0.0.1:12345");
      return { Browser: "TestApp/1.0" };
    });

    const result = await runFlow(registry, {
      name: "locked-dead-owned",
      project_root: PROJECT_ROOT,
      flow_file: flowFile,
    });

    expect(result.ok).toBe(false);
    const failed = result.steps[1];
    expect(failed.reason).toMatch(/single-instance lock/i);
    expect(failed.reason).not.toContain("chromium-cdp-12345");
    expect(failed.reason).toContain("If a copy of this app is already running, close it and rerun");
  });

  it("keeps the bare error when a boot failure is not lock-shaped, even with an attached instance", async () => {
    // A missing app path has nothing to do with any lock — blaming the pinned
    // instance would point the agent at the wrong app entirely.
    const flowFile = await writeFlow(
      "steps:\n  - launch: { chromium: ./app }\n  - launch: { chromium: ./nope }\n"
    );
    const registry = makeRegistry();
    (registry.resolveService as any).mockImplementation(async () => ({
      refreshViewport: vi.fn(async () => ({ width: 800, height: 600 })),
      cdp: { send: vi.fn(async () => ({})) },
    }));
    bootElectronApp.mockImplementationOnce(async () => {
      throw new Error("Electron boot: path does not exist: /apps/nope");
    });

    const result = await runFlow(registry, {
      name: "not-lock-shaped",
      project_root: PROJECT_ROOT,
      flow_file: flowFile,
      device: "chromium-cdp-9999",
    });

    expect(result.ok).toBe(false);
    const failed = result.steps[1];
    expect(failed).toMatchObject({ kind: "launch", status: "error" });
    expect(failed.reason).toBe(
      "could not boot the chromium app: Electron boot: path does not exist: /apps/nope"
    );
    expect(ensureCdpReachable).not.toHaveBeenCalled();
  });

  it("treats an early exit with a non-zero code as a crash, not a lock", async () => {
    // Same failure code, but the process died with code 1 — that is the app
    // crashing at startup, which the base error already explains.
    const flowFile = await writeFlow(
      "steps:\n  - launch: { chromium: ./app }\n  - launch: { chromium: ./app }\n"
    );
    const registry = makeRegistry();
    (registry.resolveService as any).mockImplementation(async () => ({
      refreshViewport: vi.fn(async () => ({ width: 800, height: 600 })),
      cdp: { send: vi.fn(async () => ({})) },
    }));
    bootElectronApp.mockImplementationOnce(async () => {
      throw new FailureError(
        "Electron boot: child process exited with code 1 before CDP was ready. Inspect [chromium-cdp-12345] stderr above for the cause.",
        {
          error_code: FAILURE_CODES.CHROMIUM_ELECTRON_EXITED_BEFORE_READY,
          failure_stage: "electron_early_exit",
          failure_area: "tool_server",
          error_kind: "subprocess",
          failure_command: "electron",
          failure_exit_code: 1,
        }
      );
    });

    const result = await runFlow(registry, {
      name: "crash-not-lock",
      project_root: PROJECT_ROOT,
      flow_file: flowFile,
      device: "chromium-cdp-9999",
    });

    expect(result.ok).toBe(false);
    const failed = result.steps[1];
    expect(failed.reason).toContain("exited with code 1 before CDP was ready");
    expect(failed.reason).not.toMatch(/single-instance lock/i);
    expect(ensureCdpReachable).not.toHaveBeenCalled();
  });

  it("explains the single-instance lock when the HOISTED boot is the one it quits", async () => {
    // The likeliest way to meet the lock: the app is already open when the run
    // starts, so the very first boot loses — and that one is the hoist, which
    // rejects the whole call with no report to carry a step reason. The
    // diagnosis therefore has to ride the thrown message itself.
    const flowFile = await writeFlow("steps:\n  - launch: { chromium: ./app }\n  - echo: done\n");
    const registry = makeRegistry();
    bootElectronApp.mockImplementationOnce(async () => {
      throw lockShapedBootError(12345);
    });

    const rejection = runFlow(registry, {
      name: "hoist-locked",
      project_root: PROJECT_ROOT,
      flow_file: flowFile,
    });

    // The underlying error survives the rewording; the hint follows it.
    await expect(rejection).rejects.toThrow(/exited with code 0 before CDP was ready/);
    await expect(rejection).rejects.toThrow(/single-instance lock/i);
    // A hoisted run attached to nothing, so no instance is named as the holder
    // (and none is probed for liveness).
    await expect(rejection).rejects.toThrow(/close it and rerun/);
    await expect(rejection).rejects.not.toThrow(/does not own it/);
    expect(ensureCdpReachable).not.toHaveBeenCalled();
    // Only the message grows: the classification the CLI and the failure
    // taxonomy key on must come through the rethrow intact.
    const signal = getFailureSignal(await rejection.catch((e: unknown) => e));
    expect(signal?.error_code).toBe(FAILURE_CODES.CHROMIUM_ELECTRON_EXITED_BEFORE_READY);
    expect(signal?.failure_exit_code).toBe(0);
    // The boot never returned an instance, so there is nothing to tear down.
    expect(killChromiumByPort).not.toHaveBeenCalled();
    expect(killChromiumByPortAndWait).not.toHaveBeenCalled();
  });

  it("rethrows a hoisted boot failure that is not lock-shaped exactly as thrown", async () => {
    // A missing app path already says what is wrong; a lock hint would send the
    // caller closing windows that have nothing to do with the failure.
    const flowFile = await writeFlow("steps:\n  - launch: { chromium: ./nope }\n");
    const registry = makeRegistry();
    const raw = new Error("Electron boot: path does not exist: /apps/nope");
    bootElectronApp.mockImplementationOnce(async () => {
      throw raw;
    });

    // toBe, not toThrow: the original error object propagates, unwrapped.
    await expect(
      runFlow(registry, {
        name: "hoist-missing-app",
        project_root: PROJECT_ROOT,
        flow_file: flowFile,
      })
    ).rejects.toBe(raw);
  });

  it("treats a non-zero exit on the hoisted boot as a crash, not a lock", async () => {
    // Same failure code as the lock's shape, but code 1 is the app crashing at
    // startup — so the exit code, not merely the presence of a failure signal,
    // is what decides on the hoist too.
    const flowFile = await writeFlow("steps:\n  - launch: { chromium: ./app }\n");
    const registry = makeRegistry();
    const raw = new FailureError(
      "Electron boot: child process exited with code 1 before CDP was ready. Inspect [chromium-cdp-12345] stderr above for the cause.",
      {
        error_code: FAILURE_CODES.CHROMIUM_ELECTRON_EXITED_BEFORE_READY,
        failure_stage: "electron_early_exit",
        failure_area: "tool_server",
        error_kind: "subprocess",
        failure_command: "electron",
        failure_exit_code: 1,
      }
    );
    bootElectronApp.mockImplementationOnce(async () => {
      throw raw;
    });

    await expect(
      runFlow(registry, {
        name: "hoist-crash",
        project_root: PROJECT_ROOT,
        flow_file: flowFile,
      })
    ).rejects.toBe(raw);
  });

  it("still honors the first launch when a fragment run:s an e2e flow (the common composition)", async () => {
    // Fragment B (no leading launch) that run:s e2e flow A (launch + setup).
    // A's launch is the run's FIRST, so it attaches to the pinned instance
    // rather than booting. The pinned device is what suppresses the boot —
    // without one this same shape hoist-boots A's app before step 1.
    const fragmentB = await writeFlow("steps:\n  - run: setup-a.yaml\n  - echo: B after A\n");
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

    // Pinned device: the runner never boots (nor tears down) an instance;
    // A's launch attaches to the pinned one instead.
    expect(bootElectronApp).not.toHaveBeenCalled();
    expect(killChromiumByPort).not.toHaveBeenCalled();
    expect(killChromiumByPortAndWait).not.toHaveBeenCalled();
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

describe("flow-execute prerequisite vs leading launch chain", () => {
  // The run-time analog of the parse rule: parse validates one file, so a
  // prerequisite fragment whose leading run: chain reaches a launch slips past
  // it — but that launch (re)starts the app at step 1, destroying the very
  // state the prerequisite demands. The runner must refuse such a run outright,
  // before anything boots.
  it("rejects a prerequisite fragment whose leading run: reaches a launch, before any boot", async () => {
    const fragment = await writeFlow(
      'executionPrerequisite: "the counter must already read taps: 1"\n' +
        "steps:\n  - run: e2e-a\n  - echo: after\n"
    );
    await writeSiblingFlow(fragment, "e2e-a", "steps:\n  - launch: { chromium: ./app }\n");
    const registry = makeRegistry();

    const refusal = runFlow(registry, {
      name: "indirect-prereq",
      project_root: PROJECT_ROOT,
      flow_file: fragment,
      prerequisiteAcknowledged: true,
    });
    await expect(refusal).rejects.toThrow(/must not declare executionPrerequisite/i);
    // And the message names the third way out, since this launch does declare a
    // chromium app: pinning is a supported answer here, not just a diagnosis.
    await expect(refusal).rejects.toThrow(/--device chromium-cdp-<port>/);
    // Refused before the hoist — the state the prerequisite demands survives.
    expect(bootElectronApp).not.toHaveBeenCalled();
    expect((registry.invokeTool as any).mock.calls).toEqual([]);
  });

  it("names the flow that carries the launch, not the top-level fragment", async () => {
    const fragment = await writeFlow(
      'executionPrerequisite: "logged in"\nsteps:\n  - run: middle-frag\n'
    );
    await writeSiblingFlow(fragment, "middle-frag", "steps:\n  - run: e2e-inner\n");
    await writeSiblingFlow(fragment, "e2e-inner", "steps:\n  - launch: { chromium: ./app }\n");
    const registry = makeRegistry();

    await expect(
      runFlow(registry, {
        name: "top-frag",
        project_root: PROJECT_ROOT,
        flow_file: fragment,
        prerequisiteAcknowledged: true,
      })
    ).rejects.toThrow(/"e2e-inner"/);
    expect(bootElectronApp).not.toHaveBeenCalled();
  });

  it("rejects on the unacknowledged path too, instead of returning the notice", async () => {
    // Without the check, the LLM handshake would echo the prerequisite back and
    // tell the caller to establish state the run would then throw away.
    const fragment = await writeFlow(
      'executionPrerequisite: "the counter must already read taps: 1"\n' +
        "steps:\n  - run: e2e-a\n  - echo: after\n"
    );
    await writeSiblingFlow(fragment, "e2e-a", "steps:\n  - launch: { chromium: ./app }\n");
    const registry = makeRegistry();

    await expect(
      runFlowRaw(registry, {
        name: "indirect-prereq-notice",
        project_root: PROJECT_ROOT,
        flow_file: fragment,
      })
    ).rejects.toThrow(/must not declare executionPrerequisite/i);
    expect(bootElectronApp).not.toHaveBeenCalled();
  });

  it("rejects a prerequisite fragment whose leading run: hop only narrates before the launch", async () => {
    // An echo-only fragment executes as nothing and the run reaches e2e-a's
    // launch at step 1 all the same — so the guard has to see through the hop.
    // Missing it is worse than not guarding: the handshake asks the caller to
    // establish state, then the acknowledged run relaunches the app and wipes it.
    const fragment = await writeFlow(
      'executionPrerequisite: "the counter must already read taps: 1"\n' +
        "steps:\n  - run: narrate\n  - run: e2e-a\n"
    );
    await writeSiblingFlow(fragment, "narrate", "steps:\n  - echo: about to run e2e-a\n");
    await writeSiblingFlow(fragment, "e2e-a", "steps:\n  - launch: { chromium: ./app }\n");
    const registry = makeRegistry();

    // Refused on both paths, and pointing at the file that carries the launch.
    await expect(
      runFlowRaw(registry, {
        name: "hop-prereq",
        project_root: PROJECT_ROOT,
        flow_file: fragment,
      })
    ).rejects.toThrow(/must not declare executionPrerequisite/i);
    await expect(
      runFlow(registry, {
        name: "hop-prereq",
        project_root: PROJECT_ROOT,
        flow_file: fragment,
        prerequisiteAcknowledged: true,
      })
    ).rejects.toThrow(/"e2e-a"/);
    expect(bootElectronApp).not.toHaveBeenCalled();
    expect((registry.invokeTool as any).mock.calls).toEqual([]);
  });

  it("rejects the inline-echo spelling of that fragment identically", async () => {
    // The control: the same run with the narration in the fragment itself.
    const fragment = await writeFlow(
      'executionPrerequisite: "the counter must already read taps: 1"\n' +
        "steps:\n  - echo: about to run e2e-a\n  - run: e2e-a\n"
    );
    await writeSiblingFlow(fragment, "e2e-a", "steps:\n  - launch: { chromium: ./app }\n");
    const registry = makeRegistry();

    await expect(
      runFlowRaw(registry, {
        name: "inline-prereq",
        project_root: PROJECT_ROOT,
        flow_file: fragment,
      })
    ).rejects.toThrow(/must not declare executionPrerequisite/i);
    await expect(
      runFlow(registry, {
        name: "inline-prereq",
        project_root: PROJECT_ROOT,
        flow_file: fragment,
        prerequisiteAcknowledged: true,
      })
    ).rejects.toThrow(/"e2e-a"/);
    expect(bootElectronApp).not.toHaveBeenCalled();
  });

  it("runs a chromium-pinned fragment whose leading run: reaches a launch, attaching to it", async () => {
    // The escape hatch the refusal exists to leave open. Pinned with `device`,
    // resolveRunDevice hoists no boot — so the run owns nothing at step 1 and
    // e2e-a's launch can only attach (a CDP viewport refresh, no process
    // touched), leaving the state the caller established exactly as it was.
    const fragment = await writeFlow(
      'executionPrerequisite: "the counter must already read taps: 3"\n' +
        "steps:\n  - run: e2e-a\n  - echo: after\n"
    );
    await writeSiblingFlow(
      fragment,
      "e2e-a",
      "steps:\n  - launch: { chromium: ./app }\n  - echo: A launched\n"
    );
    const registry = makeRegistry();
    const refreshViewport = vi.fn(async () => ({ width: 800, height: 600 }));
    (registry.resolveService as any).mockImplementation(async () => ({
      refreshViewport,
      cdp: { send: vi.fn(async () => ({})) },
    }));
    const params = {
      name: "pinned-prereq",
      project_root: PROJECT_ROOT,
      flow_file: fragment,
      device: "chromium-cdp-9999",
    };

    // Not refused: it takes the ordinary handshake, like any other fragment
    // carrying a prerequisite — and answers it without touching the device.
    const noticed = await runFlowRaw(registry, params);
    expect(noticed).toMatchObject({
      notice: expect.stringContaining("prerequisite"),
      executionPrerequisite: "the counter must already read taps: 3",
    });
    expect((registry.invokeTool as any).mock.calls).toEqual([]);

    const result = await runFlow(registry, { ...params, prerequisiteAcknowledged: true });

    expect(result.ok).toBe(true);
    expect(result.device).toBe("chromium-cdp-9999");
    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual([
      "run:pass",
      "launch:pass",
      "echo:pass",
      "echo:pass",
    ]);
    // Attached, not booted: a bare launch pass (no reason) is the attach signal,
    // and the instance the caller brought is neither booted over nor killed.
    expect(result.steps[1].reason).toBeUndefined();
    expect(refreshViewport).toHaveBeenCalledTimes(1);
    expect(bootElectronApp).not.toHaveBeenCalled();
    expect(killChromiumByPort).not.toHaveBeenCalled();
    expect(killChromiumByPortAndWait).not.toHaveBeenCalled();
  });

  it("still rejects that same fragment with no explicit device", async () => {
    // The control for the exemption above: unpinned, the hoist boots e2e-a's app
    // and the run OWNS it, so the leading launch settles a brand-new process and
    // the prerequisite state is gone. Only the attach makes the refusal wrong.
    const fragment = await writeFlow(
      'executionPrerequisite: "the counter must already read taps: 3"\n' +
        "steps:\n  - run: e2e-a\n  - echo: after\n"
    );
    await writeSiblingFlow(
      fragment,
      "e2e-a",
      "steps:\n  - launch: { chromium: ./app }\n  - echo: A launched\n"
    );
    const registry = makeRegistry();

    await expect(
      runFlow(registry, {
        name: "unpinned-prereq",
        project_root: PROJECT_ROOT,
        flow_file: fragment,
        prerequisiteAcknowledged: true,
      })
    ).rejects.toThrow(/must not declare executionPrerequisite/i);
    expect(bootElectronApp).not.toHaveBeenCalled();
  });

  it("still rejects a pinned run on a native platform, where a launch restarts the app", async () => {
    // Pinning proves nothing off chromium: `launch` on ios/android/vega is
    // restart-app, which terminates and relaunches the app on whatever device it
    // is handed — the pinned one included — so the state dies at step 1 just as
    // it would unpinned. Exempting every pinned run would wave these through.
    const fragment = await writeFlow(
      'executionPrerequisite: "the counter must already read taps: 3"\n' +
        "steps:\n  - run: e2e-a\n"
    );
    await writeSiblingFlow(
      fragment,
      "e2e-a",
      "steps:\n  - launch: { ios: com.acme.app, android: com.acme.app, vega: com.acme.app }\n"
    );
    const registry = makeRegistry();

    // One id per native platform, in resolveDevice's shapes: an `emulator-` adb
    // serial, an 8-4-4-4-12 iOS udid, an `amazon-` Vega serial — each classifies
    // off chromium, and each has a launch entry, so the run really would
    // restart-app on it.
    for (const device of [
      "emulator-5554",
      "00000000-0000-0000-0000-0000000000ab",
      "amazon-4a27df03c9777152",
    ]) {
      const refusal = runFlow(registry, {
        name: "pinned-native-prereq",
        project_root: PROJECT_ROOT,
        flow_file: fragment,
        device,
        prerequisiteAcknowledged: true,
      });
      await expect(refusal).rejects.toThrow(/must not declare executionPrerequisite/i);
      // No chromium pin offered: this launch declares no chromium app, so the
      // exemption is unreachable and suggesting it would just misdirect.
      await expect(refusal).rejects.not.toThrow(/--device/);
    }
    // Refused before the device was touched at all — no restart-app went out.
    expect((registry.invokeTool as any).mock.calls).toEqual([]);
  });

  it("still notices a prerequisite fragment whose leading run: reaches no launch", async () => {
    // A plain fragment composition keeps the ordinary handshake: notice first,
    // run on acknowledgement — no launch anywhere in the leading chain.
    const fragment = await writeFlow(
      'executionPrerequisite: "logged in"\nsteps:\n  - run: helper\n'
    );
    await writeSiblingFlow(fragment, "helper", "steps:\n  - echo: nothing to launch\n");
    const registry = makeRegistry();

    const result = await runFlowRaw(registry, {
      name: "plain-prereq",
      project_root: PROJECT_ROOT,
      flow_file: fragment,
    });

    expect(result).toMatchObject({
      notice: expect.stringContaining("prerequisite"),
      executionPrerequisite: "logged in",
    });
    expect(result).not.toHaveProperty("steps");
    expect(bootElectronApp).not.toHaveBeenCalled();
  });

  it("keeps best-effort behavior when the leading run: chain is broken", async () => {
    // A missing sibling makes the chain unreadable: leadingRun finds no launch,
    // so no new rejection fires — the notice comes back as before, and an
    // acknowledged run proceeds to device resolution (the broken run: target is
    // reported at step time, exactly as on main).
    const fragment = await writeFlow(
      'executionPrerequisite: "logged in"\nsteps:\n  - run: missing-sibling\n'
    );
    const registry = makeRegistry(async (id: string) =>
      id === "list-devices" ? { devices: [] } : {}
    );

    const noticed = await runFlowRaw(registry, {
      name: "broken-chain",
      project_root: PROJECT_ROOT,
      flow_file: fragment,
    });
    expect(noticed).toMatchObject({ notice: expect.stringContaining("prerequisite") });

    await expect(
      runFlow(registry, {
        name: "broken-chain",
        project_root: PROJECT_ROOT,
        flow_file: fragment,
        prerequisiteAcknowledged: true,
      })
    ).rejects.toThrow(/No booted device found/);
    expect(bootElectronApp).not.toHaveBeenCalled();
  });
});
