import { describe, expect, it, vi } from "vitest";
import { FAILURE_CODES, getFailureSignal } from "@argent/registry";

vi.mock("../src/utils/ios-devices", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/ios-devices")>()),
  getSimulatorRuntimeKind: vi.fn(async () => "mobile" as const),
  isTvOsSimulator: vi.fn(async () => false),
}));

// `paste`'s iOS impl declares `requires: ["xcrun"]`, which `dispatchByPlatform`
// preflights before the handler runs — so without this the queue assertions
// below fail on any host with no Xcode command-line tools, Linux CI included.
vi.mock("../src/utils/check-deps", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/check-deps")>()),
  ensureDeps: vi.fn(async () => {}),
}));

import { awaitDeviceHold, holdDeviceQueue, serializedPerDevice } from "../src/utils/device-serial";
import { gestureTapTool } from "../src/tools/gesture-tap";
import { createKeyboardTool } from "../src/tools/keyboard";
import { createPasteTool } from "../src/tools/paste";

const IOS_UDID = "AAAAAAAA-BBBB-CCCC-DDDD-EEEEFFFF0001";
const OTHER_UDID = "AAAAAAAA-BBBB-CCCC-DDDD-EEEEFFFF0002";
const ABANDON_UDID = "AAAAAAAA-BBBB-CCCC-DDDD-EEEEFFFF0003";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Long enough that a paste starting 2ms in cannot land after it by accident. */
const TYPED = "abcdefghij";

/**
 * The queue is what keeps two sessions from interleaving inside one device's
 * keyboard, and it is asserted here at both levels it has to hold at: the map
 * itself, and the two tools that share it.
 *
 * Both properties are invisible to the tools' own suites. Reverting
 * `utils/device-serial.ts` to a module-local map per tool — undoing the whole
 * reason it was extracted — left `paste.test.ts` and
 * `keyboard-text-key-exclusive.test.ts` green, and a single GLOBAL queue would
 * satisfy them too, because every serialization assertion there uses one udid.
 */
/**
 * The queue serializes `keyboard` and `paste` and nothing else, so a bare
 * `gesture-tap` from another session lands INSIDE a `run-sequence`'s hold —
 * between the sequence's own focus tap and its clear — and the clear then
 * empties whatever the tap moved focus to. Measured on Chrome 152 against
 * `[gesture-tap delayMs 4000, keyboard { clear: true }]` with a second session's
 * tap 1.5s in: the sequence reported `completed: 2 of 2`, `cleared: true`,
 * `clearVerified: true`, the OTHER session's textarea was emptied, and the field
 * the sequence tapped kept its value.
 */
describe("a queued call the caller abandoned", () => {
  it("does not reach the device when its turn comes", async () => {
    // Without this the queue turned "an unstoppable write" into "a write into
    // another session's field": measured on Chrome 152 with the client SIGKILLed
    // 2.5s into a 12s wait, the text landed at t=16s in the field the session
    // ahead had focused, and the server logged `toolCompleted keyboard (12107ms)`.
    const controller = new AbortController();
    let release = () => {};
    const blocking = serializedPerDevice(
      ABANDON_UDID,
      () => new Promise<void>((resolve) => (release = resolve))
    );
    // The queued task starts on a microtask, so `release` is only bound once it
    // has actually run.
    await sleep(2);
    const task = vi.fn(async () => "written");
    const abandoned = serializedPerDevice(ABANDON_UDID, task, controller.signal).then(
      () => undefined,
      (e: unknown) => e as Error
    );

    controller.abort();
    release();
    await blocking;
    const err = await abandoned;
    expect(task).not.toHaveBeenCalled();
    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.KEYBOARD_DEVICE_BUSY);
    expect(getFailureSignal(err)?.failure_stage).toBe("device_queue_abandoned");
  });

  it("still runs a call whose signal never fired", async () => {
    const controller = new AbortController();
    const task = vi.fn(async () => "written");
    await expect(serializedPerDevice(ABANDON_UDID, task, controller.signal)).resolves.toBe(
      "written"
    );
    expect(task).toHaveBeenCalledTimes(1);
  });
});

