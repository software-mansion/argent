import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FAILURE_CODES,
  Registry,
  ServiceState,
  TypedEventEmitter,
  getFailureSignal,
  type ServiceBlueprint,
  type ServiceEvents,
} from "@argent/registry";
import {
  cacheProfilerPaths,
  clearCachedProfilerPaths,
  clearLostProfilerRun,
  getCachedProfilerPaths,
  getLostProfilerRun,
  reactProfilerSessionBlueprint,
  recordLostProfilerRun,
  type ProfilerSessionPaths,
  type ReactProfilerSessionApi,
} from "../../src/blueprints/react-profiler-session";
import {
  DEFAULT_STALE_THRESHOLD_MS,
  STALE_OWN_RUN_NOTE,
  STOP_IN_PROGRESS_NOTE,
  type ProfilerSessionOwner,
} from "../../src/utils/react-profiler/session-ownership";
import {
  READ_STATE_SCRIPT,
  RESOLVE_FIBER_META_SCRIPT,
  STOP_AND_READ_SCRIPT,
  STOP_FOR_TAKEOVER_SCRIPT,
} from "../../src/utils/react-profiler/scripts";
import { rememberDeviceAlias, resetDeviceAliases } from "../../src/utils/debugger/device-alias";
import { __resetProfilingDevicesForTesting } from "../../src/utils/profiling-devices";
import { createReactProfilerStartTool } from "../../src/tools/profiler/react/react-profiler-start";
import { createReactProfilerStopTool } from "../../src/tools/profiler/react/react-profiler-stop";
import { createReactProfilerStatusTool } from "../../src/tools/profiler/react/react-profiler-status";
import { reactProfilerRendersTool } from "../../src/tools/profiler/react/react-profiler-renders";
import { reactProfilerFiberTreeTool } from "../../src/tools/profiler/react/react-profiler-fiber-tree";
import { profilerLoadTool } from "../../src/tools/profiler/query/profiler-load";

// Stop writes its dumps through these; keep them off the disk.
vi.mock("../../src/utils/react-profiler/debug/dump", () => ({
  getDebugDir: async () => debugDir.path,
  writeDumpCompact: async (dir: string, name: string, payload: DumpPayload) => {
    dumps.written.push({ name, payload });
    if (dumps.hold) await dumps.hold();
    if (dumps.failure) throw dumps.failure;
    return `${dir}/${name}`;
  },
}));
const debugDir = vi.hoisted(() => ({ path: "/tmp/argent-test-debug" }));
type DumpPayload = { commits?: Array<{ componentName: string }> };
const dumps = vi.hoisted(() => ({
  written: [] as Array<{ name: string; payload: DumpPayload }>,
  hold: null as null | (() => Promise<void>),
  failure: null as null | Error,
}));

const PORT = 8081;
const DEVICE = "emulator-5554";
const NOW = 2_000_000_000_000;
const PS_URN = `ReactProfilerSession:${PORT}:${DEVICE}`;

interface AppState {
  isRunning: boolean;
  owner: ProfilerSessionOwner | null;
}

function owner(sessionId: string, heartbeatAgoMs = 1_000): ProfilerSessionOwner {
  return {
    sessionId,
    startedAtEpochMs: NOW - heartbeatAgoMs - 10_000,
    lastHeartbeatEpochMs: NOW - heartbeatAgoMs,
  };
}

/** A session node whose app answers the profiler scripts from `app`. */
function fakeSession(opts: {
  app: AppState;
  sessionId?: string | null;
  profilingActive?: boolean;
  /** What the app's start script returns, when not a clean start. */
  startResult?: Record<string, unknown>;
  /** Makes the app's start script fail: a timeout on a busy JS thread, or no value. */
  startScript?: "rejects" | "returns nothing";
  /** Makes `Profiler.start` reject, as a dropped connection does. */
  profilerStartRejects?: boolean;
  /** Makes `Profiler.stop` reject, as a slow serialization past its timeout does. */
  profilerStopRejects?: boolean;
}) {
  const evaluated: string[] = [];
  const sent: string[] = [];
  const app = opts.app;
  const api = {
    port: PORT,
    deviceId: DEVICE,
    hermesVersion: "0.14.0",
    detectedArchitecture: "bridgeless",
    profilingActive: opts.profilingActive ?? false,
    sessionId: opts.sessionId ?? null,
    ownerToolServerPid: null,
    profileStartWallMs: null,
    sessionPaths: null,
    disposed: false,
    projectRoot: "/tmp/app",
    appName: "App",
    deviceName: "Pixel",
    disposeSession: vi.fn(),
    cdp: {
      isConnected: () => true,
      send: async (method: string, params?: { expression?: string }) => {
        sent.push(
          method === "Runtime.evaluate" ? `Runtime.evaluate:${params?.expression}` : method
        );
        if (method === "Profiler.start" && opts.profilerStartRejects) {
          throw new Error("CDP connection closed");
        }
        if (method === "Profiler.stop") {
          if (opts.profilerStopRejects) throw new Error("CDP request Profiler.stop timed out");
          return {
            profile: { nodes: [], samples: [], timeDeltas: [], startTime: 0, endTime: 1e6 },
          };
        }
        if (method === "Runtime.evaluate" && params?.expression === STOP_AND_READ_SCRIPT) {
          return {
            result: { value: JSON.stringify({ live: { dataForRoots: [] }, displayNameById: {} }) },
          };
        }
        return {};
      },
      evaluate: async (expression: string) => {
        evaluated.push(expression);
        if (expression.includes("__argent_readState")) {
          return JSON.stringify({
            hookExists: true,
            rendererInterfaceFound: true,
            isRunning: app.isRunning,
            owner: app.owner,
            nowEpochMs: NOW,
          });
        }
        if (expression.includes("__argent_doStart")) {
          if (opts.startScript === "rejects") {
            throw new Error("CDP request Runtime.evaluate timed out after 10000ms");
          }
          if (opts.startScript === "returns nothing") return undefined;
          return JSON.stringify(
            opts.startResult ?? {
              ok: true,
              startedAtEpochMs: NOW,
              isProfilingFlagSet: true,
              ownerInstalled: true,
            }
          );
        }
        return undefined;
      },
    },
  } as unknown as ReactProfilerSessionApi;
  const registry = {
    getSnapshot: () => ({ services: new Map([[PS_URN, { state: ServiceState.RUNNING }]]) }),
    resolveService: async () => api,
  } as unknown as Registry;
  return { api, registry, evaluated, sent };
}

function start(registry: Registry, force = false) {
  return createReactProfilerStartTool(registry).execute(
    {},
    { device_id: DEVICE, port: PORT, sample_interval_us: 100, force }
  );
}

function stop(registry: Registry) {
  return createReactProfilerStopTool(registry).execute!({}, { device_id: DEVICE, port: PORT });
}

function status(registry: Registry) {
  return createReactProfilerStatusTool(registry).execute({}, { device_id: DEVICE, port: PORT });
}

function savedPaths(sessionId: string): ProfilerSessionPaths {
  return {
    sessionId,
    debugDir: "/tmp/argent-test-debug",
    cpuProfilePath: null,
    commitsPath: `/tmp/argent-test-debug/react-profiler-${sessionId}_commits.json`,
    cpuSampleIndexPath: null,
    detectedArchitecture: "bridgeless",
    anyCompilerOptimized: false,
    hotCommitIndices: [],
    totalReactCommits: 0,
  };
}

