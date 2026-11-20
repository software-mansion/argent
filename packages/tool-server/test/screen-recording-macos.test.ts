import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { promises as fs, realpathSync, writeFileSync } from "fs";
import os from "os";
import path from "path";
import { getFailureSignal, FAILURE_CODES, Registry, TypedEventEmitter } from "@argent/registry";

vi.mock("../src/utils/macos-apps", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/utils/macos-apps")>();
  return { ...actual, getTrackedMacosApp: vi.fn(), issueSandboxExtension: vi.fn() };
});

import {
  screenRecordingSessionBlueprint,
  screenRecordingSessionRef,
  type ScreenRecordingSessionApi,
} from "../src/blueprints/screen-recording-session";
import { MACOS_APP_NAMESPACE, type MacosAppApi } from "../src/blueprints/macos-app";
import { startMacosCapture, stopMacosCapture } from "../src/tools/screen-recording/capture-macos";
import { createScreenRecordingStartTool } from "../src/tools/screen-recording/screen-recording-start";
import { WATERMARK_PNG_BASE64 } from "../src/tools/screen-recording/watermark-asset";
import { getTrackedMacosApp, issueSandboxExtension, macosFailure } from "../src/utils/macos-apps";
import { resolveDevice } from "../src/utils/device-info";
import {
  __resetActiveScreenRecordingsForTesting,
  getActiveScreenRecordings,
} from "../src/utils/screen-recording-reminder";
import { __resetReapedSessionsForTesting } from "../src/utils/reaped-sessions";
import { redirectTmpdir } from "./helpers/tmpdir-env";
import { useMacosAppsFlag } from "./helpers/macos-apps-flag";
import {
  MAC_ID,
  MAC_URN,
  errorOf,
  fakeMacosApp,
  macosToolRegistry,
} from "./helpers/macos-input-fake";

const flag = useMacosAppsFlag();
const mockTracked = vi.mocked(getTrackedMacosApp);
const mockIssue = vi.mocked(issueSandboxExtension);

const STOP_REPLY = {
  durationMs: 4200,
  wallClockMs: 9800,
  trimmedMs: 5600,
  timedOut: false,
  warnings: [],
};

/**
 * A fake library whose stop writes `bytes` to the path its start was given,
 * as the app does.
 */
function recordingApp(
  stopReply: Record<string, unknown> = STOP_REPLY,
  bytes = "mp4 bytes",
  extra: Parameters<typeof fakeMacosApp>[0] = {}
) {
  let outputPath = "";
  return fakeMacosApp({
    "ScreenRecording.start": (params) => {
      outputPath = params.outputPath as string;
      return { width: 1600, height: 1000 };
    },
    "ScreenRecording.stop": () => {
      writeFileSync(outputPath, bytes);
      return stopReply;
    },
    ...extra,
  });
}

async function makeSession() {
  const device = resolveDevice(MAC_ID);
  const instance = await screenRecordingSessionBlueprint.factory({}, device, {
    device,
  } as never);
  return { api: instance.api as ScreenRecordingSessionApi, dispose: instance.dispose };
}

const START = { timeLimitSeconds: 60, watermark: true, trimStatic: true, showTouches: true };

/**
 * A real registry whose Mac app connection is `app`; its dispose (what
 * stop-simulator-server and a shutdown do) notes the library calls made by
 * then, since the app discards its recording once the connection closes.
 */
async function registryWithConnection(app: MacosAppApi, calls: { method: string }[]) {
  const registry = new Registry();
  const closedAfter: string[][] = [];
  registry.registerBlueprint({
    namespace: MACOS_APP_NAMESPACE,
    getURN: (deviceId: string) => `${MACOS_APP_NAMESPACE}:${deviceId}`,
    factory: async () => ({
      api: app,
      dispose: async () => {
        closedAfter.push(calls.map((c) => c.method));
      },
      events: new TypedEventEmitter(),
    }),
  });
  registry.registerBlueprint(screenRecordingSessionBlueprint);
  // As in use: the connection exists before a recording session does.
  await registry.resolveService(MAC_URN);
  const ref = screenRecordingSessionRef(resolveDevice(MAC_ID)) as {
    urn: string;
    options: Record<string, unknown>;
  };
  const session = await registry.resolveService<ScreenRecordingSessionApi>(ref.urn, ref.options);
  return { registry, session, closedAfter };
}

