import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FAILURE_CODES, ServiceState, getFailureSignal, type Registry } from "@argent/registry";
import {
  cacheProfilerPaths,
  clearCachedProfilerPaths,
  clearLostProfilerRun,
  getCachedProfilerPaths,
  getLostProfilerRun,
  recordLostProfilerRun,
  type ProfilerSessionPaths,
  type ReactProfilerSessionApi,
} from "../../src/blueprints/react-profiler-session";
import {
  DEFAULT_STALE_THRESHOLD_MS,
  type ProfilerSessionOwner,
} from "../../src/utils/react-profiler/session-ownership";
import {
  STOP_AND_READ_SCRIPT,
  STOP_FOR_TAKEOVER_SCRIPT,
} from "../../src/utils/react-profiler/scripts";
import { __resetProfilingDevicesForTesting } from "../../src/utils/profiling-devices";
import { createReactProfilerStartTool } from "../../src/tools/profiler/react/react-profiler-start";
import { createReactProfilerStopTool } from "../../src/tools/profiler/react/react-profiler-stop";
import { createReactProfilerStatusTool } from "../../src/tools/profiler/react/react-profiler-status";
import { profilerLoadTool } from "../../src/tools/profiler/query/profiler-load";

// Stop writes its dumps through these; keep them off the disk.
vi.mock("../../src/utils/react-profiler/debug/dump", () => ({
  getDebugDir: async () => debugDir.path,
  writeDumpCompact: async (dir: string, name: string) => `${dir}/${name}`,
}));
const debugDir = vi.hoisted(() => ({ path: "/tmp/argent-test-debug" }));

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
  /** Makes `Profiler.start` reject, as a dropped connection does. */
  profilerStartRejects?: boolean;
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

    expect(res).toMatchObject({ already_running: true, mine: true });
    expect(res.note).toContain("react-profiler-stop");
    expect(res).not.toHaveProperty("how_to_reclaim");
    expect(evaluated).not.toContain(STOP_FOR_TAKEOVER_SCRIPT);
    expect(sent).not.toContain("Profiler.start");
  });

  it("keeps the own run even when its heartbeat is stale", async () => {
    // A stale heartbeat let any start take the run over silently, the
    // caller's own included, discarding its data.
    const { registry, evaluated } = fakeSession({
      app: { isRunning: true, owner: owner("uuid-mine", DEFAULT_STALE_THRESHOLD_MS + 60_000) },
      sessionId: "uuid-mine",
      profilingActive: true,
    });

    const res = await start(registry);

    expect(res).toMatchObject({ already_running: true, mine: true });
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
