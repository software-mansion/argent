import { afterEach, describe, it, expect } from "vitest";
import type { Registry } from "@argent/registry";
import { createReactProfilerStatusTool } from "../../src/tools/profiler/react/react-profiler-status";
import {
  cacheProfilerPaths,
  clearCachedProfilerPaths,
  clearLostProfilerRun,
  recordLostProfilerRun,
  type LostProfilerRunCause,
  type ReactProfilerSessionApi,
  type ProfilerSessionPaths,
} from "../../src/blueprints/react-profiler-session";
import { buildHeartbeatScript } from "../../src/utils/react-profiler/scripts";
import type { ProfilerSessionOwner } from "../../src/utils/react-profiler/session-ownership";
import { rememberDeviceAlias, resetDeviceAliases } from "../../src/utils/debugger/device-alias";

/**
 * react-profiler-status used to read only the app, so it gave one "stopped …
 * prior data is not recoverable" answer before any start, after a JS reload
 * and after a successful stop whose data was saved. It now also reads this
 * tool-server's own record of the run, and tells those apart.
 */

const PORT = 8081;
const DEVICE = "DEV";

interface StubState {
  hookExists: boolean;
  rendererInterfaceFound: boolean;
  isRunning: boolean;
  owner: ProfilerSessionOwner | null;
}

function buildOwner(sessionId: string): ProfilerSessionOwner {
  return {
    sessionId,
    startedAtEpochMs: 1_000_000_000,
    lastHeartbeatEpochMs: 1_000_000_000,
  };
}

function inApp(isRunning: boolean, owner: ProfilerSessionOwner | null = null): StubState {
  return { hookExists: true, rendererInterfaceFound: true, isRunning, owner };
}

function buildApi(opts: {
  sessionId: string | null;
  profilingActive?: boolean;
  state: StubState;
}): { api: ReactProfilerSessionApi; evaluated: string[] } {
  const { state } = opts;
  const evaluated: string[] = [];
  const api: ReactProfilerSessionApi = {
    port: PORT,
    deviceId: DEVICE,
    cdp: {
      isConnected: () => true,
      // Setup is best-effort and its value is ignored; the state read must
      // return a JSON-encoded ReadStateResult string.
      evaluate: async (expression: string) => {
        evaluated.push(expression);
        return JSON.stringify({
          hookExists: state.hookExists,
          rendererInterfaceFound: state.rendererInterfaceFound,
          isRunning: state.isRunning,
          owner: state.owner,
          nowEpochMs: 1_000_001_000,
        });
      },
      send: async () => undefined,
      events: { on: () => undefined, off: () => undefined },
    } as unknown as ReactProfilerSessionApi["cdp"],
    projectRoot: "/tmp",
    appName: "TestApp",
    deviceName: "iPhone Test",
    hermesVersion: "unknown",
    detectedArchitecture: null,
    sessionPaths: null as ProfilerSessionPaths | null,
    profilingActive: opts.profilingActive ?? false,
    stopping: false,
    scriptSources: new Map(),
    anyCompilerOptimized: null,
    hotCommitIndices: null,
    totalReactCommits: null,
    profileStartWallMs: null,
    sessionId: opts.sessionId,
    ownerToolServerPid: null,
    disposed: false,
    disposeSession: () => undefined,
  };
  return { api, evaluated };
}

function buildRegistry(api: ReactProfilerSessionApi, resolved: string[] = []): Registry {
  return {
    resolveService: async <T = unknown>(urn: string) => {
      resolved.push(urn);
      return api as unknown as T;
    },
  } as unknown as Registry;
}

async function runStatus(api: ReactProfilerSessionApi, deviceId = DEVICE) {
  const tool = createReactProfilerStatusTool(buildRegistry(api));
  return tool.execute({}, { port: PORT, device_id: deviceId });
}