describe("Mac app screen recording", () => {
  let tmpDir = "";
  let restoreTmpdir: () => void = () => {};

  beforeEach(async () => {
    vi.clearAllMocks();
    __resetActiveScreenRecordingsForTesting();
    __resetReapedSessionsForTesting();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "argent-macos-recording-"));
    restoreTmpdir = redirectTmpdir(tmpDir);
    mockTracked.mockReturnValue(undefined);
  });

  afterEach(async () => {
    vi.useRealTimers();
    restoreTmpdir();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("records in the app and hands over the video the app wrote", async () => {
    const { api } = await makeSession();
    const { app, calls } = recordingApp();

    const started = await startMacosCapture(api, app, START);
    expect(started.status).toBe("recording");
    // The app is given the resolved path: a sandboxed app is granted that one.
    expect(path.dirname(started.outputFile)).toBe(realpathSync(tmpDir));
    expect(calls[0]).toMatchObject({
      method: "ScreenRecording.start",
      params: {
        outputPath: started.outputFile,
        timeLimitSeconds: 60,
        trimStatic: true,
        showPointer: true,
        watermark: WATERMARK_PNG_BASE64,
      },
    });
    expect(calls[0]!.params).not.toHaveProperty("tokens");
    expect(getActiveScreenRecordings()).toHaveLength(1);

    const stopped = await stopMacosCapture(api);
    expect(calls.map((c) => c.method)).toEqual(["ScreenRecording.start", "ScreenRecording.stop"]);
    expect(stopped).toEqual({
      outputFile: started.outputFile,
      sizeBytes: "mp4 bytes".length,
      durationMs: 4200,
      wallClockMs: 9800,
      trimmedMs: 5600,
    });
    expect(getActiveScreenRecordings()).toHaveLength(0);
    // Startable again.
    expect(api.recordingActive || api.startPending || api.stopPending).toBe(false);
    expect(api.macos).toBeNull();
  });

  it("sends no watermark when the flag is off, and the pointer setting as asked", async () => {
    const { api } = await makeSession();
    const { app, calls } = recordingApp();
    await startMacosCapture(api, app, { ...START, watermark: false, showTouches: false });
    expect(calls[0]!.params).not.toHaveProperty("watermark");
    expect(calls[0]!.params.showPointer).toBe(false);
    await stopMacosCapture(api);
  });

  it("reports no trim when nothing was cut, and passes the app's warnings on", async () => {
    const { api } = await makeSession();
    const { app } = recordingApp({
      ...STOP_REPLY,
      durationMs: 3000,
      wallClockMs: 3000,
      trimmedMs: 0,
      warnings: [
        "For part of the recording the window was minimized, so the video holds the last frame there.",
      ],
    });
    await startMacosCapture(api, app, START);
    const stopped = await stopMacosCapture(api);
    expect(stopped.durationMs).toBe(3000);
    expect(stopped).not.toHaveProperty("trimmedMs");
    expect(stopped).not.toHaveProperty("wallClockMs");
    expect(stopped.warning).toMatch(/minimized/);
  });

  it("gives a sandboxed app access to the output file", async () => {
    mockTracked.mockReturnValue({ sandboxed: true } as never);
    mockIssue.mockResolvedValue("token-1");
    const { api } = await makeSession();
    const { app, calls } = recordingApp();
    const started = await startMacosCapture(api, app, START);
    expect(mockIssue).toHaveBeenCalledWith(started.outputFile);
    expect(calls[0]!.params.tokens).toEqual(["token-1"]);
    await stopMacosCapture(api);
  });

  it("asks for a restart when the app's library predates recording, and stays startable", async () => {
    const { api } = await makeSession();
    const { app } = fakeMacosApp({
      "ScreenRecording.start": () => {
        throw macosFailure(
          "Unsupported method: ScreenRecording.start",
          FAILURE_CODES.MACOS_APP_RPC_ERROR,
          "macos_app_rpc",
          "unknown"
        );
      },
    });
    const err = await errorOf(startMacosCapture(api, app, START));
    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.MACOS_APP_LIBRARY_OUTDATED);
    expect(err?.message).toMatch(/restart-app/);
    expect(api.startPending).toBe(false);
    expect(api.recordingActive).toBe(false);
    expect(getActiveScreenRecordings()).toHaveLength(0);
  });

  it("passes the app's refusal on unchanged", async () => {
    const { api } = await makeSession();
    const refusal = macosFailure(
      "The app window is minimized, and a minimized window cannot be recorded.",
      FAILURE_CODES.MACOS_APP_RPC_ERROR,
      "macos_app_rpc",
      "unknown"
    );
    const { app } = fakeMacosApp({
      "ScreenRecording.start": () => {
        throw refusal;
      },
    });
    expect(await errorOf(startMacosCapture(api, app, START))).toBe(refusal);
    expect(api.startPending).toBe(false);
  });

  it("refuses a second start while one records", async () => {
    const { api } = await makeSession();
    const { app } = recordingApp();
    await startMacosCapture(api, app, START);
    const err = await errorOf(startMacosCapture(api, app, START));
    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.SCREEN_RECORDING_ALREADY_ACTIVE);
    await stopMacosCapture(api);
  });

  it("has the app write the video at the time limit; the stop then returns it once", async () => {
    vi.useFakeTimers();
    const { api } = await makeSession();
    const { app, calls } = recordingApp({ ...STOP_REPLY, timedOut: true });
    await startMacosCapture(api, app, { ...START, timeLimitSeconds: 5 });

    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls.map((c) => c.method)).toEqual(["ScreenRecording.start", "ScreenRecording.stop"]);
    expect(api.pendingRetrieval).toBe(true);
    expect(getActiveScreenRecordings()[0]?.status).toBe("finalized");

    const stopped = await stopMacosCapture(api);
    // The stop joined the cap's, it did not ask the app again.
    expect(calls.filter((c) => c.method === "ScreenRecording.stop")).toHaveLength(1);
    expect(stopped.warning).toMatch(/5s time limit/);
    expect(getActiveScreenRecordings()).toHaveLength(0);
  });

  it("fails a stop whose app quit, removes nothing real, and stays startable", async () => {
    const { api } = await makeSession();
    const quit = macosFailure(
      "The connection to com.example.Probe closed: the app quit or crashed.",
      FAILURE_CODES.MACOS_APP_CONNECTION_LOST,
      "macos_app_connection",
      "unknown"
    );
    const { app } = recordingApp(STOP_REPLY, "", {
      "ScreenRecording.stop": () => {
        throw quit;
      },
    });
    const started = await startMacosCapture(api, app, START);
    expect(await errorOf(stopMacosCapture(api))).toBe(quit);
    await expect(fs.stat(started.outputFile)).rejects.toThrow();
    expect(api.recordingActive || api.stopPending || api.pendingRetrieval).toBe(false);
    expect(getActiveScreenRecordings()).toHaveLength(0);
  });

  it("keeps a video the app wrote when its stop still fails", async () => {
    const { api } = await makeSession();
    let outputPath = "";
    const { app } = fakeMacosApp({
      "ScreenRecording.start": (params) => {
        outputPath = params.outputPath as string;
        return {};
      },
      "ScreenRecording.stop": () => {
        writeFileSync(outputPath, "mp4 bytes");
        throw macosFailure("late", FAILURE_CODES.MACOS_APP_RPC_ERROR, "macos_app_rpc", "unknown");
      },
    });
    const started = await startMacosCapture(api, app, START);
    expect(await errorOf(stopMacosCapture(api))).toBeDefined();
    expect(await fs.readFile(started.outputFile, "utf8")).toBe("mp4 bytes");
  });

  it("fails a stop when the app wrote no video", async () => {
    const { api } = await makeSession();
    const { app } = fakeMacosApp({ "ScreenRecording.stop": () => STOP_REPLY });
    await startMacosCapture(api, app, START);
    const err = await errorOf(stopMacosCapture(api));
    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.SCREEN_RECORDING_OUTPUT_MISSING);
  });

  it("ends the in-app recording when the session is torn down", async () => {
    const { api, dispose } = await makeSession();
    const { app, calls } = recordingApp();
    const started = await startMacosCapture(api, app, START);

    await dispose?.();
    expect(calls.map((c) => c.method)).toEqual(["ScreenRecording.start", "ScreenRecording.stop"]);
    // The video is where the breadcrumb that the next stop reads says it is.
    expect(await fs.readFile(started.outputFile, "utf8")).toBe("mp4 bytes");
    expect(getActiveScreenRecordings()).toHaveLength(0);
    const { api: next } = await makeSession();
    const err = await errorOf(stopMacosCapture(next));
    expect(getFailureSignal(err)?.error_code).toBe(
      FAILURE_CODES.SCREEN_RECORDING_SERVER_SHUTTING_DOWN
    );
    expect(err?.message).toContain(started.outputFile);
  });

  it("ends the app's recording when the session is torn down mid-start, and leaves no file", async () => {
    const { api, dispose } = await makeSession();
    let finishStart: () => void = () => {};
    let outputPath = "";
    const { app, calls } = fakeMacosApp({
      "ScreenRecording.start": (params) => {
        outputPath = params.outputPath as string;
        return new Promise<void>((resolve) => (finishStart = resolve));
      },
      "ScreenRecording.stop": () => {
        writeFileSync(outputPath, "mp4 bytes");
        return STOP_REPLY;
      },
    });
    const starting = startMacosCapture(api, app, START);
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    await dispose?.();
    finishStart();
    const err = await errorOf(starting);
    expect(getFailureSignal(err)?.error_code).toBe(
      FAILURE_CODES.SCREEN_RECORDING_SERVER_SHUTTING_DOWN
    );
    expect(calls.map((c) => c.method)).toEqual(["ScreenRecording.start", "ScreenRecording.stop"]);
    expect(await fs.readdir(tmpDir)).toEqual([]);
    expect(getActiveScreenRecordings()).toHaveLength(0);
  });

  it("reports the teardown, not the closed connection, when a teardown cuts a start short", async () => {
    const { api, dispose } = await makeSession();
    let closeConnection: () => void = () => {};
    const { app, calls } = fakeMacosApp({
      "ScreenRecording.start": () =>
        new Promise((_resolve, reject) => {
          closeConnection = () =>
            reject(
              macosFailure(
                "argent closed its connection to the app.",
                FAILURE_CODES.MACOS_APP_CONNECTION_CLOSED,
                "macos_app_connection",
                "unknown"
              )
            );
        }),
    });
    const starting = startMacosCapture(api, app, START);
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    // The session goes first, then the connection it depends on.
    await dispose?.();
    closeConnection();
    const err = await errorOf(starting);
    expect(getFailureSignal(err)?.error_code).toBe(
      FAILURE_CODES.SCREEN_RECORDING_SERVER_SHUTTING_DOWN
    );
    expect(api.startPending).toBe(false);
  });

  it("ties only a Mac app's session to the app's connection", () => {
    // The registry passes the URN's payload, the device id, as a string.
    const deps = (id: string) => screenRecordingSessionBlueprint.getDependencies!(id as never);
    expect(deps(MAC_ID)).toEqual({ macosApp: MAC_URN });
    expect(screenRecordingSessionBlueprint.getDependencies!(resolveDevice(MAC_ID))).toEqual({
      macosApp: MAC_URN,
    });
    for (const id of [
      "11111111-2222-3333-4444-555555555555",
      "emulator-5554",
      "remote:11111111-2222-3333-4444-555555555555",
      "chromium-cdp-9222",
    ]) {
      expect(deps(id)).toEqual({});
    }
  });

  it.each([
    ["stop-simulator-server disposes the connection", (r: Registry) => r.disposeService(MAC_URN)],
    ["the tool-server shuts down", (r: Registry) => r.dispose()],
  ])(
    "has the app write the video before the connection closes when %s",
    async (_when, teardown) => {
      const { app, calls } = recordingApp();
      const { registry, session, closedAfter } = await registryWithConnection(app, calls);
      const started = await startMacosCapture(session, app, START);

      await teardown(registry);
      expect(closedAfter).toEqual([["ScreenRecording.start", "ScreenRecording.stop"]]);
      expect(await fs.readFile(started.outputFile, "utf8")).toBe("mp4 bytes");
      const { api: next } = await makeSession();
      expect((await errorOf(stopMacosCapture(next)))?.message).toContain(started.outputFile);
    }
  );
});

