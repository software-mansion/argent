/**
 * Failure paths of the MoQ video stream, driven through the real
 * `openMoqVideoStreamFromInfo` against a fake transport.
 *
 * These are the paths where the transport dies and the recording has to say so.
 * The local MJPEG stream pins the same three (`mjpeg-stream.ts`'s `fail`), and
 * each one here is the difference between naming the cause and blaming the
 * device's screen for it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const establishMoqSimulatorMock = vi.fn();
vi.mock("../src/utils/moq-client", () => ({
  establishMoqSimulator: (...args: unknown[]) => establishMoqSimulatorMock(...args),
}));
vi.mock("../src/utils/sim-remote", () => ({
  moqInfo: vi.fn(),
}));

import { openMoqVideoStreamFromInfo } from "../src/tools/screen-recording/moq-video-stream";
import type { MoqInfo } from "../src/utils/sim-remote";

const info = { url: "https://127.0.0.1:4443", fingerprint: "00", token: "t" } as unknown as MoqInfo;

/** A keyframe access unit: 4-byte start code + SPS NAL, with hang's 1-byte VarInt. */
function keyframeWireFrame(): Uint8Array {
  return Uint8Array.from([0x05, 0x00, 0x00, 0x00, 0x01, 0x67, 0xde, 0xad]);
}

/**
 * Fake the MoQ session. `frames` is served in order; an entry of `null` is a
 * clean track close, and an `Error` rejects the read.
 */
function fakeSession(frames: Array<Uint8Array | null | Error>) {
  const close = vi.fn();
  let i = 0;
  const readFrame = vi.fn(async () => {
    const next = frames[i++];
    if (next instanceof Error) throw next;
    if (next === undefined) return await new Promise<null>(() => {}); // hang
    return next;
  });
  return {
    close,
    session: {
      connection: { close },
      simulator: { subscribe: () => ({ readFrame }) },
    },
  };
}

beforeEach(() => {
  establishMoqSimulatorMock.mockReset();
});

describe("a MoQ session that drops before any frame", () => {
  it("fails the first-frame wait immediately, naming the transport error", async () => {
    // Without this the caller burns the whole first-frame timeout and then
    // reports "no video frame arrived — is the screen on?", which points at the
    // device for what was a dead session.
    const { session } = fakeSession([new Error("QUIC session closed: lease expired")]);
    establishMoqSimulatorMock.mockResolvedValue(session);
    const stream = await openMoqVideoStreamFromInfo(info);

    const started = Date.now();
    await expect(stream.waitForFirstFrame(30_000)).rejects.toThrow(/lease expired/);
    expect(Date.now() - started).toBeLessThan(5_000);
    stream.close();
  });

  it("reports the drop to a wait that started before it", async () => {
    let rejectRead: ((e: Error) => void) | undefined;
    const readFrame = vi.fn(() => new Promise<never>((_, rej) => (rejectRead = rej)));
    establishMoqSimulatorMock.mockResolvedValue({
      connection: { close: vi.fn() },
      simulator: { subscribe: () => ({ readFrame }) },
    });
    const stream = await openMoqVideoStreamFromInfo(info);

    const pending = stream.waitForFirstFrame(30_000);
    await new Promise((r) => setImmediate(r));
    rejectRead!(new Error("transport reset"));

    await expect(pending).rejects.toThrow(/transport reset/);
    expect(stream.error?.message).toMatch(/transport reset/);
  });
});

describe("a MoQ session the server stops publishing", () => {
  it("records a clean track close as a drop, so stop can warn about it", async () => {
    // Clean at the transport layer, but mid-recording the frames simply stop.
    // Left unrecorded, `stop` returns a video that freezes early with no
    // warning at all.
    const { session } = fakeSession([keyframeWireFrame(), null]);
    establishMoqSimulatorMock.mockResolvedValue(session);
    const stream = await openMoqVideoStreamFromInfo(info);

    await stream.waitForFirstFrame(5_000);
    await vi.waitFor(() => expect(stream.error).not.toBeNull());
    expect(stream.error?.message).toMatch(/stopped publishing/);
    stream.close();
  });
});

describe("close() while a first-frame wait is outstanding", () => {
  it("settles the waiter instead of leaving it to time out", async () => {
    establishMoqSimulatorMock.mockResolvedValue(fakeSession([]).session);
    const stream = await openMoqVideoStreamFromInfo(info);

    const pending = stream.waitForFirstFrame(30_000);
    const started = Date.now();
    stream.close();

    await expect(pending).rejects.toThrow(/closed before the first frame/);
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

describe("a connect that finishes after the timeout already fired", () => {
  it("closes the late session rather than leaking it", async () => {
    // `Promise.race` abandons the loser; the connection it yields is live and
    // owned by this caller, so nothing else would ever close it.
    const connectionClose = vi.fn();
    establishMoqSimulatorMock.mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(
            () =>
              resolve({
                connection: { close: connectionClose },
                simulator: { subscribe: () => ({ readFrame: vi.fn() }) },
              }),
            60
          )
        )
    );

    await expect(openMoqVideoStreamFromInfo(info, 10)).rejects.toThrow(/timed out after 10 ms/);
    await vi.waitFor(() => expect(connectionClose).toHaveBeenCalledTimes(1));
  });
});
