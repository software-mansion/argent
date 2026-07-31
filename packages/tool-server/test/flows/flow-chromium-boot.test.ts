import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Registry } from "@argent/registry";
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

async function runFlow(
  registry: Registry,
  params: Record<string, unknown>,
  signal?: AbortSignal
): Promise<FlowRunResult> {
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
  return asRun(
    await createRunFlowTool(registry).execute(
      {},
      { ...rest, flow_path: flowPath } as never,
      ctx as never
    )
  );
}

beforeEach(() => {
  bootCount = 0;
  // Reset, not clear: mockClear leaves queued mockImplementationOnce handlers
  // in place, so a test that failed early would leak one into the next.
  bootElectronApp.mockReset().mockImplementation(defaultBoot);
  killChromiumByPort.mockReset();
  killChromiumByPortAndWait.mockReset();
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
    // The nested launch says it moved the run onto a new device.
    const nestedLaunch = result.steps[2];
    expect(nestedLaunch.flow).toBe("nested-chromium");
    expect(nestedLaunch.reason).toContain("chromium-cdp-12346");
    // The report names the device the run STARTED on; the switch is on the step.
    expect(result.device).toBe("chromium-cdp-12345");

    // Both are torn down, nested first — a parent instance outlives its child.
    expect(killChromiumByPort.mock.calls).toEqual([
      [12346, 4243],
      [12345, 4242],
    ]);
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
    // The retire goes through the awaiting kill — the replacement must not race
    // the dying process's lock — and lands before the second boot.
    expect(killChromiumByPortAndWait.mock.calls).toEqual([[12345, 4242]]);
    expect(killChromiumByPortAndWait.mock.invocationCallOrder[0]).toBeLessThan(
      bootElectronApp.mock.invocationCallOrder[1]!
    );
    // Only the replacement is left for run-end teardown.
    expect(killChromiumByPort.mock.calls).toEqual([[12346, 4243]]);
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
    // before the replacement boots.
    expect(killChromiumByPortAndWait.mock.calls).toEqual([[12345, 4242]]);
    expect(killChromiumByPortAndWait.mock.invocationCallOrder[0]).toBeLessThan(
      bootElectronApp.mock.invocationCallOrder[1]!
    );
    // Only the replacement is left for run-end teardown.
    expect(killChromiumByPort.mock.calls).toEqual([[12346, 4243]]);
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
    // Only the instance the runner booted is torn down — never the pinned one.
    expect(killChromiumByPort.mock.calls).toEqual([[12345, 4242]]);
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
    expect(killChromiumByPort.mock.calls).toEqual([
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
    expect(killChromiumByPort).toHaveBeenCalledWith(12345, 4242);
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

  // The hoist must accept exactly the chains execRunStep accepts (both walk
  // MAX_RUN_DEPTH deep, cycle-checked), or a boot could precede a run the
  // executor then refuses for depth. The two tests pin the bound from both
  // sides: 19 run-hops is the deepest chain the executor runs, 20 is refused.
  async function writeRunChain(hops: number): Promise<string> {
    const top = await writeFlow("steps:\n  - run: chain-1\n");
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

  it("refuses a leading run: that escapes the flows directory, before anything boots", async () => {
    // Defence-in-depth on the hoist: the name check must run before the chain
    // walk reads the file, or `run: ../evil` would boot the caller-chosen app
    // path that file names — execRunStep's own check runs only after the boot.
    const top = await writeFlow("steps:\n  - run: ../evil\n");
    const evil = path.join(path.dirname(top), "..", "evil.yaml");
    await fs.writeFile(evil, "steps:\n  - launch: { chromium: /abs/evil-app }\n", "utf8");
    try {
      const registry = makeRegistry(async (id: string) =>
        id === "list-devices" ? { devices: [] } : {}
      );

      // The hoist yields nothing, so device resolution proceeds and finds no
      // device — the escaped file's launch must never have entered the picture.
      await expect(
        runFlow(registry, { name: "escape", project_root: PROJECT_ROOT, flow_file: top })
      ).rejects.toThrow(/No booted device found/);
      expect(bootElectronApp).not.toHaveBeenCalled();
    } finally {
      await fs.rm(evil, { force: true });
    }
  });

  it("does not boot when a leading run: chain reaches no launch", async () => {
    // A plain fragment composition: nothing to boot, so device resolution
    // proceeds normally (and reports no booted device here).
    const top = await writeFlow("steps:\n  - run: helper\n");
    await writeSiblingFlow(top, "helper", "steps:\n  - echo: nothing to launch\n");
    const registry = makeRegistry(async (id: string) =>
      id === "list-devices" ? { devices: [] } : {}
    );

    await expect(
      runFlow(registry, { name: "no-launch", project_root: PROJECT_ROOT, flow_file: top })
    ).rejects.toThrow(/No booted device found/);
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
    // sweep state.owned — otherwise every failure leaks the booted apps.
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
    // Both owned instances go down despite the failure, newest first.
    expect(killChromiumByPort.mock.calls).toEqual([
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

  it("names the single-instance lock when a boot fails against an instance it does not own", async () => {
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
      throw new Error("CDP never became reachable on port 12345");
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
    expect(failed.reason).toContain("CDP never became reachable");
    expect(failed.reason).toMatch(/single-instance lock/i);
    expect(failed.reason).toContain("chromium-cdp-9999");
    // Nothing was booted, so nothing is torn down — least of all the pinned one.
    expect(killChromiumByPort).not.toHaveBeenCalled();
  });

  it("still names the foreign instance after the run has moved onto one it owns", async () => {
    // The foreign instance outlives every launch (the runner never kills it), so
    // the hint must name IT — not the owned instance the run currently sits on.
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
      throw new Error("CDP never became reachable on port 12346");
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
    expect(failed.reason).toContain("CDP never became reachable");
    expect(failed.reason).toMatch(/single-instance lock/i);
    expect(failed.reason).toContain("chromium-cdp-9999");
    expect(failed.reason).not.toContain("chromium-cdp-12345");
    // Only the instance the runner booted for app-b is torn down.
    expect(killChromiumByPort.mock.calls).toEqual([[12345, 4242]]);
  });

  it("does not blame a foreign instance when the run never attached to one", async () => {
    // Hoisted boot: the run starts on an instance it owns, so a later boot
    // failure has no un-owned lock-holder candidate to name.
    const flowFile = await writeFlow(
      "steps:\n  - launch: { chromium: ./app-a }\n  - launch: { chromium: ./app-b }\n"
    );
    const registry = makeRegistry();
    // The hoisted boot succeeds; app-b's fails.
    bootElectronApp.mockImplementationOnce(defaultBoot).mockImplementationOnce(async () => {
      throw new Error("CDP never became reachable on port 12346");
    });

    const result = await runFlow(registry, {
      name: "owned-only",
      project_root: PROJECT_ROOT,
      flow_file: flowFile,
    });

    expect(result.ok).toBe(false);
    const failed = result.steps[1];
    expect(failed).toMatchObject({ kind: "launch", status: "error" });
    expect(failed.reason).toContain("could not boot the chromium app");
    expect(failed.reason).toContain("CDP never became reachable");
    expect(failed.reason).not.toContain("An instance this run does not own");
    // The hoisted instance is still reclaimed at run end.
    expect(killChromiumByPort.mock.calls).toEqual([[12345, 4242]]);
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
