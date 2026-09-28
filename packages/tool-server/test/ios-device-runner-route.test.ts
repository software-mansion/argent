import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createUsbmuxCommandSender } from "../src/utils/ios-device/runner-route";
import type { Deadline } from "../src/utils/ios-device/usbmux";
import {
  IosDeviceTransportError,
  type IosDeviceTransportErrorKind,
} from "../src/utils/ios-device/usbmux-protocol";

const UDID = "00008110-000978540290401E";
const PORT = 8_100;
const OK = { ok: true, data: {} };

const unattachedError = (): IosDeviceTransportError =>
  new IosDeviceTransportError("device-unattached", "device not on cable", {
    retryable: false,
    hint: "Connect the device by cable, trust this Mac, keep it unlocked, and retry.",
  });

const notListeningError = (): IosDeviceTransportError =>
  new IosDeviceTransportError("runner-not-listening", "port closed", { retryable: true });

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createUsbmuxCommandSender", () => {
  it("surfaces the unattached verdict as-is: Wi-Fi-only devices are not a route", async () => {
    const sendViaUsbmux = vi.fn(async () => {
      throw unattachedError();
    });
    const sender = createUsbmuxCommandSender({ sendViaUsbmux });

    const error = await sender
      .sendCommand(UDID, PORT, { command: "status" }, { timeoutMs: 1_000, readOnly: true })
      .catch((caught: unknown) => caught);

    // The cable hint is the actionable message; there is deliberately no
    // fallback transport that could bury or delay it.
    expect((error as IosDeviceTransportError).kind).toBe(
      "device-unattached" satisfies IosDeviceTransportErrorKind
    );
    expect((error as IosDeviceTransportError).hint).toMatch(/cable/);
    expect(sendViaUsbmux).toHaveBeenCalledTimes(1);
  });

  it("sends mutating commands AT MOST ONCE even for retryable transport errors", async () => {
    const sendViaUsbmux = vi.fn(async () => {
      throw notListeningError();
    });
    const sender = createUsbmuxCommandSender({ sendViaUsbmux });

    const error = await sender
      .sendCommand(
        UDID,
        PORT,
        { command: "tap", commandId: "argent-abc", x: 10, y: 20 },
        { timeoutMs: 1_000 }
      )
      .catch((caught: unknown) => caught);

    expect(sendViaUsbmux).toHaveBeenCalledTimes(1);
    expect((error as IosDeviceTransportError).kind).toBe("runner-not-listening");
  });

  it("retries read-only commands on retryable errors with backoff, up to 3 attempts", async () => {
    const sendViaUsbmux = vi
      .fn()
      .mockRejectedValueOnce(notListeningError())
      .mockRejectedValueOnce(notListeningError())
      .mockResolvedValueOnce(OK);
    const sender = createUsbmuxCommandSender({ sendViaUsbmux });

    const pending = sender.sendCommand(
      UDID,
      PORT,
      { command: "status" },
      {
        timeoutMs: 1_000,
        readOnly: true,
      }
    );
    await vi.runAllTimersAsync();

    await expect(pending).resolves.toBe(OK);
    expect(sendViaUsbmux).toHaveBeenCalledTimes(3);
  });

  it("gives up read-only retries after 3 attempts", async () => {
    const sendViaUsbmux = vi.fn(async () => {
      throw notListeningError();
    });
    const sender = createUsbmuxCommandSender({ sendViaUsbmux });

    const pending = sender
      .sendCommand(UDID, PORT, { command: "status" }, { timeoutMs: 1_000, readOnly: true })
      .catch((caught: unknown) => caught);
    await vi.runAllTimersAsync();

    expect(await pending).toBeInstanceOf(IosDeviceTransportError);
    expect(sendViaUsbmux).toHaveBeenCalledTimes(3);
  });

  it("does not retry read-only commands on non-retryable errors", async () => {
    const sendViaUsbmux = vi.fn(async () => {
      throw new IosDeviceTransportError("protocol", "bad packet", { retryable: false });
    });
    const sender = createUsbmuxCommandSender({ sendViaUsbmux });

    const error = await sender
      .sendCommand(UDID, PORT, { command: "status" }, { timeoutMs: 1_000, readOnly: true })
      .catch((caught: unknown) => caught);

    expect((error as IosDeviceTransportError).kind).toBe("protocol");
    expect(sendViaUsbmux).toHaveBeenCalledTimes(1);
  });

  it("hands the send seam one already-ticking deadline instead of a constant budget", async () => {
    let seen: Deadline | undefined;
    const sendViaUsbmux = vi.fn(
      async (_udid: string, _port: number, _body: unknown, deadline: Deadline) => {
        seen = deadline;
        return OK;
      }
    );
    const sender = createUsbmuxCommandSender({ sendViaUsbmux });

    await sender.sendCommand(
      UDID,
      PORT,
      { command: "tap", commandId: "argent-abc" },
      { timeoutMs: 1_000 }
    );

    // Fake timers freeze Date.now, so the full budget is visible at hand-off…
    expect(seen?.remainingMs()).toBe(1_000);
    vi.advanceTimersByTime(400);
    // …and it decreases as wall time passes: a stage downstream (the HTTP
    // exchange after the usbmux handshake) sees only what is left, never a
    // fresh 1000.
    expect(seen?.remainingMs()).toBe(600);
  });

  it("gives each read-only retry attempt its own full budget", async () => {
    const budgets: number[] = [];
    const sendViaUsbmux = vi.fn(
      async (_udid: string, _port: number, _body: unknown, deadline: Deadline) => {
        budgets.push(deadline.remainingMs());
        throw notListeningError();
      }
    );
    const sender = createUsbmuxCommandSender({ sendViaUsbmux });

    const pending = sender
      .sendCommand(UDID, PORT, { command: "status" }, { timeoutMs: 3_000, readOnly: true })
      .catch((caught: unknown) => caught);
    await vi.runAllTimersAsync();
    await pending;

    // The backoff sleeps advanced the (faked) clock between attempts; one
    // deadline shared across attempts would show shrinking budgets here.
    expect(budgets).toEqual([3_000, 3_000, 3_000]);
  });
});