describe("one key per device, not per spelling of its id", () => {
  it("serializes two spellings of one Chromium target", async () => {
    // `parseChromiumCdpPort` reads both of these as port 9333, so they are one
    // browser — but the map keyed on the caller's raw string, so they got two
    // queues and the serialization silently did nothing. Two concurrent
    // `keyboard` calls spelled the two ways interleaved to `AAABABABABABABBB`
    // instead of `AAAAAAAABBBBBBBB`.
    const order: string[] = [];
    const task = (tag: string) => async () => {
      for (let i = 0; i < 4; i++) {
        order.push(tag);
        await sleep(2);
      }
    };
    await Promise.all([
      serializedPerDevice("chromium-cdp-9333", task("A")),
      serializedPerDevice("chromium-cdp-09333", task("B")),
    ]);
    expect(order.join("")).toBe("AAAABBBB");
  });

  it("serializes an iOS UDID whatever its case", async () => {
    const order: string[] = [];
    const task = (tag: string) => async () => {
      for (let i = 0; i < 4; i++) {
        order.push(tag);
        await sleep(2);
      }
    };
    await Promise.all([
      serializedPerDevice(IOS_UDID, task("A")),
      serializedPerDevice(IOS_UDID.toLowerCase(), task("B")),
    ]);
    expect(order.join("")).toBe("AAAABBBB");
  });

  it("still keeps genuinely different devices apart", async () => {
    // The normalisation must not collapse two targets into one queue.
    const order: string[] = [];
    const task = (tag: string) => async () => {
      for (let i = 0; i < 3; i++) {
        order.push(tag);
        await sleep(2);
      }
    };
    await Promise.all([
      serializedPerDevice("chromium-cdp-9333", task("A")),
      serializedPerDevice("chromium-cdp-9444", task("B")),
    ]);
    expect(order.join("")).not.toBe("AAABBB");
  });
});

describe("focus movers and an open hold", () => {
  it("waits out a hold on the same device", async () => {
    const order: string[] = [];
    let release = () => {};
    const held = holdDeviceQueue(IOS_UDID, async () => {
      order.push("hold:in");
      await new Promise<void>((resolve) => (release = resolve));
      order.push("hold:out");
    });
    await sleep(2);
    const mover = awaitDeviceHold(IOS_UDID).then(() => order.push("tap"));
    await sleep(20);
    expect(order).toEqual(["hold:in"]);

    release();
    await Promise.all([held, mover]);
    expect(order).toEqual(["hold:in", "hold:out", "tap"]);
  });

  it("does not wait when nothing holds the device, nor for another device's hold", async () => {
    // The map is empty whenever no sequence is mid-hold, which is nearly always
    // — putting the focus movers on the QUEUE instead would make every tap wait
    // behind every `keyboard` call, up to 90s for an Android clear.
    let release = () => {};
    const held = holdDeviceQueue(OTHER_UDID, () => new Promise<void>((r) => (release = r)));
    await sleep(2);
    let ran = false;
    await awaitDeviceHold(IOS_UDID).then(() => (ran = true));
    expect(ran).toBe(true);

    release();
    await held;
  });

  it("lets the holder's OWN steps through, exactly as a nested keyboard step is", async () => {
    // A `run-sequence` invokes its gesture steps inside its own hold; if those
    // waited on it the sequence would deadlock on itself.
    let inside = false;
    await holdDeviceQueue(IOS_UDID, async () => {
      await awaitDeviceHold(IOS_UDID);
      inside = true;
    });
    expect(inside).toBe(true);
  });

  it("holds a real `gesture-tap` back until the hold releases", async () => {
    // The wiring, not just the helper: every tool that can move keyboard focus
    // takes this wait. The stub transport makes the tap itself fail, which is
    // beside the point — what is asserted is WHEN it got to try.
    const order: string[] = [];
    let release = () => {};
    const held = holdDeviceQueue(IOS_UDID, async () => {
      await new Promise<void>((resolve) => (release = resolve));
      order.push("hold:out");
    });
    await sleep(2);

    const settled = () => order.push("tap");
    const tap = gestureTapTool.execute!({ simulatorServer: {} } as never, {
      udid: IOS_UDID,
      x: 0.5,
      y: 0.5,
    }).then(settled, settled);
    await sleep(20);
    expect(order).toEqual([]);

    release();
    await Promise.all([held, tap]);
    expect(order).toEqual(["hold:out", "tap"]);
  });
});

