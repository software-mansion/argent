import { FAILURE_CODES, FailureError } from "@argent/registry";
import { establishMoqSimulator, type MoqSimulatorSession } from "../../utils/moq-client";
import { moqInfo, type MoqInfo } from "../../utils/sim-remote";

/**
 * Client for the simulator-server MoQ "video" track — the remote-transport
 * counterpart of `mjpeg-stream.ts`. A `sim-remote` sim has no HTTP MJPEG
 * endpoint; instead it publishes an H.264 (Annex-B) elementary stream over
 * MoQ/WebTransport. This module subscribes to that track, strips hang's
 * per-frame microsecond-timestamp VarInt off each MoQ frame, and hands the raw
 * Annex-B access units to the capture pipeline, which feeds them to `ffmpeg -f
 * h264` exactly as the local path feeds JPEGs to `image2pipe`.
 *
 * Like the MJPEG stream, the server only emits a frame when the screen CHANGES
 * (the encoder idles on a still screen), so the capture code — not this module —
 * owns turning that into an even-cadence video. Frames that arrive before a
 * consumer attaches are buffered and replayed, so the leading keyframe (which
 * carries the SPS/PPS the decoder needs) is never dropped.
 */

/** H.264 NAL unit types that mark a decodable entry point (SPS or IDR slice). */
const NAL_SPS = 7;
const NAL_IDR = 5;

/**
 * Cap on frames held for a consumer that has not attached yet. The window is
 * short in practice — the capture code probes dimensions and starts ffmpeg —
 * but it is driven by how fast the remote screen draws, not by anything this
 * module controls, so it needs a bound.
 */
const MAX_PENDING_BYTES = 16 * 1024 * 1024;

export interface MoqVideoStream {
  /** Frames seen since connect — diagnostics for "the device never drew". */
  readonly frameCount: number;
  /** Set when the MoQ session dropped or the read loop failed mid-recording. */
  readonly error: Error | null;
  /**
   * Resolve with the first decodable frame — a keyframe, which for the first
   * frame of a stream is where the SPS/PPS ride — or reject if none arrives in
   * time, or if the stream drops before one does. The frame stays buffered, so a consumer attached
   * afterwards still receives it — callers use this only to prove the device is
   * drawing and to probe the video dimensions.
   */
  waitForFirstFrame(timeoutMs: number): Promise<Buffer>;
  /**
   * Attach the frame consumer. Any frames buffered before this call are replayed
   * in order first (so the leading keyframe is fed), then live frames are
   * delivered as they arrive. Only one consumer is supported.
   */
  onFrame(cb: (annexb: Buffer, isKeyframe: boolean) => void): void;
  /** Tear down the subscription and the underlying MoQ session. */
  close(): void;
}

function streamFailure(message: string, stage: string, kind: "network" | "timeout"): FailureError {
  return new FailureError(message, {
    error_code: FAILURE_CODES.SCREEN_RECORDING_STREAM_UNAVAILABLE,
    failure_stage: stage,
    failure_area: "tool_server",
    error_kind: kind,
    failure_command: "simulator_server",
  });
}

/**
 * Strip hang's leading microsecond-timestamp VarInt (QUIC RFC 9000 §16: the top
 * two bits of the first byte select a 1/2/4/8-byte length) off a MoQ video
 * frame, leaving the raw H.264 Annex-B access unit.
 */
export function stripHangTimestamp(frame: Uint8Array): Buffer {
  if (frame.length === 0) return Buffer.alloc(0);
  const varintLen = 1 << (frame[0]! >> 6);
  return Buffer.from(frame.subarray(Math.min(varintLen, frame.length)));
}

/**
 * Whether an Annex-B access unit begins a decodable GOP — i.e. carries an SPS or
 * IDR NAL. Scans for a start code (`00 00 01` or `00 00 00 01`) and inspects the
 * following NAL header's type (low 5 bits).
 */
export function isKeyframe(annexb: Buffer): boolean {
  for (let i = 0; i + 3 < annexb.length; i++) {
    if (annexb[i] !== 0 || annexb[i + 1] !== 0) continue;
    let nalPos = -1;
    if (annexb[i + 2] === 1) nalPos = i + 3;
    else if (annexb[i + 2] === 0 && annexb[i + 3] === 1) nalPos = i + 4;
    if (nalPos >= 0 && nalPos < annexb.length) {
      const type = annexb[nalPos]! & 0x1f;
      if (type === NAL_SPS || type === NAL_IDR) return true;
      // Keep scanning: a keyframe AU leads with SPS/PPS, but be tolerant of
      // ordering by checking every NAL in the unit.
    }
  }
  return false;
}

