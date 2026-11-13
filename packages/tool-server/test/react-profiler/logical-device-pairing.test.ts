/**
 * When two or more devices share one Metro, the agent connects to its app with
 * Metro's logicalDeviceId: the React session is keyed by that hash, while the
 * native session of the same run is keyed by the device's own id (a UDID or an
 * adb serial). react-profiler-start finds that id; the stop must save it, or
 * profiler-load can never pair the run's two sessions.
 *
 * Drives the real registry, blueprints, react-profiler-start and
 * react-profiler-stop against a fake Metro that lists two devices.
 */
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { Registry } from "@argent/registry";
import { jsRuntimeDebuggerBlueprint } from "../../src/blueprints/js-runtime-debugger";
import {
  clearCachedProfilerPaths,
  reactProfilerSessionBlueprint,
} from "../../src/blueprints/react-profiler-session";
import { createReactProfilerStartTool } from "../../src/tools/profiler/react/react-profiler-start";
import { createReactProfilerStopTool } from "../../src/tools/profiler/react/react-profiler-stop";
import { profilerLoadTool } from "../../src/tools/profiler/query/profiler-load";
import { readCommitTree } from "../../src/utils/react-profiler/debug/dump";
import { resetDeviceAliases } from "../../src/utils/debugger/device-alias";
import { __resetProfilingDevicesForTesting } from "../../src/utils/profiling-devices";
import { scopeTempHome } from "../helpers/temp-home";
import { redirectTmpdir } from "../helpers/tmpdir-env";

scopeTempHome("argent-logical-pairing-home-");

const UDID_A = "0D3C2B1A-9F8E-4D7C-B6A5-948372615F00";
const findRuntimeDeviceMock = vi.hoisted(() =>
  vi.fn(async (): Promise<string | undefined> => undefined)
);
vi.mock("../../src/utils/debugger/runtime-device", () => ({
  findRuntimeDevice: () => findRuntimeDeviceMock(),
}));

const A = {
  logicalDeviceId: "aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111",
  deviceName: "iPhone 17 Pro",
};
const B = { logicalDeviceId: "bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222", deviceName: "iPhone 17" };

/** One recorded commit, as the React DevTools backend returns it. */
const PROFILING_DATA = JSON.stringify({
  live: {
    dataForRoots: [
      {
        commitData: [
          {
            timestamp: 0,
            duration: 40,
            fiberActualDurations: [[1, 40]],
            fiberSelfDurations: [[1, 40]],
            changeDescriptions: [[1, { props: [], state: null, hooks: [], context: false }]],
          },
        ],
      },
    ],
  },
  displayNameById: { "1": "Screen" },
  displayNameApiAvailable: true,
});

/** The answer of the app to each script the start and the stop evaluate. */
function evaluateAnswer(expression: string): unknown {
  if (expression.includes("__argent_readState")) {
    return JSON.stringify({
      hookExists: true,
      rendererInterfaceFound: true,
      isRunning: false,
      owner: null,
      nowEpochMs: Date.now(),
    });
  }
  if (expression.includes("__argent_doStart")) {
    return JSON.stringify({
      ok: true,
      startedAtEpochMs: Date.now(),
      isProfilingFlagSet: true,
      ownerInstalled: true,
    });
  }
  if (expression.includes("getProfilingData")) return PROFILING_DATA;
  return JSON.stringify({});
}

