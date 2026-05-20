import { describe, expect, it, vi } from "vitest";
import { TypedEventEmitter } from "@argent/registry";
import { FpsTracker } from "../src/electron-server/fps";
import { ScreencastManager } from "../src/electron-server/screencast";
import type { CDPClient } from "../src/utils/debugger/cdp-client";
import type { ScreencastFrame, ServerEvents } from "../src/electron-server/types";

interface FakeCdp {
  send: ReturnType<typeof vi.fn>;
  events: TypedEventEmitter<{ event: (method: string, params: Record<string, unknown>) => void }>;
  emitFrame(frame: Partial<ScreencastFrame> & { sessionId: number; data: string }): void;
}

function makeFakeCdp(): FakeCdp {
  const send = vi.fn().mockResolvedValue({});
  const events = new TypedEventEmitter<{
    event: (method: string, params: Record<string, unknown>) => void;
  }>();
  return {
    send,
    events,
    emitFrame(frame) {
      events.emit("event", "Page.screencastFrame", {
        sessionId: frame.sessionId,
        data: frame.data,
        metadata: frame.metadata ?? {
          offsetTop: 0,
          pageScaleFactor: 1,
          deviceWidth: 800,
          deviceHeight: 600,
          scrollOffsetX: 0,
          scrollOffsetY: 0,
        },
      });
    },
  };
}

describe("electron-server/screencast", () => {
  it("starts CDP screencast on the first subscriber and stops on the last", async () => {
    const cdp = makeFakeCdp();
    const events = new TypedEventEmitter<ServerEvents>();
    const fps = new FpsTracker(events);
    const mgr = new ScreencastManager(cdp as unknown as CDPClient, events, fps);

    const s1 = await mgr.start({ format: "jpeg", quality: 60 });
    expect(cdp.send).toHaveBeenCalledWith("Page.startScreencast", {
      format: "jpeg",
      quality: 60,
      everyNthFrame: 1,
    });

    // Second subscriber shares the session — no second startScreencast.
    cdp.send.mockClear();
    const s2 = await mgr.start({ format: "jpeg", quality: 60 });
    expect(cdp.send).not.toHaveBeenCalled();

    // First stop doesn't tear down — second subscriber still active.
    await s1.stop();
    expect(cdp.send).not.toHaveBeenCalled();

    // Second stop tears down.
    await s2.stop();
    expect(cdp.send).toHaveBeenCalledWith("Page.stopScreencast");
  });

  it("emits a 'frame' event and acks every frame so CDP keeps streaming", async () => {
    const cdp = makeFakeCdp();
    const events = new TypedEventEmitter<ServerEvents>();
    const fps = new FpsTracker(events);
    const mgr = new ScreencastManager(cdp as unknown as CDPClient, events, fps);

    const frames: ScreencastFrame[] = [];
    events.on("frame", (f) => frames.push(f));
    await mgr.start();

    cdp.emitFrame({ sessionId: 1, data: "AAA" });
    cdp.emitFrame({ sessionId: 2, data: "BBB" });

    expect(frames).toHaveLength(2);
    expect(frames[0]?.data).toBe("AAA");
    expect(frames[1]?.sessionId).toBe(2);

    // Acks: we expect at least one ack per sessionId received.
    const ackCalls = cdp.send.mock.calls.filter((c) => c[0] === "Page.screencastFrameAck");
    expect(ackCalls.length).toBe(2);
    expect((ackCalls[0]?.[1] as { sessionId: number }).sessionId).toBe(1);
    expect((ackCalls[1]?.[1] as { sessionId: number }).sessionId).toBe(2);

    expect(mgr.getLastFrame()?.data).toBe("BBB");
  });

  it("idempotent stop(): calling twice is safe", async () => {
    const cdp = makeFakeCdp();
    const events = new TypedEventEmitter<ServerEvents>();
    const fps = new FpsTracker(events);
    const mgr = new ScreencastManager(cdp as unknown as CDPClient, events, fps);
    const s = await mgr.start();
    await s.stop();
    await s.stop(); // no-op the second time
    const stops = cdp.send.mock.calls.filter((c) => c[0] === "Page.stopScreencast");
    expect(stops.length).toBe(1);
  });
});

describe("electron-server/fps", () => {
  it("emits fpsReport once per second when enabled", async () => {
    vi.useFakeTimers();
    try {
      const events = new TypedEventEmitter<ServerEvents>();
      const reports: Array<{ fps: number }> = [];
      events.on("fpsReport", (r) => reports.push(r));
      const tracker = new FpsTracker(events);
      tracker.setEnabled(true);

      tracker.recordFrame();
      tracker.recordFrame();
      tracker.recordFrame();
      vi.advanceTimersByTime(1000);
      expect(reports[0]).toEqual({ fps: 3, windowMs: 1000 });

      // Second window resets the counter.
      tracker.recordFrame();
      vi.advanceTimersByTime(1000);
      expect(reports[1]).toEqual({ fps: 1, windowMs: 1000 });

      tracker.setEnabled(false);
      tracker.recordFrame();
      vi.advanceTimersByTime(1000);
      // No new report after disabling.
      expect(reports).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("setEnabled is idempotent", () => {
    const events = new TypedEventEmitter<ServerEvents>();
    const tracker = new FpsTracker(events);
    tracker.setEnabled(true);
    tracker.setEnabled(true); // should not double-arm the interval
    tracker.dispose();
  });
});
