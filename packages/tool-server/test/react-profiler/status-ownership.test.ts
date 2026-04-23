import { describe, it, expect } from "vitest";
import type { Registry } from "@argent/registry";
import { createReactProfilerStatusTool } from "../../src/tools/profiler/react/react-profiler-status";
import type {
  ReactProfilerSessionApi,
  ProfilerSessionPaths,
} from "../../src/blueprints/react-profiler-session";
import type { ProfilerSessionOwner } from "../../src/utils/react-profiler/session-ownership";

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
    toolServerPid: 100,
    toolServerStartedAtEpochMs: 999_999_000,
    toolName: "react-profiler-start",
    startArgs: {},
    commitCountAtStart: 0,
  };
}

function buildApi(opts: { sessionId: string | null; state: StubState }): ReactProfilerSessionApi {
  const { state } = opts;
  return {
    port: 8081,
    deviceId: "DEV",
    cdp: {
      isConnected: () => true,
      // The tool calls cdp.evaluate(REACT_NATIVE_PROFILER_SETUP_SCRIPT) then cdp.evaluate(READ_STATE_SCRIPT).
      // Setup is best-effort; the second call must return a JSON-encoded ReadStateResult string.
      // We return the same value for both — setup parsing isn't verified here.
      evaluate: async () =>
        JSON.stringify({
          hookExists: state.hookExists,
          rendererInterfaceFound: state.rendererInterfaceFound,
          isRunning: state.isRunning,
          owner: state.owner,
          nowEpochMs: 1_000_001_000,
        }),
      send: async () => undefined,
      events: { on: () => undefined, off: () => undefined },
    } as unknown as ReactProfilerSessionApi["cdp"],
    projectRoot: "/tmp",
    appName: "TestApp",
    deviceName: "iPhone Test",
    hermesVersion: "unknown",
    detectedArchitecture: null,
    sessionPaths: null as ProfilerSessionPaths | null,
    profilingActive: false,
    scriptSources: new Map(),
    anyCompilerOptimized: null,
    hotCommitIndices: null,
    totalReactCommits: null,
    profileStartWallMs: null,
    sessionId: opts.sessionId,
    ownerToolServerPid: null,
    disposeSession: () => undefined,
  };
}

function buildRegistry(api: ReactProfilerSessionApi): Registry {
  return {
    resolveService: async <T = unknown>() => api as unknown as T,
  } as unknown as Registry;
}

async function runStatus(api: ReactProfilerSessionApi) {
  const tool = createReactProfilerStatusTool(buildRegistry(api));
  return tool.execute({}, { port: 8081, device_id: "DEV" });
}

describe("react-profiler-status: server-side ownership", () => {
  it("returns 'active' when api.sessionId matches owner.sessionId", async () => {
    const api = buildApi({
      sessionId: "uuid-mine",
      state: {
        hookExists: true,
        rendererInterfaceFound: true,
        isRunning: true,
        owner: buildOwner("uuid-mine"),
      },
    });
    const res = await runStatus(api);
    expect(res.session_status).toBe("active");
    expect(res.is_running).toBe(true);
    expect(res.current_session_id).toBe("uuid-mine");
  });

  it("returns 'taken_over' when api.sessionId is null but a session is running on device", async () => {
    // Simulates the tool-server restart case: device still has an owner, but
    // the reborn process has no in-memory api.sessionId.
    const api = buildApi({
      sessionId: null,
      state: {
        hookExists: true,
        rendererInterfaceFound: true,
        isRunning: true,
        owner: buildOwner("uuid-prior"),
      },
    });
    const res = await runStatus(api);
    expect(res.session_status).toBe("taken_over");
    expect(res.current_session_id).toBe("uuid-prior");
  });

  it("returns 'taken_over' when device-side owner.sessionId differs from api.sessionId", async () => {
    const api = buildApi({
      sessionId: "uuid-mine",
      state: {
        hookExists: true,
        rendererInterfaceFound: true,
        isRunning: true,
        owner: buildOwner("uuid-stranger"),
      },
    });
    const res = await runStatus(api);
    expect(res.session_status).toBe("taken_over");
    expect(res.current_session_id).toBe("uuid-stranger");
  });

  it("returns 'stopped' when no session is running, regardless of api.sessionId", async () => {
    const api = buildApi({
      sessionId: "uuid-mine",
      state: {
        hookExists: true,
        rendererInterfaceFound: true,
        isRunning: false,
        owner: null,
      },
    });
    const res = await runStatus(api);
    expect(res.session_status).toBe("stopped");
    expect(res.is_running).toBe(false);
  });
});
