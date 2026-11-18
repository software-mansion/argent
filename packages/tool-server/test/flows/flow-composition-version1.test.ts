import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type Registry } from "@argent/registry";
import {
  createRunFlowTool,
  flowLaunchGateReason,
  LAUNCH_TO_VERDICT_MS,
  NATIVE_READY_TIMEOUT_MS,
  type FlowRunResult,
} from "../../src/tools/flows/flow-run";
import { serializeFlow } from "../../src/tools/flows/flow-utils";

// Five tests here drive the launch gate's real 1.5 s settle plus the whole
// connect wait in fake time, pumping a real event-loop turn between advances so
// the run's disk I/O can settle. Each pump is a real macrotask, so the cost is
// the pump count, not the fake duration — under full-suite load it outruns
// vitest's 5 s default. Widening the advance is NOT the fix: coarser steps
// starve that I/O and take longer in real time (measured: 1 s steps took the
// file from 46 s to 52 s). Budget the pumping, and prefer unit-testing the pure
// message mapping over driving the whole runner once per case.
vi.setConfig({ testTimeout: 60_000 });

/**
 * Ceiling on those pumps. The loop has to cover the settle plus the entire
 * connect wait in fake time — one 250 ms advance each — and still have turns
 * spare for the real-async steps interleaved between them, which multiply as
 * parallel workers contend for the disk.
 *
 * Derived from the connect budget rather than fixed, because running out is
 * silent and mimics nothing else: the run never settles, the loop abandons it
 * pending, and the test hangs on `await pending` until the timeout — so it reads
 * as slowness, and no timeout value fixes it. A settled run leaves the loop
 * immediately, so the headroom costs nothing.
 */
const PUMP_LIMIT = Math.ceil(NATIVE_READY_TIMEOUT_MS / 250) * 10;

const DEVICE = "00000000-0000-0000-0000-0000000000ab";
let tmpDir: string;

/**
 * `props`, when given, makes `getTool` report that schema for EVERY tool id —
 * so a fixture using it must be a single step and must pass an explicit device,
 * otherwise unrelated dispatches (list-devices) would be handed a bogus schema.
 */
function mockRegistry(props?: Record<string, unknown>): Registry {
  return {
    invokeTool: vi.fn(async (id: string) => {
      if (id === "list-devices") return { devices: [] };
      return { ok: true };
    }),
    getTool: vi.fn(() => (props ? { inputSchema: { properties: props } } : undefined)),
    // iOS launch steps gate on a native-devtools connection: report connected
    // so the run proceeds. The selector directives that do run here read a
    // com.apple.* target, so they are refused before the stubs below matter.
    resolveService: vi.fn(async () => ({
      isConnected: () => true,
      listConnectedBundleIds: () => [],
      // No windows, so a read that does reach the tree source fails there
      // rather than degrading to an empty tree.
      queryViewHierarchy: async () => ({ windows: [] }),
      getAppState: async (bundleId: string) => ({
        bundleId,
        applicationState: "active",
        foregroundActiveSceneCount: 1,
        foregroundInactiveSceneCount: 0,
        backgroundSceneCount: 0,
        unattachedSceneCount: 0,
        isFrontmostCandidate: true,
      }),
    })),
  } as unknown as Registry;
}

async function writeFlow(name: string, yaml: Parameters<typeof serializeFlow>[0]): Promise<void> {
  const dir = path.join(tmpDir, ".argent", "flows");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, `${name}.yaml`),
    serializeFlow({ ...yaml, version: 1 }),
    "utf8"
  );
}

function asRun(r: FlowRunResult | { notice: string }): FlowRunResult {
  if (!("steps" in r)) throw new Error(`expected a run result, got notice: ${r.notice}`);
  return r;
}