let server: http.Server;
let wss: WebSocketServer;
let port = 0;
// Replaced in beforeEach; set here so the teardown never reads an unset value.
let registry = new Registry();
let scratch = "";
let restoreTmpdir: () => void = () => {};

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url === "/status") {
      res.setHeader("X-React-Native-Project-Root", "/mock/project");
      res.end("packager-status:running");
      return;
    }
    if (req.url === "/json/list") {
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify(
          [A, B].map((d) => ({
            id: `${d.logicalDeviceId}-1`,
            title: `com.example.app (${d.deviceName})`,
            description: "React Native Bridgeless [C++ connection]",
            appId: "com.example.app",
            type: "node",
            webSocketDebuggerUrl: `ws://localhost:${port}/inspector/debug?device=${d.logicalDeviceId}&page=1`,
            deviceName: d.deviceName,
            reactNative: {
              logicalDeviceId: d.logicalDeviceId,
              capabilities: { prefersFuseboxFrontend: true },
            },
          }))
        )
      );
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  wss = new WebSocketServer({ server });
  wss.on("connection", (ws) => {
    ws.on("message", (raw) => {
      const { id, method, params } = JSON.parse(raw.toString()) as {
        id: number;
        method: string;
        params?: { expression?: string };
      };
      if (method === "Runtime.evaluate") {
        const value = evaluateAnswer(params?.expression ?? "");
        ws.send(JSON.stringify({ id, result: { result: { type: typeof value, value } } }));
        return;
      }
      if (method === "Profiler.stop") {
        const profile = {
          nodes: [{ id: 1, callFrame: {}, hitCount: 0 }],
          samples: [1],
          timeDeltas: [0],
          startTime: 0,
          endTime: 1_000_000,
        };
        ws.send(JSON.stringify({ id, result: { profile } }));
        return;
      }
      ws.send(JSON.stringify({ id, result: {} }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => wss.close(() => server.close(() => resolve())));
});

beforeEach(async () => {
  scratch = await fs.mkdtemp(join(tmpdir(), "argent-logical-pairing-"));
  restoreTmpdir = redirectTmpdir(scratch);
  registry = new Registry();
  registry.registerBlueprint(jsRuntimeDebuggerBlueprint);
  registry.registerBlueprint(reactProfilerSessionBlueprint);
});

afterEach(async () => {
  await registry.dispose();
  resetDeviceAliases();
  __resetProfilingDevicesForTesting();
  findRuntimeDeviceMock.mockReset();
  clearCachedProfilerPaths(port, A.logicalDeviceId);
  clearCachedProfilerPaths(port, UDID_A);
  restoreTmpdir();
  await fs.rm(scratch, { recursive: true, force: true });
});

/** react-profiler-start and -stop on device A by its logicalDeviceId, as two devices on one Metro need. */
async function recordOnA(): Promise<{ debugDir: string; reactId: string; startMs: number }> {
  const params = { device_id: A.logicalDeviceId, port, sample_interval_us: 100, force: false };
  const started = (await createReactProfilerStartTool(registry).execute({}, params)) as {
    startedAtEpochMs: number;
  };
  await createReactProfilerStopTool(registry).execute!({}, { port, device_id: A.logicalDeviceId });
  const debugDir = join(scratch, "argent-profiler-cwd");
  const commits = (await fs.readdir(debugDir)).find((f) => f.endsWith("_commits.json"))!;
  return {
    debugDir,
    reactId: /^react-profiler-(\d{8}-\d{6})_/.exec(commits)![1]!,
    startMs: started.startedAtEpochMs,
  };
}

/** The native session of the same run on device A, as native-profiler-stop saves it. */
async function nativeSessionOnA(debugDir: string, startMs: number): Promise<string> {
  const nativeId = new Date(startMs - 2_000)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace("T", "-")
    .slice(0, 15);
  await fs.writeFile(
    join(debugDir, `native-profiler-${nativeId}_raw_hangs.xml`),
    "<trace-query-result><node></node></trace-query-result>"
  );
  await fs.writeFile(
    join(debugDir, `native-profiler-${nativeId}.trace.metadata.json`),
    JSON.stringify({
      deviceId: UDID_A,
      wallClockStartMs: startMs - 2_000,
      stoppedAtMs: Date.now() + 5_000,
      cpuFilterPid: null,
      mallocStackLogging: null,
      appSuspensions: null,
      recordedMs: null,
      appEndedDuringCapture: false,
    })
  );
  return nativeId;
}

describe("a React run keyed by a logicalDeviceId pairs with its device's native run", () => {
  it("saves the device the runtime runs on, and profiler-load pairs on it", async () => {
    findRuntimeDeviceMock.mockResolvedValue(UDID_A);
    const { debugDir, reactId, startMs } = await recordOnA();

    const meta = (await readCommitTree(join(debugDir, `react-profiler-${reactId}_commits.json`)))
      .meta;
    expect(meta?.deviceId).toBe(A.logicalDeviceId);
    expect(meta?.runtimeDeviceId).toBe(UDID_A);

    const nativeId = await nativeSessionOnA(debugDir, startMs);
    const list = (await profilerLoadTool.execute(
      {} as never,
      {
        mode: "list",
        port,
        device_id: UDID_A,
      } as never
    )) as string;
    const nativeRow = list.split("\n").find((l) => l.startsWith(`| \`${nativeId}\``));
    expect(nativeRow).toContain(`\`${reactId}\``);

    const loaded = (await profilerLoadTool.execute(
      {} as never,
      {
        mode: "load_react",
        session_id: nativeId,
        port,
        device_id: UDID_A,
      } as never
    )) as string;
    expect(loaded).toContain(`Loaded React profiler session \`${reactId}\``);
  });

  it("pairs nothing when the start could not find the device", async () => {
    const { debugDir, reactId, startMs } = await recordOnA();
    const meta = (await readCommitTree(join(debugDir, `react-profiler-${reactId}_commits.json`)))
      .meta;
    expect(meta?.runtimeDeviceId).toBeNull();

    const nativeId = await nativeSessionOnA(debugDir, startMs);
    const list = (await profilerLoadTool.execute(
      {} as never,
      {
        mode: "list",
        port,
        device_id: UDID_A,
      } as never
    )) as string;
    const nativeRow = list.split("\n").find((l) => l.startsWith(`| \`${nativeId}\``));
    expect(nativeRow).not.toContain(reactId);
  });
});
