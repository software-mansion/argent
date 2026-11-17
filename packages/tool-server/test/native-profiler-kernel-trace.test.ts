/**
 * For each recording, xctrace's helper writes the raw kernel trace to
 * `instruments<random>.ktrace` in the user's temporary folder (150 MB to more
 * than 1 GB), keeps it open after xctrace exits, and never deletes it. argent
 * deletes the file of its own recording once xctrace has exited. A stub
 * `xctrace` first on PATH writes such a file at its start and leaves a process
 * that holds it open, as the helper does; the table export is faked.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { DeviceInfo } from "@argent/registry";

// No notifyutil off macOS: the start waits for the stub's output.
vi.mock("../src/utils/ios-profiler/notify", () => ({
  listenForDarwinNotification: vi.fn(() => {
    throw new Error("notifyutil unavailable in this test");
  }),
}));
vi.mock("../src/utils/ios-profiler/export", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/ios-profiler/export")>()),
  exportIosTraceData: vi.fn(async () => ({
    files: { cpu: "/tmp/cpu.xml", hangs: "/tmp/hangs.xml", leaks: "/tmp/leaks.xml" },
    diagnostics: { tocSchemas: ["time-profile"], cpuSchemaUsed: "time-profile", errors: {} },
  })),
}));

import {
  nativeProfilerSessionBlueprint,
  type NativeProfilerSessionApi,
} from "../src/blueprints/native-profiler-session";
import { stopNativeProfilerIos } from "../src/tools/profiler/native-profiler/platforms/ios";
import {
  commitXctraceRecording,
  spawnXctraceRecording,
  xctraceOutput,
} from "../src/tools/profiler/native-profiler/platforms/xctrace";
// test/setup/isolate-kernel-traces.ts gives each test file an empty folder.
import { kernelTraceDir } from "../src/utils/ios-profiler/kernel-trace";
import { resolveDevice } from "../src/utils/device-info";

let dir: string;
let ktraces: string;
let originalPath: string | undefined;

/** How the stub behaves at its start: see the script below. */
function stub(settings: {
  mode: "one" | "two" | "fail" | "lost";
  holdS?: number;
  growS?: number;
}): void {
  fs.writeFileSync(path.join(dir, "mode"), settings.mode);
  fs.writeFileSync(path.join(dir, "hold"), String(settings.holdS ?? 20));
  fs.writeFileSync(path.join(dir, "grow"), String(settings.growS ?? 0));
}

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "argent-ktrace-test-"));
  ktraces = kernelTraceDir();
  fs.writeFileSync(
    path.join(dir, "xctrace"),
    `#!/bin/bash
ctl="${dir}"
mode=$(cat "$ctl/mode"); hold=$(cat "$ctl/hold"); grow=$(cat "$ctl/grow")
kernel_trace() {
  f="${ktraces}/instruments$RANDOM$RANDOM.ktrace"
  head -c 1048576 /dev/zero > "$f"
  # The helper: holds the file open, writes to it for $grow s, outlives xctrace.
  ( exec 3>>"$f"; end=$((SECONDS + grow)); while [ $SECONDS -lt $end ]; do head -c 65536 /dev/zero >&3; sleep 0.2; done; sleep "$hold" ) </dev/null >/dev/null 2>&1 &
  echo $! >> "$ctl/holders"
}
if [ "$mode" = fail ]; then kernel_trace; echo "* [Error] attach failed"; exit 1; fi
if [ "$mode" = lost ]; then
  # Another recording holds the kernel trace: its helper creates its file, and
  # this xctrace, which cannot start its recording, gets none.
  echo "Starting recording with the Argent template."
  sleep 0.5
  kernel_trace
  sleep 0.5
  echo "Ctrl-C to stop the recording"
  sleep 0.3
  echo "Run issues were detected (trace is still ready to be viewed):"
  echo "* [Error] Failed to start the recording: _lockKPerf: could not lock kperf. Likely another session just started."
  exit 2
fi
trap 'echo "Stopping recording..."; echo "Recording completed. Saving output file..."; exit 0' INT
# As xctrace prints it: the helper creates the file after "Starting recording".
echo "Starting recording with the Argent template."
sleep 0.5
kernel_trace
[ "$mode" = two ] && kernel_trace
sleep 0.5
echo "Ctrl-C to stop the recording"
while true; do sleep 0.05; done
`,
    { mode: 0o755 }
  );
  originalPath = process.env.PATH;
  process.env.PATH = `${dir}:${originalPath}`;
});

afterAll(() => {
  process.env.PATH = originalPath;
  fs.rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  fs.rmSync(path.join(dir, "holders"), { force: true });
});

