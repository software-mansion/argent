import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeviceInfo } from "@argent/registry";
import {
  READBACK_MISMATCH_WARNING,
  READBACK_TIMING,
  typeWithReadback,
} from "../src/tools/keyboard/ios-readback";
import { KEY_HOLD, typeSimulatorServer } from "../src/tools/keyboard/simulator-server-keys";

// #2030: a stalled simulator drops or repeats keys while every key is acked,
// so `keyboard` reads the field back where the answer means something.

const IOS_SIM: DeviceInfo = { id: "TEST-UDID", platform: "ios", kind: "simulator" };

type FillAnswer = { focused: boolean; verified: boolean; timedOut?: boolean };

/** An ax-service whose `fill` check answers from a script, keyed by the text asked about. */
function fakeAx(answer: (text: string) => FillAnswer | Promise<FillAnswer>, degraded = false) {
  const fill = vi.fn(async (text: string, _opts?: { check?: boolean }) => answer(text));
  return { api: { degraded, fill }, fill };
}

function registryWith(api: unknown) {
  return { resolveService: vi.fn(async () => api) } as never;
}

const saved = { ...READBACK_TIMING };
beforeEach(() => {
  Object.assign(READBACK_TIMING, { precheckMs: 50, settleMs: 60, pollMs: 10 });
});
afterEach(() => {
  Object.assign(READBACK_TIMING, saved);
});

describe("typeWithReadback", () => {
  it("verifies a field that was empty and now holds the text", async () => {
    let typed = false;
    const { api, fill } = fakeAx((text) => ({
      focused: true,
      verified: text === "" ? !typed : typed && text === "Ab@1",
    }));
    const type = vi.fn(async () => {
      typed = true;
      return { typed: "Ab@1", keys: 4 };
    });

    const out = await typeWithReadback(registryWith(api), IOS_SIM, "Ab@1", type);

    expect(out).toEqual({ result: { typed: "Ab@1", keys: 4 }, readback: { verified: true } });
    // Only ever a check: the read-back never writes the field.
    for (const call of fill.mock.calls) expect(call[1]).toEqual({ check: true });
  });

  it("warns, without quoting the text, when the field holds something else", async () => {
    let typed = false;
    const { api } = fakeAx((text) => ({ focused: true, verified: text === "" && !typed }));

    const out = await typeWithReadback(registryWith(api), IOS_SIM, "s3cret!", async () => {
      typed = true;
      return { typed: "s3cret!", keys: 7 };
    });

    expect(out.readback).toEqual({ verified: false, warning: READBACK_MISMATCH_WARNING });
    expect(READBACK_MISMATCH_WARNING).not.toContain("s3cret");
  });

  it("waits for an app that applies the text late", async () => {
    let checks = 0;
    let typed = false;
    const { api } = fakeAx((text) => {
      if (text === "") return { focused: true, verified: !typed };
      checks++;
      return { focused: true, verified: checks >= 3 };
    });

    const out = await typeWithReadback(registryWith(api), IOS_SIM, "hi", async () => {
      typed = true;
      return { typed: "hi", keys: 2 };
    });

    expect(out.readback).toEqual({ verified: true });
    expect(checks).toBe(3);
  });

  it("skips the check when the field was not empty: the keys insert at the caret", async () => {
    const { api, fill } = fakeAx(() => ({ focused: true, verified: false }));

    const out = await typeWithReadback(registryWith(api), IOS_SIM, "more", async () => ({
      typed: "more",
      keys: 4,
    }));

    expect(out.readback).toBeUndefined();
    expect(fill).toHaveBeenCalledTimes(1);
  });

  it("skips the check when nothing is focused", async () => {
    const { api, fill } = fakeAx(() => ({ focused: false, verified: false }));

    const out = await typeWithReadback(registryWith(api), IOS_SIM, "hi", async () => ({
      typed: "hi",
      keys: 2,
    }));

    expect(out.readback).toBeUndefined();
    expect(fill).toHaveBeenCalledTimes(1);
  });

  it("says nothing when focus left the field after typing", async () => {
    let typed = false;
    const { api } = fakeAx((text) =>
      text === "" ? { focused: true, verified: !typed } : { focused: false, verified: false }
    );

    const out = await typeWithReadback(registryWith(api), IOS_SIM, "hi", async () => {
      typed = true;
      return { typed: "hi", keys: 2 };
    });

    expect(out.readback).toBeUndefined();
  });

  it("does not check text with Return or Tab, which can move focus or submit", async () => {
    const { api, fill } = fakeAx(() => ({ focused: true, verified: true }));
    for (const text of ["a\nb", "a\tb", "a\rb"]) {
      const out = await typeWithReadback(registryWith(api), IOS_SIM, text, async () => ({
        typed: text,
        keys: 3,
      }));
      expect(out.readback).toBeUndefined();
    }
    expect(fill).not.toHaveBeenCalled();
  });

  it("types unchecked when the ax-service is degraded, missing or hangs", async () => {
    const type = vi.fn(async () => ({ typed: "hi", keys: 2 }));

    const degraded = fakeAx(() => ({ focused: true, verified: true }), true);
    expect((await typeWithReadback(registryWith(degraded.api), IOS_SIM, "hi", type)).readback).toBe(
      undefined
    );
    expect(degraded.fill).not.toHaveBeenCalled();

    const failing = { resolveService: vi.fn(async () => Promise.reject(new Error("no ax"))) };
    expect((await typeWithReadback(failing as never, IOS_SIM, "hi", type)).readback).toBe(
      undefined
    );

    // A service without `fill` throws synchronously; that is unchecked too.
    expect((await typeWithReadback(registryWith({}), IOS_SIM, "hi", type)).readback).toBe(
      undefined
    );

    const hanging = fakeAx(() => new Promise<FillAnswer>(() => {}));
    expect((await typeWithReadback(registryWith(hanging.api), IOS_SIM, "hi", type)).readback).toBe(
      undefined
    );

    expect(type).toHaveBeenCalledTimes(4);
  });

  it("still types when the text is empty, without asking the ax-service", async () => {
    const registry = { resolveService: vi.fn() };
    const type = vi.fn(async () => ({ typed: "", keys: 0 }));
    await typeWithReadback(registry as never, IOS_SIM, "", type);
    expect(type).toHaveBeenCalledTimes(1);
    expect(registry.resolveService).not.toHaveBeenCalled();
  });
});

describe("typeSimulatorServer key hold", () => {
  it("holds each key for the fixed hold, and spends delayMs between keys", async () => {
    const stamps: Array<[string, number, number]> = [];
    const api = {
      pressKey: async (direction: string, code: number) =>
        void stamps.push([direction, code, Date.now()]),
    };
    const savedHold = KEY_HOLD.ms;
    KEY_HOLD.ms = 5;
    try {
      await typeSimulatorServer(registryWith(api), IOS_SIM, {
        udid: IOS_SIM.id,
        text: "ab",
        delayMs: 120,
      });
    } finally {
      KEY_HOLD.ms = savedHold;
    }

    const [aDown, aUp, bDown] = stamps;
    // Down to Up is the short hold, far under delayMs: a stall has little
    // time to catch a key down and make it repeat.
    expect(aUp![2] - aDown![2]).toBeLessThan(60);
    // The gap between keys is where delayMs goes.
    expect(bDown![2] - aUp![2]).toBeGreaterThanOrEqual(110);
  });
});
