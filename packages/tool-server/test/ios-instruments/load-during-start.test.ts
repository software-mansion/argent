/**
 * load_native refuses while a capture holds the session, but it read the trace
 * after that check: a native-profiler-start during the parse got the old
 * session's trace and start time written over its own, and its stop then
 * exported the old trace. The load now checks again before it writes anything.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";
import {
  nativeProfilerSessionBlueprint,
  type NativeProfilerSessionApi,
} from "../../src/blueprints/native-profiler-session";

let debugDir = "";
/** Set by a test: holds the load in its read until the test lets it go on. */
let hold: Promise<void> | null = null;
let held: () => void = () => {};

vi.mock("../../src/utils/react-profiler/debug/dump", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getDebugDir: async () => debugDir,
}));
vi.mock("../../src/utils/ios-profiler/pipeline/index", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/utils/ios-profiler/pipeline/index")>();
  return {
    ...real,
    runIosProfilerPipeline: async (...args: Parameters<typeof real.runIosProfilerPipeline>) => {
      held();
      await hold;
      return real.runIosProfilerPipeline(...args);
    },
  };
});
vi.mock("../../src/utils/android-profiler/session-metadata", async (importOriginal) => {
  const real =
    await importOriginal<typeof import("../../src/utils/android-profiler/session-metadata")>();
  return {
    ...real,
    readAndroidNativeProfilerMetadata: async (
      ...args: Parameters<typeof real.readAndroidNativeProfilerMetadata>
    ) => {
      held();
      await hold;
      return real.readAndroidNativeProfilerMetadata(...args);
    },
  };
});

import { profilerLoadTool } from "../../src/tools/profiler/query/profiler-load";

const OLD = "20261110-100000";
const OLD_START = Date.parse("2026-11-10T10:00:00Z");

beforeEach(async () => {
  debugDir = await fs.mkdtemp(path.join(os.tmpdir(), "argent-load-during-start-"));
});
afterEach(async () => {
  await fs.rm(debugDir, { recursive: true, force: true });
});

async function sessionOf(id: string, platform: "ios" | "android") {
  const device = { id, platform, kind: platform === "ios" ? "simulator" : "emulator" } as const;
  return (await nativeProfilerSessionBlueprint.factory({}, device, { device })).api;
}

/** Starts a load, lets a recording start while the load reads, and returns the load's outcome. */
async function loadWhileStarting(api: NativeProfilerSessionApi, deviceId: string) {
  let release: () => void = () => {};
  hold = new Promise<void>((r) => (release = r));
  const reading = new Promise<void>((r) => (held = r));
  const load = profilerLoadTool
    .execute(
      { session: api } as never,
      {
        mode: "load_native",
        session_id: OLD,
        device_id: deviceId,
        port: 8081,
      } as never
    )
    .then(
      () => null,
      (err: unknown) => err
    );
  await reading;
  // What a successful native-profiler-start sets.
  api.profilingActive = true;
  api.traceFile = path.join(debugDir, "native-profiler-20261113-224900.trace");
  api.wallClockStartMs = Date.now();
  const live = { traceFile: api.traceFile, wallClockStartMs: api.wallClockStartMs };
  release();
  return { error: await load, live };
}

describe("load_native while a recording starts", () => {
  it("leaves an xctrace recording that started during the parse as it is", async () => {
    const udid = "11111111-1111-1111-1111-111111111111";
    await fs.writeFile(
      path.join(debugDir, `native-profiler-${OLD}_raw_hangs.xml`),
      "<trace-query-result><node></node></trace-query-result>"
    );
    await fs.writeFile(
      path.join(debugDir, `native-profiler-${OLD}.trace.metadata.json`),
      JSON.stringify({
        wallClockStartMs: OLD_START,
        cpuFilterPid: null,
        mallocStackLogging: null,
        appSuspensions: null,
        recordedMs: null,
        appEndedDuringCapture: false,
      })
    );
    const api = await sessionOf(udid, "ios");

    const { error, live } = await loadWhileStarting(api, udid);

    expect(String(error)).toContain("A native profiling session is recording on this device.");
    expect(api.traceFile).toBe(live.traceFile);
    expect(api.wallClockStartMs).toBe(live.wallClockStartMs);
    expect(api.parsedData).toBeNull();
    expect(api.exportedFiles).toBeNull();
  });

  it("leaves an Android recording that started during the metadata read as it is", async () => {
    const serial = "emulator-5554";
    const pftrace = path.join(debugDir, `native-profiler-${OLD}.pftrace`);
    await fs.writeFile(pftrace, "x");
    await fs.writeFile(
      `${pftrace}.metadata.json`,
      JSON.stringify({
        platform: "android",
        appProcess: "com.example.old",
        wallClockStartMs: OLD_START,
      })
    );
    const api = await sessionOf(serial, "android");

    const { error, live } = await loadWhileStarting(api, serial);

    expect(String(error)).toContain("A native profiling session is recording on this device.");
    expect(api.traceFile).toBe(live.traceFile);
    expect(api.wallClockStartMs).toBe(live.wallClockStartMs);
    expect(api.exportedFiles).toBeNull();
  });
});
