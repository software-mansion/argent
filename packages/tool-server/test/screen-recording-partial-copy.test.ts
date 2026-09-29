import { describe, it, expect, vi } from "vitest";
import os from "os";
import path from "path";
import { getFailureSignal, FAILURE_CODES, type DeviceInfo } from "@argent/registry";

/**
 * A copy out of simulator-server that dies part-way is the one destination
 * failure the main suite cannot stage: its test puts a directory at the
 * destination, so `copyFile` fails with EISDIR having written nothing. A full
 * disk or a file-size limit does the opposite — it accepts the create and then
 * refuses the rest of the bytes, leaving a truncated mp4 at exactly the path
 * `screen-recording-start` handed the caller.
 *
 * Mocked at the module boundary; the real `writeFile` still runs, so the partial
 * file left behind is a real one.
 */
const partialCopyTargets: string[] = [];
vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return {
    ...actual,
    default: actual,
    promises: {
      ...actual.promises,
      copyFile: vi.fn(async (src: string, dest: string, mode?: number) => {
        if (partialCopyTargets.includes(dest)) {
          await actual.promises.writeFile(dest, Buffer.alloc(4));
          throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
        }
        return actual.promises.copyFile(src, dest, mode);
      }),
    },
  };
});

// `vi.mock` is hoisted above these, so they resolve against the mocked module.
import { promises as fs } from "fs";
import { startCapture, stopCapture } from "../src/tools/screen-recording/capture";
import {
  screenRecordingSessionBlueprint,
  type ScreenRecordingSessionApi,
} from "../src/blueprints/screen-recording-session";
import type { ServerRecordingControl } from "../src/tools/screen-recording/server-capture";

const iosDevice = {
  id: "11111111-2222-3333-4444-555555555555",
  platform: "ios",
  kind: "simulator",
} as DeviceInfo;

async function makeSession(): Promise<ScreenRecordingSessionApi> {
  const instance = await screenRecordingSessionBlueprint.factory({}, iosDevice, {
    device: iosDevice,
  } as never);
  return instance.api;
}

describe("a copy out of simulator-server that fails part-way", () => {
  it("leaves no truncated mp4 at the path start handed the caller", async () => {
    const serverDir = await fs.mkdtemp(path.join(os.tmpdir(), "argent-partial-copy-"));
    const serverFile = path.join(serverDir, "recording-123.mp4");
    await fs.writeFile(serverFile, Buffer.from("a whole finished mp4 payload"));

    const server: ServerRecordingControl = {
      start: async () => async () => ({
        path: serverFile,
        sizeBytes: 28,
        durationMs: 2_000,
        wallClockMs: 2_000,
        trimmedMs: null,
        warning: null,
      }),
    };

    const api = await makeSession();
    const started = await startCapture(api, {
      streamUrl: "http://127.0.0.1:54321/stream.mjpeg",
      timeLimitSeconds: 180,
      watermark: true,
      trimStatic: true,
      server,
    });
    partialCopyTargets.push(started.outputFile);

    const err = await stopCapture(api).catch((e: unknown) => e);

    // The failure still points at the intact video inside simulator-server.
    expect((err as Error).message).toContain(`the video is still at ${serverFile}`);
    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.SCREEN_RECORDING_OUTPUT_MISSING);
    await expect(fs.stat(serverFile)).resolves.toBeTruthy();

    // `outputFile` is what start told the caller their recording would be. A
    // truncated file sitting there is worse than none: nothing later in this
    // process reads it, so the corruption is only ever found by whoever opens
    // the path they were given. The path is unique per start, so anything at it
    // is unambiguously this copy's debris — which is why the host fallback
    // removes its own on a failed start too.
    await expect(fs.stat(started.outputFile)).rejects.toMatchObject({ code: "ENOENT" });

    partialCopyTargets.length = 0;
    await fs.rm(serverDir, { recursive: true, force: true });
  });
});
