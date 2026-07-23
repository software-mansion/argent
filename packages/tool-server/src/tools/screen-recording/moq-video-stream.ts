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

export interface MoqVideoStream {
  /** Frames seen since connect — diagnostics for "the device never drew". */
  readonly frameCount: number;
  /** Set when the MoQ session dropped or the read loop failed mid-recording. */
  readonly error: Error | null;
  /**
   * Resolve with the first decodable frame (a keyframe carrying SPS), or reject
   * if none arrives in time. The frame stays buffered, so a consumer attached
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
  try {
    session = await Promise.race([
      establishMoqSimulator(info),
      new Promise<never>((_, reject) =>
        setTimeout(
          () =>
            reject(
              streamFailure(
                `Connecting to the MoQ video endpoint timed out after ${connectTimeoutMs} ms.`,
                "screen_recording_moq_connect",
                "timeout"
              )
            ),
          connectTimeoutMs
        )
      ),
    ]);
  } catch (err) {
    if (err instanceof FailureError) throw err;
    throw streamFailure(
      `Could not open the MoQ video stream: ${(err as Error).message}`,
      "screen_recording_moq_connect",
      "network"
    );
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
  };
  let consumer: ((annexb: Buffer, isKeyframe: boolean) => void) | null = null;
  const buffered: Array<{ annexb: Buffer; keyframe: boolean }> = [];
  let seenKeyframe = false;

  const deliver = (annexb: Buffer, keyframe: boolean): void => {
    if (consumer) consumer(annexb, keyframe);
    else buffered.push({ annexb, keyframe });
  };

  // Read loop: pull frames until the track closes or the session errors.
  void (async () => {
    try {
      for (;;) {
        const raw = await videoTrack.readFrame();
        if (state.closed) return;
        if (!raw) {
          // Track closed cleanly (server stopped the broadcast).
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
      if (!state.closed) state.error = err instanceof Error ? err : new Error(String(err));
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
      return new Promise<Buffer>((resolve, reject) => {
        const timer = setTimeout(() => {
          state.firstFrameResolve = null;
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
      state.closed = true;
      state.firstFrameResolve = null;
      try {
        session.connection.close();
      } catch {
        // Best-effort — an already-closed transport is not an error here.
      }
    },
  };
}
