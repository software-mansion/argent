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

  it("does not strand a concurrent joiner when the owner's start rejects", async () => {
    // The owner's Page.startScreencast is gated so a second caller can join
    // while it is in flight, then the owner's start rejects. The joiner must
    // reject too (not hold a session for a screencast that never started), the
    // refcount must drain to 0, and a later start must re-issue cleanly.
    let releaseFirst!: (fail: boolean) => void;
    const firstGate = new Promise<boolean>((resolve) => {
      releaseFirst = resolve;
    });
    let calls = 0;
    const send = vi.fn(async (method: string) => {
      if (method === "Page.startScreencast") {
        calls += 1;
        if (calls === 1 && (await firstGate)) throw new Error("transient");
      }
      return {};
    });
    const cdp = { events: new TypedEventEmitter(), send } as never;
    const mgr = new ScreencastManager(
      cdp,
      new TypedEventEmitter() as never,
      { recordFrame: () => {} } as never
    );

    const owner = mgr.start(); // owner: startScreencast is in flight (gated)
    const joiner = mgr.start(); // joiner: enters while the owner's start is in flight
    // Attach rejection handlers before releasing the gate (no unhandled reject).
    const ownerRejects = expect(owner).rejects.toThrow(/transient/);
    const joinerRejects = expect(joiner).rejects.toThrow(/transient/);
    await Promise.resolve();
    releaseFirst(true); // fail the owner's start
    await ownerRejects;
    await joinerRejects;

    // Fully drained: a fresh start re-issues Page.startScreencast and succeeds.
    send.mockClear();
    const recovered = await mgr.start();
    expect(recovered).toBeTruthy();
    expect(send.mock.calls.filter((c) => c[0] === "Page.startScreencast").length).toBe(1);
  });

  it("takes no phantom refcount when forceStop races a successful start", async () => {
    // forceStop() (dispose) tears the screencast down while the owner's
    // Page.startScreencast is still in flight; when it then SUCCEEDS the owner
    // must NOT take a refcount for the now-torn-down screencast, or a later
    // start() would see activeCount != 0 and skip re-issuing.
    let releaseStart!: () => void;
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    let startCalls = 0;
    const send = vi.fn(async (method: string) => {
      if (method === "Page.startScreencast") {
        startCalls += 1;
        if (startCalls === 1) await startGate;
      }
      return {};
    });
    const cdp = { events: new TypedEventEmitter(), send } as never;
    const mgr = new ScreencastManager(
      cdp,
      new TypedEventEmitter() as never,
      { recordFrame: () => {} } as never
    );

    const starting = mgr.start(); // owner: startScreencast gated (in flight)
    await Promise.resolve();
    await mgr.forceStop(); // dispose-style teardown mid-start
    releaseStart(); // the gated start now resolves
    await starting;

    // No phantom refcount ⇒ a fresh start re-issues Page.startScreencast.
    send.mockClear();
    await mgr.start();
    expect(send.mock.calls.filter((c) => c[0] === "Page.startScreencast").length).toBe(1);
  });

  it("takes no phantom refcount when forceStop races a successful start with a joiner", async () => {
    // Same race, but a JOINER is present when forceStop tears the screencast
    // down and the owner's start then succeeds — the joiner must not take a
    // phantom refcount either.
    let releaseStart!: () => void;
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    let startCalls = 0;
    const send = vi.fn(async (method: string) => {
      if (method === "Page.startScreencast") {
        startCalls += 1;
        if (startCalls === 1) await startGate;
      }
      return {};
    });
    const cdp = { events: new TypedEventEmitter(), send } as never;
    const mgr = new ScreencastManager(
      cdp,
      new TypedEventEmitter() as never,
      { recordFrame: () => {} } as never
    );

    const owner = mgr.start(); // owner: startScreencast gated (in flight)
    const joiner = mgr.start(); // joiner: joins the in-flight start
    await Promise.resolve();
    await mgr.forceStop(); // dispose-style teardown mid-start
    releaseStart(); // the gated start now resolves
    await owner;
    await joiner;

    // Neither owner nor joiner took a refcount ⇒ a fresh start re-issues.
    send.mockClear();
    await mgr.start();
    expect(send.mock.calls.filter((c) => c[0] === "Page.startScreencast").length).toBe(1);
  });
});