/**
 * Bound `pending` by dropping the middle of it, mutating in place and returning
 * the retained byte count.
 *
 * Frames pile up here only while no consumer has attached, but how fast they
 * arrive is the remote screen's business, not this module's, so the pile needs
 * a bound. What survives is the head plus the newest GOP, and both halves are
 * load-bearing:
 *
 * - The head is the first access unit the stream delivered, which is where the
 *   SPS/PPS the decoder configures itself from live. Dropping it to keep newer
 *   frames would leave ffmpeg with pictures it has no parameter sets to decode
 *   — and a producer that sends its headers once, at the start, is exactly the
 *   shape this module's own doc describes.
 * - The tail resumes at a keyframe, because a P-frame references pictures that
 *   the trim just removed.
 *
 * The cost is the middle of the recording, which is the right thing to lose
 * when the alternative is growing without limit. With nothing between the head
 * and the newest keyframe there is nothing to drop, and the buffer is left over
 * the cap rather than made undecodable.
 */
export function trimToRecentGop(
  pending: Array<{ annexb: Buffer; keyframe: boolean }>,
  bytes: number,
  maxBytes: number
): number {
  if (bytes <= maxBytes) return bytes;
  let newestKeyframe = -1;
  for (let i = pending.length - 1; i > 0; i--) {
    if (pending[i]!.keyframe) {
      newestKeyframe = i;
      break;
    }
  }
  if (newestKeyframe <= 1) return bytes;
  let retained = bytes;
  for (const dropped of pending.splice(1, newestKeyframe - 1)) retained -= dropped.annexb.length;
  return retained;
}

/**
 * Open a MoQ video stream to the `sim-remote` device `udid`, resolving its MoQ
 * endpoint (url / cert fingerprint / lease token) via `sim-remote moq-info`.
 */
export async function openMoqVideoStream(
  udid: string,
  connectTimeoutMs = 15_000
): Promise<MoqVideoStream> {
  const info = await moqInfo(udid);
  return openMoqVideoStreamFromInfo(info, connectTimeoutMs);
}

/**
 * Open a MoQ video stream against an already-resolved endpoint. Split out from
 * {@link openMoqVideoStream} so the transport can be driven directly (tests, a
 * locally-run moq-featured simulator-server) without the orchestrator round-trip.
 */