describe("the per-device queue", () => {
  it("runs two tasks for one device one after the other", async () => {
    const order: string[] = [];
    const task = (tag: string) => async () => {
      order.push(`${tag}:in`);
      await sleep(20);
      order.push(`${tag}:out`);
    };
    const first = serializedPerDevice(IOS_UDID, task("a"));
    await sleep(1);
    const second = serializedPerDevice(IOS_UDID, task("b"));
    await Promise.all([first, second]);
    expect(order).toEqual(["a:in", "a:out", "b:in", "b:out"]);
  });

  it("runs tasks for DIFFERENT devices at the same time", async () => {
    // Per device, not one global queue: a second simulator's clear must not wait
    // out the first one's 90s Android budget. A global queue passes every
    // single-udid serialization test in the suite, so this is the one assertion
    // that can tell the two apart.
    const order: string[] = [];
    const task = (tag: string) => async () => {
      order.push(`${tag}:in`);
      await sleep(20);
      order.push(`${tag}:out`);
    };
    const first = serializedPerDevice(IOS_UDID, task("a"));
    await sleep(1);
    const second = serializedPerDevice(OTHER_UDID, task("b"));
    await Promise.all([first, second]);
    expect(order).toEqual(["a:in", "b:in", "a:out", "b:out"]);
  });

  it("does not stall behind a task that rejected", async () => {
    await expect(
      serializedPerDevice(IOS_UDID, async () => {
        throw new Error("first task failed");
      })
    ).rejects.toThrow(/first task failed/);
    await expect(serializedPerDevice(IOS_UDID, async () => "second")).resolves.toBe("second");
  });

  it("is SHARED by keyboard and paste, which write to the same focused field", async () => {
    // The hazard is the device's single focused field, not any one tool's steps:
    // a paste racing a clear corrupts the value exactly as two clears would. Two
    // module-local maps serialize each tool against itself and let the pair
    // interleave, which is what this file exists to catch.
    const order: string[] = [];
    const api = {
      apiUrl: "http://127.0.0.1:49152",
      pressKey: async () => {
        order.push("keyboard:key");
        await sleep(2);
      },
    };
    const registry = { resolveService: vi.fn(async () => api) } as never;
    const fetchMock = vi.fn(async () => {
      order.push("paste:clipboard");
      await sleep(2);
      return new Response(JSON.stringify({ status: "ok" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const typing = createKeyboardTool(registry).execute!({}, {
        udid: IOS_UDID,
        text: TYPED,
        delayMs: 1,
      } as never);
      await sleep(2);
      const pasting = createPasteTool(registry).execute!({}, { udid: IOS_UDID, text: "OTP-1234" });
      await Promise.all([typing, pasting]);
    } finally {
      vi.unstubAllGlobals();
    }
    // The paste fills the clipboard only after EVERY key event of the typing
    // call — one Down and one Up per character — so it waited out the whole
    // call, not just other pastes. With a queue per tool the clipboard fill
    // lands within the first few keys. (The key events after it are the paste's
    // own Cmd+V, over the same transport.)
    expect(order.indexOf("paste:clipboard")).toBe(TYPED.length * 2);
  });
});
