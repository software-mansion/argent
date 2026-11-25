import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { releaseOnExit } from "../src/release-on-exit.js";

const SIGNALS: NodeJS.Signals[] = ["SIGTERM", "SIGINT"];
let setAside: Array<[NodeJS.Signals, NodeJS.SignalsListener[]]>;
let stdinClose: unknown[];

beforeEach(() => {
  setAside = SIGNALS.map((signal) => {
    const listeners = process.listeners(signal) as NodeJS.SignalsListener[];
    process.removeAllListeners(signal);
    return [signal, listeners];
  });
  stdinClose = process.stdin.listeners("close");
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const [signal, listeners] of setAside) {
    process.removeAllListeners(signal);
    for (const listener of listeners) process.on(signal, listener);
  }
  for (const listener of process.stdin.listeners("close")) {
    if (!stdinClose.includes(listener))
      process.stdin.removeListener("close", listener as () => void);
  }
});

describe("releaseOnExit", () => {
  it("releases before it raises a stop signal again, and leaves no listener behind", async () => {
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    let finish = (): void => {};
    const release = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    releaseOnExit(release);

    process.emit("SIGTERM", "SIGTERM");
    await new Promise((resolve) => setImmediate(resolve));
    expect(release).toHaveBeenCalledTimes(1);
    expect(kill).not.toHaveBeenCalled();

    finish();
    await vi.waitFor(() => expect(kill).toHaveBeenCalledWith(process.pid, "SIGTERM"));
    expect(process.listenerCount("SIGTERM")).toBe(0);
    expect(process.listenerCount("SIGINT")).toBe(0);
  });

  it("raises the signal even when another listener was added during the release", async () => {
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    releaseOnExit(async () => {
      process.on("SIGINT", () => {});
    });
    process.emit("SIGINT", "SIGINT");
    await vi.waitFor(() => expect(kill).toHaveBeenCalledWith(process.pid, "SIGINT"));
  });

  it("releases when stdin closes", () => {
    const release = vi.fn(async () => {});
    releaseOnExit(release);
    process.stdin.emit("close");
    expect(release).toHaveBeenCalledTimes(1);
  });
});