function savedPaths(sessionId: string): ProfilerSessionPaths {
  return {
    sessionId,
    debugDir: "/tmp/argent-debug",
    cpuProfilePath: `/tmp/argent-debug/react-profiler-${sessionId}_cpu.json`,
    commitsPath: `/tmp/argent-debug/react-profiler-${sessionId}_commits.json`,
    cpuSampleIndexPath: null,
    detectedArchitecture: "bridgeless",
    anyCompilerOptimized: false,
    hotCommitIndices: [],
    totalReactCommits: 3,
  };
}

function recordLost(sessionId: string, cause: LostProfilerRunCause, takenOverBy?: string) {
  recordLostProfilerRun(
    { port: PORT, deviceId: DEVICE, sessionId, profileStartWallMs: 1_000_000_000 },
    cause,
    takenOverBy
  );
}

afterEach(() => {
  clearCachedProfilerPaths(PORT, DEVICE);
  clearLostProfilerRun(PORT, DEVICE);
  resetDeviceAliases();
});

describe("react-profiler-status: a run this tool-server is recording", () => {
  it("returns 'active' and refreshes the run's heartbeat", async () => {
    const { api, evaluated } = buildApi({
      sessionId: "uuid-mine",
      profilingActive: true,
      state: inApp(true, buildOwner("uuid-mine")),
    });
    const res = await runStatus(api);
    expect(res.session_status).toBe("active");
    expect(res.is_running).toBe(true);
    expect(res.current_session_id).toBe("uuid-mine");
    // Polling status keeps the run from going stale and being taken over.
    expect(evaluated).toContain(buildHeartbeatScript("uuid-mine"));
  });

  it("does not refresh a heartbeat that is not this tool-server's", async () => {
    const { api, evaluated } = buildApi({
      sessionId: null,
      state: inApp(true, buildOwner("uuid-other")),
    });
    await runStatus(api);
    expect(evaluated).not.toContain(buildHeartbeatScript("uuid-other"));
  });
});

