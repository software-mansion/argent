import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import { finalizeEncoder, encoderDiagnostics } from "../src/tools/screen-recording/encoder";

afterEach(() => vi.useRealTimers());

it("keeps finalization pending until the killed encoder exits or its reap grace expires", async () => {
  vi.useFakeTimers();
  const child = Object.assign(new EventEmitter(), {
    stderr: new EventEmitter(),
    exitCode: null,
    signalCode: null,
    kill: vi.fn(),
  });
  let complete = false;
  const ending = finalizeEncoder(child as unknown as ChildProcess, true).then((result) => {
    complete = true;
    return result;
  });
  await vi.advanceTimersByTimeAsync(25_000);
  expect(child.kill).toHaveBeenLastCalledWith("SIGKILL");
  expect(complete).toBe(false);
  child.emit("exit", null, "SIGKILL");
  child.emit("close", null, "SIGKILL");
  expect(await ending).toBe(false);
});

it("expires the progress grace after advancing frames stall", async () => {
  vi.useFakeTimers();
  const child = Object.assign(new EventEmitter(), {
    stderr: new EventEmitter(),
    exitCode: null,
    signalCode: null,
    kill: vi.fn(),
  });
  const ending = finalizeEncoder(child as unknown as ChildProcess, true);
  for (let frame = 1; frame <= 5; frame++) {
    await vi.advanceTimersByTimeAsync(250);
    child.stderr.emit("data", Buffer.from(`frame=${frame}\n`));
  }
  await vi.advanceTimersByTimeAsync(19_999);
  expect(child.kill).not.toHaveBeenCalled();
  child.stderr.emit("data", Buffer.from("frame=5\n"));
  await vi.advanceTimersByTimeAsync(1);
  expect(child.kill).toHaveBeenLastCalledWith("SIGINT");
  await vi.advanceTimersByTimeAsync(5_000);
  expect(child.kill).toHaveBeenLastCalledWith("SIGKILL");
  child.emit("exit", null, "SIGKILL");
  child.emit("close", null, "SIGKILL");
  expect(await ending).toBe(false);
});

it("retains a long failing input path beyond the old 300-character diagnostic limit", () => {
  const file = `/var/folders/${"scratch-directory/".repeat(23)}argent-recording-frames-73189-cKAT6a/60.jpg`;
  const message = `[concat @ 0x123456789] Impossible to open 'file:${file}'\n[in#0/concat @ 0x123456789] Error opening input file\n`;
  expect(message.length).toBeGreaterThan(300);
  const diagnostics = encoderDiagnostics(message + "frame=60\nprogress=end\n");
  expect(diagnostics).toContain(`Impossible to open 'file:${file}'`);
  expect(diagnostics).not.toContain("progress=end");
});

it.each([
  "frame=174",
  "fps=29.98",
  "stream_0_0_q=12.0",
  "bitrate=2300.0kbits/s",
  "total_size=123456",
  "out_time_us=5800000",
  "out_time_ms=5800000",
  "out_time=00:00:05.800000",
  "dup_frames=0",
  "drop_frames=0",
  "speed=0.85x",
  "progress=continue",
])("keeps decoder diagnostics after repeated %s progress", (line) => {
  const diagnostic = "No JPEG data found in image";
  const stderr = diagnostic + "\n" + (line + "\n").repeat(500);
  expect(encoderDiagnostics(stderr)).toBe(diagnostic);
});

it("retains diagnostic text containing a progress-like key away from line start", () => {
  expect(encoderDiagnostics("decoder rejected frame=174\nprogress=end\n")).toBe(
    "decoder rejected frame=174"
  );
});
