import { describe, it, expect, afterEach, vi } from "vitest";
import * as net from "node:net";
import { connectAndroidDevtoolsClient } from "../src/utils/android-devtools-client";

/**
 * Which RPC gets which timeout, driven through the real client over a real
 * socket that never answers.
 *
 * The branch is a correctness property, not a preference: `setText` is the only
 * WRITE on this client, and abandoning it does not stop the device — nothing is
 * sent to cancel it, and the helper's own worker budget outlives the default
 * host timeout. A host that gave up at 5s would report "fall back", run the
 * injected clear, and let the accessibility write land in the middle of it,
 * writing the value once and then again on top. Reverting the branch to
 * `method === "getHierarchy"` is a one-token edit that reads as tidying, and
 * nothing else in the repo would object to it.
 */
describe("android-devtools client — per-method RPC timeouts", () => {
  const servers: net.Server[] = [];

  afterEach(() => {
    vi.useRealTimers();
    for (const server of servers.splice(0)) server.close();
  });

  /** A helper socket that accepts the connection and never answers a request. */
  async function silentHelper(): Promise<number> {
    const server = net.createServer(() => {
      /* accept, then say nothing */
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return (server.address() as net.AddressInfo).port;
  }

  /** How long the client waited before giving up on `method`, in ms. */
  async function timeoutOf(method: string): Promise<number> {
    const port = await silentHelper();
    const client = await connectAndroidDevtoolsClient(port, () => {});
    // Faked only AFTER the connection is up, so the socket's own I/O is real.
    vi.useFakeTimers();
    try {
      const pending = client.request(method).then(
        () => {
          throw new Error(`expected ${method} to time out, but it resolved`);
        },
        (e: unknown) => e as Error
      );
      await vi.advanceTimersByTimeAsync(60_000);
      const err = await pending;
      const match = /timed out after (\d+)ms/.exec(err.message);
      expect(match, `no timeout in: ${err.message}`).not.toBeNull();
      return Number(match![1]);
    } finally {
      vi.useRealTimers();
      client.close();
    }
  }

  it("gives `setText` the long budget, past the helper's own worker timeout", async () => {
    expect(await timeoutOf("setText")).toBe(15_000);
  });

  it("gives `getHierarchy` the long budget, because a capture is slow", async () => {
    expect(await timeoutOf("getHierarchy")).toBe(15_000);
  });

  it.each([["ping"], ["getScreenSize"]])(
    "leaves %s on the default budget, since abandoning a read costs only the answer",
    async (method) => {
      expect(await timeoutOf(method)).toBe(5_000);
    }
  );
});