afterEach(() => {
  clearCachedProfilerPaths(PORT, DEVICE);
  clearLostProfilerRun(PORT, DEVICE);
  __resetProfilingDevicesForTesting();
});

describe("react-profiler-start with a session already running", () => {
  it("says the run is this tool-server's own, and leaves it recording", async () => {
    // It used to answer "another session is active, ask the user" for the
    // caller's own run.
    const { registry, evaluated, sent } = fakeSession({
      app: { isRunning: true, owner: owner("uuid-mine") },
      sessionId: "uuid-mine",
      profilingActive: true,
    });

    const res = await start(registry);

    expect(res).toMatchObject({
      already_running: true,
      mine: true,
      stale: false,
      heartbeat_age_seconds: 1,
    });
    expect(res.note).toContain("react-profiler-stop");
    expect(res.note).not.toBe(STALE_OWN_RUN_NOTE);
    expect(res).not.toHaveProperty("how_to_reclaim");
    expect(evaluated).not.toContain(STOP_FOR_TAKEOVER_SCRIPT);
    expect(sent).not.toContain("Profiler.start");
  });

  it("keeps the own run even when its heartbeat is stale, and warns it may not be the caller's", async () => {
    // A stale heartbeat let any start take the run over silently, the
    // caller's own included, discarding its data. `mine` only means this
    // tool-server, which another agent or an earlier conversation can share.
    const { registry, evaluated } = fakeSession({
      app: { isRunning: true, owner: owner("uuid-mine", DEFAULT_STALE_THRESHOLD_MS + 60_000) },
      sessionId: "uuid-mine",
      profilingActive: true,
    });

    const res = await start(registry);

    expect(res).toMatchObject({
      already_running: true,
      mine: true,
      stale: true,
      heartbeat_age_seconds: 360,
      note: STALE_OWN_RUN_NOTE,
    });
    expect(evaluated).not.toContain(STOP_FOR_TAKEOVER_SCRIPT);
  });

  it("replaces the own run with force, and says so", async () => {
    const { registry, evaluated } = fakeSession({
      app: { isRunning: true, owner: owner("uuid-mine") },
      sessionId: "uuid-mine",
      profilingActive: true,
    });

    const res = await start(registry, true);

    expect(evaluated).toContain(STOP_FOR_TAKEOVER_SCRIPT);
    expect(res.started_at).toBeDefined();
    expect(res.took_over).toMatchObject({ session_id: "uuid-mine", reason: "forced" });
  });

  it("refuses another session's fresh run, marked as not the caller's", async () => {
    const { registry, evaluated } = fakeSession({
      app: { isRunning: true, owner: owner("uuid-other") },
    });

    const res = await start(registry);

    expect(res).toMatchObject({ already_running: true, mine: false, stale: false });
    expect(res.how_to_reclaim).toContain("force: true");
    expect(evaluated).not.toContain(STOP_FOR_TAKEOVER_SCRIPT);
  });

  it("reports a takeover of a stale run, which needs no force", async () => {
    const { registry, evaluated } = fakeSession({
      app: { isRunning: true, owner: owner("uuid-other", DEFAULT_STALE_THRESHOLD_MS + 60_000) },
    });

    const res = await start(registry);

    expect(evaluated).toContain(STOP_FOR_TAKEOVER_SCRIPT);
    expect(res.started_at).toBeDefined();
    expect(res.took_over).toMatchObject({
      session_id: "uuid-other",
      reason: "stale",
      heartbeat_age_seconds: 360,
    });
    expect((res.took_over as { note: string }).note).toContain("without force");
  });

  it("reports a forced takeover of another session's fresh run", async () => {
    const { registry } = fakeSession({ app: { isRunning: true, owner: owner("uuid-other") } });

    const res = await start(registry, true);

    expect(res.took_over).toMatchObject({ session_id: "uuid-other", reason: "forced" });
  });

  it("reports stopping a run with no owner record", async () => {
    const { registry } = fakeSession({ app: { isRunning: true, owner: null } });

    const res = await start(registry);

    expect(res.took_over).toMatchObject({ session_id: null, reason: "unattributed" });
  });

  it("stops a lost run of its own that the app kept recording, without force", async () => {
    // A teardown that could not reach the app leaves the run recording; the
    // session node that knew it is gone, and only the lost-run record names it.
    recordLostProfilerRun(
      { port: PORT, deviceId: DEVICE, sessionId: "uuid-orphan", profileStartWallMs: NOW - 60_000 },
      "session_torn_down"
    );
    const { registry, evaluated } = fakeSession({
      app: { isRunning: true, owner: owner("uuid-orphan") },
    });

    const res = await start(registry);

    expect(evaluated).toContain(STOP_FOR_TAKEOVER_SCRIPT);
    expect(res.took_over).toMatchObject({ session_id: "uuid-orphan", reason: "own_unsaved" });
    // The new run supersedes the record.
    expect(getLostProfilerRun(PORT, DEVICE)).toBeUndefined();
  });

  it("still treats a lost run as its own after a session is loaded from disk", async () => {
    recordLostProfilerRun(
      { port: PORT, deviceId: DEVICE, sessionId: "uuid-orphan", profileStartWallMs: NOW - 60_000 },
      "cdp_disconnected"
    );
    cacheProfilerPaths(PORT, { ...savedPaths("20261001-090000"), loadedFromDisk: true }, DEVICE);
    const { registry } = fakeSession({ app: { isRunning: true, owner: owner("uuid-orphan") } });

    const res = await start(registry);

    expect(res.took_over).toMatchObject({ session_id: "uuid-orphan", reason: "own_unsaved" });
  });

  it("does not report a takeover when nothing was running", async () => {
    const { registry } = fakeSession({ app: { isRunning: false, owner: null } });

    const res = await start(registry, true);

    expect(res.started_at).toBeDefined();
    expect(res).not.toHaveProperty("took_over");
  });
});

