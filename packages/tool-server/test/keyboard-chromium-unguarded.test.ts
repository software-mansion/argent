import { describe, it, expect, vi } from "vitest";
import { Registry, type DeviceInfo } from "@argent/registry";
import { makeChromiumImpl } from "../src/tools/keyboard/platforms/chromium";
import { createKeyboardTool } from "../src/tools/keyboard";
import { buttonTool } from "../src/tools/button";
import { assertSupported, UnsupportedOperationError } from "../src/utils/capability";

// The mouse tools (gesture-tap/-drag/-scroll) refuse up front on a hidden
// Chromium window because every mouse dispatch waits on compositor hit-testing.
// Key events skip hit-testing and stay fast on the same window — measured on a
// minimized Electron window with no focus emulation applied,
// Input.dispatchKeyEvent returned in 1-14ms while ten consecutive mouse moves
// cost 5002-5005ms each — so `keyboard` is deliberately NOT guarded. These
// tests are what hold it that way: guarding `keyboard` would make it refuse
// input that demonstrably works.
//
// The sibling `button` tool is exempt for a different reason, pinned below: it
// declares no chromium capability, so there is no guard on its path to reach.
// What enforces that varies: `assertSupported` runs at the HTTP edge and in
// run-sequence's pre-flight, while a flow reaches `Registry.invokeTool`, which
// skips it and fails earlier still, resolving `services()` against the
// simulator-server factory. A Chromium app has no hardware buttons anyway; the
// chromium-server's WebSocket `button` command emulates `Back` alone, as an
// Alt+Left chord, and throws for the rest.

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

  it("stays unguarded through the full tool wrapper, not just the impl", async () => {
    // The two cases above hold the exemption below makeChromiumImpl; this one
    // drives createKeyboardTool().execute, so a guard added at the wrapper
    // level (before dispatchByPlatform) goes red here too.
    const { registry } = hiddenWindowRegistry();
    const result = await createKeyboardTool(registry).execute(
      {},
      { udid: chromiumDevice.id, text: "hi", delayMs: 0 }
    );
    expect(result).toEqual({ typed: "hi", keys: 2 });
  });
});

describe("button chromium lockout", () => {
  it("declares no chromium capability, so the gate rejects the device", () => {
    expect(buttonTool.capability).not.toHaveProperty("chromium");
    expect(() => assertSupported("button", buttonTool.capability, chromiumDevice)).toThrow(
      UnsupportedOperationError
    );
    expect(() => assertSupported("button", buttonTool.capability, chromiumDevice)).toThrow(
      /button.*not supported on chromium/
    );
  });
});