afterEach(() => {
  // The stand-ins for the helper, which outlive the stub.
  const holders = fs.existsSync(path.join(dir, "holders"))
    ? fs.readFileSync(path.join(dir, "holders"), "utf8").split("\n").filter(Boolean)
    : [];
  for (const pid of holders) {
    try {
      process.kill(Number(pid), "SIGKILL");
    } catch {
      // already gone
    }
  }
  for (const name of fs.readdirSync(ktraces)) fs.rmSync(path.join(ktraces, name), { force: true });
});

const IOS = "6DBF83B4-0000-0000-0000-00000000C7AC";

function kernelTraceFiles(): string[] {
  return fs
    .readdirSync(ktraces)
    .filter((name) => name.endsWith(".ktrace"))
    .map((name) => path.join(ktraces, name));
}

/** Another recording's file, there before the start. */
function foreignKernelTrace(): string {
  const file = path.join(ktraces, "instrumentsOTHER1.ktrace");
  fs.writeFileSync(file, Buffer.alloc(4096));
  return file;
}

async function newSession(): Promise<NativeProfilerSessionApi> {
  const device: DeviceInfo = resolveDevice(IOS);
  return (await nativeProfilerSessionBlueprint.factory({}, device, { device } as never)).api;
}

async function recording(): Promise<NativeProfilerSessionApi> {
  const api = await newSession();
  const traceFile = path.join(dir, `native-profiler-${Date.now()}.trace`);
  fs.mkdirSync(traceFile, { recursive: true });
  const started = await spawnXctraceRecording(api, () => ["record", "--output", traceFile]);
  commitXctraceRecording(api, started, {
    appProcess: "ProfProbe",
    traceFile,
    mallocStackLogging: false,
    cpuFilterPid: 4242,
  });
  // The start returns at "Starting recording", before the helper creates the file.
  await vi.waitFor(() => expect(xctraceOutput(api.captureProcess!)).toContain("Ctrl-C to stop"), {
    timeout: 10_000,
    interval: 100,
  });
  return api;
}

const gone = (file: string) =>
  vi.waitFor(() => expect(fs.existsSync(file)).toBe(false), { timeout: 15_000, interval: 200 });

describe("the raw kernel trace of a recording", () => {
  it("is deleted after the stop, and emptied while the helper still holds it open", async () => {
    stub({ mode: "one" });
    const other = foreignKernelTrace();
    const api = await recording();
    const [file] = kernelTraceFiles().filter((f) => f !== other);
    const held = fs.openSync(file, "r");

    try {
      await stopNativeProfilerIos(api);
      await gone(file);
      expect(fs.fstatSync(held).size).toBe(0);
    } finally {
      fs.closeSync(held);
    }
    expect(fs.statSync(other).size).toBe(4096);
  }, 30_000);

  it("is deleted when xctrace ends without a stop", async () => {
    stub({ mode: "one" });
    const api = await recording();
    const [file] = kernelTraceFiles();

    api.captureProcess!.kill("SIGINT");
    await gone(file);
    expect(api.recordingExitedUnexpectedly).toBe(true);
  }, 30_000);

  it("stays after a start that failed, as nothing tells whose it is", async () => {
    stub({ mode: "fail" });
    await expect(recording()).rejects.toThrow();
    const files = kernelTraceFiles();
    expect(files).toHaveLength(1);

    // Past the 2 s in which an idle file of an ended xctrace is deleted.
    await new Promise((r) => setTimeout(r, 5_000));
    expect(kernelTraceFiles()).toEqual(files);
  }, 30_000);

  it("stays when xctrace could not start the recording, as the new file is another recording's", async () => {
    stub({ mode: "lost" });
    const started = await spawnXctraceRecording(await newSession(), () => ["record"]);
    await vi.waitFor(() => expect(started.child.exitCode).toBe(2), { timeout: 10_000 });
    const files = kernelTraceFiles();
    expect(files).toHaveLength(1);

    await new Promise((r) => setTimeout(r, 5_000));
    expect(kernelTraceFiles()).toEqual(files);
  }, 30_000);

  it("is deleted only once nothing writes to it any more", async () => {
    stub({ mode: "one", growS: 4 });
    const api = await recording();
    const [file] = kernelTraceFiles();

    await stopNativeProfilerIos(api);
    await new Promise((r) => setTimeout(r, 2_500));
    expect(fs.existsSync(file)).toBe(true);
    await gone(file);
  }, 30_000);

  it("stays when two recordings started at once, as nothing tells which file is whose", async () => {
    stub({ mode: "two" });
    const api = await recording();
    const files = kernelTraceFiles();
    expect(files).toHaveLength(2);

    await stopNativeProfilerIos(api);
    await new Promise((r) => setTimeout(r, 5_000));
    expect(kernelTraceFiles().sort()).toEqual(files.sort());
  }, 30_000);
});
