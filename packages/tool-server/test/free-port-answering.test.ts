import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

class FakeSocket extends EventEmitter {
  destroy = vi.fn();
  onTimeout: (() => void) | undefined;
  timeoutMs: number | undefined;
  setTimeout(ms: number, cb: () => void) {
    this.timeoutMs = ms;
    this.onTimeout = cb;
    return this;
  }
}
let socket: FakeSocket;
vi.mock("node:net", async () => ({
  ...(await vi.importActual<typeof import("node:net")>("node:net")),
  connect: () => (socket = new FakeSocket()),
}));

import { isLoopbackPortAnswering } from "../src/utils/free-port";

describe("isLoopbackPortAnswering", () => {
  it.each([
    ["an accepted connect", (s: FakeSocket) => s.emit("connect"), true],
    ["a refused connect", (s: FakeSocket) => s.emit("error", new Error("ECONNREFUSED")), false],
    ["a connect that never settles", (s: FakeSocket) => s.onTimeout!(), false],
  ])("reports %s and closes the socket", async (_name, settle, answering) => {
    const verdict = isLoopbackPortAnswering(9333);
    settle(socket);
    expect(await verdict).toBe(answering);
    expect(socket.destroy).toHaveBeenCalled();
  });

  it("gives the connect 500 ms by default", () => {
    void isLoopbackPortAnswering(9333);
    expect(socket.timeoutMs).toBe(500);
    socket.emit("connect");
  });
});
