import type { TypedEventEmitter } from "@argent/registry";
import type { CDPClient } from "../utils/debugger/cdp-client";
import type { FpsTracker } from "./fps";
import type { ScreencastFrame, ScreencastOpts, ScreencastSession, ServerEvents } from "./types";

/**
 * Manages a single Chromium screencast session per Chromium device, with
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
  // The in-flight Page.startScreencast promise for the first subscriber, shared
  // so concurrent joiners await the SAME start instead of assuming a live
  // session (and stranding themselves on a frame-less stream if it fails). Null
  // when no start is in flight (idle, or a live session already running).
  private startInFlight: Promise<void> | null = null;
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

    if (this.startInFlight) {
      // A first caller is mid-Page.startScreencast. Join the SAME in-flight start
      // rather than assuming a live session: await it so a transient failure
      // fails us too, and only take a refcount once the screencast is actually
      // running. Incrementing before this await — as the naive refcount did —
      // strands this caller on a frame-less stream when the owner's start
      // rejects (activeCount never drains to 0, so no later start re-issues).
      await this.startInFlight;
      if (this.optsDiffer(opts, this.currentOpts)) this.warnOptsIgnored();
      this.activeCount += 1;
    } else if (this.activeCount === 0) {
      // First subscriber, nothing in flight: issue Page.startScreencast and
      // publish the promise so concurrent joiners await it. On failure nothing
      // is left behind — no refcount, no currentOpts, no phantom session — so
      // the next start() re-issues cleanly.
      this.currentOpts = opts;
      const inFlight = this.cdp
        .send("Page.startScreencast", this.toCdpStartArgs(opts))
        .then(() => undefined);
      this.startInFlight = inFlight;
      try {
        await inFlight;
      } catch (err) {
        if (this.startInFlight === inFlight) {
          this.startInFlight = null;
          this.currentOpts = null;
        }
        throw err;
      }
      if (this.startInFlight === inFlight) {
        this.startInFlight = null;
        this.activeCount += 1;
      }
      // else: a forceStop()/dispose superseded this start while it was in flight,
      // so the screencast we started is already torn down — don't take a refcount
      // for it (the returned session's stop() is then a harmless no-op). Mirrors
      // the catch path's `startInFlight === inFlight` identity guard.
    } else {
      // A live session is already running: join it (first writer wins on opts).
      if (this.optsDiffer(opts, this.currentOpts)) this.warnOptsIgnored();
      this.activeCount += 1;
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
    this.startInFlight = null;
    await this.cdp.send("Page.stopScreencast").catch(() => {
      /* ignore */
    });
  }

  private warnOptsIgnored(): void {
    // Subsequent callers join the existing session and accept whatever format /
    // quality / size the first caller chose. Forcing a restart would tear down
    // the first caller's stream mid-frame.
    process.stderr.write(
      `[chromium-screencast] additional caller requested screencast opts that differ from the active session; ignoring (first writer wins).\n`
    );
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
