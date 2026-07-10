/**
 * Finding 0 (pass-4): profiler-combined-report anchors the FROZEN
 * parsedData.uiHangs to the LIVE nativeApi.wallClockStartMs. A capture started
 * after analyze re-stamps wallClockStartMs (and traceFile) to the new
 * recording, so the report would shift every frozen hang by the gap between the
 * two recordings' starts — real hang↔commit correlations silently render as
 * "Hangs Without React Commit Match" and the "Clock offset" line is wrong.
 *
 * analyze and profiler-load already refuse this exact state (a capture in
 * flight or a partial trace pending recovery); combined-report must too. The
 * guard fires before any data is loaded, so these tests need no react/native
 * fixtures — reaching data-loading at all would be the bug.
 */
import { describe, it, expect } from "vitest";
import { getFailureSignal } from "@argent/registry";
import {
  nativeProfilerSessionBlueprint,
  type NativeProfilerSessionApi,
  type NativeProfilerParsedData,
} from "../../src/blueprints/native-profiler-session";
import { profilerCombinedReportTool } from "../../src/tools/profiler/combined/profiler-combined-report";

async function buildIosSession(): Promise<NativeProfilerSessionApi> {
  const device = { id: "ios-sim", platform: "ios" as const, kind: "simulator" as const };
  const instance = await nativeProfilerSessionBlueprint.factory({}, device, { device });
  return instance.api;
}

// A non-empty frozen parsedData the report would consume if the guard let it
// through — its identity is asserted untouched after each refusal.
function frozenParsedData(): NativeProfilerParsedData {
  return {
    cpuSamples: [],
    uiHangs: [
      {
        type: "ui_hang",
        platform: "ios",
        hangType: "Hang",
        startNs: 1_000_000,
        endNs: 2_000_000,
        durationMs: 1,
        startTimeFormatted: "0:01",
        severity: "RED",
        suspectedFunctions: [],
        appCallChains: [],
      },
    ],
    cpuHotspots: [],
    memoryLeaks: [],
    mallocStackLogging: true,
  };
}

async function expectRefusal(api: NativeProfilerSessionApi, messagePattern: RegExp) {
  const frozen = api.parsedData;
  let error: unknown;
  try {
    await profilerCombinedReportTool.execute({ nativeSession: api } as never, {
      port: 8081,
      device_id: "ios-sim",
    });
    throw new Error("expected profiler-combined-report to refuse, but it resolved");
  } catch (err) {
    error = err;
  }
  expect((error as Error).message).toMatch(messagePattern);
  expect(getFailureSignal(error)?.error_code).toBe("NATIVE_PROFILER_SESSION_ALREADY_RUNNING");
  // Guard fired before any rendering — the frozen capture data is untouched.
  expect(api.parsedData).toBe(frozen);
}

describe("profiler-combined-report in-flight guard (pass-4 finding 0)", () => {
  it("refuses while a newer recording is active, distinguishing it as recording", async () => {
    const api = await buildIosSession();
    api.parsedData = frozenParsedData();
    api.wallClockStartMs = 5_000_000; // re-stamped by the NEW capture
    api.traceFile = "/tmp/new-capture.trace";
    api.profilingActive = true;

    await expectRefusal(api, /is recording on this device/);
  });

  it("refuses while a timed-out capture awaits recovery, naming the 10-minute cap", async () => {
    const api = await buildIosSession();
    api.parsedData = frozenParsedData();
    api.wallClockStartMs = 5_000_000;
    api.traceFile = "/tmp/timed-out.trace";
    api.recordingTimedOut = true;

    await expectRefusal(api, /10-minute recording cap/);
  });

  it("refuses while a crashed capture awaits recovery, naming the unexpected exit", async () => {
    const api = await buildIosSession();
    api.parsedData = frozenParsedData();
    api.wallClockStartMs = 5_000_000;
    api.traceFile = "/tmp/crashed.trace";
    api.recordingExitedUnexpectedly = true;
    api.lastExitInfo = { code: 137, signal: "SIGKILL" };

    await expectRefusal(api, /ended unexpectedly/);
  });
});
