import { describe, it, expect, vi } from "vitest";
import { Registry, type DeviceInfo } from "@argent/registry";
import { makeChromiumImpl } from "../src/tools/keyboard/platforms/chromium";

// The mouse tools (gesture-tap/-drag/-scroll) refuse up front on a hidden
// Chromium window because every mouse dispatch waits on compositor hit-testing.
// Key events skip hit-testing and stay fast on the same window — measured on a
// minimized Electron window, Input.dispatchKeyEvent returned in 1-14ms while
// ten consecutive mouse moves cost 5002-5005ms each — so `keyboard` is
// deliberately NOT guarded.
//
// That exemption lived only in a comment on assertChromiumWindowVisible, which
// meant adding the guard to `keyboard` would have made it refuse input that
// demonstrably works, with the suite staying green. This pins it.
//
// The sibling `button` tool needs no such test: its capability omits chromium
// altogether, so it can never reach a Chromium device (chromium hardware
// buttons exist only on the chromium-server HTTP surface).

const chromiumDevice = {
  id: "chromium-cdp-9222",
  platform: "chromium",
  kind: "app",
} as unknown as DeviceInfo;

/**
 * A Chromium session whose window reports itself hidden — the exact state that
 * makes the three mouse tools refuse.
 */
function hiddenWindowRegistry(): {
  registry: Registry;
  dispatchKeyEvent: ReturnType<typeof vi.fn>;
} {
  const dispatchKeyEvent = vi.fn(async () => {});
  const registry = new Registry();
  vi.spyOn(registry, "resolveService").mockResolvedValue({
    dispatchKeyEvent,
    cdp: { send: vi.fn().mockResolvedValue({ result: { value: "hidden" } }) },
  } as never);
  return { registry, dispatchKeyEvent };
}

describe("keyboard on chromium — deliberately unguarded on a hidden window", () => {
  it("types text on a hidden window instead of refusing", async () => {
    const { registry, dispatchKeyEvent } = hiddenWindowRegistry();
    const impl = makeChromiumImpl(registry);

    const result = await impl.handler(
      {},
      { udid: chromiumDevice.id, text: "hi", delayMs: 0 },
      chromiumDevice
    );

    expect(result).toEqual({ typed: "hi", keys: 2 });
    // Two characters, each keyDown + char + keyUp.
    expect(dispatchKeyEvent).toHaveBeenCalledTimes(6);
  });

  it("presses a named key on a hidden window instead of refusing", async () => {
    const { registry, dispatchKeyEvent } = hiddenWindowRegistry();
    const impl = makeChromiumImpl(registry);

    const result = await impl.handler(
      {},
      { udid: chromiumDevice.id, key: "enter", delayMs: 0 },
      chromiumDevice
    );

    expect(result).toEqual({ typed: "enter", keys: 1 });
    // keyDown + keyUp for the named key.
    expect(dispatchKeyEvent).toHaveBeenCalledTimes(2);
  });
});