describe("screen-recording-start on a Mac app", () => {
  let tmpDir = "";
  let restoreTmpdir: () => void = () => {};

  beforeEach(async () => {
    vi.clearAllMocks();
    __resetActiveScreenRecordingsForTesting();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "argent-macos-recording-tool-"));
    restoreTmpdir = redirectTmpdir(tmpDir);
    mockTracked.mockReturnValue(undefined);
  });

  afterEach(async () => {
    restoreTmpdir();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  /** The start tool on a registry with the fake app and a real session; records every URN. */
  async function harness() {
    const { app, calls } = recordingApp();
    const sessionUrn = screenRecordingSessionBlueprint.getURN(resolveDevice(MAC_ID));
    const { api: session } = await makeSession();
    const { registry, urns } = macosToolRegistry(app, (r) => [createScreenRecordingStartTool(r)], {
      [sessionUrn]: session,
    });
    return { registry, calls, urns, session, sessionUrn };
  }

  it("records through the app's library, with no simulator-server", async () => {
    const { registry, calls, urns, session, sessionUrn } = await harness();
    const result = await registry.invokeTool<{ status: string }>("screen-recording-start", {
      udid: MAC_ID,
      showTouches: false,
    });
    expect(result.status).toBe("recording");
    expect(calls[0]).toMatchObject({
      method: "ScreenRecording.start",
      params: { timeLimitSeconds: 180, trimStatic: true, showPointer: false },
    });
    expect(new Set(urns)).toEqual(new Set([sessionUrn, MAC_URN]));
    await stopMacosCapture(session);
  });

  it("refuses a Mac app while the macos-apps flag is off", async () => {
    const { registry, calls } = await harness();
    flag.off();
    const err = await errorOf(registry.invokeTool("screen-recording-start", { udid: MAC_ID }));
    expect(err?.message).toMatch(/macos-apps/);
    expect(calls).toHaveLength(0);
  });
});
