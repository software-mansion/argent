/**
 * End-to-end validation of stale-trace freshness flagging in the Android
 * native-profiler analyze report (PR #340, behavior 2).
 *
 * This drives the REAL pipeline → render path. Nothing in the freshness chain
 * is mocked: `analyzeNativeProfilerAndroid` calls `formatTraceFreshness(
 * api.wallClockStartMs, Date.now())` for real, threads the result into
 * `renderNativeProfilerReport`, and the renderer emits (or omits) the warning
 * line. Only the Perfetto WASM engine boundary (`ensureTraceProcessorReady` +
 * `runTpQuery`) is stubbed — exactly as native-profiler-analyze-failure.test.ts
 * does — so a minimal/empty `.pftrace` fixture is tolerated and we get a clean
 * "All clear" body to hang the freshness header off.
 *
 * Two layers are exercised:
 *   1. Persistence round-trip: the real `.pftrace.metadata.json` sidecar shape
 *      is written, then restored by the REAL `profilerLoadTool.execute`, which
 *      sets `api.wallClockStartMs`. The age matrix flows wallClockStartMs →
 *      sidecar → profiler-load → analyze → rendered freshness line.
 *   2. The freshness line in the final report is asserted AND console.logged so
 *      the real output is observable in the test run.
 *
 * Age matrix (relative to a frozen "now"): fresh (−2 min), boundary (−30 min),
 * stale minutes (−45 min), hours (−3 h), days (−2 d), and the unknown/guarded
 * cases (missing field, NaN, Infinity).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ArtifactStore } from "@argent/registry";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Stub ONLY the Perfetto engine boundary. The pipeline, render, and the entire
// freshness chain run for real against the empty .pftrace fixture.
vi.mock("../../src/utils/android-profiler/pipeline/run-tp", () => ({
  runTpQuery: vi.fn(),
}));
vi.mock("@argent/native-devtools-android", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@argent/native-devtools-android")>();
  return {
    ...actual,
    ensureTraceProcessorReady: vi.fn().mockResolvedValue(undefined),
  };
});

import { runTpQuery } from "../../src/utils/android-profiler/pipeline/run-tp";
import {
  nativeProfilerSessionBlueprint,
  type NativeProfilerSessionApi,
} from "../../src/blueprints/native-profiler-session";
import { profilerLoadTool } from "../../src/tools/profiler/query/profiler-load";
import { nativeProfilerAnalyzeTool } from "../../src/tools/profiler/native-profiler/native-profiler-analyze";
import {
  writeAndroidNativeProfilerMetadata,
  readAndroidNativeProfilerMetadata,
  androidNativeProfilerMetadataPath,
} from "../../src/utils/android-profiler/session-metadata";
import { RECORDING_CAP_MS } from "../../src/utils/profiler-shared/types";

const runTpQueryMock = runTpQuery as unknown as ReturnType<typeof vi.fn>;
const MIN = 60_000;
const SESSION_ID = "20260101-000000";
const SERIAL = "emulator-5554";

// Route the stubbed engine so the real pipeline produces a clean ("All clear")
// report: one CPU row whose leaf_function is null (the aggregator drops it, so
// bottlenecksTotal === 0 without tripping the "no CPU samples" fallback that a
// pair of empty results would). Mirrors the happy-path stub in
// native-profiler-analyze-failure.test.ts.
function routeCleanTrace(): void {
  runTpQueryMock.mockImplementation(async (opts: { query: string }) => {
    switch (opts.query) {
      case "trace-bounds.sql":
        return [{ start_ts: 0 }];
      case "cpu-hotspots.sql":
        return [
          {
            thread_name: "main",
            is_main_thread: 1,
            leaf_function: null,
            sample_count: 0,
            first_ts_ns: 0,
            last_ts_ns: 0,
            burst_windows: null,
            total_samples: 0,
          },
        ];
      case "ui-hangs.sql":
      case "memory-rss.sql":
        return [];
      default:
        throw new Error(`unexpected query ${opts.query}`);
    }
  });
}

async function buildAndroidSession(): Promise<NativeProfilerSessionApi> {
  const device = { id: SERIAL, platform: "android" as const, kind: "emulator" as const };
  const instance = await nativeProfilerSessionBlueprint.factory({}, device, { device });
  return instance.api;
}

/** Pull the rendered "Stale trace" line out of the report, if present. */
function staleLine(report: string): string | null {
  const line = report.split("\n").find((l) => l.includes("Stale trace"));
  return line ?? null;
}

