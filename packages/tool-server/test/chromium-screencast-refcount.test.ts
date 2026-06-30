import { describe, it, expect, vi } from "vitest";
import { TypedEventEmitter } from "@argent/registry";
import { ScreencastManager } from "../src/chromium-server/screencast";

describe("ScreencastManager recovers after a failed start", () => {
  it("re-issues Page.startScreencast after a transient failure", async () => {
    let failNext = true;
    const send = vi.fn(async (method: string) => {
      if (method === "Page.startScreencast" && failNext) throw new Error("transient");
      return {};
    });
    const cdp = { events: new TypedEventEmitter(), send } as never;
    const events = new TypedEventEmitter() as never;
    const fps = { recordFrame: () => {} } as never;
    const mgr = new ScreencastManager(cdp, events, fps);
    await expect(mgr.start()).rejects.toThrow(/transient/);
    failNext = false;
    send.mockClear();
    await mgr.start();
    expect(send.mock.calls.filter((c) => c[0] === "Page.startScreencast").length).toBe(1);
  });
});
