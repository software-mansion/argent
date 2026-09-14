/**
 * A cloud transport dies under an open session whenever the machine is
 * released. The SDK only refuses work on a session someone explicitly closed,
 * so the first screenshot after that subscribed a track on a dead
 * WebTransport - and `@moq/net` runs a subscribe detached, so the
 * `InvalidStateError` it threw was an unhandled rejection with no handler to
 * attach. `index.ts` treats one of those as fatal, so a screenshot aimed at a
 * released machine killed the tool server.
 *
 * Observed against a live cloud simulator, and reproducible on the parent
 * commit of this file.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const sdk = vi.hoisted(() => ({ sessions: [] as FakeSessionShape[] }));

interface FakeSessionShape {
  closed: Promise<void>;
  disposed: boolean;
  subscribed: number;
  killTransport(): void;
  failTransport(): void;
  close(): void;
  screenshot(): Promise<Uint8Array>;
  sendControl(): Promise<void>;
}

vi.mock("@swmansion/argent-cloud-sdk", () => {
  /** Mirrors the real `MoqDeviceSession` on the two points that matter. */
  class FakeSession implements FakeSessionShape {
    closed: Promise<void>;
    disposed = false;
    /** How many times a track was subscribed on the server's broadcast. */
    subscribed = 0;
    private killed!: () => void;
    private failed!: (reason: Error) => void;

    constructor() {
      this.closed = new Promise<void>((resolve, reject) => {
        this.killed = resolve;
        this.failed = reject;
      });
      sdk.sessions.push(this);
    }

    killTransport(): void {
      this.killed();
    }

    /** A transport that failed rather than ended rejects `closed` instead. */
    failTransport(): void {
      this.failed(new Error("WebTransportError: Session closed"));
    }

    close(): void {
      this.disposed = true;
    }

    screenshot(): Promise<Uint8Array> {
      // The SDK's own guard, the one a released machine never reached.
      if (this.disposed) return Promise.reject(new Error("MoQ session is closed"));
      // Otherwise it subscribes, and the library discards that promise.
      this.subscribed += 1;
      void Promise.reject(
        new Error("InvalidStateError: Session is failed or closed and can not open streams")
      );
      return new Promise<Uint8Array>(() => {});
    }

    sendControl(): Promise<void> {
      return Promise.resolve();
    }
  }

  return { MoqDeviceSession: FakeSession, connectMoq: () => Promise.resolve({}) };
});

vi.mock("@swmansion/argent-cloud-sdk/node", () => ({
  installNodeWebTransport: () => Promise.resolve(),
}));

vi.mock("../src/utils/sim-remote", () => ({ moqInfo: () => Promise.resolve({}) }));

import { openMoqClient } from "../src/utils/moq-client";

/** Node reports an unhandled rejection once the microtask queue has drained. */
async function unhandledDuring(run: () => Promise<unknown>): Promise<unknown[]> {
  const seen: unknown[] = [];
  const record = (reason: unknown) => seen.push(reason);
  process.on("unhandledRejection", record);
  try {
    await run().catch(() => {});
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setTimeout(resolve, 20));
    return seen;
  } finally {
    process.off("unhandledRejection", record);
  }
}

const session = () => sdk.sessions[sdk.sessions.length - 1]!;

beforeEach(() => {
  sdk.sessions.length = 0;
});

describe("a MoQ session whose transport died", () => {
  it("is closed, so the SDK refuses work instead of reaching a dead stream", async () => {
    await openMoqClient("remote:AAAA");
    expect(session().disposed).toBe(false);

    session().killTransport();
    await session().closed;
    await new Promise((resolve) => setImmediate(resolve));

    expect(session().disposed).toBe(true);
  });

  /**
   * The WebTransport contract rejects `closed` for a session that failed. The
   * Node polyfill resolves it once connected, but a handler with no reject arm
   * would leave a spec transport's session open and leak the rejection.
   */
  it("is closed when its transport fails, and handles the rejection", async () => {
    await openMoqClient("remote:AAAA");

    const unhandled = await unhandledDuring(async () => {
      session().failTransport();
      await session().closed.catch(() => {});
    });

    expect(session().disposed).toBe(true);
    expect(unhandled).toEqual([]);
  });

  it("fails a screenshot without killing the process", async () => {
    const client = await openMoqClient("remote:AAAA");
    session().killTransport();
    await session().closed;
    await new Promise((resolve) => setImmediate(resolve));

    const unhandled = await unhandledDuring(() => client.screenshot());

    await expect(client.screenshot()).rejects.toThrow(/session is closed/i);
    // Never subscribed, so nothing detached could reject: this is the crash guard.
    expect(session().subscribed).toBe(0);
    expect(unhandled).toEqual([]);
  });

  it("leaves a live session alone", async () => {
    const client = await openMoqClient("remote:AAAA");
    await new Promise((resolve) => setImmediate(resolve));

    expect(session().disposed).toBe(false);
    await expect(client.sendControl(new Uint8Array([1]))).resolves.toBeUndefined();
  });
});
