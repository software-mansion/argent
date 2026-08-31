import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { execFileSync } from "child_process";
import { promises as fs } from "fs";
import { execFile } from "child_process";
import { promisify } from "util";
import os from "os";
import path from "path";
import type { DeviceInfo } from "@argent/registry";

vi.mock("../src/utils/sim-remote", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/utils/sim-remote")>();
  return { ...actual, screenRecordStart: vi.fn(), screenRecordStop: vi.fn() };
});

import {
  screenRecordingSessionBlueprint,
  type ScreenRecordingSessionApi,
} from "../src/blueprints/screen-recording-session";
import {
  startRemoteCapture,
  stopRemoteCapture,
} from "../src/tools/screen-recording/capture-remote";
import { screenRecordStart, screenRecordStop } from "../src/utils/sim-remote";
import { redirectTmpdir } from "./helpers/tmpdir-env";

const execFileAsync = promisify(execFile);

/**
 * The post-pass is the one part of remote recording that runs a real encoder,
 * and the filter chain is the part that a mock cannot vouch for: a graph that
 * silently drops half a video's frames, or an mpdecimate threshold tuned for
 * telecine, both look identical to a stub. So this suite runs ffmpeg for real
 * over a clip with known dead air — and skips where ffmpeg is not installed,
 * which is a supported state for remote recording (the video still comes back,
 * untrimmed, with a warning; that path is covered in screen-recording-remote).
 */
function hasFfmpeg(): boolean {
  for (const bin of ["ffmpeg", "ffprobe"]) {
    try {
      execFileSync("/bin/sh", ["-c", `command -v ${bin}`], { stdio: "ignore" });
    } catch {
      return false;
    }
  }
  return true;
}

const REMOTE_UDID = "remote:6DBF83B4-0000-0000-0000-000000000000";
const device = { id: REMOTE_UDID, platform: "ios-remote", kind: "simulator" } as DeviceInfo;

/** 10s clip: 3s of motion, 4s frozen, 3s of motion — a recording with dead air. */
async function makeSourceVideo(file: string): Promise<void> {
  await execFileAsync("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc=size=390x844:rate=30:duration=3",
    "-f",
    "lavfi",
    "-i",
    "color=c=blue:size=390x844:rate=30:duration=4",
    "-f",
    "lavfi",
    "-i",
    "testsrc=size=390x844:rate=30:duration=3",
    "-filter_complex",
    "[0:v][1:v][2:v]concat=n=3:v=1[out]",
    "-map",
    "[out]",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-y",
    file,
  ]);
}

async function durationSeconds(file: string): Promise<number> {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "format=duration",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    file,
  ]);
  return Number(String(stdout).trim());
}

describe.skipIf(!hasFfmpeg())("remote recording post-pass (real ffmpeg)", () => {
  let tmpDir: string;
  let restore: () => void;
  beforeEach(async () => {
    vi.clearAllMocks();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "argent-postpass-"));
    restore = redirectTmpdir(tmpDir);
    vi.mocked(screenRecordStart).mockResolvedValue(undefined);
    vi.mocked(screenRecordStop).mockImplementation(async (_u: string, out: string) => {
      await makeSourceVideo(out);
    });
  });
  afterEach(async () => {
    restore();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function run(opts: { trimStatic: boolean; watermark: boolean }) {
    const instance = await screenRecordingSessionBlueprint.factory({}, device, { device } as never);
    const api = instance.api as ScreenRecordingSessionApi;
    await startRemoteCapture(api, { timeLimitSeconds: 60, showTouches: false, ...opts });
    return stopRemoteCapture(api);
  }

  it("trims dead air out of the downloaded video", async () => {
    const stopped = await run({ trimStatic: true, watermark: false });
    expect(stopped.warning).toBeUndefined();
    const seconds = await durationSeconds(stopped.outputFile);
    console.log(
      "trimmed duration:",
      seconds,
      "durationMs:",
      stopped.durationMs,
      "warning:",
      stopped.warning
    );
    expect(seconds).toBeLessThan(8);
    expect(seconds).toBeGreaterThan(5.5);
    expect(stopped.wallClockMs).toBeGreaterThan(9_000);
    expect(stopped.trimmedMs).toBeGreaterThan(3_000);
  }, 120_000);

  it("watermarks and trims in one pass", async () => {
    const stopped = await run({ trimStatic: true, watermark: true });
    expect(stopped.warning).toBeUndefined();
    expect(stopped.sizeBytes).toBeGreaterThan(0);
    const { stdout } = await execFileAsync("ffprobe", [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=width,height",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      stopped.outputFile,
    ]);
    expect(String(stdout).trim().split(/\s+/)).toEqual(["390", "844"]);
  }, 120_000);

  it("watermarks without trimming, keeping real time", async () => {
    const stopped = await run({ trimStatic: false, watermark: true });
    expect(stopped.warning).toBeUndefined();
    const seconds = await durationSeconds(stopped.outputFile);
    expect(seconds).toBeGreaterThan(9);
    expect(stopped.durationMs).toBeGreaterThan(9_000);
    expect(stopped.trimmedMs).toBeUndefined();
  }, 120_000);
});
