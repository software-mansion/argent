import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Registry } from "@argent/registry";
import {
  createRunFlowTool,
  flowLaunchGateReason,
  LAUNCH_TO_VERDICT_MS,
  NATIVE_READY_TIMEOUT_MS,
  type FlowRunResult,
} from "../../src/tools/flows/flow-run";
import { serializeFlow, parseFlow } from "../../src/tools/flows/flow-utils";
import { bindDeviceArgs, stripDeviceKeys } from "../../src/tools/flows/flow-device";

// Four tests here drive the launch gate's real 1.5 s settle + 8 s connect wait
// in fake time, pumping a real event-loop turn between advances so the run's
// disk I/O (it re-reads the flow off disk between steps) can settle. Every pump
// is a real macrotask, so the cost is the number of pumps, not the fake
// duration — and under full-suite parallel load ~40 of them per test outran
// vitest's 5 s default, failing tests that are not actually slow.
//
// Widening the advance is NOT the fix: the pumps are what let that I/O run, so
// coarser steps starve it and the run takes longer in real time, not less
// (measured: 1 s steps took the file from 46 s to 52 s and failed more). Give
// the pumping a budget instead, and prefer unit-testing pure message mapping
// over driving the whole runner once per case.
vi.setConfig({ testTimeout: 30_000 });

const DEVICE = "00000000-0000-0000-0000-0000000000ab";
let tmpDir: string;

function mockRegistry(): Registry {
  return {
    invokeTool: vi.fn(async (id: string) => {
      if (id === "list-devices") return { devices: [] };
      return { ok: true };
    }),
    getTool: vi.fn(() => undefined),
    // iOS launch steps gate on a native-devtools connection: report connected
    // so the run proceeds. No selector directives run in these tests, so the
    // flow tree is never fetched.
    resolveService: vi.fn(
      stubNativeDevtools({
        isConnected: () => true,
        listConnectedBundleIds: () => [],
      })
    ),
  } as unknown as Registry;
}

/**
 * One native-devtools stub, resolved repeatedly the way the registry hands back
 * the same per-device service. `noteRelaunchAdvice` / `wasAdvisedToRelaunch`
 * back the record `adviseOnUninjectedApp` reads, so it has to survive across
 * resolutions exactly as the real instance-scoped set does.
 */
function stubNativeDevtools<T extends object>(api: T): () => Promise<T> {
  const advised = new Set<string>();
  const service = {
    ...api,
    noteRelaunchAdvice: (bundleId: string) => {
      advised.add(bundleId);
    },
    wasAdvisedToRelaunch: (bundleId: string) => advised.has(bundleId),
  };
  return async () => service;
}