describe("react-profiler-start and the Hermes sampler", () => {
  // Hermes ignores `Profiler.start` while its sampler runs and clears samples
  // only on `Profiler.stop`, so a replaced run left sampling leaks into the new
  // run's profile. None of these session nodes but the forced own run's started
  // the sampler, so `profilingActive` cannot be what decides the stop.
  const STALE_MS = DEFAULT_STALE_THRESHOLD_MS + 60_000;
  const lostRun = () =>
    recordLostProfilerRun(
      { port: PORT, deviceId: DEVICE, sessionId: "uuid-lost", profileStartWallMs: NOW - 60_000 },
      "cdp_disconnected"
    );
  const replacements: Array<{
    run: string;
    reason: string;
    session: Parameters<typeof fakeSession>[0];
    force?: boolean;
    arrange?: () => void;
  }> = [
    {
      run: "a lost run of this tool-server",
      reason: "own_unsaved",
      session: { app: { isRunning: true, owner: owner("uuid-lost") } },
      arrange: lostRun,
    },
    {
      run: "this session's own run",
      reason: "forced",
      session: {
        app: { isRunning: true, owner: owner("uuid-mine") },
        sessionId: "uuid-mine",
        profilingActive: true,
      },
      force: true,
    },
    {
      run: "another session's fresh run",
      reason: "forced",
      session: { app: { isRunning: true, owner: owner("uuid-other") } },
      force: true,
    },
    {
      run: "another session's stale run",
      reason: "stale",
      session: { app: { isRunning: true, owner: owner("uuid-other", STALE_MS) } },
    },
    {
      run: "a run with no owner record",
      reason: "unattributed",
      session: { app: { isRunning: true, owner: null } },
    },
  ];

  it.each(replacements)(
    "stops the sampler before starting it again when replacing $run ($reason)",
    async ({ reason, session, force, arrange }) => {
      arrange?.();
      const { registry, sent } = fakeSession(session);

      const res = await start(registry, force);

      expect(res.took_over).toMatchObject({ reason });
      const stopAt = sent.indexOf("Profiler.stop");
      expect(stopAt).toBeGreaterThanOrEqual(0);
      expect(stopAt).toBeLessThan(sent.indexOf("Profiler.start"));
    }
  );

  it("still starts when stopping the replaced run's sampler fails", async () => {
    lostRun();
    const { registry, sent } = fakeSession({
      app: { isRunning: true, owner: owner("uuid-lost") },
      profilerStopRejects: true,
    });

    const res = await start(registry);

    expect(sent).toContain("Profiler.stop");
    expect(sent).toContain("Profiler.start");
    expect(res.started_at).toBeDefined();
    expect(res.took_over).toMatchObject({ session_id: "uuid-lost", reason: "own_unsaved" });
  });

  // A run whose connection dropped keeps its sampler through a JS reload, while
  // the reloaded app reports no recording: nothing tells the start it is on.
  it.each([false, true])(
    "stops the sampler first when the app reports no recording (force: %s)",
    async (force) => {
      const { registry, sent } = fakeSession({ app: { isRunning: false, owner: null } });

      const res = await start(registry, force);

      expect(res.started_at).toBeDefined();
      expect(res).not.toHaveProperty("took_over");
      const stopAt = sent.indexOf("Profiler.stop");
      expect(stopAt).toBeGreaterThanOrEqual(0);
      expect(stopAt).toBeLessThan(sent.indexOf("Profiler.start"));
    }
  );

  it.each([
    ["reports a failure", { ok: false, reason: "no-renderers" }],
    ["fails verification", { ok: true, isProfilingFlagSet: false, ownerInstalled: true }],
  ])(
    "rolls the sampler back, and tracks no run, when the app's start script %s",
    async (_what, startResult) => {
      const { api, registry, sent } = fakeSession({
        app: { isRunning: true, owner: owner("uuid-mine") },
        sessionId: "uuid-mine",
        profilingActive: true,
        startResult,
      });

      await expect(start(registry, true)).rejects.toThrow("nothing is recording now");

      expect(sent.lastIndexOf("Profiler.stop")).toBeGreaterThan(sent.indexOf("Profiler.start"));
      // The replaced run's sampler is stopped: a stop must not try to collect it.
      expect(api.profilingActive).toBe(false);
    }
  );

  it.each(["rejects", "returns nothing"] as const)(
    "rolls the sampler back when the app's start script %s",
    async (startScript) => {
      lostRun();
      const { registry, sent } = fakeSession({
        app: { isRunning: true, owner: owner("uuid-lost") },
        startScript,
      });

      const err = await start(registry).catch((e: unknown) => e);

      expect((err as Error).message).toContain("nothing is recording now");
      expect(sent.lastIndexOf("Profiler.stop")).toBeGreaterThan(sent.indexOf("Profiler.start"));
    }
  );
});

describe("profiler-load", () => {
  it("does not pass a session from disk off as a run, or hide a lost one", async () => {
    debugDir.path = await fs.mkdtemp(join(tmpdir(), "argent-profiler-load-"));
    const sessionId = "20261001-090000";
    await fs.writeFile(
      join(debugDir.path, `react-profiler-${sessionId}_cpu.json`),
      JSON.stringify({ samples: [1] })
    );
    const load = () =>
      profilerLoadTool.execute!({}, {
        mode: "load_react",
        session_id: sessionId,
        port: PORT,
        device_id: DEVICE,
      } as never);
    const { registry } = fakeSession({ app: { isRunning: false, owner: null } });

    try {
      await load();
      expect(getCachedProfilerPaths(PORT, DEVICE)?.loadedFromDisk).toBe(true);
      expect((await status(registry)).note).toContain("loaded from disk");

      recordLostProfilerRun(
        { port: PORT, deviceId: DEVICE, sessionId: "uuid-mine", profileStartWallMs: NOW },
        "js_reload"
      );
      await load();
      expect(await status(registry)).toMatchObject({
        session_status: "lost",
        lost_run: { session_id: "uuid-mine" },
      });
    } finally {
      await fs.rm(debugDir.path, { recursive: true, force: true });
      debugDir.path = "/tmp/argent-test-debug";
    }
  });
});

describe("react-profiler-start that fails after replacing a run", () => {
  const stale = () => owner("uuid-other", DEFAULT_STALE_THRESHOLD_MS + 60_000);

  it("names the run it stopped when the app refuses the start", async () => {
    const { registry, evaluated } = fakeSession({
      app: { isRunning: true, owner: stale() },
      startResult: { ok: false, reason: "startProfiling-threw", message: "boom" },
    });

    const err = await start(registry).catch((e: unknown) => e);

    expect(evaluated).toContain(STOP_FOR_TAKEOVER_SCRIPT);
    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.REACT_PROFILER_START_FAILED);
    expect((err as Error).message).toContain("startProfiling-threw: boom");
    expect((err as Error).message).toContain("stopped session uuid-other (reason: stale)");
  });

  it("names it when post-start verification fails", async () => {
    const { registry } = fakeSession({
      app: { isRunning: true, owner: stale() },
      startResult: { ok: true, isProfilingFlagSet: false, ownerInstalled: true },
    });

    const err = await start(registry).catch((e: unknown) => e);

    expect(getFailureSignal(err)?.error_code).toBe(
      FAILURE_CODES.REACT_PROFILER_START_VERIFY_FAILED
    );
    expect((err as Error).message).toContain("stopped session uuid-other");
  });

  it("names it when the connection drops during the start", async () => {
    const { registry } = fakeSession({
      app: { isRunning: true, owner: stale() },
      profilerStartRejects: true,
    });

    const err = await start(registry).catch((e: unknown) => e);

    expect((err as Error).message).toContain("CDP connection closed");
    expect((err as Error).message).toContain("stopped session uuid-other");
  });

  it("names a recording with no owner record", async () => {
    const { registry } = fakeSession({
      app: { isRunning: true, owner: null },
      startResult: { ok: false, reason: "no-renderers" },
    });

    const err = await start(registry).catch((e: unknown) => e);

    expect((err as Error).message).toContain("a recording with no owner record");
  });

  it("adds nothing when it replaced no run", async () => {
    const { registry } = fakeSession({
      app: { isRunning: false, owner: null },
      startResult: { ok: false, reason: "no-renderers" },
    });

    const err = await start(registry).catch((e: unknown) => e);

    expect((err as Error).message).toBe("React profiler failed to start (no-renderers)");
  });
});