describe("react-profiler-status: nothing recording", () => {
  it("returns 'not_started' before any run", async () => {
    const { api, evaluated } = buildApi({ sessionId: null, state: inApp(false) });
    const res = await runStatus(api);
    expect(res.session_status).toBe("not_started");
    expect(res.is_running).toBe(false);
    expect(res).not.toHaveProperty("saved_session");
    expect(res).not.toHaveProperty("lost_run");
    expect(res.note).not.toContain("not recoverable");
    expect(evaluated.join()).not.toContain("o.sessionId");
  });

  it("returns 'saved' with the session after a successful stop", async () => {
    // A stop disposes the session node, so status reads a fresh one.
    cacheProfilerPaths(PORT, savedPaths("20261103-120000"), DEVICE);
    const { api } = buildApi({ sessionId: null, state: inApp(false) });
    const res = await runStatus(api);
    expect(res.session_status).toBe("saved");
    expect(res.saved_session).toEqual({
      session_id: "20261103-120000",
      commits_path: "/tmp/argent-debug/react-profiler-20261103-120000_commits.json",
      cpu_profile_path: "/tmp/argent-debug/react-profiler-20261103-120000_cpu.json",
    });
    expect(res.note).toContain("react-profiler-analyze");
    expect(res.note).toContain("20261103-120000");
    expect(res.note).not.toContain("not recoverable");
  });

  it("returns 'lost' with the cause after a JS reload ended the run", async () => {
    recordLost("uuid-mine", "js_reload");
    const { api } = buildApi({ sessionId: null, state: inApp(false) });
    const res = await runStatus(api);
    expect(res.session_status).toBe("lost");
    expect(res.lost_run).toMatchObject({ session_id: "uuid-mine", cause: "js_reload" });
    expect(res.note).toContain("JS reload");
    expect(res.note).toContain("react-profiler-start");
  });

  it("names a teardown, and why it reaches the run, when one ended it", async () => {
    // A react-profiler session rides on the device's JS-runtime debugger, which
    // `stop-all-simulator-servers` reaps — and one tool-server serves every
    // agent using this install, so the teardown is commonly another agent's.
    // The note is the only place an agent learns that.
    recordLost("uuid-mine", "session_torn_down");
    const { api } = buildApi({ sessionId: null, state: inApp(false) });
    const res = await runStatus(api);
    expect(res.session_status).toBe("lost");
    expect(res.note).toContain("stop-all-simulator-servers");
    expect(res.note).toContain("JS-runtime debugger");
  });

  it("returns 'lost' when a stop failed partway and left the run unsaved", async () => {
    // A failed stop clears profilingActive but never reaches the line that
    // clears the session id.
    const { api } = buildApi({ sessionId: "uuid-mine", state: inApp(false) });
    const res = await runStatus(api);
    expect(res.session_status).toBe("lost");
    expect(res.lost_run).toEqual({ session_id: "uuid-mine", cause: "stop_failed" });
  });

  it("says a failed stop's run is still recording, and that start can replace it", async () => {
    const { api } = buildApi({
      sessionId: "uuid-mine",
      profilingActive: false,
      state: inApp(true, buildOwner("uuid-mine")),
    });
    const res = await runStatus(api);
    expect(res.session_status).toBe("lost");
    expect(res.lost_run).toMatchObject({ cause: "stop_failed" });
    expect(res.note).toContain("The app is still recording it");
    expect(res.note).toContain("no force needed");
  });

  it("returns 'lost' when the app stopped recording a run this tool-server still tracks", async () => {
    const { api } = buildApi({
      sessionId: "uuid-mine",
      profilingActive: true,
      state: inApp(false),
    });
    const res = await runStatus(api);
    expect(res.session_status).toBe("lost");
    expect(res.lost_run).toEqual({ session_id: "uuid-mine", cause: "ended_in_app" });
    expect(res.note).toContain("react-profiler-stop can still collect it");
  });

  it("returns 'taken_over' when another session replaced the run and has stopped since", async () => {
    recordLost("uuid-mine", "taken_over", "uuid-stranger");
    const { api } = buildApi({ sessionId: null, state: inApp(false) });
    const res = await runStatus(api);
    expect(res.session_status).toBe("taken_over");
    expect(res.lost_run).toMatchObject({ cause: "taken_over", taken_over_by: "uuid-stranger" });
    expect(res.note).toContain("uuid-stranger");
  });
});

describe("react-profiler-status: another session recording", () => {
  it("returns 'taken_over' when it replaced this tool-server's run", async () => {
    const { api, evaluated } = buildApi({
      sessionId: "uuid-mine",
      profilingActive: true,
      state: inApp(true, buildOwner("uuid-stranger")),
    });
    const res = await runStatus(api);
    expect(res.session_status).toBe("taken_over");
    expect(res.current_session_id).toBe("uuid-stranger");
    expect(res.note).toContain(
      "Your run (session uuid-mine) was taken over by session uuid-stranger"
    );
    expect(evaluated).not.toContain(buildHeartbeatScript("uuid-mine"));
    expect(evaluated).not.toContain(buildHeartbeatScript("uuid-stranger"));
  });

  it("returns 'taken_over' when this tool-server has no run, as after a restart", async () => {
    // The device still has an owner, but the reborn process has no record of it.
    const { api } = buildApi({ sessionId: null, state: inApp(true, buildOwner("uuid-prior")) });
    const res = await runStatus(api);
    expect(res.session_status).toBe("taken_over");
    expect(res.current_session_id).toBe("uuid-prior");
    expect(res.note).toContain("another tool-server instance took over");
    expect(res.note).toContain("restarted");
    expect(res.note).toContain("force: true");
  });

  it("returns 'lost', not 'taken_over', for a lost run of this tool-server the app still records", async () => {
    // A teardown that could not reach the app leaves the run recording under
    // this tool-server's owner record.
    recordLost("uuid-orphan", "session_torn_down");
    const { api } = buildApi({ sessionId: null, state: inApp(true, buildOwner("uuid-orphan")) });
    const res = await runStatus(api);
    expect(res.session_status).toBe("lost");
    expect(res.note).toContain("no force needed");
  });
});

