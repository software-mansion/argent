/**
 * A native and a React session of one profiling run get unrelated ids: the
 * native id is the time its recording started, the React id the time its stop
 * ran. After a tool-server restart, load_react with the native id failed with
 * "No data found for React session", and nothing said which React session went
 * with it. profiler-load list now names the session of the other kind that
 * recorded on the same device at the same time, and load_react / load_native
 * accept that id. Agents that profile other devices at the same time share the
 * folder, so a session of another device is never a pair.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";
import {
  nativeProfilerSessionBlueprint,
  type NativeProfilerSessionApi,
} from "../../src/blueprints/native-profiler-session";
import {
  clearCachedProfilerPaths,
  getCachedProfilerPaths,
} from "../../src/blueprints/react-profiler-session";

let debugDir = "";

vi.mock("../../src/utils/react-profiler/debug/dump", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getDebugDir: async () => debugDir,
}));

import { profilerLoadTool } from "../../src/tools/profiler/query/profiler-load";

const DEVICE = "11111111-1111-1111-1111-111111111111";
const OTHER_DEVICE = "22222222-2222-2222-2222-222222222222";
const PORT = 8081;
// One run: native start 13:52:45.200, React start 13:52:47, React stop 13:53:07, native stop 13:53:10.
const NATIVE_ID = "20261113-135245";
const REACT_ID = "20261113-135307";
const at = (hms: string) => Date.parse(`2026-11-13T${hms}Z`);
// A React session of a later run on the same device.
const LATER_REACT_ID = "20261113-140102";
// Another agent's React session on another device, at the same time as the run.
const OTHER_DEVICE_REACT_ID = "20261113-135305";

async function writeJson(name: string, value: unknown): Promise<void> {
  await fs.writeFile(path.join(debugDir, name), JSON.stringify(value));
}

async function nativeSession(deviceId: string | undefined): Promise<void> {
  await writeJson(`native-profiler-${NATIVE_ID}.trace.metadata.json`, {
    ...(deviceId ? { deviceId } : {}),
    wallClockStartMs: at("13:52:45.200"),
    stoppedAtMs: at("13:53:10"),
    cpuFilterPid: null,
    mallocStackLogging: null,
    appSuspensions: null,
    recordedMs: null,
    appEndedDuringCapture: false,
  });
}

async function reactSession(id: string, startHms: string, deviceId: string): Promise<void> {
  await writeJson(`react-profiler-${id}_commits.json`, {
    commits: [],
    meta: { profileStartWallMs: at(startHms), deviceId },
  });
}

beforeEach(async () => {
  debugDir = await fs.mkdtemp(path.join(os.tmpdir(), "argent-load-pairs-"));
  await fs.writeFile(
    path.join(debugDir, `native-profiler-${NATIVE_ID}_raw_hangs.xml`),
    "<trace-query-result><node></node></trace-query-result>"
  );
  await nativeSession(DEVICE);
  await reactSession(REACT_ID, "13:52:47", DEVICE);
  await reactSession(LATER_REACT_ID, "14:00:40", DEVICE);
});

afterEach(async () => {
  clearCachedProfilerPaths(PORT, DEVICE);
  await fs.rm(debugDir, { recursive: true, force: true });
});

async function buildIosSession(): Promise<NativeProfilerSessionApi> {
  const device = { id: DEVICE, platform: "ios" as const, kind: "simulator" as const };
  return (await nativeProfilerSessionBlueprint.factory({}, device, { device })).api;
}

const run = (params: Record<string, unknown>, services: Record<string, unknown> = {}) =>
  profilerLoadTool.execute(
    services as never,
    {
      port: PORT,
      device_id: DEVICE,
      ...params,
    } as never
  ) as Promise<string>;

const row = (out: string, id: string) => out.split("\n").find((l) => l.startsWith(`| \`${id}\``));

describe("profiler-load pairs a run's native and React sessions", () => {
  it("list names the session of the other kind that recorded at the same time", async () => {
    const out = await run({ mode: "list" });
    expect(row(out, REACT_ID)).toContain(`\`${NATIVE_ID}\``);
    expect(row(out, LATER_REACT_ID)).not.toContain(NATIVE_ID);
    expect(row(out, NATIVE_ID)).toContain(`\`${REACT_ID}\``);
    expect(row(out, NATIVE_ID)).not.toContain(LATER_REACT_ID);
  });

  it("load_react with the native id loads the React session of the same run", async () => {
    const params = { mode: "load_react", session_id: NATIVE_ID };
    const out = await run(params);
    expect(out).toContain(`\`${NATIVE_ID}\` is a native session`);
    expect(out).toContain(`Loaded React profiler session \`${REACT_ID}\``);
    expect(getCachedProfilerPaths(PORT, DEVICE)?.sessionId).toBe(REACT_ID);
    const completed = profilerLoadTool.interaction!.completedMsg!({
      params: params as never,
      result: out,
    });
    expect(completed).toBe(`Loaded React profile ${REACT_ID}`);
  });

  it("load_native with the React id loads the native session of the same run", async () => {
    const api = await buildIosSession();
    const out = await run({ mode: "load_native", session_id: REACT_ID }, { session: api });
    expect(out).toContain(`\`${REACT_ID}\` is a React session`);
    expect(out).toContain(`Loaded native profiler session \`${NATIVE_ID}\``);
    expect(api.exportedFiles?.hangs).toContain(NATIVE_ID);
  });

  it("never pairs a session of another device that recorded at the same time", async () => {
    await reactSession(OTHER_DEVICE_REACT_ID, "13:52:50", OTHER_DEVICE);
    const out = await run({ mode: "list" });
    expect(row(out, NATIVE_ID)).toContain(`\`${REACT_ID}\``);
    expect(row(out, NATIVE_ID)).not.toContain(OTHER_DEVICE_REACT_ID);
    expect(row(out, OTHER_DEVICE_REACT_ID)).not.toContain(NATIVE_ID);

    await run({ mode: "load_react", session_id: NATIVE_ID });
    expect(getCachedProfilerPaths(PORT, DEVICE)?.sessionId).toBe(REACT_ID);
  });

  it("names every React session of the run when there is more than one", async () => {
    const second = "20261113-135309";
    await reactSession(second, "13:53:08", DEVICE);
    await expect(run({ mode: "load_react", session_id: NATIVE_ID })).rejects.toThrow(
      `On its device, 2 React sessions recorded at the same time as native session ` +
        `"${NATIVE_ID}": \`${REACT_ID}\`, \`${second}\`. Pass one of them as session_id.`
    );
  });

  it("pairs nothing with a native session saved without its device", async () => {
    await nativeSession(undefined);
    expect(row(await run({ mode: "list" }), NATIVE_ID)).not.toContain(REACT_ID);
    await expect(run({ mode: "load_react", session_id: NATIVE_ID })).rejects.toThrow(
      /No data found for React session "20261113-135245"/
    );
  });

  it("pairs an Android session, and the progress line names the loaded one", async () => {
    const serial = "emulator-5554";
    await fs.rm(path.join(debugDir, `native-profiler-${NATIVE_ID}.trace.metadata.json`));
    await fs.rm(path.join(debugDir, `native-profiler-${NATIVE_ID}_raw_hangs.xml`));
    await fs.writeFile(path.join(debugDir, `native-profiler-${NATIVE_ID}.pftrace`), "x");
    await writeJson(`native-profiler-${NATIVE_ID}.pftrace.metadata.json`, {
      platform: "android",
      appProcess: "com.example.app",
      wallClockStartMs: at("13:52:45.200"),
      stoppedAtMs: at("13:53:10"),
      deviceId: serial,
    });
    await reactSession(REACT_ID, "13:52:47", serial);
    const device = { id: serial, platform: "android" as const, kind: "emulator" as const };
    const api = (await nativeProfilerSessionBlueprint.factory({}, device, { device })).api;

    const list = await run({ mode: "list", device_id: serial });
    expect(row(list, NATIVE_ID)).toContain(`\`${REACT_ID}\``);
    const params = { mode: "load_native", session_id: REACT_ID, device_id: serial };
    const out = await run(params, { session: api });
    expect(out).toContain(`Loaded Android profiler session \`${NATIVE_ID}\``);
    expect(api.traceFile).toBe(path.join(debugDir, `native-profiler-${NATIVE_ID}.pftrace`));
    const completed = profilerLoadTool.interaction!.completedMsg!({
      params: params as never,
      result: out,
    });
    expect(completed).toBe(`Loaded native profile ${NATIVE_ID}`);
  });

  it("pairs an iOS and an Android session that started in the same second each on its own device", async () => {
    const serial = "emulator-5554";
    const androidReactId = "20261113-135308";
    await fs.writeFile(path.join(debugDir, `native-profiler-${NATIVE_ID}.pftrace`), "x");
    await writeJson(`native-profiler-${NATIVE_ID}.pftrace.metadata.json`, {
      platform: "android",
      appProcess: "com.example.app",
      wallClockStartMs: at("13:52:45.700"),
      stoppedAtMs: at("13:53:11"),
      deviceId: serial,
    });
    await reactSession(androidReactId, "13:52:48", serial);

    const list = await run({ mode: "list" });
    const [ios, android] = list.split("### Native Profiler Sessions (Android)");
    expect(row(ios!, NATIVE_ID)).toContain(`\`${REACT_ID}\``);
    expect(row(ios!, NATIVE_ID)).not.toContain(androidReactId);
    expect(row(android!, NATIVE_ID)).toContain(`\`${androidReactId}\``);
    expect(row(android!, NATIVE_ID)).not.toContain(REACT_ID);
    expect(row(list, androidReactId)).toContain(`\`${NATIVE_ID}\``);

    await run({ mode: "load_react", session_id: NATIVE_ID, device_id: serial });
    expect(getCachedProfilerPaths(PORT, serial)?.sessionId).toBe(androidReactId);
    clearCachedProfilerPaths(PORT, serial);
    await run({ mode: "load_react", session_id: NATIVE_ID });
    expect(getCachedProfilerPaths(PORT, DEVICE)?.sessionId).toBe(REACT_ID);

    const device = { id: serial, platform: "android" as const, kind: "emulator" as const };
    const androidApi = (await nativeProfilerSessionBlueprint.factory({}, device, { device })).api;
    const out = await run(
      { mode: "load_native", session_id: androidReactId, device_id: serial },
      { session: androidApi }
    );
    expect(out).toContain(`Loaded Android profiler session \`${NATIVE_ID}\``);
    const iosApi = await buildIosSession();
    expect(await run({ mode: "load_native", session_id: REACT_ID }, { session: iosApi })).toContain(
      `Loaded native profiler session \`${NATIVE_ID}\``
    );
  });

  it("takes the session with the given id only when it is on the load's device", async () => {
    // Another device's React stop ran in the second this run's native start did.
    await reactSession(NATIVE_ID, "13:52:30", OTHER_DEVICE);
    const out = await run({ mode: "load_react", session_id: NATIVE_ID });
    expect(out).toContain(
      `React session \`${NATIVE_ID}\` recorded on another device, so it was not loaded. This is ` +
        `the React session of the run of native session \`${NATIVE_ID}\` on this device.`
    );
    expect(getCachedProfilerPaths(PORT, DEVICE)?.sessionId).toBe(REACT_ID);

    // With two React sessions of the run on this device, the refusal names them.
    const second = "20261113-135309";
    await reactSession(second, "13:53:08", DEVICE);
    await expect(run({ mode: "load_react", session_id: NATIVE_ID })).rejects.toThrow(
      `React session "${NATIVE_ID}" recorded on another device. On this device, 2 React ` +
        `sessions recorded at the same time as native session "${NATIVE_ID}": ` +
        `\`${REACT_ID}\`, \`${second}\`. Pass one of them as session_id.`
    );
    await fs.rm(path.join(debugDir, `react-profiler-${second}_commits.json`));

    const own = await run({ mode: "load_react", session_id: NATIVE_ID, device_id: OTHER_DEVICE });
    expect(own.startsWith(`Loaded React profiler session \`${NATIVE_ID}\``)).toBe(true);
    clearCachedProfilerPaths(PORT, OTHER_DEVICE);

    // A session whose files do not name its device is taken by its id, as before.
    await writeJson(`react-profiler-${NATIVE_ID}_commits.json`, { commits: [], meta: {} });
    await run({ mode: "load_react", session_id: NATIVE_ID });
    expect(getCachedProfilerPaths(PORT, DEVICE)?.sessionId).toBe(NATIVE_ID);
  });

  it("says the same for load_native, each sentence with a capital", async () => {
    // Native session NATIVE_ID is another device's; React session NATIVE_ID is this
    // device's, and a native session of this device recorded at the same time.
    await nativeSession(OTHER_DEVICE);
    await reactSession(NATIVE_ID, "13:52:20", DEVICE);
    const native = async (id: string, start: string, stop: string) => {
      await fs.writeFile(
        path.join(debugDir, `native-profiler-${id}_raw_hangs.xml`),
        "<trace-query-result><node></node></trace-query-result>"
      );
      await writeJson(`native-profiler-${id}.trace.metadata.json`, {
        deviceId: DEVICE,
        wallClockStartMs: at(start),
        stoppedAtMs: at(stop),
        cpuFilterPid: null,
        mallocStackLogging: null,
        appSuspensions: null,
        recordedMs: null,
        appEndedDuringCapture: false,
      });
    };
    await native("20261113-135230", "13:52:30.500", "13:52:50");
    const api = await buildIosSession();
    const out = await run({ mode: "load_native", session_id: NATIVE_ID }, { session: api });
    expect(out).toContain(
      `Native session \`${NATIVE_ID}\` recorded on another device, so it was not loaded. This ` +
        `is the native session of the run of React session \`${NATIVE_ID}\` on this device.\n\n` +
        "Loaded native profiler session `20261113-135230`."
    );

    await native("20261113-135219", "13:52:19.500", "13:52:40");
    await expect(
      run({ mode: "load_native", session_id: NATIVE_ID }, { session: await buildIosSession() })
    ).rejects.toThrow(
      `Native session "${NATIVE_ID}" recorded on another device. On this device, 2 native ` +
        `sessions recorded at the same time as React session "${NATIVE_ID}": ` +
        "`20261113-135219`, `20261113-135230`. Pass one of them as session_id."
    );
  });

  it("loads the session with the given id when no run of the load's device has that id", async () => {
    // The given id names a session of each kind, each on another device than the load's.
    const thirdDevice = "33333333-3333-3333-3333-333333333333";
    await reactSession(NATIVE_ID, "13:52:20", OTHER_DEVICE);
    await run({ mode: "load_react", session_id: NATIVE_ID, device_id: thirdDevice });
    expect(getCachedProfilerPaths(PORT, thirdDevice)?.sessionId).toBe(NATIVE_ID);
    clearCachedProfilerPaths(PORT, thirdDevice);

    // The same for load_native: the React session with the id is on the device of a
    // native run, but the native session with the id is on another device.
    await fs.rm(path.join(debugDir, `react-profiler-${NATIVE_ID}_commits.json`));
    await reactSession(REACT_ID, "13:52:47", OTHER_DEVICE);
    const device = { id: thirdDevice, platform: "ios" as const, kind: "simulator" as const };
    const api = (await nativeProfilerSessionBlueprint.factory({}, device, { device })).api;
    await writeJson(`native-profiler-${REACT_ID}.trace.metadata.json`, {
      deviceId: DEVICE,
      wallClockStartMs: at("13:53:07.200"),
      stoppedAtMs: at("13:53:30"),
      cpuFilterPid: null,
      mallocStackLogging: null,
      appSuspensions: null,
      recordedMs: null,
      appEndedDuringCapture: false,
    });
    await fs.writeFile(
      path.join(debugDir, `native-profiler-${REACT_ID}_raw_hangs.xml`),
      "<trace-query-result><node></node></trace-query-result>"
    );
    await writeJson(`native-profiler-20261113-135230.trace.metadata.json`, {
      deviceId: OTHER_DEVICE,
      wallClockStartMs: at("13:52:30.500"),
      stoppedAtMs: at("13:53:08"),
      cpuFilterPid: null,
      mallocStackLogging: null,
      appSuspensions: null,
      recordedMs: null,
      appEndedDuringCapture: false,
    });
    const out = await run(
      { mode: "load_native", session_id: REACT_ID, device_id: thirdDevice },
      { session: api }
    );
    expect(out.startsWith(`Loaded native profiler session \`${REACT_ID}\``)).toBe(true);
  });

  it("names the devices when the runs of one id are on two devices and neither is the load's", async () => {
    const serial = "emulator-5554";
    const androidReactId = "20261113-135308";
    await fs.writeFile(path.join(debugDir, `native-profiler-${NATIVE_ID}.pftrace`), "x");
    await writeJson(`native-profiler-${NATIVE_ID}.pftrace.metadata.json`, {
      platform: "android",
      appProcess: "com.example.app",
      wallClockStartMs: at("13:52:45.700"),
      stoppedAtMs: at("13:53:11"),
      deviceId: serial,
    });
    await reactSession(androidReactId, "13:52:48", serial);
    await expect(
      run({ mode: "load_react", session_id: NATIVE_ID, device_id: OTHER_DEVICE })
    ).rejects.toThrow(
      `No React session has the id "${NATIVE_ID}". 2 React sessions recorded at the same time ` +
        `as a native session "${NATIVE_ID}": \`${REACT_ID}\` on ${DEVICE}, ` +
        `\`${androidReactId}\` on ${serial}. Pass one of them as session_id.`
    );
  });

  it("loads a React session keyed by Metro's logicalDeviceId by its id, with that id as device_id", async () => {
    // The stop of that session ran in the second this run's native start did.
    const logicalId = "1c3346c4a6889e88dbb8116da34f0f4af6f8067c";
    for (const runtimeDeviceId of [DEVICE, OTHER_DEVICE]) {
      await writeJson(`react-profiler-${NATIVE_ID}_commits.json`, {
        commits: [],
        meta: { profileStartWallMs: at("13:52:30"), deviceId: logicalId, runtimeDeviceId },
      });
      const out = await run({ mode: "load_react", session_id: NATIVE_ID, device_id: logicalId });
      expect(out.startsWith(`Loaded React profiler session \`${NATIVE_ID}\``)).toBe(true);
      expect(getCachedProfilerPaths(PORT, logicalId)?.sessionId).toBe(NATIVE_ID);
      clearCachedProfilerPaths(PORT, logicalId);
    }
  });

  it("pairs a provider's device: the native session saves its ext: id, the React session its serial", async () => {
    const serial = "emulator-5554";
    const extId = `ext:acme:${serial}`;
    await nativeSession(extId);
    await writeJson(`react-profiler-${REACT_ID}_commits.json`, {
      commits: [],
      meta: {
        profileStartWallMs: at("13:52:47"),
        deviceId: "904f32cb7611d7a43b99a5276e18506a3505b892",
        runtimeDeviceId: serial,
      },
    });
    expect(row(await run({ mode: "list" }), NATIVE_ID)).toContain(`\`${REACT_ID}\``);

    await nativeSession(serial);
    await reactSession(REACT_ID, "13:52:47", extId);
    expect(row(await run({ mode: "list" }), NATIVE_ID)).toContain(`\`${REACT_ID}\``);

    // Two providers' devices with one serial are two devices.
    await nativeSession(`ext:other:${serial}`);
    expect(row(await run({ mode: "list" }), NATIVE_ID)).not.toContain(REACT_ID);
  });

  it("names both ids when the run's native session has no exports", async () => {
    await fs.rm(path.join(debugDir, `native-profiler-${NATIVE_ID}_raw_hangs.xml`));
    const api = await buildIosSession();
    await expect(
      run({ mode: "load_native", session_id: REACT_ID }, { session: api })
    ).rejects.toThrow(
      `No native profiler XML files found for session "${NATIVE_ID}", the native session of ` +
        `the run of React session "${REACT_ID}".`
    );
  });

  it("an id with no session of either kind still fails", async () => {
    await expect(run({ mode: "load_react", session_id: "20200101-000000" })).rejects.toThrow(
      /No data found for React session "20200101-000000"/
    );
  });
});
