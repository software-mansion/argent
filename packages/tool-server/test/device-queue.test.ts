import { describe, expect, it, vi } from "vitest";

vi.mock("../src/utils/ios-devices", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/ios-devices")>()),
  getSimulatorRuntimeKind: vi.fn(async () => "mobile" as const),
  isTvOsSimulator: vi.fn(async () => false),
}));

import { serializedPerDevice } from "../src/utils/device-serial";
import { createKeyboardTool } from "../src/tools/keyboard";
import { createPasteTool } from "../src/tools/paste";

const IOS_UDID = "AAAAAAAA-BBBB-CCCC-DDDD-EEEEFFFF0001";
const OTHER_UDID = "AAAAAAAA-BBBB-CCCC-DDDD-EEEEFFFF0002";

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