export async function openMoqVideoStreamFromInfo(
  info: MoqInfo,
  connectTimeoutMs = 15_000
): Promise<MoqVideoStream> {
  let session: MoqSimulatorSession;
  // A race leaves the loser running. `establishMoqSimulator` hands back a live
  // WebTransport connection its caller owns, so a session that finishes after
  // the timeout has already fired must be closed here — otherwise it outlives
  // the failed call for as long as the tool-server runs.
  let connectTimedOut = false;
  let connectTimer: NodeJS.Timeout | undefined;
  const connect = establishMoqSimulator(info).then((established) => {
    if (connectTimedOut) {
      try {
        established.connection.close();
      } catch {
        // Best-effort: the transport may already be torn down.
      }
    }
    return established;
  });
  try {
    session = await Promise.race([
      connect,
      new Promise<never>((_, reject) => {
        connectTimer = setTimeout(() => {
          connectTimedOut = true;
          reject(
            streamFailure(
              `Connecting to the MoQ video endpoint timed out after ${connectTimeoutMs} ms.`,
              "screen_recording_moq_connect",
              "timeout"
            )
          );
        }, connectTimeoutMs);
      }),
    ]);
  } catch (err) {
    if (err instanceof FailureError) throw err;
    throw streamFailure(
      `Could not open the MoQ video stream: ${(err as Error).message}`,
      "screen_recording_moq_connect",
      "network"
    );
  } finally {
    clearTimeout(connectTimer);
  }

  const videoTrack = session.simulator.subscribe("video", 0);

  const state = {
    frameCount: 0,
    error: null as Error | null,
    firstFrame: null as Buffer | null,
    closed: false,
    // Held on the state object (not a bare `let`) so its type survives control-
    // flow narrowing when read from the read-loop closure below.
    firstFrameResolve: null as ((frame: Buffer) => void) | null,
    firstFrameReject: null as ((err: Error) => void) | null,
  };

  /**
   * Record a drop and hand it to a waiter that can no longer be satisfied.
   * Without the second half, a session that dies right after connect leaves
   * `waitForFirstFrame` to burn its whole timeout and then blame the device's
   * screen for what was a transport failure. Mirrors `mjpeg-stream`'s `fail`.
   */
  const fail = (err: Error): void => {
    if (state.closed) return;
    state.error = err;
    const reject = state.firstFrameReject;
    state.firstFrameResolve = null;
    state.firstFrameReject = null;
    if (reject) {
      reject(
        streamFailure(
          `The MoQ video stream dropped before the first frame arrived: ${err.message}`,
          "screen_recording_moq_first_frame",
          "network"
        )
      );
    }
  };
  let consumer: ((annexb: Buffer, isKeyframe: boolean) => void) | null = null;
  const buffered: Array<{ annexb: Buffer; keyframe: boolean }> = [];
  let seenKeyframe = false;

  let bufferedBytes = 0;

  const deliver = (annexb: Buffer, keyframe: boolean): void => {
    if (consumer) {
      consumer(annexb, keyframe);
      return;
    }
    buffered.push({ annexb, keyframe });
    bufferedBytes = trimToRecentGop(buffered, bufferedBytes + annexb.length, MAX_PENDING_BYTES);
  };

  // Read loop: pull frames until the track closes or the session errors.
  void (async () => {
    try {
      for (;;) {
        const raw = await videoTrack.readFrame();
        if (state.closed) return;
        if (!raw) {
          // The server stopped publishing. Clean at the transport layer, but
          // mid-recording it means the frames just end: without recording it as
          // a drop, stop would hand back a video that freezes early with no
          // warning and a duration covering time it never captured. The MJPEG
          // twin treats its own `aborted` the same way.
          fail(new Error("simulator-server stopped publishing the video track"));
          return;
        }
        const annexb = stripHangTimestamp(raw);
        const keyframe = isKeyframe(annexb);
        // Drop frames until the first keyframe: decoding a mid-GOP slice with no
        // SPS/PPS is undefined. The server withholds pre-keyframe frames anyway,
        // but guard here too.
        if (!seenKeyframe) {
          if (!keyframe) continue;
          seenKeyframe = true;
          state.firstFrame = annexb;
          const resolveFirst = state.firstFrameResolve;
          state.firstFrameResolve = null;
          if (resolveFirst) resolveFirst(annexb);
        }
        state.frameCount++;
        deliver(annexb, keyframe);
      }
    } catch (err) {
      fail(err instanceof Error ? err : new Error(String(err)));
    }
  })();

  return {
    get frameCount() {
      return state.frameCount;
    },
    get error() {
      return state.error;
    },
    waitForFirstFrame(timeoutMs: number): Promise<Buffer> {
      if (state.firstFrame) return Promise.resolve(state.firstFrame);
      // Already dropped: no frame can arrive, so say why now instead of waiting
      // out the timeout and then reporting a symptom instead of the cause.
      if (state.error) {
        return Promise.reject(
          streamFailure(
            `The MoQ video stream dropped before any frame arrived: ${state.error.message}`,
            "screen_recording_moq_first_frame",
            "network"
          )
        );
      }
      return new Promise<Buffer>((resolve, reject) => {
        const timer = setTimeout(() => {
          state.firstFrameResolve = null;
          state.firstFrameReject = null;
          reject(
            streamFailure(
              `No video frame arrived over MoQ within ${timeoutMs} ms. ` +
                `Is the remote device booted and its screen on?`,
              "screen_recording_moq_first_frame",
              "timeout"
            )
          );
        }, timeoutMs);
        state.firstFrameResolve = (frame) => {
          clearTimeout(timer);
          resolve(frame);
        };
        state.firstFrameReject = (err) => {
          clearTimeout(timer);
          reject(err);
        };
      });
    },
    onFrame(cb: (annexb: Buffer, isKeyframe: boolean) => void): void {
      consumer = cb;
      // Replay everything buffered before the consumer attached, in order.
      while (buffered.length > 0) {
        const { annexb, keyframe } = buffered.shift()!;
        cb(annexb, keyframe);
      }
    },
    close(): void {
      // Settle a pending waiter before the closed flag silences `fail`, so a
      // teardown mid-connect resolves the caller now instead of leaving it to
      // time out against a stream that is already gone.
      const reject = state.firstFrameReject;
      state.firstFrameResolve = null;
      state.firstFrameReject = null;
      state.closed = true;
      if (reject) {
        reject(
          streamFailure(
            "The MoQ video stream was closed before the first frame arrived.",
            "screen_recording_moq_first_frame",
            "network"
          )
        );
      }
      try {
        session.connection.close();
      } catch {
        // Best-effort — an already-closed transport is not an error here.
      }
    },
  };
}