describe("react-profiler-stop after another session took the run over", () => {
  it("fails with the takeover, and leaves the other recording and the sampler alone", async () => {
    const { api, registry, sent } = fakeSession({
      app: { isRunning: true, owner: owner("uuid-other") },
      sessionId: "uuid-mine",
      profilingActive: true,
    });

    const err = await stop(registry).catch((e: unknown) => e);

    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.REACT_PROFILER_SESSION_TAKEN_OVER);
    expect((err as Error).message).toContain("session uuid-other");
    // Stopping would have ended their recording and read their data as ours.
    expect(sent).not.toContain("Profiler.stop");
    expect(sent).not.toContain(`Runtime.evaluate:${STOP_AND_READ_SCRIPT}`);
    expect(api.profilingActive).toBe(false);
    expect(getLostProfilerRun(PORT, DEVICE)).toMatchObject({
      cause: "taken_over",
      sessionId: "uuid-mine",
      takenOverBy: "uuid-other",
    });
  });

  it("treats an ownerless recording as a takeover, and stops the sampler nobody owns", async () => {
    // A DevTools client outside argent restarts renderer profiling but never
    // sends Hermes `Profiler.stop`, so nothing else would end this run's sampler.
    const { registry, sent } = fakeSession({
      app: { isRunning: true, owner: null },
      sessionId: "uuid-mine",
      profilingActive: true,
    });

    const err = await stop(registry).catch((e: unknown) => e);

    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.REACT_PROFILER_SESSION_TAKEN_OVER);
    expect(sent).toContain("Profiler.stop");
    expect(sent).not.toContain(`Runtime.evaluate:${STOP_AND_READ_SCRIPT}`);
  });

  it("leaves status naming the takeover while the other session records", async () => {
    const { registry } = fakeSession({
      app: { isRunning: true, owner: owner("uuid-other") },
      sessionId: "uuid-mine",
      profilingActive: true,
    });
    await stop(registry).catch(() => undefined);

    const res = await status(registry);

    expect(res.session_status).toBe("taken_over");
    expect(res.note).toContain("Your run (session uuid-mine) was taken over by session uuid-other");
  });

  it("leaves status naming the takeover after the other session stopped", async () => {
    const app: AppState = { isRunning: true, owner: owner("uuid-other") };
    const { registry } = fakeSession({ app, sessionId: "uuid-mine", profilingActive: true });
    await stop(registry).catch(() => undefined);

    app.isRunning = false;
    app.owner = null;
    const res = await status(registry);

    expect(res.session_status).toBe("taken_over");
    expect(res.lost_run).toMatchObject({ cause: "taken_over", session_id: "uuid-mine" });
    expect(res.note).toContain("That session has since stopped too");
  });

  it("stops and saves its own run as before", async () => {
    recordLostProfilerRun(
      { port: PORT, deviceId: DEVICE, sessionId: "uuid-earlier", profileStartWallMs: NOW - 60_000 },
      "js_reload"
    );
    const { api, registry, sent } = fakeSession({
      app: { isRunning: true, owner: owner("uuid-mine") },
      sessionId: "uuid-mine",
      profilingActive: true,
    });

    const res = await stop(registry);

    expect(res.duration_ms).toBe(1000);
    expect(sent).toContain("Profiler.stop");
    expect(getCachedProfilerPaths(PORT, DEVICE)).toBeDefined();
    expect(api.sessionId).toBeNull();
    expect(getLostProfilerRun(PORT, DEVICE)).toBeUndefined();
  });
});

describe("react-profiler-stop with no run to stop", () => {
  it("names the saved session when the run was already stopped", async () => {
    // Status re-creates the session node after a stop, so a second stop finds
    // a node with no run rather than no node.
    cacheProfilerPaths(PORT, savedPaths("20261103-120000"), DEVICE);
    const { registry } = fakeSession({ app: { isRunning: false, owner: null } });

    const err = await stop(registry).catch((e: unknown) => e);

    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.REACT_PROFILER_NO_ACTIVE_SESSION);
    expect((err as Error).message).toContain("saved as session 20261103-120000");
    expect((err as Error).message).toContain("react-profiler-analyze");
  });

  it("names the loss, not a session loaded after it", async () => {
    recordLostProfilerRun(
      { port: PORT, deviceId: DEVICE, sessionId: "uuid-mine", profileStartWallMs: NOW },
      "js_reload"
    );
    cacheProfilerPaths(PORT, { ...savedPaths("20261001-090000"), loadedFromDisk: true }, DEVICE);
    const { registry } = fakeSession({ app: { isRunning: false, owner: null } });

    const err = await stop(registry).catch((e: unknown) => e);

    expect((err as Error).message).toContain("session uuid-mine");
    expect((err as Error).message).not.toContain("saved as session");
  });

  it("names what ended a lost run when the session node is gone", async () => {
    recordLostProfilerRun(
      { port: PORT, deviceId: DEVICE, sessionId: "uuid-mine", profileStartWallMs: NOW },
      "js_reload"
    );
    const registry = {
      getSnapshot: () => ({ services: new Map() }),
      resolveService: async () => {
        throw new Error("must not resolve");
      },
    } as unknown as Registry;

    const err = await stop(registry).catch((e: unknown) => e);

    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.REACT_PROFILER_NO_ACTIVE_SESSION);
    expect((err as Error).message).toContain("session uuid-mine");
    expect((err as Error).message).toContain("JS reload");
  });
});

/**
 * The tests below run the real registry, session blueprint, tools and injected
 * scripts. Only the transport is fake: `makeApp` is a JS runtime with a renderer
 * that keeps react-devtools-core's buffer contract, `startProfiling` replaces the
 * buffer and `stopProfiling` keeps it, and `toolServer` is one tool-server on it.
 */
const T0 = 2_000_000_000_000;
const MINUTE = 60_000;
const OTHER_PORT = 8082;
const LOGICAL_ID = "logical-xyz";

function newRuntime(nowEpochMs: number, renderers: number, tickMs: number) {
  const ctx = vm.createContext({ console });
  vm.runInContext(
    `
    var __now = ${nowEpochMs};
    Date.now = function () { __now += ${tickMs}; return __now; };
    globalThis.__advance = function (ms) { __now += ms; };
    globalThis.HermesInternal = {
      getRuntimeProperties: function () { return { 'OSS Release Version': '0.14.0' }; },
    };
    function makeRenderer() {
      return {
        on: false, commits: null, names: {},
        flushInitialOperations: function () {},
        startProfiling: function () { this.commits = []; this.on = true; },
        stopProfiling: function () { this.on = false; },
        getProfilingData: function () {
          if (this.commits === null) throw new Error('no profiling data yet');
          return { dataForRoots: [{ rootID: 1, commitData: this.commits }] };
        },
        getDisplayNameForElementID: function (id) { return this.names[id] || null; },
      };
    }
    var map = new Map();
    for (var i = 1; i <= ${renderers}; i++) map.set(i, makeRenderer());
    globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__ = { rendererInterfaces: map, renderers: new Map() };
    globalThis.__ri = map.get(1);
    globalThis.__commit = function (name) {
      var ri = globalThis.__ri;
      if (!ri.on) return;
      var id = Object.keys(ri.names).length + 1;
      ri.names[id] = name;
      ri.commits.push({ duration: 20, timestamp: Date.now(),
        fiberActualDurations: [[id, 20]], fiberSelfDurations: [[id, 20]], changeDescriptions: [] });
    };
  `,
    ctx
  );
  return ctx;
}

/** One app. With `tickMs`, renderers start at different times, as on a device. */
function makeApp({ renderers = 1, tickMs = 0 } = {}) {
  let ctx = newRuntime(T0, renderers, tickMs);
  const app = {
    /** Hermes' sampler is process-wide: it outlives a JS reload. */
    sampling: false,
    run: (js: string): unknown => vm.runInContext(js, ctx),
    now: () => vm.runInContext("Date.now()", ctx) as number,
    advance: (ms: number) => app.run(`__advance(${ms})`),
    commit: (name: string) => app.run(`__commit(${JSON.stringify(name)})`),
    owner: () =>
      JSON.parse(
        app.run("JSON.stringify(globalThis.__ARGENT_PROFILER_OWNER__ || null)") as string
      ) as ProfilerSessionOwner | null,
    recording: () => app.run("__ri.__argent_isProfiling__ === true") as boolean,
    reloadRuntime: () => {
      ctx = newRuntime(app.now(), renderers, tickMs);
    },
  };
  return app;
}
type App = ReturnType<typeof makeApp>;