beforeEach(async () => {
  // realpath'd so the path math below matches the runner's canonical anchors:
  // macOS's tmpdir lives behind the /var → /private/var symlink, which would
  // otherwise skew every equality for reasons unrelated to what a test pins.
  tmpDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "flow-compose-")));
});
afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("flow composition (run:)", () => {
  it("expands a referenced standalone flow inline, launch step and all", async () => {
    await writeFlow("other-e2e", {
      executionPrerequisite: "",
      steps: [
        { kind: "launch", app: "com.acme.app" },
        { kind: "echo", message: "in nested e2e" },
      ],
    });
    await writeFlow("main", {
      executionPrerequisite: "",
      steps: [{ kind: "run", flow: "other-e2e.yaml" }],
    });
    const runFlow = createRunFlowTool(mockRegistry());
    const result = asRun(
      await runFlow.execute({}, { name: "main", project_root: tmpDir, device: DEVICE })
    );
    // run marker, then the nested e2e's launch + echo expanded inline.
    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual([
      "run:pass",
      "launch:pass",
      "echo:pass",
    ]);
    expect(result.steps[1].flow).toBe("other-e2e");
    expect(result.ok).toBe(true);
  });

  it("executes a leading launch step from scratch (restart-app) and reports it", async () => {
    await writeFlow("main", {
      executionPrerequisite: "",
      steps: [
        { kind: "launch", app: "com.acme.app" },
        { kind: "echo", message: "running" },
      ],
    });
    const registry = mockRegistry();
    const result = asRun(
      await createRunFlowTool(registry).execute(
        {},
        { name: "main", project_root: tmpDir, device: DEVICE }
      )
    );

    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["launch:pass", "echo:pass"]);
    // e2e contract: terminate + relaunch, so a running copy can't leak state.
    expect(registry.invokeTool).toHaveBeenCalledWith("restart-app", { bundleId: "com.acme.app" });
    expect(result.ok).toBe(true);
  });

  it("errors the launch step when native devtools never connects on iOS", async () => {
    await writeFlow("main", {
      executionPrerequisite: "",
      steps: [
        { kind: "launch", app: "com.acme.app" },
        { kind: "echo", message: "should never run" },
      ],
    });
    // Registry whose native-devtools service is unavailable: the launch step
    // must fail rather than let selectors silently fall back to the AX tree.
    // (An unresolvable service fails fast; a resolvable-but-never-connected
    // one hits the same guard after the connect timeout.)
    const resolveService = vi.fn(async () => {
      throw new Error("native-devtools unavailable");
    });
    const registry = {
      invokeTool: vi.fn(async (id: string) =>
        id === "list-devices" ? { devices: [] } : { ok: true }
      ),
      getTool: vi.fn(() => undefined),
      resolveService,
    } as unknown as Registry;

    const result = asRun(
      await createRunFlowTool(registry).execute(
        {},
        { name: "main", project_root: tmpDir, device: DEVICE }
      )
    );

    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["launch:error", "echo:skip"]);
    expect(result.steps[0].reason).toMatch(/could not connect to native devtools/i);
    // Every reason names the bundle id, so the prefix must not — doubled, it
    // reads as two separate failures. Asserted here and on the measured and
    // system-app shapes below, since the rule is worth nothing partially held.
    expect(result.steps[0].reason?.match(/com\.acme\.app/g)).toHaveLength(1);
    // Resolution fails for reasons the flow author can act on and cannot
    // otherwise see — a socket already bound, a device of the wrong platform —
    // and the step's reason is the only place any of them surfaces.
    expect(result.steps[0].reason).toContain("native-devtools unavailable");
    expect(result.ok).toBe(false);
    expect(resolveService).toHaveBeenCalled();
  });

  it("waits out the gate for a com.apple.* launch, then withholds the verdict", async () => {
    // The gate ties the launched bundle to the app a later selector step
    // auto-targets, so the wait runs for every bundle (see `treeSourceGate`).
    // Only the verdict is withheld for `com.apple.*`: the first selector read
    // reports the missing hierarchy instead.
    await writeFlow("main", {
      executionPrerequisite: "",
      steps: [
        // The bundle prefix match is case-insensitive.
        { kind: "launch", app: "com.APPLE.Preferences" },
        { kind: "echo", message: "should never run" },
      ],
    });
    const resolveService = vi.fn(async () => ({ isConnected: () => false }));
    const registry = {
      invokeTool: vi.fn(async (id: string) =>
        id === "list-devices" ? { devices: [] } : { ok: true }
      ),
      getTool: vi.fn(() => undefined),
      resolveService,
    } as unknown as Registry;

    const result = asRun(
      await createRunFlowTool(registry).execute(
        {},
        { name: "main", project_root: tmpDir, device: DEVICE }
      )
    );

    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["launch:pass", "echo:pass"]);
    expect(result.ok).toBe(true);
    // The wait ran: a per-bundle skip would never touch the service.
    expect(resolveService).toHaveBeenCalled();
    // The pass is clean: no connection failure for a hierarchy the gate cannot
    // wait for.
    expect(result.steps[0].reason ?? "").not.toMatch(/could not connect to native devtools/i);
    expect(result.steps[0].reason ?? "").not.toMatch(/stale or duplicate argent server/i);
    // The launch spends the post-launch settle plus the full 15s
    // NATIVE_DEVTOOLS_CONNECT_BUDGET_MS, so the 30s budget covers both on a
    // loaded host.
  }, 30000);

  it("runs a coordinate-only flow green against an app that never connects", async () => {
    // A raw `tool: restart-app` step dispatches through the registry, not
    // `runLaunch`, so it never reaches `treeSourceGate`. Point taps and `tool:`
    // steps resolve no selectors.
    await writeFlow("main", {
      executionPrerequisite: "",
      steps: [
        { kind: "tool", name: "restart-app", args: { bundleId: "com.apple.Preferences" } },
        {
          kind: "tool",
          name: "await-ui-element",
          args: { condition: "visible", selector: { text: "General" } },
        },
        { kind: "tap", x: 0.5, y: 0.35 },
      ],
    });
    const resolveService = vi.fn(async () => ({ isConnected: () => false }));
    const registry = {
      invokeTool: vi.fn(async (id: string) =>
        id === "list-devices" ? { devices: [] } : { ok: true }
      ),
      getTool: vi.fn(() => undefined),
      resolveService,
    } as unknown as Registry;

    const result = asRun(
      await createRunFlowTool(registry).execute(
        {},
        { name: "main", project_root: tmpDir, device: DEVICE }
      )
    );

    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual([
      "tool:pass",
      "tool:pass",
      "tap:pass",
    ]);
    expect(result.ok).toBe(true);
    // No step gates on the connection this flow never gets. A gesture without a
    // selector still settles the screen first, so the tap goes out unsettled and
    // warns.
    expect(result.steps[2].warning).toContain("without settling the screen");
  });

  it("passes the gate for a com.apple.* app that does connect", async () => {
    // Argent treats `com.apple.*` as non-injectable, but simulator system apps
    // do connect after a restart-app (measured on iOS 18.3 and 26.5).
    await writeFlow("main", {
      executionPrerequisite: "",
      steps: [
        { kind: "launch", app: "com.apple.Preferences" },
        { kind: "echo", message: "runs once the system app has connected" },
      ],
    });
    const registry = {
      invokeTool: vi.fn(async (id: string) =>
        id === "list-devices" ? { devices: [] } : { ok: true }
      ),
      getTool: vi.fn(() => undefined),
      resolveService: vi.fn(async () => ({ isConnected: () => true })),
    } as unknown as Registry;

    const result = asRun(
      await createRunFlowTool(registry).execute(
        {},
        { name: "main", project_root: tmpDir, device: DEVICE }
      )
    );

    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["launch:pass", "echo:pass"]);
    expect(result.ok).toBe(true);
  });

  // Argent refuses an Apple system app a flow tree, so its hierarchy never
  // becomes readable — which is not a reason to fail the LAUNCH. The step
  // started the app, and a flow that taps by coordinate needs nothing else; the
  // refusal belongs where a selector actually needs the hierarchy.
  it("lets a system-app launch through so a coordinate-driven flow still runs", async () => {
    await writeFlow("main", {
      executionPrerequisite: "",
      steps: [
        { kind: "launch", app: "com.apple.Preferences" },
        { kind: "tool", name: "gesture-tap", args: { x: 0.5, y: 0.35 } },
      ],
    });

    const result = asRun(
      await createRunFlowTool(mockRegistry()).execute(
        {},
        { name: "main", project_root: tmpDir, device: DEVICE }
      )
    );

    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["launch:pass", "tool:pass"]);
    expect(result.ok).toBe(true);
  });

  // A blocked precheck comes back RESOLVED, and returns before the terminate and
  // the launch — so this is a step whose app was never started. The gate's
  // remedies are all written for one that was: read as a launch, `not_running`
  // becomes "it exited after launch", which sends the author after a crash that
  // never happened and drops the message that named the real cause.
  it("fails a launch whose restart-app was blocked before it started anything", async () => {
    await writeFlow("main", {
      executionPrerequisite: "",
      steps: [
        { kind: "launch", app: "com.acme.app" },
        { kind: "tool", name: "gesture-tap", args: { x: 0.5, y: 0.35 } },
      ],
    });
    const registry = {
      invokeTool: vi.fn(async (id: string) => {
        if (id === "list-devices") return { devices: [] };
        if (id === "restart-app") {
          return {
            status: "init_failed",
            attempts: 3,
            message:
              `Native devtools failed to initialize for ${DEVICE} after 3 attempts. ` +
              `Last error: Native devtools dylib not found: /x/libArgentInjectionBootstrap.dylib. ` +
              `Try shutting down and re-booting the simulator, or restart CoreSimulatorService.`,
          };
        }
        return { ok: true };
      }),
      getTool: vi.fn(() => undefined),
      resolveService: vi.fn(async () => ({
        isConnected: () => false,
        listConnectedBundleIds: () => [],
        // What the gate would measure for an app nothing launched.
        appConnectionState: async () => "not_running" as const,
      })),
    } as unknown as Registry;

    const result = asRun(
      await createRunFlowTool(registry).execute(
        {},
        { name: "main", project_root: tmpDir, device: DEVICE }
      )
    );

    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["launch:error", "tool:skip"]);
    expect(result.steps[0].reason).toContain("dylib not found");
    expect(result.steps[0].reason).not.toContain("exited after launch");
  });

  // The connected case above never reaches the gate's verdict. This is the one
  // that matters: a system app that never connects at all. The launch must STILL
  // pass, where every measured state would have failed it — and failed it with a
  // remedy that cannot apply to such an app.
  it("passes a system-app launch that never connects at all", async () => {
    await writeFlow("main", {
      executionPrerequisite: "",
      steps: [
        { kind: "launch", app: "com.apple.Preferences" },
        { kind: "tool", name: "gesture-tap", args: { x: 0.5, y: 0.35 } },
      ],
    });
    const registry = {
      invokeTool: vi.fn(async (id: string) =>
        id === "list-devices" ? { devices: [] } : { ok: true }
      ),
      getTool: vi.fn(() => undefined),
      resolveService: vi.fn(async () => ({
        isConnected: () => false,
        listConnectedBundleIds: () => [],
        // The launchd env carrying the bootstrap dylib is simulator-wide, so a
        // system app's process inherits the injection tokens and scores as a
        // live app the service merely never registered.
        appConnectionState: async () => "unregistered" as const,
      })),
    } as unknown as Registry;

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const pending = createRunFlowTool(registry).execute(
        {},
        { name: "main", project_root: tmpDir, device: DEVICE }
      );
      let settled = false;
      void pending.then(() => (settled = true));
      for (let i = 0; i < PUMP_LIMIT && !settled; i++) {
        await new Promise((resolve) => setImmediate(resolve));
        await vi.advanceTimersByTimeAsync(250);
      }
      const result = asRun(await pending);

      expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual([
        "launch:pass",
        "tool:pass",
      ]);
      expect(result.ok).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  // The verdict is withheld BEFORE the state is measured: that measurement is
  // several uninterruptible simctl round-trips, and no arm consults it for such
  // an app — pure latency on every system-app launch step.
  it("does not measure a state it will not report", async () => {
    await writeFlow("main", {
      executionPrerequisite: "",
      steps: [{ kind: "launch", app: "com.apple.Preferences" }],
    });
    const appConnectionState = vi.fn(async () => "unregistered" as const);
    const registry = {
      invokeTool: vi.fn(async (id: string) =>
        id === "list-devices" ? { devices: [] } : { ok: true }
      ),
      getTool: vi.fn(() => undefined),
      resolveService: vi.fn(async () => ({
        isConnected: () => false,
        listConnectedBundleIds: () => [],
        appConnectionState,
      })),
    } as unknown as Registry;

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const pending = createRunFlowTool(registry).execute(
        {},
        { name: "main", project_root: tmpDir, device: DEVICE }
      );
      let settled = false;
      void pending.then(() => (settled = true));
      for (let i = 0; i < PUMP_LIMIT && !settled; i++) {
        await new Promise((resolve) => setImmediate(resolve));
        await vi.advanceTimersByTimeAsync(250);
      }
      const result = asRun(await pending);

      expect(result.steps[0].status).toBe("pass");
      expect(appConnectionState).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  // The gate consults the service before withholding its verdict, so an
  // unresolvable service was the one remaining way a system-app launch could
  // fail — on a failure irrelevant to an app it was never going to serve.
  it("passes a system-app launch even when native-devtools cannot resolve", async () => {
    await writeFlow("main", {
      executionPrerequisite: "",
      steps: [
        { kind: "launch", app: "com.apple.Preferences" },
        { kind: "tool", name: "gesture-tap", args: { x: 0.5, y: 0.35 } },
      ],
    });
    const registry = {
      invokeTool: vi.fn(async (id: string) =>
        id === "list-devices" ? { devices: [] } : { ok: true }
      ),
      getTool: vi.fn(() => undefined),
      resolveService: vi.fn(async () => {
        throw new Error("listen EADDRINUSE: address already in use /tmp/argent-nd-00000000.sock");
      }),
    } as unknown as Registry;

    const result = asRun(
      await createRunFlowTool(registry).execute(
        {},
        { name: "main", project_root: tmpDir, device: DEVICE }
      )
    );

    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["launch:pass", "tool:pass"]);
    expect(result.ok).toBe(true);
  });

  // The control for the test above: an injectable app in the identical state
  // must still fail, or the pass-through would be excusing every service
  // failure rather than the one it reasons about.
  it("still fails an injectable launch when native-devtools cannot resolve", async () => {
    await writeFlow("main", {
      executionPrerequisite: "",
      steps: [
        { kind: "launch", app: "com.acme.app" },
        { kind: "tool", name: "gesture-tap", args: { x: 0.5, y: 0.35 } },
      ],
    });
    const registry = {
      invokeTool: vi.fn(async (id: string) =>
        id === "list-devices" ? { devices: [] } : { ok: true }
      ),
      getTool: vi.fn(() => undefined),
      resolveService: vi.fn(async () => {
        throw new Error("listen EADDRINUSE: address already in use /tmp/argent-nd-00000000.sock");
      }),
    } as unknown as Registry;

    const result = asRun(
      await createRunFlowTool(registry).execute(
        {},
        { name: "main", project_root: tmpDir, device: DEVICE }
      )
    );

    expect(result.steps[0].status).toBe("error");
    expect(result.steps[0].reason).toMatch(/native-devtools service is unavailable/);
  });

  // The other half of letting the launch through: a SELECTOR step against the
  // same app has to say why it cannot resolve, terminally. Also the only
  // end-to-end proof that the launched bundle id reaches the tree source —
  // without it the author gets the stock "Launch or restart the app first"
  // auto-target text, the restart loop this measurement exists to break.
  it("gives a selector step against a system app the terminal reason, not the auto-target text", async () => {
    await writeFlow("main", {
      executionPrerequisite: "",
      steps: [
        { kind: "launch", app: "com.apple.Preferences" },
        { kind: "assert", selector: { text: "General" }, condition: "visible" },
      ],
    });

    const result = asRun(
      await createRunFlowTool(mockRegistry()).execute(
        {},
        { name: "main", project_root: tmpDir, device: DEVICE }
      )
    );

    expect(result.steps[0].status).toBe("pass");
    const reason = result.steps[1].reason ?? "";
    expect(reason).toMatch(/Apple system app/);
    expect(reason).toMatch(/com\.apple\.Preferences/);
    // The reason must also name the coordinate remedy this launch was let
    // through for.
    expect(reason).toContain("`tap: { x: 0.5, y: 0.35 }` takes a point directly and reads no tree");
    // Not the native-* dead-end warning: none of those tools is a flow step.
    expect(reason).not.toMatch(/native-describe-screen|native-find-views/);
    // The auto-target text is what auto-resolution alone can produce here, and
    // its remedy is the loop.
    expect(reason).not.toMatch(/auto-targeting/);
    expect(reason).not.toMatch(/Launch or restart the app first/);
  });

  // `assert`/`await` read the tree through `waitForCondition`; `tap`, `type`,
  // `scroll-to` and `long-press` reach it through `settleTree`, a separate call
  // site. Pinning only the first left the id droppable at the second — the one
  // every action directive uses — with the suite green.
  it("threads the launched id to the settleTree read an action directive uses", async () => {
    await writeFlow("main", {
      executionPrerequisite: "",
      steps: [
        { kind: "launch", app: "com.apple.Preferences" },
        { kind: "tap", selector: { text: "General" } },
      ],
    });

    const result = asRun(
      await createRunFlowTool(mockRegistry()).execute(
        {},
        { name: "main", project_root: tmpDir, device: DEVICE }
      )
    );

    const reason = result.steps[1].reason ?? "";
    expect(reason).toMatch(/Apple system app/);
    expect(reason).not.toMatch(/Launch or restart the app first/);
  });

  // `launch-app` / `restart-app` are in FOREGROUND_CHANGING_TOOLS, which drops
  // the launched id — but unlike the rest of that set they NAME the app they
  // switched to. Dropping it there sends every read from that step onward back
  // to the auto-target text, in the middle of a run that has a launched app.
  it.each(["restart-app", "launch-app"])(
    "keeps the launched id across a %s tool step that names the same app",
    async (name) => {
      await writeFlow("main", {
        executionPrerequisite: "",
        steps: [
          { kind: "launch", app: "com.apple.Preferences" },
          { kind: "tool", name, args: { bundleId: "com.apple.Preferences" } },
          { kind: "assert", selector: { text: "General" }, condition: "visible" },
        ],
      });

      const result = asRun(
        await createRunFlowTool(mockRegistry()).execute(
          {},
          { name: "main", project_root: tmpDir, device: DEVICE }
        )
      );

      const reason = result.steps[2].reason ?? "";
      // Both reasons say "Apple system app", so that phrase no longer separates
      // the two paths. Only the launched-id diagnosis NAMES the bundle: it is
      // handed the id the tool step preserved. Drop that id and the read falls
      // through to auto-targeting, whose no-connection text names no app.
      expect(reason).toMatch(/com\.apple\.Preferences is an Apple system app/);
      expect(reason).not.toMatch(/no app is connected to native devtools/);
    }
  );

  // The control that keeps the restore scoped: `button` can send the app to the
  // background with nothing naming what replaced it, so there the id really is
  // unknown and auto-targeting is the honest fallback.
  it("still drops the launched id across a foreground-changing tool that names no app", async () => {
    await writeFlow("main", {
      executionPrerequisite: "",
      steps: [
        { kind: "launch", app: "com.apple.Preferences" },
        { kind: "tool", name: "button", args: { name: "home" } },
        { kind: "assert", selector: { text: "General" }, condition: "visible" },
      ],
    });

    const result = asRun(
      await createRunFlowTool(mockRegistry()).execute(
        {},
        { name: "main", project_root: tmpDir, device: DEVICE }
      )
    );

    // A flow selector step cannot name a bundleId, so `resolveNativeTargetApp`'s
    // own "Launch or restart the app first" advice is dropped. The auto-target
    // reason that replaces it names no bundle and reports nothing is connected.
    const reason = result.steps[2].reason ?? "";
    expect(reason).toMatch(/no app is connected to native devtools/);
    expect(reason).not.toMatch(/platform binary with library validation/);
  });

  // The measured half says what is wrong with the app; without this half a flow
  // author is told to restart a tool-server with no mention that a selector
  // needed a hierarchy.
  it("says why the tree was being read, not just what is wrong with the app", async () => {
    // Through the UNPINNED read: the `tool:` step demotes the launch's pin,
    // which is where a launched id that no longer resolves is measured.
    await writeFlow("main", {
      executionPrerequisite: "",
      steps: [
        { kind: "launch", app: "com.acme.app" },
        { kind: "tool", name: "screenshot", args: {} },
        { kind: "assert", selector: { text: "General" }, condition: "visible" },
      ],
    });
    const registry = {
      invokeTool: vi.fn(async (id: string) =>
        id === "list-devices" ? { devices: [] } : { ok: true }
      ),
      getTool: vi.fn(() => undefined),
      resolveService: vi.fn(async () => ({
        isConnected: () => true,
        listConnectedBundleIds: () => [],
        appConnectionState: async () => "unregistered" as const,
      })),
    } as unknown as Registry;

    const result = asRun(
      await createRunFlowTool(registry).execute(
        {},
        { name: "main", project_root: tmpDir, device: DEVICE }
      )
    );

    const reason = result.steps[2].reason ?? "";
    expect(reason).toMatch(/argent server stop && argent server start --detach/);
    expect(reason).toMatch(/E2E tests resolve selectors against the full view hierarchy/);
  });

  // Replacing the whole diagnosis with a literal left every flow test green.
  // `unregistered` is the case that matters — the remedy inverts, and this gate
  // runs right after a launch, so "re-run to relaunch" is the loop one level up.
  it("reports the measured reason when the connection times out", async () => {
    await writeFlow("main", {
      executionPrerequisite: "",
      steps: [{ kind: "launch", app: "com.acme.app" }],
    });
    const registry = {
      invokeTool: vi.fn(async (id: string) =>
        id === "list-devices" ? { devices: [] } : { ok: true }
      ),
      getTool: vi.fn(() => undefined),
      resolveService: vi.fn(async () => ({
        isConnected: () => false,
        listConnectedBundleIds: () => [],
        appConnectionState: async () => "unregistered" as const,
      })),
    } as unknown as Registry;

    // Leave setImmediate real: the run reads the flow off disk between sleeps,
    // and that I/O needs actual event-loop turns. Pumping one between advances
    // elapses the 1.5 s settle and 8 s connect wait in fake time.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const pending = createRunFlowTool(registry).execute(
        {},
        { name: "main", project_root: tmpDir, device: DEVICE }
      );
      let settled = false;
      void pending.then(() => (settled = true));
      for (let i = 0; i < PUMP_LIMIT && !settled; i++) {
        await new Promise((resolve) => setImmediate(resolve));
        await vi.advanceTimersByTimeAsync(250);
      }
      const result = asRun(await pending);

      expect(result.steps[0].status).toBe("error");
      expect(result.steps[0].reason).toContain(
        "argent server stop && argent server start --detach"
      );
      expect(result.steps[0].reason).not.toMatch(/restart-app/);
      expect(result.steps[0].reason?.match(/com\.acme\.app/g)).toHaveLength(1);
      // This gate is the one caller whose wait was bounded: a cold start slower
      // than LAUNCH_TO_VERDICT_MS reads identically to a genuinely unregistered
      // app, so "restarting cannot help" must not be the last word here.
      expect(result.steps[0].reason).toMatch(/cold start/i);
      expect(result.steps[0].reason).toMatch(/re-run the e2e test/i);
      // The figure sizing that judgement is the whole wait the step performed:
      // the poll reads the live map once before its first sleep, so the
      // post-launch settle counts and quoting the poll alone understates it.
      expect(result.steps[0].reason).toContain(`${LAUNCH_TO_VERDICT_MS} ms`);
      expect(result.steps[0].reason).not.toContain(`${NATIVE_READY_TIMEOUT_MS} ms`);
    } finally {
      vi.useRealTimers();
    }
  });

  // `buildAppStateMessage` is written for a reader who has not launched
  // anything, so "call launch-app (or restart-app)" is the missing step there
  // and the step's own action here — emitted verbatim it hands the flow author
  // back the relaunch that just ran, which re-runs into the identical state.
  //
  // Exercised directly rather than through the runner: it is a pure function of
  // (bundleId, state), and each runner pass costs ~9 s of pumped fake time. The
  // end-to-end test above proves the gate reaches it at all.
  describe("flowLaunchGateReason", () => {
    it.each([
      // `not_running` is the sharpest: a relaunch is what produced the state
      // being reported, so the remedy must not be one.
      ["not_running", /exited after launch/i],
      ["stale_process", /re-run the e2e test to launch again/i],
      ["indeterminate", /at most once more/i],
      ["connecting", /started after the step's own launch/i],
      ["unregistered", /cold start/i],
    ] as const)("tells %s something the step has not already done or tried", (state, expected) => {
      expect(flowLaunchGateReason("com.acme.app", state)).toMatch(expected);
    });

    // The one state whose tool-surface remedy IS the launch step's own action.
    // `launch-app` may still appear — the arm suggests starting it by hand to
    // watch it die — but never as the prescribed retry.
    it("does not tell a crash-on-launch app to simply launch itself again", () => {
      const reason = flowLaunchGateReason("com.acme.app", "not_running");

      expect(reason).not.toMatch(/Call launch-app/);
      expect(reason).not.toMatch(/restart-app/);
      // What it must say instead: the process is gone because it exited, and
      // re-running reproduces exactly that.
      expect(reason).toMatch(/exited after launch/);
      expect(reason).toMatch(/Re-running the e2e test repeats the same launch/);
    });

    // The `not.toContain` guards below compare rendered substrings, so they only
    // mean anything while neither figure is a suffix of the other: 500/1500 would
    // make `"1500 ms".includes("500 ms")` true and fail them for the wrong
    // reason. Pin what those guards need, not merely the ordering.
    it("renders a launch-to-verdict spend the connect wait cannot be read into", () => {
      expect(LAUNCH_TO_VERDICT_MS).toBeGreaterThan(NATIVE_READY_TIMEOUT_MS);
      expect(`${LAUNCH_TO_VERDICT_MS} ms`).not.toContain(`${NATIVE_READY_TIMEOUT_MS} ms`);
    });

    // `stale_process` has two producers, and one carries THIS endpoint — it
    // predates the listener, not the launchd environment. Blaming the
    // environment would contradict the measured text this wraps.
    it("does not blame the launchd environment for a stale process", () => {
      const reason = flowLaunchGateReason("com.acme.app", "stale_process");

      expect(reason).toMatch(/predates whatever the relaunch would have given it/);
      // One producer carries THIS endpoint and is merely older than the
      // listener, so the environment is not at fault on a first landing. The
      // message may name it only for a REPEAT, which rules that producer out —
      // so the blame must be conditional AND follow the re-run, both asserted.
      const blame = reason.indexOf("launchd environment");
      const rerun = reason.indexOf("re-run the e2e test");
      expect(rerun).toBeGreaterThanOrEqual(0);
      expect(blame === -1 || blame > rerun).toBe(true);
      // Unconditional on purpose: `if (blame !== -1)` let the whole
      // repeat-landing clause be deleted with the suite green, leaving a reader
      // who lands here twice with "re-run the flow" and no escape. The wording is
      // pinned too — "It lands here twice, so …" states on a FIRST landing what
      // only a second one supports.
      expect(reason).toMatch(/If it lands here twice, the simulator's launchd environment/);
    });

    it.each(["not_running", "connecting", "unregistered"] as const)(
      "quotes the whole launch-to-verdict spend in the %s remedy",
      (state) => {
        const reason = flowLaunchGateReason("com.acme.app", state);

        expect(reason).toContain(`${LAUNCH_TO_VERDICT_MS} ms`);
        expect(reason).not.toContain(`${NATIVE_READY_TIMEOUT_MS} ms`);
      }
    );
  });

  // The connection can land between the final poll and the measurement. Without
  // the `connected` short-circuit, buildAppStateMessage falls off its switch and
  // a healthy run dies with a literal "undefined" as its reason.
  it("passes when the connection lands between the last poll and the measurement", async () => {
    await writeFlow("main", {
      executionPrerequisite: "",
      steps: [{ kind: "launch", app: "com.acme.app" }],
    });
    const registry = {
      invokeTool: vi.fn(async (id: string) =>
        id === "list-devices" ? { devices: [] } : { ok: true }
      ),
      getTool: vi.fn(() => undefined),
      resolveService: vi.fn(async () => ({
        isConnected: () => false, // never connects during the poll…
        listConnectedBundleIds: () => [],
        appConnectionState: async () => "connected" as const, // …but has by the measurement
      })),
    } as unknown as Registry;

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const pending = createRunFlowTool(registry).execute(
        {},
        { name: "main", project_root: tmpDir, device: DEVICE }
      );
      let settled = false;
      void pending.then(() => (settled = true));
      for (let i = 0; i < PUMP_LIMIT && !settled; i++) {
        await new Promise((resolve) => setImmediate(resolve));
        await vi.advanceTimersByTimeAsync(250);
      }
      const result = asRun(await pending);

      expect(result.steps[0].status).toBe("pass");
      expect(result.ok).toBe(true);
      // Without the short-circuit the step errors with a literal "undefined" —
      // buildAppStateMessage has no `connected` arm to fall to.
      expect(result.steps[0].reason ?? "").not.toMatch(/undefined/);
    } finally {
      vi.useRealTimers();
    }
  });

  // A rejected measurement must not propagate: `runLaunch` has no try/catch, so
  // it would escape `execute()` and the run would return no step reports at all
  // instead of a structured failure.
  it("keeps a rejected measurement inside the step report", async () => {
    await writeFlow("main", {
      executionPrerequisite: "",
      steps: [
        { kind: "launch", app: "com.acme.app" },
        { kind: "echo", message: "after" },
      ],
    });
    const registry = {
      invokeTool: vi.fn(async (id: string) =>
        id === "list-devices" ? { devices: [] } : { ok: true }
      ),
      getTool: vi.fn(() => undefined),
      resolveService: vi.fn(async () => ({
        isConnected: () => false,
        listConnectedBundleIds: () => [],
        appConnectionState: async () => {
          throw new Error("Invalid device: UDID");
        },
      })),
    } as unknown as Registry;

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const pending = createRunFlowTool(registry).execute(
        {},
        { name: "main", project_root: tmpDir, device: DEVICE }
      );
      let settled = false;
      void pending.then(() => (settled = true));
      for (let i = 0; i < PUMP_LIMIT && !settled; i++) {
        await new Promise((resolve) => setImmediate(resolve));
        await vi.advanceTimersByTimeAsync(250);
      }
      const result = asRun(await pending);

      expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual([
        "launch:error",
        "echo:skip",
      ]);
      expect(result.steps[0].reason).toContain("could not be inspected");
      expect(result.steps[0].reason).not.toMatch(/Invalid device/);
    } finally {
      vi.useRealTimers();
    }
  });
});
