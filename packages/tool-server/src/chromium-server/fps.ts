import { TypedEventEmitter } from "@argent/registry";
import type { ServerEvents } from "./types";

const REPORT_INTERVAL_MS = 1000;

/**
 * Tracks screencast frame arrivals and emits `fpsReport` once per second when
 * reporting is enabled. Mirrors sim-server's behavior — reporting is opt-in so
 * an idle session doesn't generate WS chatter no one cares about.
 */
export class FpsTracker {
  private framesInWindow = 0;
  private interval: NodeJS.Timeout | null = null;
  private enabled = false;

  constructor(private readonly events: TypedEventEmitter<ServerEvents>) {}

  recordFrame(): void {
    this.framesInWindow++;
  }

  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    if (enabled) {
      this.framesInWindow = 0;
      this.interval = setInterval(() => this.flush(), REPORT_INTERVAL_MS);
      this.interval.unref?.();
    } else if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  private flush(): void {
    const fps = this.framesInWindow;
    this.framesInWindow = 0;
    this.events.emit("fpsReport", { fps, windowMs: REPORT_INTERVAL_MS });
  }

  dispose(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    this.enabled = false;
  }
}
