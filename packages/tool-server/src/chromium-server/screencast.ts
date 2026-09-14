import type { TypedEventEmitter } from "@argent/registry";
import type { CDPClient } from "../utils/debugger/cdp-client";
import type { FpsTracker } from "./fps";
import type { ScreencastFrame, ScreencastOpts, ScreencastSession, ServerEvents } from "./types";

/**
 * One Chromium screencast session per device, shared by refcounted consumers:
 * `Page.startScreencast` fires on the 0 → 1 transition, `Page.stopScreencast`
 * once the last subscriber drops. The returned `ScreencastSession.stop()` is
 * each caller's disposal handle; calling it twice is safe.
 */
export class ScreencastManager {
  private activeCount = 0;
  private currentOpts: ScreencastOpts | null = null;
  // The first subscriber's in-flight Page.startScreencast, published so joiners
  // await the SAME start instead of assuming a live session and stranding
  // themselves on a frame-less stream if it fails.
  private startInFlight: Promise<void> | null = null;
  private lastFrame: ScreencastFrame | null = null;
  private cdpListenerInstalled = false;

  constructor(
    private readonly cdp: CDPClient,
    private readonly events: TypedEventEmitter<ServerEvents>,
    private readonly fps: FpsTracker
  ) {}

  /** Never cleared on stop, so single-shot consumers can read a frame without
   * starting their own session. */
  getLastFrame(): ScreencastFrame | null {
    return this.lastFrame;
  }

  async start(opts: ScreencastOpts = {}): Promise<ScreencastSession> {
    this.installCdpListenerOnce();

    // Whether THIS call took a refcount slot. A start that raced forceStop() and
    // lost (the `startInFlight === inFlight` guards below) must return a session
    // whose stop() is a true no-op — otherwise it would later decrement
    // activeCount and stop a stream this caller never subscribed to.
    let acquired = false;

    if (this.startInFlight) {
      // Await the owner's start so a transient failure fails us too, and take a
      // refcount only once the screencast is actually running. Incrementing
      // before the await would leave activeCount stuck above 0 when the owner's
      // start rejects, so no later start() re-issues.
      await this.startInFlight;
      // If forceStop()/dispose superseded the start, the owner took no refcount
      // and the screencast is torn down — don't take a phantom one either. The
      // owner's continuation on the shared promise runs before ours, so
      // activeCount already reflects superseded (0) vs live (>0).
      if (this.activeCount > 0) {
        if (this.optsDiffer(opts, this.currentOpts)) this.warnOptsIgnored();
        this.activeCount += 1;
        acquired = true;
      }
    } else if (this.activeCount === 0) {
      // Publish the promise so concurrent joiners await it. On failure nothing is
      // left behind — no refcount, no currentOpts — so the next start() re-issues.
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
        acquired = true;
      }
      // else: forceStop()/dispose superseded this start, so what we started is
      // already torn down — take no refcount (`acquired` stays false, making the
      // returned session's stop() a true no-op).
    } else {
      // Join the live session; the first caller's opts win.
      if (this.optsDiffer(opts, this.currentOpts)) this.warnOptsIgnored();
      this.activeCount += 1;
      acquired = true;
    }

    let stopped = false;
    const session: ScreencastSession = {
      stop: async () => {
        if (stopped || !acquired) return;
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
    // Restarting to honor the new opts would tear down the first caller's stream
    // mid-frame.
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
      // a missed ack manifests as a frozen stream.
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