describe("react-profiler-status: a session loaded from disk", () => {
  const loaded = { ...savedPaths("20261001-090000"), loadedFromDisk: true };

  it("does not claim it as a run of this tool-server", async () => {
    cacheProfilerPaths(PORT, loaded, DEVICE);
    const { api } = buildApi({ sessionId: null, state: inApp(false) });
    const res = await runStatus(api);
    expect(res.session_status).toBe("saved");
    expect(res.saved_session).toMatchObject({
      session_id: "20261001-090000",
      loaded_from_disk: true,
    });
    expect(res.note).toContain("loaded from disk");
    expect(res.note).not.toContain("Your last run");
  });

  it("keeps reporting the lost run it was loaded after", async () => {
    // Comparing against an earlier baseline is the usual reason to load one.
    recordLost("uuid-mine", "js_reload");
    cacheProfilerPaths(PORT, loaded, DEVICE);
    const { api } = buildApi({ sessionId: null, state: inApp(false) });
    const res = await runStatus(api);
    expect(res.session_status).toBe("lost");
    expect(res.lost_run).toMatchObject({ session_id: "uuid-mine", cause: "js_reload" });
    expect(res.note).not.toContain("saved as session");
  });

  it("still recognises its lost run that the app keeps recording", async () => {
    recordLost("uuid-mine", "cdp_disconnected");
    cacheProfilerPaths(PORT, loaded, DEVICE);
    const { api } = buildApi({ sessionId: null, state: inApp(true, buildOwner("uuid-mine")) });
    const res = await runStatus(api);
    expect(res.session_status).toBe("lost");
  });
});

describe("react-profiler-status: lookup", () => {
  it("reads the run under the id react-profiler-start keyed it by", async () => {
    // A forwarded logicalDeviceId must not mint a second session (and a second
    // debugger connection) or miss the saved run.
    rememberDeviceAlias("logical-123", DEVICE);
    cacheProfilerPaths(PORT, savedPaths("20261103-120000"), DEVICE);
    const { api } = buildApi({ sessionId: null, state: inApp(false) });
    const resolved: string[] = [];
    const tool = createReactProfilerStatusTool(buildRegistry(api, resolved));
    const res = await tool.execute({}, { port: PORT, device_id: "logical-123" });
    expect(resolved).toEqual([`ReactProfilerSession:${PORT}:${DEVICE}`]);
    expect(res.session_status).toBe("saved");
  });

  it("reports a lost run under the logicalDeviceId after the alias is gone", async () => {
    // The form this tool's schema documents, and a dropped connection forgets
    // the alias: it used to answer not_started here and lost for the UDID.
    rememberDeviceAlias("logical-123", DEVICE);
    recordLost("uuid-mine", "cdp_disconnected");
    resetDeviceAliases();
    const { api } = buildApi({ sessionId: null, state: inApp(false) });
    const res = await runStatus(api, "logical-123");
    expect(res.session_status).toBe("lost");
    expect(res.lost_run).toMatchObject({ session_id: "uuid-mine", cause: "cdp_disconnected" });
  });

  it("still reports a saved session when the React runtime cannot be read", async () => {
    cacheProfilerPaths(PORT, savedPaths("20261103-120000"), DEVICE);
    const { api } = buildApi({
      sessionId: null,
      state: { hookExists: false, rendererInterfaceFound: false, isRunning: false, owner: null },
    });
    const res = await runStatus(api);
    expect(res.session_status).toBe("no_react_runtime");
    expect(res.saved_session).toMatchObject({ session_id: "20261103-120000" });
    expect(res.note).toContain("react-profiler-analyze");
  });
});