interface Rig {
  sent: Array<{ method: string; expression?: string; timeout?: number }>;
  evaluated: string[];
  connected: boolean;
  events: TypedEventEmitter<Record<string, (...args: unknown[]) => void>>;
  /** Runs before a call reaches the app. Its result, if any, is the call's reply. */
  intercept?: (method: string, expression?: string) => unknown;
}

function fakeCdp(app: App, rig: Rig) {
  rig.events = new TypedEventEmitter();
  rig.connected = true;
  const reachApp = async (method: string, expression?: string) => {
    if (!rig.connected) throw new Error("CDP not connected");
    return rig.intercept?.(method, expression);
  };
  return {
    events: rig.events,
    isConnected: () => rig.connected,
    disconnect: async () => {},
    evaluate: async (expression: string) => {
      rig.evaluated.push(expression);
      return (await reachApp("Runtime.evaluate", expression)) ?? app.run(expression);
    },
    send: async (
      method: string,
      params?: { expression?: string },
      timeout?: number
    ): Promise<unknown> => {
      rig.sent.push({ method, expression: params?.expression, timeout });
      const reply = await reachApp(method, params?.expression);
      if (reply !== undefined) return reply;
      if (method === "Runtime.evaluate") return { result: { value: app.run(params!.expression!) } };
      if (method === "Profiler.start") app.sampling = true;
      if (method === "Profiler.stop") {
        app.sampling = false;
        return {
          profile: {
            nodes: [{ id: 1 }],
            samples: [1],
            timeDeltas: [1],
            startTime: 0,
            endTime: 1e6,
          },
        };
      }
      return {};
    },
  };
}

function toolServer(app: App, port: number) {
  const rig: Rig = { sent: [], evaluated: [], connected: false, events: new TypedEventEmitter() };
  const registry = new Registry();
  registry.registerBlueprint({
    namespace: "JsRuntimeDebugger",
    getURN: (payload: string) => `JsRuntimeDebugger:${payload}`,
    async factory() {
      const cdp = fakeCdp(app, rig);
      const events = new TypedEventEmitter<ServiceEvents>();
      // As js-runtime-debugger.ts: it hears a drop before any dependent does.
      cdp.events.on("disconnected", () => events.emit("terminated", new Error("CDP disconnected")));
      const api = { port, projectRoot: "/tmp/app", appName: "App", deviceName: "Pixel", cdp };
      return { api, dispose: async () => {}, events };
    },
  } as unknown as ServiceBlueprint<unknown, string>);
  registry.registerBlueprint(reactProfilerSessionBlueprint);

  const params = { device_id: DEVICE, port };
  const psUrn = `ReactProfilerSession:${port}:${DEVICE}`;
  // As the dispatcher: `services()` names the session the tool runs on.
  const sessionOf = (ref: unknown) =>
    registry.resolveService<ReactProfilerSessionApi>(ref as string);
  return {
    registry,
    rig,
    psUrn,
    port,
    api: () => registry.resolveService<ReactProfilerSessionApi>(psUrn),
    start: (force = false) =>
      createReactProfilerStartTool(registry).execute(
        {},
        { ...params, sample_interval_us: 100, force }
      ),
    stop: () => createReactProfilerStopTool(registry).execute!({}, params),
    status: () => createReactProfilerStatusTool(registry).execute({}, params),
    renders: async (deviceId = DEVICE) => {
      const toolParams = { port, device_id: deviceId, top_n: 5 };
      const { profilerSession } = reactProfilerRendersTool.services!(toolParams);
      const services = { profilerSession: await sessionOf(profilerSession) };
      return reactProfilerRendersTool.execute(services, toolParams);
    },
    fiberTree: async (deviceId = DEVICE) => {
      const toolParams = { port, device_id: deviceId, max_depth: 3 };
      const { profilerSession } = reactProfilerFiberTreeTool.services!(toolParams);
      const services = { profilerSession: await sessionOf(profilerSession) };
      return reactProfilerFiberTreeTool.execute(services, toolParams);
    },
    /** A JS reload: the runtime is replaced over a connection kept open. */
    reload: () => {
      app.reloadRuntime();
      rig.events.emit("event", "Runtime.executionContextsCleared");
    },
    announceNewRuntime: () => rig.events.emit("event", "Runtime.executionContextCreated"),
    drop: () => {
      rig.connected = false;
      rig.events.emit("disconnected");
    },
    teardown: () => registry.disposeService(psUrn),
    settled: () =>
      vi.waitFor(() =>
        expect(registry.getSnapshot().services.get(psUrn)?.state).not.toBe(ServiceState.TERMINATING)
      ),
    sentMethods: () => rig.sent.map((c) => c.method),
    stoppedApp: () =>
      rig.sent.some(
        (c) => c.expression === STOP_FOR_TAKEOVER_SCRIPT || c.method === "Profiler.stop"
      ),
  };
}
type ToolServer = ReturnType<typeof toolServer>;

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const failure = (p: Promise<unknown>) =>
  p.then(
    () => {
      throw new Error("expected a failure");
    },
    (e: unknown) => e as Error
  );

/** Holds the first call of `method` until the test lets it go. */
function holdFirstCall(ts: ToolServer, method: string) {
  const reached = deferred();
  const release = deferred();
  let held = false;
  ts.rig.intercept = async (m) => {
    if (m !== method || held) return undefined;
    held = true;
    reached.resolve();
    await release.promise;
    return undefined;
  };
  return { reached: reached.promise, release };
}

/** Holds stop at its first dump write, after the app has stopped recording. */
function holdDumpWrites() {
  const reached = deferred();
  const release = deferred();
  dumps.hold = async () => {
    reached.resolve();
    await release.promise;
  };
  return { reached: reached.promise, release };
}

const lastCommitNames = () =>
  dumps.written
    .filter((d) => d.name.endsWith("_commits.json"))
    .pop()
    ?.payload.commits?.map((c) => c.componentName);

