import type { TypedEventEmitter } from "@argent/registry";
import type { CDPClient } from "../utils/debugger/cdp-client";
import type { FpsTracker } from "./fps";
import type { ScreencastFrame, ScreencastOpts, ScreencastSession, ServerEvents } from "./types";

/**
 * Manages a single Chromium screencast session per Electron device, with
 * refcounted consumers. Sim-server's MJPEG service spins up a JPEG encoder
 * only while at least one client is connected; we do the same — `start()` is
 * idempotent for additional callers and only triggers `Page.startScreencast`
 * on the transition from 0 → 1 active subscriber. `Page.stopScreencast` fires
 * once the last subscriber drops.
 *
 * The wrapping `ScreencastSession.stop()` is the disposal handle each caller
 * holds; calling it twice is safe.
 */
export class ScreencastManager {
  private activeCount = 0;
  private currentOpts: ScreencastOpts | null = null;
  private lastFrame: ScreencastFrame | null = null;
  private cdpListenerInstalled = false;

  constructor(
    private readonly cdp: CDPClient,
    private readonly events: TypedEventEmitter<ServerEvents>,
    private readonly fps: FpsTracker
  ) {}

  /**
   * Most-recently-received frame, or null if no screencast is active /
   * Chromium hasn't pushed a frame yet. Exposed so single-shot consumers
   * (preview overlay, snapshot debug tool) can grab the last frame without
   * starting their own session.
   */
  getLastFrame(): ScreencastFrame | null {
    return this.lastFrame;
  }

  async start(opts: ScreencastOpts = {}): Promise<ScreencastSession> {
    this.installCdpListenerOnce();

    this.activeCount += 1;
    if (this.activeCount === 1) {
      this.currentOpts = opts;
      await this.cdp.send("Page.startScreencast", this.toCdpStartArgs(opts));
    } else if (this.optsDiffer(opts, this.currentOpts)) {
      // Subsequent callers join the existing session and accept whatever
      // format / quality / size the first caller chose. Forcing a restart
      // would tear down the first caller's stream mid-frame.
      process.stderr.write(
        `[electron-screencast] additional caller requested screencast opts that differ from the active session; ignoring (first writer wins).\n`
      );
    }

    let stopped = false;
    const session: ScreencastSession = {
      stop: async () => {
        if (stopped) return;
        stopped = true;
        this.activeCount = Math.max(0, this.activeCount - 1);
        if (this.activeCount === 0) {
          await this.cdp.send("Page.stopScreencast").catch(() => {
            /* the session may already be torn down on disconnect */
          });
          this.currentOpts = null;
        }
      },
    };
    return session;
  }

  /** Force-stop screencast regardless of refcount. Called on dispose. */
  async forceStop(): Promise<void> {
    this.activeCount = 0;
    this.currentOpts = null;
    await this.cdp.send("Page.stopScreencast").catch(() => {
      /* ignore */
    });
  }

  private installCdpListenerOnce(): void {
    if (this.cdpListenerInstalled) return;
    this.cdpListenerInstalled = true;
    this.cdp.events.on("event", (method, params) => {
      if (method !== "Page.screencastFrame") return;
      const payload = params as {
        sessionId: number;
        data: string;
        metadata: ScreencastFrame["metadata"];
      };
      const frame: ScreencastFrame = {
        sessionId: payload.sessionId,
        data: payload.data,
        metadata: payload.metadata,
      };
      this.lastFrame = frame;
      this.fps.recordFrame();
      this.events.emit("frame", frame);
      // Chromium pauses the screencast until every emitted frame is ack'd —
      // missing an ack manifests as a frozen stream. Fire-and-forget is fine
      // because send() returns a promise we don't need to await.
      this.cdp.send("Page.screencastFrameAck", { sessionId: payload.sessionId }).catch(() => {
        /* ignore — session may have closed between emit and ack */
      });
    });
  }

  private toCdpStartArgs(opts: ScreencastOpts): Record<string, unknown> {
    const args: Record<string, unknown> = {
      format: opts.format ?? "jpeg",
      everyNthFrame: opts.everyNthFrame ?? 1,
    };
    if (opts.quality !== undefined) args.quality = opts.quality;
    if (opts.maxWidth !== undefined) args.maxWidth = opts.maxWidth;
    if (opts.maxHeight !== undefined) args.maxHeight = opts.maxHeight;
    return args;
  }

  private optsDiffer(a: ScreencastOpts, b: ScreencastOpts | null): boolean {
    if (!b) return true;
    return (
      (a.format ?? "jpeg") !== (b.format ?? "jpeg") ||
      (a.quality ?? null) !== (b.quality ?? null) ||
      (a.maxWidth ?? null) !== (b.maxWidth ?? null) ||
      (a.maxHeight ?? null) !== (b.maxHeight ?? null) ||
      (a.everyNthFrame ?? 1) !== (b.everyNthFrame ?? 1)
    );
  }
}