describe("native-profiler freshness flagging — real analyze/render path", () => {
  let tempDir: string;
  let originalTmpdir: string | undefined;

  beforeEach(async () => {
    runTpQueryMock.mockReset();
    routeCleanTrace();
    // Resolve the isolated dir off the REAL tmpdir before we redirect TMPDIR.
    originalTmpdir = process.env.TMPDIR;
    tempDir = await mkdtemp(join(tmpdir(), "argent-freshness-e2e-"));
    // getDebugDir() = join(os.tmpdir(), "argent-profiler-cwd"); profiler-load
    // resolves it dynamically, so redirect os.tmpdir() via TMPDIR to our
    // isolated dir. The session_id .pftrace then lives under <TMPDIR>/argent-
    // profiler-cwd/.
    process.env.TMPDIR = tempDir;
  });

  afterEach(async () => {
    // Restore TMPDIR FIRST so the cleanup rm and any later suite resolve the
    // real tmpdir again — leaving it pointed at the (about-to-be-deleted) temp
    // dir breaks every subsequent os.tmpdir() consumer.
    if (originalTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = originalTmpdir;
    await rm(tempDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  // Directory getDebugDir() resolves to once TMPDIR points at tempDir.
  function debugDir(): string {
    return join(tempDir, "argent-profiler-cwd");
  }

  /**
   * Write the .pftrace fixture (empty file — the stubbed engine tolerates it)
   * plus the REAL metadata sidecar carrying `wallClockStartMs`, then restore it
   * via the real profiler-load tool and run the real analyze tool. Returns the
   * rendered report.
   */
  async function loadThenAnalyze(wallClockStartMs: number | null): Promise<string> {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(debugDir(), { recursive: true });
    const pftrace = join(debugDir(), `native-profiler-${SESSION_ID}.pftrace`);
    await writeFile(pftrace, "", "utf8");
    await writeAndroidNativeProfilerMetadata(pftrace, {
      platform: "android",
      appProcess: "com.example.app",
      wallClockStartMs,
    });

    const api = await buildAndroidSession();

    // Real restore: profiler-load reads the sidecar and sets api.wallClockStartMs.
    await profilerLoadTool.execute({ session: api } as never, {
      mode: "load_native",
      session_id: SESSION_ID,
      port: 8081,
      device_id: SERIAL,
    });

    // Real analyze: runs the pipeline (engine stubbed), then
    // formatTraceFreshness(api.wallClockStartMs, Date.now()) for real, threads
    // the note into the renderer.
    const result = await nativeProfilerAnalyzeTool.execute(
      { session: api } as never,
      { device_id: SERIAL },
      { artifacts: new ArtifactStore() } as never
    );
    return result.report;
  }

  it("a just-made capture (−2 min) is NEVER flagged stale", async () => {
    const report = await loadThenAnalyze(Date.now() - 2 * MIN);
    const line = staleLine(report);
    console.log(`[freshness E2E] −2 min  → ${line ?? "(no stale flag — FRESH)"}`);
    expect(line).toBeNull();
    expect(report).toContain("All clear");
  });

  it("a capture at the RECORDING_CAP_MS limit is still fresh (10-min cap < 30-min stale)", async () => {
    // The hard recording cap is 10 min; even a trace recorded right up to the
    // cap and analyzed instantly is well under the 30-min stale threshold.
    const report = await loadThenAnalyze(Date.now() - RECORDING_CAP_MS);
    const line = staleLine(report);
    console.log(`[freshness E2E] −RECORDING_CAP (10 min) → ${line ?? "(no stale flag — FRESH)"}`);
    expect(line).toBeNull();
  });

  it("the exact 30-min boundary IS flagged stale (ageMs === STALE_AFTER_MS)", async () => {
    const report = await loadThenAnalyze(Date.now() - 30 * MIN);
    const line = staleLine(report);
    console.log(`[freshness E2E] −30 min (boundary) → ${line}`);
    expect(line).toMatch(/Stale trace/);
    expect(line).toMatch(/30 minutes ago/);
  });

  it("a 45-min-old trace is flagged stale, in minutes", async () => {
    const report = await loadThenAnalyze(Date.now() - 45 * MIN);
    const line = staleLine(report);
    console.log(`[freshness E2E] −45 min → ${line}`);
    expect(line).toMatch(/Stale trace/);
    expect(line).toMatch(/45 minutes ago/);
  });

  it("a 3-hour-old trace is flagged stale, in hours", async () => {
    const report = await loadThenAnalyze(Date.now() - 3 * 60 * MIN);
    const line = staleLine(report);
    console.log(`[freshness E2E] −3 h → ${line}`);
    expect(line).toMatch(/Stale trace/);
    expect(line).toMatch(/3 hours ago/);
  });

  it("a 2-day-old trace is flagged stale, in days", async () => {
    const report = await loadThenAnalyze(Date.now() - 2 * 24 * 60 * MIN);
    const line = staleLine(report);
    console.log(`[freshness E2E] −2 d → ${line}`);
    expect(line).toMatch(/Stale trace/);
    expect(line).toMatch(/2 days ago/);
  });

  it("a sidecar with a MISSING wallClockStartMs is guarded (no flag, no NaN/Invalid Date)", async () => {
    const report = await loadThenAnalyze(null);
    const line = staleLine(report);
    console.log(`[freshness E2E] wallClockStartMs=null → ${line ?? "(no stale flag — guarded)"}`);
    expect(line).toBeNull();
    expect(report).not.toMatch(/NaN/);
    expect(report).not.toMatch(/Invalid Date/);
  });

  it("a non-finite wallClockStartMs (NaN) is guarded — never throws, never renders garbage", async () => {
    // The sidecar reader rejects non-number wallClockStartMs, so a NaN can only
    // reach analyze via an in-memory session (e.g. a future code path setting
    // it). Assert the guard at the analyze boundary directly with the same
    // engine stub in force.
    const api = await buildAndroidSession();
    const { mkdir } = await import("node:fs/promises");
    await mkdir(debugDir(), { recursive: true });
    const pftrace = join(debugDir(), `native-profiler-${SESSION_ID}.pftrace`);
    await writeFile(pftrace, "", "utf8");
    api.appProcess = "com.example.app";
    api.exportedFiles = { pftrace };
    api.wallClockStartMs = NaN;

    const result = await nativeProfilerAnalyzeTool.execute(
      { session: api } as never,
      { device_id: SERIAL },
      { artifacts: new ArtifactStore() } as never
    );
    console.log(
      `[freshness E2E] wallClockStartMs=NaN → ${staleLine(result.report) ?? "(no stale flag — guarded)"}`
    );
    expect(staleLine(result.report)).toBeNull();
    expect(result.report).not.toMatch(/NaN/);
    expect(result.report).not.toMatch(/Invalid Date/);

    api.wallClockStartMs = Infinity;
    const result2 = await nativeProfilerAnalyzeTool.execute(
      { session: api } as never,
      { device_id: SERIAL },
      { artifacts: new ArtifactStore() } as never
    );
    console.log(
      `[freshness E2E] wallClockStartMs=Infinity → ${staleLine(result2.report) ?? "(no stale flag — guarded)"}`
    );
    expect(staleLine(result2.report)).toBeNull();
    expect(result2.report).not.toMatch(/Invalid Date/);
  });
});

describe("Android profiler metadata sidecar — wallClockStartMs persistence round-trip", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "argent-sidecar-"));
  });
  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("persists and restores a numeric wallClockStartMs verbatim", async () => {
    const pftrace = join(tempDir, "native-profiler-x.pftrace");
    const wall = 1_710_000_000_000;
    await writeAndroidNativeProfilerMetadata(pftrace, {
      platform: "android",
      appProcess: "com.example.app",
      wallClockStartMs: wall,
    });
    // Inspect the on-disk sidecar shape too — this is the contract profiler-load
    // and the device-side stop path both depend on.
    const raw = JSON.parse(await readFile(androidNativeProfilerMetadataPath(pftrace), "utf8"));
    expect(raw).toMatchObject({
      platform: "android",
      appProcess: "com.example.app",
      wallClockStartMs: wall,
    });

    const restored = await readAndroidNativeProfilerMetadata(pftrace);
    expect(restored).toEqual({
      platform: "android",
      appProcess: "com.example.app",
      wallClockStartMs: wall,
    });
  });

  it("persists and restores a null wallClockStartMs (unknown capture time)", async () => {
    const pftrace = join(tempDir, "native-profiler-y.pftrace");
    await writeAndroidNativeProfilerMetadata(pftrace, {
      platform: "android",
      appProcess: "com.example.app",
      wallClockStartMs: null,
    });
    const restored = await readAndroidNativeProfilerMetadata(pftrace);
    expect(restored?.wallClockStartMs).toBeNull();
  });

  it("returns null when the sidecar is absent (ENOENT, not a throw)", async () => {
    const pftrace = join(tempDir, "native-profiler-missing.pftrace");
    expect(await readAndroidNativeProfilerMetadata(pftrace)).toBeNull();
  });

  it("throws on a corrupt sidecar where wallClockStartMs is the wrong type", async () => {
    const pftrace = join(tempDir, "native-profiler-bad.pftrace");
    await writeFile(
      androidNativeProfilerMetadataPath(pftrace),
      JSON.stringify({
        platform: "android",
        appProcess: "com.example.app",
        wallClockStartMs: "nope",
      }),
      "utf8"
    );
    await expect(readAndroidNativeProfilerMetadata(pftrace)).rejects.toThrow(
      /Invalid Android profiler metadata/
    );
  });
});