describe("the run lifecycle, on the real session and scripts", () => {
  beforeEach(() => {
    dumps.written.length = 0;
    dumps.hold = null;
    dumps.failure = null;
  });

  afterEach(() => {
    clearCachedProfilerPaths(OTHER_PORT, DEVICE);
    clearLostProfilerRun(OTHER_PORT, DEVICE);
    resetDeviceAliases();
  });

  describe("while a react-profiler-stop is running", () => {
    const stages = [
      {
        stage: "at Profiler.stop, with the app still recording",
        hold: (ts: ToolServer) => holdFirstCall(ts, "Profiler.stop"),
      },
      {
        stage: "at the dump writes, with the app stopped",
        hold: () => holdDumpWrites(),
      },
    ];

    it.each(stages)("everything else waits for it $stage", async ({ hold }) => {
      const app = makeApp();
      const ts = toolServer(app, PORT);
      await ts.start();
      const run = app.owner()!.sessionId;
      app.commit("Screen");
      ts.rig.sent.length = 0;
      const held = hold(ts);
      const stopping = ts.stop();
      await held.reached;
      const evaluatedBefore = ts.rig.evaluated.length;

      await expect(ts.status()).resolves.toMatchObject({
        session_status: "active",
        is_running: true,
        current_session_id: run,
        note: STOP_IN_PROGRESS_NOTE,
      });
      const waitForTheStop = {
        already_running: true,
        mine: true,
        note: STOP_IN_PROGRESS_NOTE,
      };
      await expect(ts.start()).resolves.toEqual(waitForTheStop);
      await expect(ts.start(true)).resolves.toEqual(waitForTheStop);
      expect(getFailureSignal(await failure(ts.stop()))?.error_code).toBe(
        FAILURE_CODES.REACT_PROFILER_STOP_IN_PROGRESS
      );

      // The app may be busy with the stop, and a start must not replace the run.
      expect(ts.rig.evaluated.length).toBe(evaluatedBefore);
      expect(ts.sentMethods()).not.toContain("Profiler.start");
      held.release.resolve();
      dumps.hold = null;
      await expect(stopping).resolves.toMatchObject({ fiber_renders_captured: 1 });
      await ts.settled();

      expect(lastCommitNames()).toEqual(["Screen"]);
      expect(getCachedProfilerPaths(PORT, DEVICE)).toBeDefined();
      expect(getLostProfilerRun(PORT, DEVICE)).toBeUndefined();
      await expect(ts.status()).resolves.toMatchObject({ session_status: "saved" });
    });

    it("lets one of two parallel stops collect the run, and tells the other to wait", async () => {
      const app = makeApp();
      const ts = toolServer(app, PORT);
      await ts.start();
      const sentByStart = ts.rig.sent.length;

      const results = await Promise.allSettled([ts.stop(), ts.stop()]);

      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const rejected = results.find((r) => r.status === "rejected")!;
      expect(getFailureSignal(rejected.reason)?.error_code).toBe(
        FAILURE_CODES.REACT_PROFILER_STOP_IN_PROGRESS
      );
      expect(
        ts
          .sentMethods()
          .slice(sentByStart)
          .filter((m) => m === "Profiler.stop")
      ).toHaveLength(1);
    });

    it("refuses a start that was reading the app when the stop began", async () => {
      const app = makeApp();
      const ts = toolServer(app, PORT);
      await ts.start();
      ts.rig.sent.length = 0;
      const read = holdRead(ts);
      const starting = ts.start();
      await read.reached;
      const collecting = holdFirstCall(ts, "Profiler.stop");
      const stopping = ts.stop();
      await collecting.reached;

      read.release.resolve();
      await expect(starting).resolves.toMatchObject({ note: STOP_IN_PROGRESS_NOTE });

      expect(ts.sentMethods()).not.toContain("Profiler.start");
      collecting.release.resolve();
      await stopping;
    });

    it("does not call a stop a failed one when status was reading the app as it began", async () => {
      const app = makeApp();
      const ts = toolServer(app, PORT);
      await ts.start();
      const read = holdRead(ts);
      const statusing = ts.status();
      await read.reached;
      const collecting = holdFirstCall(ts, "Profiler.stop");
      const stopping = ts.stop();
      await collecting.reached;

      read.release.resolve();
      await expect(statusing).resolves.toMatchObject({
        session_status: "active",
        note: STOP_IN_PROGRESS_NOTE,
      });

      collecting.release.resolve();
      await stopping;
    });

    it("reports a JS reload as what ended the run, not the stop it breaks", async () => {
      const app = makeApp();
      const ts = toolServer(app, PORT);
      await ts.start();
      const run = app.owner()!.sessionId;
      const held = holdFirstCall(ts, "Profiler.stop");
      const stopping = ts.stop();
      await held.reached;

      ts.reload();
      held.release.reject(new Error("Hermes refused Profiler.stop"));
      await failure(stopping);
      await ts.settled();

      expect(getLostProfilerRun(PORT, DEVICE)).toMatchObject({
        cause: "js_reload",
        sessionId: run,
      });
      await expect(ts.status()).resolves.toMatchObject({ session_status: "lost" });
      // The sampler survives a reload: it is stopped in the new runtime.
      ts.rig.sent.length = 0;
      ts.announceNewRuntime();
      expect(ts.sentMethods()).toContain("Profiler.stop");
    });

    it("keeps the data when a JS reload lands after the app has answered", async () => {
      const app = makeApp();
      const ts = toolServer(app, PORT);
      await ts.start();
      app.commit("Screen");
      const held = holdDumpWrites();
      const stopping = ts.stop();
      await held.reached;

      ts.reload();
      held.release.resolve();
      dumps.hold = null;
      await stopping;
      await ts.settled();

      expect(lastCommitNames()).toEqual(["Screen"]);
      expect(getLostProfilerRun(PORT, DEVICE)).toBeUndefined();
      await expect(ts.status()).resolves.toMatchObject({ session_status: "saved" });
    });

    it("reports a teardown as what ended the run, not the stop it breaks", async () => {
      const app = makeApp();
      const ts = toolServer(app, PORT);
      await ts.start();
      const held = holdFirstCall(ts, "Profiler.stop");
      const stopping = ts.stop();
      await held.reached;

      await ts.teardown();
      held.release.reject(new Error("CDP connection closed"));
      await failure(stopping);

      expect(getLostProfilerRun(PORT, DEVICE)?.cause).toBe("session_torn_down");
      expect(app.recording()).toBe(false);
    });

    it("reports a dropped connection as what ended the run", async () => {
      const app = makeApp();
      const ts = toolServer(app, PORT);
      await ts.start();
      const held = holdFirstCall(ts, "Profiler.stop");
      const stopping = ts.stop();
      await held.reached;

      ts.drop();
      held.release.reject(new Error("CDP connection closed"));
      await failure(stopping);

      expect(getLostProfilerRun(PORT, DEVICE)?.cause).toBe("cdp_disconnected");
    });

    it("gives the calls that collect the data a minute, and the optional read 15 s", async () => {
      const app = makeApp();
      const ts = toolServer(app, PORT);
      await ts.start();
      const sentByStart = ts.rig.sent.length;
      app.commit("Screen");

      await ts.stop();

      const timeoutOf = (found: (c: Rig["sent"][number]) => boolean) =>
        ts.rig.sent.slice(sentByStart).find(found)?.timeout;
      expect(timeoutOf((c) => c.method === "Profiler.stop")).toBe(60_000);
      expect(timeoutOf((c) => c.expression === STOP_AND_READ_SCRIPT)).toBe(60_000);
      expect(timeoutOf((c) => c.expression === RESOLVE_FIBER_META_SCRIPT)).toBe(15_000);
    });

    it("is declared longRunning, so the MCP client cannot abort and resend a long collection", () => {
      // Without it, argent-mcp aborts each attempt at 30 s and resends the call.
      // The tool-server keeps collecting, so the resend fails on this very stop.
      expect(createReactProfilerStopTool(new Registry()).longRunning).toBe(true);
    });
  });

  it("stops the sampler of a run lost to a dropped connection, on the rebuilt session", async () => {
    const app = makeApp();
    const ts = toolServer(app, PORT);
    await ts.start();
    const run = app.owner()!.sessionId;
    ts.drop();
    await ts.settled();
    expect(app.sampling).toBe(true);

    ts.rig.sent.length = 0;
    const res = await ts.start();

    expect(res.took_over).toMatchObject({ session_id: run, reason: "own_unsaved" });
    const sent = ts.sentMethods();
    expect(sent.indexOf("Profiler.stop")).toBeGreaterThanOrEqual(0);
    expect(sent.indexOf("Profiler.stop")).toBeLessThan(sent.indexOf("Profiler.start"));
  });

  describe("after a react-profiler-stop failed", () => {
    const rejectCall = (method: string, expression?: string) => async (m: string, e?: string) => {
      if (m === method && (!expression || e === expression)) throw new Error("no reply");
      return undefined;
    };
    const replyTo =
      (method: string, reply: unknown, expression?: string) => async (m: string, e?: string) =>
        m === method && (!expression || e === expression) ? reply : undefined;

    const failedStops: Array<[string, (ts: ToolServer) => void]> = [
      ["Profiler.stop rejects", (ts) => (ts.rig.intercept = rejectCall("Profiler.stop"))],
      ["Hermes returns no profile", (ts) => (ts.rig.intercept = replyTo("Profiler.stop", {}))],
      [
        "Hermes returns a malformed profile",
        (ts) => (ts.rig.intercept = replyTo("Profiler.stop", { profile: {} })),
      ],
      [
        "reading the data rejects",
        (ts) => (ts.rig.intercept = rejectCall("Runtime.evaluate", STOP_AND_READ_SCRIPT)),
      ],
      [
        "reading the data throws in the app",
        (ts) =>
          (ts.rig.intercept = replyTo(
            "Runtime.evaluate",
            { exceptionDetails: { text: "boom" } },
            STOP_AND_READ_SCRIPT
          )),
      ],
      [
        "reading the data returns nothing",
        (ts) => (ts.rig.intercept = replyTo("Runtime.evaluate", {}, STOP_AND_READ_SCRIPT)),
      ],
      ["writing the dump fails", () => (dumps.failure = new Error("ENOSPC"))],
    ];

    async function failedStop(arrange: (ts: ToolServer) => void) {
      const app = makeApp();
      const ts = toolServer(app, PORT);
      await ts.start();
      const run = app.owner()!.sessionId;
      arrange(ts);
      await failure(ts.stop());
      ts.rig.intercept = undefined;
      dumps.failure = null;
      return { app, ts, run };
    }

    it.each(failedStops)("records the failure when %s", async (_stage, arrange) => {
      const { ts, run } = await failedStop(arrange);

      expect(getLostProfilerRun(PORT, DEVICE)).toMatchObject({
        cause: "stop_failed",
        sessionId: run,
      });
      const api = await ts.api();
      expect(api.stopping).toBe(false);
      expect(api.sessionId).toBe(run);
      await expect(ts.status()).resolves.toMatchObject({
        session_status: "lost",
        lost_run: { session_id: run, cause: "stop_failed" },
      });
    });

    it("still names the failure after a JS reload", async () => {
      const { ts, run } = await failedStop(rejectStopCall);

      ts.reload();
      await ts.settled();

      await expect(ts.status()).resolves.toMatchObject({
        session_status: "lost",
        lost_run: { session_id: run, cause: "stop_failed" },
      });
    });

    it("ends the recording it left in the app on a teardown", async () => {
      const { app, ts, run } = await failedStop(rejectStopCall);
      expect(app.recording()).toBe(true);

      ts.rig.sent.length = 0;
      await ts.teardown();

      expect(app.recording()).toBe(false);
      expect(ts.sentMethods()).toContain("Profiler.stop");
      expect(getLostProfilerRun(PORT, DEVICE)?.cause).toBe("stop_failed");
      await expect(ts.status()).resolves.toMatchObject({
        session_status: "lost",
        lost_run: { session_id: run, cause: "stop_failed" },
      });
      await expect(ts.start()).resolves.toHaveProperty("started_at");
    });

    it("lets a start replace the recording it left, without force", async () => {
      const { ts, run } = await failedStop(rejectStopCall);

      const res = await ts.start();

      expect(res.took_over).toMatchObject({ session_id: run, reason: "own_unsaved" });
    });

    const rejectStopCall = (ts: ToolServer) => {
      ts.rig.intercept = rejectCall("Profiler.stop");
    };
  });

  describe("a teardown of a run another session replaced", () => {
    it("leaves the other session's recording alone, and records the takeover", async () => {
      const app = makeApp();
      const replaced = toolServer(app, PORT);
      const taker = toolServer(app, OTHER_PORT);
      await replaced.start();
      await taker.start(true);
      const takerRun = app.owner()!.sessionId;
      replaced.rig.sent.length = 0;

      await replaced.teardown();

      expect(replaced.stoppedApp()).toBe(false);
      expect(app.recording()).toBe(true);
      expect(app.sampling).toBe(true);
      expect(app.owner()?.sessionId).toBe(takerRun);
      expect(getLostProfilerRun(PORT, DEVICE)).toMatchObject({
        cause: "taken_over",
        takenOverBy: takerRun,
      });
    });

    it("stops the sampler when the recording has no owner, as a stop does", async () => {
      const app = makeApp();
      const ts = toolServer(app, PORT);
      await ts.start();
      app.run("__ri.stopProfiling(); __ri.startProfiling();");
      ts.rig.sent.length = 0;

      await ts.teardown();

      expect(app.recording()).toBe(true);
      expect(app.sampling).toBe(false);
      expect(getLostProfilerRun(PORT, DEVICE)).toMatchObject({
        cause: "taken_over",
        takenOverBy: null,
      });
    });

    it("stops the run when its own session still owns it", async () => {
      const app = makeApp();
      const ts = toolServer(app, PORT);
      await ts.start();

      await ts.teardown();

      expect(app.recording()).toBe(false);
      expect(app.sampling).toBe(false);
      expect(getLostProfilerRun(PORT, DEVICE)?.cause).toBe("session_torn_down");
    });

    it("stops as before when the owner cannot be read", async () => {
      const app = makeApp();
      const replaced = toolServer(app, PORT);
      const taker = toolServer(app, OTHER_PORT);
      await replaced.start();
      await taker.start(true);
      replaced.rig.intercept = async (_m, expression) => {
        if (expression === READ_STATE_SCRIPT) throw new Error("no reply");
        return undefined;
      };

      await replaced.teardown();

      expect(getLostProfilerRun(PORT, DEVICE)?.cause).toBe("session_torn_down");
      expect(app.recording()).toBe(false);
    });

    it("does not try the app when the connection dropped", async () => {
      const app = makeApp();
      const replaced = toolServer(app, PORT);
      const taker = toolServer(app, OTHER_PORT);
      await replaced.start();
      await taker.start(true);
      replaced.rig.evaluated.length = 0;

      replaced.drop();
      await replaced.settled();

      expect(replaced.rig.evaluated).toEqual([]);
      expect(getLostProfilerRun(PORT, DEVICE)?.cause).toBe("cdp_disconnected");
      expect(app.recording()).toBe(true);
    });
  });

  describe("a stop after the session that replaced the run has stopped too", () => {
    async function replacedAndStopped(app: App) {
      const replaced = toolServer(app, PORT);
      const taker = toolServer(app, OTHER_PORT);
      await replaced.start();
      app.commit("ReplacedScreen");
      app.advance(1_000);
      await taker.start(true);
      app.commit("TakerScreen");
      await taker.stop();
      dumps.written.length = 0;
      return { replaced, taker };
    }

    it("fails with the takeover instead of saving the other session's commits", async () => {
      const { replaced } = await replacedAndStopped(makeApp());

      const err = await failure(replaced.stop());

      expect(getFailureSignal(err)?.error_code).toBe(
        FAILURE_CODES.REACT_PROFILER_SESSION_TAKEN_OVER
      );
      expect(err.message).toContain("has since stopped");
      expect(err.message).not.toContain("still recording");
      expect(dumps.written).toEqual([]);
      expect(getCachedProfilerPaths(PORT, DEVICE)).toBeUndefined();
      expect(getLostProfilerRun(PORT, DEVICE)).toMatchObject({ cause: "taken_over" });
    });

    it("has status say so too", async () => {
      const app = makeApp();
      const { replaced } = await replacedAndStopped(app);
      const run = (await replaced.api()).sessionId;

      await expect(replaced.status()).resolves.toMatchObject({
        session_status: "taken_over",
        is_running: false,
        lost_run: { session_id: run, cause: "taken_over" },
      });
    });

    it("finds the replacement across two renderers that started apart", async () => {
      const { replaced } = await replacedAndStopped(makeApp({ renderers: 2, tickMs: 1 }));

      const err = await failure(replaced.stop());

      expect(getFailureSignal(err)?.error_code).toBe(
        FAILURE_CODES.REACT_PROFILER_SESSION_TAKEN_OVER
      );
    });

    it("records a teardown as the takeover it was", async () => {
      const { replaced } = await replacedAndStopped(makeApp());

      await replaced.teardown();

      expect(getLostProfilerRun(PORT, DEVICE)).toMatchObject({
        cause: "taken_over",
        takenOverBy: null,
      });
    });
  });

  describe("a stop after profiling stopped outside argent", () => {
    it("still collects the run's data, which nothing replaced", async () => {
      const app = makeApp();
      const ts = toolServer(app, PORT);
      await ts.start();
      app.commit("Screen");
      app.run("__ri.stopProfiling()");

      await expect(ts.status()).resolves.toMatchObject({
        session_status: "lost",
        lost_run: { cause: "ended_in_app" },
      });
      await expect(ts.stop()).resolves.toMatchObject({ fiber_renders_captured: 1 });

      expect(lastCommitNames()).toEqual(["Screen"]);
    });

    it("works when the two renderers started at different times", async () => {
      // The run's start time is the first renderer's, and the second one's differs.
      const app = makeApp({ renderers: 2, tickMs: 1 });
      const ts = toolServer(app, PORT);
      await ts.start();
      const starts = JSON.parse(app.run(READ_STATE_SCRIPT) as string) as {
        rendererStartedAtEpochMs: number[];
      };
      expect(new Set(starts.rendererStartedAtEpochMs).size).toBe(2);
      app.commit("Screen");
      app.run(
        "__REACT_DEVTOOLS_GLOBAL_HOOK__.rendererInterfaces.forEach(function (ri) { ri.stopProfiling(); })"
      );

      await expect(ts.stop()).resolves.toMatchObject({ fiber_renders_captured: 1 });
    });

    it("proceeds when no renderer has a start time to compare", async () => {
      const app = makeApp();
      const ts = toolServer(app, PORT);
      await ts.start();
      app.commit("Screen");
      app.run("__ri.stopProfiling(); __ri.__argent_startedAtEpochMs__ = null;");

      await expect(ts.stop()).resolves.toMatchObject({ fiber_renders_captured: 1 });
    });
  });

  describe("a stale run of this tool-server", () => {
    it("is flagged by start, and the recording keeps running", async () => {
      const app = makeApp();
      const ts = toolServer(app, PORT);
      await ts.start();
      app.advance(30 * MINUTE);

      await expect(ts.start()).resolves.toMatchObject({
        already_running: true,
        mine: true,
        stale: true,
        heartbeat_age_seconds: 1_800,
        note: STALE_OWN_RUN_NOTE,
      });
      expect(app.recording()).toBe(true);
    });

    it("is flagged by the status call that refreshes it, and not by the next one", async () => {
      const app = makeApp();
      const ts = toolServer(app, PORT);
      await ts.start();
      app.advance(30 * MINUTE);

      await expect(ts.status()).resolves.toMatchObject({
        session_status: "active",
        stale: true,
        heartbeat_age_seconds: 1_800,
        note: STALE_OWN_RUN_NOTE,
      });
      expect(app.owner()?.lastHeartbeatEpochMs).toBe(app.now());

      const next = await ts.status();
      expect(next).toMatchObject({ stale: false, heartbeat_age_seconds: 0 });
      expect(next.note).not.toBe(STALE_OWN_RUN_NOTE);
    });

    it("is not flagged while it is fresh", async () => {
      const app = makeApp();
      const ts = toolServer(app, PORT);
      await ts.start();
      app.advance(4 * MINUTE);

      await expect(ts.status()).resolves.toMatchObject({
        stale: false,
        heartbeat_age_seconds: 240,
      });
    });

    it("can still be replaced by another tool-server, which needs no force", async () => {
      const app = makeApp();
      const owner = toolServer(app, PORT);
      const other = toolServer(app, OTHER_PORT);
      await owner.start();
      const run = app.owner()!.sessionId;
      app.advance(6 * MINUTE);

      const res = await other.start();

      expect(res.took_over).toMatchObject({
        session_id: run,
        reason: "stale",
        heartbeat_age_seconds: 360,
      });
    });
  });

  describe("heartbeats", () => {
    const tools: Array<[string, (ts: ToolServer, deviceId?: string) => Promise<unknown>]> = [
      ["react-profiler-renders", (ts, deviceId) => ts.renders(deviceId)],
      ["react-profiler-fiber-tree", (ts, deviceId) => ts.fiberTree(deviceId)],
    ];

    it.each(tools)("%s does not keep the session that replaced the run fresh", async (_t, call) => {
      const app = makeApp();
      const replaced = toolServer(app, PORT);
      const taker = toolServer(app, OTHER_PORT);
      const third = toolServer(app, 8083);
      await replaced.start();
      await taker.start(true);
      const takerRun = app.owner()!.sessionId;
      for (let i = 0; i < 4; i++) {
        app.advance(2 * MINUTE);
        await call(replaced);
      }

      const res = await third.start();

      expect(res.took_over).toMatchObject({ session_id: takerRun, reason: "stale" });
      clearCachedProfilerPaths(8083, DEVICE);
      clearLostProfilerRun(8083, DEVICE);
    });

    it.each(tools)("%s keeps its own run fresh", async (_t, call) => {
      const app = makeApp();
      const ts = toolServer(app, PORT);
      await ts.start();
      app.advance(MINUTE);

      await call(ts);

      expect(app.owner()?.lastHeartbeatEpochMs).toBe(app.now());
    });

    it.each(tools)("%s reaches the run under a forwarded logicalDeviceId", async (_t, call) => {
      rememberDeviceAlias(LOGICAL_ID, DEVICE);
      const app = makeApp();
      const ts = toolServer(app, PORT);
      await ts.start();
      app.advance(MINUTE);

      await call(ts, LOGICAL_ID);

      expect(app.owner()?.lastHeartbeatEpochMs).toBe(app.now());
    });
  });
});

/** Holds the next app state read of the call that starts now. */
function holdRead(ts: ToolServer) {
  const reached = deferred();
  const release = deferred();
  let held = false;
  ts.rig.intercept = async (_method, expression) => {
    if (expression !== READ_STATE_SCRIPT || held) return undefined;
    held = true;
    reached.resolve();
    await release.promise;
    return undefined;
  };
  return { reached: reached.promise, release };
}