async function writeFlow(name: string, yaml: Parameters<typeof serializeFlow>[0]): Promise<void> {
  const dir = path.join(tmpDir, ".argent", "flows");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${name}.yaml`), serializeFlow(yaml), "utf8");
}

function asRun(r: FlowRunResult | { notice: string }): FlowRunResult {
  if (!("steps" in r)) throw new Error(`expected a run result, got notice: ${r.notice}`);
  return r;
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-compose-"));
});
afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("flow composition (run:)", () => {
  it("expands a referenced fragment's steps inline", async () => {
    await writeFlow("login", {
      executionPrerequisite: "On login screen",
      steps: [
        { kind: "echo", message: "logging in" },
        { kind: "tool", name: "tap", args: { x: 0.5 } },
      ],
    });
    await writeFlow("main", {
      executionPrerequisite: "",
      steps: [
        { kind: "run", flow: "login" },
        { kind: "echo", message: "done" },
      ],
    });

    const runFlow = createRunFlowTool(mockRegistry());
    const result = asRun(
      await runFlow.execute({}, { name: "main", project_root: tmpDir, device: DEVICE })
    );

    // run marker, login's echo + tap, then main's echo.
    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual([
      "run:pass",
      "echo:pass",
      "tool:pass",
      "echo:pass",
    ]);
    // The expanded steps are attributed to the fragment.
    expect(result.steps[1].flow).toBe("login");
    expect(result.steps[3].flow).toBe("main");
    expect(result.ok).toBe(true);
  });

  it("stamps nesting depth on expanded fragment steps (omitted at top level)", async () => {
    await writeFlow("inner", {
      executionPrerequisite: "",
      steps: [{ kind: "echo", message: "deepest" }],
    });
    await writeFlow("login", {
      executionPrerequisite: "",
      steps: [
        { kind: "tool", name: "tap", args: { x: 0.5 } },
        { kind: "run", flow: "inner" },
      ],
    });
    await writeFlow("main", {
      executionPrerequisite: "",
      steps: [
        { kind: "run", flow: "login" },
        { kind: "echo", message: "done" },
      ],
    });

    const runFlow = createRunFlowTool(mockRegistry());
    const result = asRun(
      await runFlow.execute({}, { name: "main", project_root: tmpDir, device: DEVICE })
    );

    // Each run marker sits at its enclosing depth; the fragment it expands runs
    // one deeper. Top-level steps omit the field entirely, so a flow with no
    // block directives reports byte-identically to the pre-depth shape.
    expect(result.steps.map((s) => `${s.kind}:${s.depth ?? 0}`)).toEqual([
      "run:0",
      "tool:1",
      "run:1",
      "echo:2",
      "echo:0",
    ]);
    expect(result.steps[0].depth).toBeUndefined();
    expect(result.steps[4].depth).toBeUndefined();
  });

  it("expands a referenced e2e flow inline, launch step and all", async () => {
    await writeFlow("other-e2e", {
      executionPrerequisite: "",
      steps: [
        { kind: "launch", app: "com.acme.app" },
        { kind: "echo", message: "in nested e2e" },
      ],
    });
    await writeFlow("main", {
      executionPrerequisite: "",
      steps: [{ kind: "run", flow: "other-e2e" }],
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

  it("detects a cyclic run reference", async () => {
    await writeFlow("a", { executionPrerequisite: "", steps: [{ kind: "run", flow: "b" }] });
    await writeFlow("b", { executionPrerequisite: "", steps: [{ kind: "run", flow: "a" }] });
    await writeFlow("main", {
      executionPrerequisite: "",
      steps: [{ kind: "run", flow: "a" }],
    });
    const runFlow = createRunFlowTool(mockRegistry());
    const result = asRun(
      await runFlow.execute({}, { name: "main", project_root: tmpDir, device: DEVICE })
    );
    const errored = result.steps.find((s) => s.status === "error");
    expect(errored?.reason).toMatch(/cyclic/i);
    // The cycle is detected two fragments down; its error marker keeps that
    // depth (the fail() path stamps depthOf(scope) like the success marker),
    // so the error line renders inside the block that caused it.
    expect(result.steps.map((s) => `${s.kind}:${s.status}:${s.depth ?? 0}`)).toEqual([
      "run:pass:0",
      "run:pass:1",
      "run:error:2",
    ]);
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

  it("errors the launch step when no app id is declared for the platform", async () => {
    await writeFlow("main", {
      executionPrerequisite: "",
      steps: [
        { kind: "launch", app: { android: "com.acme.app" } }, // DEVICE is iOS
        { kind: "echo", message: "should never run" },
      ],
    });
    const result = asRun(
      await createRunFlowTool(mockRegistry()).execute(
        {},
        { name: "main", project_root: tmpDir, device: DEVICE }
      )
    );

    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["launch:error", "echo:skip"]);
    expect(result.steps[0].reason).toMatch(/no app id declared for platform/i);
    expect(result.ok).toBe(false);
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
    const registry = {
      invokeTool: vi.fn(async (id: string) =>
        id === "list-devices" ? { devices: [] } : { ok: true }
      ),
      getTool: vi.fn(() => undefined),
      resolveService: vi.fn(async () => {
        throw new Error("native-devtools unavailable");
      }),
    } as unknown as Registry;

    const result = asRun(
      await createRunFlowTool(registry).execute(
        {},
        { name: "main", project_root: tmpDir, device: DEVICE }
      )
    );

    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["launch:error", "echo:skip"]);
    expect(result.steps[0].reason).toMatch(/could not connect to native devtools/i);
    // Every reason names the bundle id itself, so the prefix must not — doubled,
    // it reads as two separate failures reported back to back. Asserted on this
    // shape and, below, on the measured and system-app ones, because the rule
    // is only worth anything if it holds for all of them.
    expect(result.steps[0].reason?.match(/com\.acme\.app/g)).toHaveLength(1);
    // The cause travels with the reason. Resolution fails for reasons the flow
    // author can act on and cannot otherwise see — a socket already bound, a
    // device of the wrong platform — and the step's reason is the only place
    // any of them surfaces; without it they all read as one opaque failure.
    expect(result.steps[0].reason).toContain("native-devtools unavailable");
    expect(result.ok).toBe(false);
  });

  // An Apple system app may not be able to load the dylib at all (a platform
  // binary with library validation), so its hierarchy may never become
  // readable. That is not a reason to fail the LAUNCH: the step's job is to
  // start the app, it succeeded, and a flow that only ever taps by coordinate
  // needs nothing else. A launch that fails there denies a coordinate-driven
  // flow its first step while telling its author to drive by coordinate. The
  // impossibility belongs where a selector actually needs the hierarchy.
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

  // The case above resolves connected, so the gate never reaches its verdict.
  // This is the one that matters: a system app that never connects at all. The
  // launch must STILL pass — the step started the app, and a coordinate flow
  // needs nothing more — where every measured state would have failed it, and
  // failed it with a remedy (relaunch, or restart the tool-server) that cannot
  // apply to an app whose dylib may never load.
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
      resolveService: vi.fn(
        stubNativeDevtools({
          isConnected: () => false,
          listConnectedBundleIds: () => [],
          // The launchd env carrying the bootstrap dylib is simulator-wide, so a
          // system app's process inherits the injection tokens and scores as a
          // live app the service merely never registered.
          appConnectionState: async () => "unregistered" as const,
        })
      ),
    } as unknown as Registry;

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const pending = createRunFlowTool(registry).execute(
        {},
        { name: "main", project_root: tmpDir, device: DEVICE }
      );
      let settled = false;
      void pending.then(() => (settled = true));
      for (let i = 0; i < 200 && !settled; i++) {
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

  // The verdict is withheld BEFORE the state is measured. That measurement is
  // several simctl round-trips the caller cannot interrupt, and no arm below
  // would consult it for an app whose verdict is withheld either way — so
  // running it would be pure latency on every system-app launch step.
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
      resolveService: vi.fn(
        stubNativeDevtools({
          isConnected: () => false,
          listConnectedBundleIds: () => [],
          appConnectionState,
        })
      ),
    } as unknown as Registry;

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const pending = createRunFlowTool(registry).execute(
        {},
        { name: "main", project_root: tmpDir, device: DEVICE }
      );
      let settled = false;
      void pending.then(() => (settled = true));
      for (let i = 0; i < 200 && !settled; i++) {
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

  // The gate consults the service before it withholds its verdict, so a service
  // that cannot resolve at all was the one remaining way a system-app launch
  // could still fail — on a failure that, by the pass-through's own reasoning,
  // is irrelevant to an app the service was never going to serve.
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
  // same app has to say why it cannot resolve, and say it terminally. This is
  // also the only end-to-end proof that the launched bundle id reaches the tree
  // source — auto-targeting resolves out of the connected list, so with nothing
  // connected it cannot name the app, and the flow author would get the stock
  // "Launch or restart the app first" auto-target text, which is the restart
  // loop this measurement exists to break.
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
    // The auto-target text is what auto-resolution alone can produce here, and
    // its remedy is the loop.
    expect(reason).not.toMatch(/auto-targeting/);
    expect(reason).not.toMatch(/Launch or restart the app first/);
  });

  // `assert`/`await` read the tree through `waitForCondition`; `tap`, `type`,
  // `scroll-to` and `long-press` reach it through `settleTree`, a different
  // call site with its own argument list. Pinning only the first left the id
  // droppable at the second — the one every action directive uses — with the
  // suite green, so the author of a tap would still get the auto-target text.
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

  // The measured half of the message says what is wrong with the app; without
  // this half nothing says what the read was FOR, and a flow author is told to
  // restart a tool-server with no mention that a selector needed a hierarchy.
  it("says why the tree was being read, not just what is wrong with the app", async () => {
    await writeFlow("main", {
      executionPrerequisite: "",
      steps: [
        { kind: "launch", app: "com.acme.app" },
        { kind: "assert", selector: { text: "General" }, condition: "visible" },
      ],
    });
    const registry = {
      invokeTool: vi.fn(async (id: string) =>
        id === "list-devices" ? { devices: [] } : { ok: true }
      ),
      getTool: vi.fn(() => undefined),
      resolveService: vi.fn(
        stubNativeDevtools({
          isConnected: () => true,
          listConnectedBundleIds: () => [],
          appConnectionState: async () => "unregistered" as const,
        })
      ),
    } as unknown as Registry;

    const result = asRun(
      await createRunFlowTool(registry).execute(
        {},
        { name: "main", project_root: tmpDir, device: DEVICE }
      )
    );

    const reason = result.steps[1].reason ?? "";
    expect(reason).toMatch(/argent server stop && argent server start --detach/);
    expect(reason).toMatch(/Flows resolve selectors against the full view hierarchy/);
  });

  // The gate's own measurement had no coverage at all: replacing the whole
  // diagnosis with a literal left every flow test green. `unregistered` is the
  // case that matters — the remedy inverts, and this gate is reached right
  // after a launch, so a guessed "re-run to relaunch" is the loop one level up.
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
      resolveService: vi.fn(
        stubNativeDevtools({
          isConnected: () => false,
          listConnectedBundleIds: () => [],
          appConnectionState: async () => "unregistered" as const,
        })
      ),
    } as unknown as Registry;

    // Leave setImmediate real: the run reads the flow off disk between sleeps,
    // and that I/O needs actual event-loop turns to settle. Pumping a real turn
    // between advances lets the 1.5 s settle and the 8 s connect timeout elapse
    // in fake time without the test spending ten real seconds on them.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const pending = createRunFlowTool(registry).execute(
        {},
        { name: "main", project_root: tmpDir, device: DEVICE }
      );
      let settled = false;
      void pending.then(() => (settled = true));
      for (let i = 0; i < 200 && !settled; i++) {
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
      // This gate is the one caller whose wait was bounded — it launched the app
      // itself and then waited LAUNCH_TO_VERDICT_MS. A cold start slower than
      // that reads identically to a genuinely unregistered app, so the measured
      // "restarting cannot help" must not be the last word here.
      expect(result.steps[0].reason).toMatch(/cold start/i);
      expect(result.steps[0].reason).toMatch(/re-run the flow/i);
      // The figure the author sizes that judgement against has to be the whole
      // wait the step performed: the post-launch settle counts, because the
      // connection is read off the live map and the poll checks it once before
      // its first sleep. Quoting the poll alone understates it by the settle.
      expect(result.steps[0].reason).toContain(`${LAUNCH_TO_VERDICT_MS} ms`);
      expect(result.steps[0].reason).not.toContain(`${NATIVE_READY_TIMEOUT_MS} ms`);
    } finally {
      vi.useRealTimers();
    }
  });

  // `buildAppStateMessage` is written for the native-* tool surface, whose
  // reader has not launched anything — so "call launch-app (or restart-app)" is
  // the missing step there and the step's own action here. Emitted verbatim,
  // every state but `unregistered` handed the flow author back the relaunch the
  // launch step had just performed, which re-runs into the identical state.
  //
  // The mapping is exercised directly rather than by driving the runner once per
  // state: it is a pure function of (bundleId, state), and each runner pass costs
  // ~9 s of pumped fake time. The end-to-end test above proves the gate reaches
  // this function at all; these prove what it says once there.
  describe("flowLaunchGateReason", () => {
    it.each([
      // `not_running` is the sharpest: a relaunch is not merely redundant, it is
      // what produced the state being reported, so the remedy must not be one.
      ["not_running", /exited after launch/i],
      ["stale_process", /re-run the flow to launch again/i],
      ["indeterminate", /at most once more/i],
      ["connecting", /started after the step's own launch/i],
      ["unregistered", /cold start/i],
    ] as const)("tells %s something the step has not already done or tried", (state, expected) => {
      expect(flowLaunchGateReason("com.acme.app", state)).toMatch(expected);
    });

    // The one state whose tool-surface remedy IS the launch step's own action.
    // `launch-app` may still appear — the arm suggests starting it by hand to
    // watch it die — but never as the prescribed retry the measured text gives.
    it("does not tell a crash-on-launch app to simply launch itself again", () => {
      const reason = flowLaunchGateReason("com.acme.app", "not_running");

      expect(reason).not.toMatch(/Call launch-app/);
      expect(reason).not.toMatch(/restart-app/);
      // What it must say instead: the process is gone because it exited, and
      // re-running reproduces exactly that.
      expect(reason).toMatch(/exited after launch/);
      expect(reason).toMatch(/Re-running the flow repeats the same launch/);
    });

    // The `not.toContain` guards below compare rendered substrings, so they are
    // only meaningful while one figure is not a suffix of the other — with
    // 8000/9500 they are distinct, but e.g. 500/1500 would make
    // `"1500 ms".includes("500 ms")` true and fail them for the wrong reason.
    // Pin the property those guards actually need, not merely the ordering.
    it("renders a launch-to-verdict spend the connect wait cannot be read into", () => {
      expect(LAUNCH_TO_VERDICT_MS).toBeGreaterThan(NATIVE_READY_TIMEOUT_MS);
      expect(`${LAUNCH_TO_VERDICT_MS} ms`).not.toContain(`${NATIVE_READY_TIMEOUT_MS} ms`);
    });

    // `stale_process` has two producers, and one of them carries THIS endpoint —
    // it predates the listener, not the launchd environment. Blaming the
    // environment would contradict the measured text this wraps, which names
    // both producers.
    it("does not blame the launchd environment for a stale process", () => {
      const reason = flowLaunchGateReason("com.acme.app", "stale_process");

      expect(reason).toMatch(/predates whatever the relaunch would have given it/);
      // One producer of this state carries THIS endpoint and is merely older
      // than the listener, so the environment is not at fault on a first
      // landing. The message may name it only for a REPEAT, which rules that
      // producer out. Two things make that true and both are asserted: the
      // blame is conditional (not a statement about what was just measured),
      // and it comes after the re-run that establishes the repeat.
      const blame = reason.indexOf("launchd environment");
      const rerun = reason.indexOf("re-run the flow");
      expect(rerun).toBeGreaterThanOrEqual(0);
      expect(blame === -1 || blame > rerun).toBe(true);
      // Unconditional on purpose: guarding this with `if (blame !== -1)` let the
      // whole repeat-landing clause be deleted with the suite green, which
      // leaves a reader who lands here twice with "re-run the flow" and no
      // escape, which is the restart loop in miniature. The wording is pinned too,
      // because "It lands here twice, so …" states on a FIRST landing what only
      // a second one supports.
      expect(reason).toMatch(/If it lands here twice, the simulator's launchd environment/);
    });

    // The figure every arm quotes is the whole spend, not the connect wait —
    // the bug the previous round fixed in `not_running` and left in the two
    // arms nothing asserted it on.
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
  // the healthy run dies with a literal "undefined" as its reason.
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
      resolveService: vi.fn(
        stubNativeDevtools({
          isConnected: () => false, // never connects during the poll…
          listConnectedBundleIds: () => [],
          appConnectionState: async () => "connected" as const, // …but has by the measurement
        })
      ),
    } as unknown as Registry;

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const pending = createRunFlowTool(registry).execute(
        {},
        { name: "main", project_root: tmpDir, device: DEVICE }
      );
      let settled = false;
      void pending.then(() => (settled = true));
      for (let i = 0; i < 200 && !settled; i++) {
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

  // A rejected measurement must not propagate: `runLaunch` has no try/catch of
  // its own, so it would escape `execute()` and the run would return no step
  // reports at all instead of a structured failure.
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
      resolveService: vi.fn(
        stubNativeDevtools({
          isConnected: () => false,
          listConnectedBundleIds: () => [],
          appConnectionState: async () => {
            throw new Error("Invalid device: UDID");
          },
        })
      ),
    } as unknown as Registry;

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const pending = createRunFlowTool(registry).execute(
        {},
        { name: "main", project_root: tmpDir, device: DEVICE }
      );
      let settled = false;
      void pending.then(() => (settled = true));
      for (let i = 0; i < 200 && !settled; i++) {
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

describe("device binding (portability)", () => {
  const reg = (props: Record<string, unknown>) =>
    ({ getTool: () => ({ inputSchema: { properties: props } }) }) as unknown as Registry;

  it("the resolved device wins over a stale stored udid", () => {
    const out = bindDeviceArgs(reg({ udid: {}, x: {}, y: {} }), "gesture-tap", "RESOLVED", {
      udid: "STALE",
      x: 0.5,
      y: 0.5,
    });
    expect(out).toEqual({ udid: "RESOLVED", x: 0.5, y: 0.5 });
  });

  it("drops a device id entirely for a tool that doesn't declare one", () => {
    const out = bindDeviceArgs(reg({ foo: {} }), "x", "R", { device_id: "STALE", foo: 1 });
    expect(out).toEqual({ foo: 1 });
  });

  it("stripDeviceKeys removes udid / device_id", () => {
    expect(stripDeviceKeys({ udid: "A", device_id: "B", x: 1 })).toEqual({ x: 1 });
  });
});

describe("flow validation", () => {
  it("rejects an e2e flow that declares executionPrerequisite", () => {
    expect(() =>
      parseFlow("executionPrerequisite: nope\nsteps:\n  - launch: com.acme.app\n")
    ).toThrow(/must not declare executionPrerequisite/i);
  });

  it("a leading echo does not hide the launch step from the e2e check", () => {
    expect(() =>
      parseFlow(
        "executionPrerequisite: nope\nsteps:\n  - echo: starting\n  - launch: com.acme.app\n"
      )
    ).toThrow(/must not declare executionPrerequisite/i);
  });

  it("rejects a path-unsafe snapshot name (no traversal into baseline path)", () => {
    expect(() => parseFlow("steps:\n  - snapshot:\n      name: ../../etc/evil\n")).toThrow(
      /snapshot name/i
    );
  });

  it("round-trips the new step kinds through YAML", () => {
    const flow = {
      executionPrerequisite: "",
      steps: [
        { kind: "launch" as const, app: "com.acme.app" },
        // Text-only selectors serialize to bare strings, which parse back loose.
        { kind: "tap" as const, selector: { text: "Login", loose: true } },
        { kind: "tap" as const, x: 0.5, y: 0.57 },
        { kind: "type" as const, into: { identifier: "email" }, text: "a@b.com" },
        {
          kind: "assert" as const,
          condition: "visible" as const,
          selector: { text: "Welcome", loose: true },
        },
        { kind: "snapshot" as const, name: "home", maxMismatch: 0.5 },
        { kind: "run" as const, flow: "login" },
        // Mid-flow relaunch with a per-platform map.
        { kind: "launch" as const, app: { ios: "com.acme.app", android: "com.acme.android" } },
      ],
    };
    const parsed = parseFlow(serializeFlow(flow));
    expect(parsed.steps).toEqual(flow.steps);
  });

  it("rejects a launch step with an invalid body", () => {
    // An unrecognized platform key is named (strict unknown-key rejection)…
    expect(() => parseFlow("steps:\n  - launch: { web: foo }\n")).toThrow(
      /launch has unknown key `web`/
    );
    // …while a non-map, non-string body still gets the shape error.
    expect(() => parseFlow("steps:\n  - launch: 42\n")).toThrow(/launch needs an app id/i);
  });
});
