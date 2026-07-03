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

  it("a phantom session's stop() does not steal a later live session's refcount", async () => {
    // forceStop() supersedes an owner's in-flight start; that start then
    // SUCCEEDS anyway (this is the same race the two tests above cover, which
    // assert no refcount is taken). This test goes one step further: a real
    // session B then starts on the same manager, and the phantom session's
    // stop() must be a true no-op — not decrement activeCount and potentially
    // tear down B's live stream out from under it.
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
    const stopCount = () => send.mock.calls.filter((c) => c[0] === "Page.stopScreencast").length;

    const phantomStarting = mgr.start(); // startScreencast gated (in flight)
    await Promise.resolve();
    await mgr.forceStop(); // supersedes the in-flight start (calls stopScreencast once)
    releaseStart(); // the superseded start now resolves successfully anyway
    const phantom = await phantomStarting;

    // A real session B starts fresh (activeCount was drained to 0 by forceStop).
    send.mockClear();
    const b = await mgr.start();
    expect(stopCount()).toBe(0);

    // The phantom's stop() must not touch B's session.
    await phantom.stop();
    expect(stopCount()).toBe(0);

    // B's own stop() still works normally.
    await b.stop();
    expect(stopCount()).toBe(1);
  });

  it("a joiner on a succeeding in-flight start shares one screencast and stops it once on the last drop", async () => {
    // Happy-path counterpart to "does not strand a concurrent joiner when the
    // owner's start rejects": the owner's Page.startScreencast is gated so a
    // joiner enters while it is in flight, then the start SUCCEEDS. Both callers
    // must take a refcount (active count 2) off a SINGLE Page.startScreencast,
    // and on teardown Page.stopScreencast must fire exactly once — on the last
    // drop, not per session and not before the final consumer leaves.
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let calls = 0;
    const send = vi.fn(async (method: string) => {
      if (method === "Page.startScreencast") {
        calls += 1;
        if (calls === 1) await firstGate;
      }
      return {};
    });
    const cdp = { events: new TypedEventEmitter(), send } as never;
    const mgr = new ScreencastManager(
      cdp,
      new TypedEventEmitter() as never,
      { recordFrame: () => {} } as never
    );
    // activeCount is a compile-time `private`; read it through a cast to assert
    // the refcount transitions directly (0 → 2 → 1 → 0).
    const activeCount = () => (mgr as unknown as { activeCount: number }).activeCount;
    const startCount = () => send.mock.calls.filter((c) => c[0] === "Page.startScreencast").length;
    const stopCount = () => send.mock.calls.filter((c) => c[0] === "Page.stopScreencast").length;

    const owner = mgr.start(); // owner: startScreencast is in flight (gated)
    const joiner = mgr.start(); // joiner: enters while the owner's start is in flight
    await Promise.resolve();
    releaseFirst(); // the owner's start now succeeds
    const ownerSession = await owner;
    const joinerSession = await joiner;

    // Both callers acquired off a single Page.startScreencast.
    expect(startCount()).toBe(1);
    expect(activeCount()).toBe(2);

    // First drop: refcount falls to 1, Page.stopScreencast must NOT fire yet.
    await ownerSession.stop();
    expect(activeCount()).toBe(1);
    expect(stopCount()).toBe(0);

    // Last drop: refcount hits 0, Page.stopScreencast fires exactly once.
    await joinerSession.stop();
    expect(activeCount()).toBe(0);
    expect(stopCount()).toBe(1);
  });
});
