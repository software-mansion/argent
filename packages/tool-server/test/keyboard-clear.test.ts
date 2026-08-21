import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  FAILURE_CODES,
  FailureError,
  getFailureSignal,
  ServiceState,
  type DeviceInfo,
} from "@argent/registry";
import { typeSimulatorServer } from "../src/tools/keyboard/simulator-server-keys";
import { makeChromiumImpl } from "../src/tools/keyboard/platforms/chromium";
import { vegaImpl } from "../src/tools/keyboard/platforms/vega";
import { typeTv } from "../src/tools/keyboard/platforms/tv";
import { InvalidToolInputError } from "../src/utils/capability";
import type { KeyEventArgs } from "../src/blueprints/chromium-cdp";

vi.mock("../src/utils/vega-input", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/utils/vega-input")>();
  return {
    ...actual,
    injectVegaText: vi.fn(async () => {}),
    injectVegaNamedKey: vi.fn(async () => {}),
  };
});

// Android's clear is observable as the `adb shell input` command sequence.
// `shellQuote` stays real so the asserted strings are the real command lines.
//
// `adbExecOutBinary` is mocked separately because the hierarchy dump does NOT
// go through `adbShell`: `adb shell` gives the device no usable controlling
// terminal, so uiautomator's XML never comes back over it (33 bytes of status
// line, exit 0). The dump therefore rides `exec-out` — which returns a Buffer,
// hence the Buffer-shaped mock — and it is a separate call from the `input`
// commands rather than another entry in `adbShell.mock.calls`.
const { adbShell, adbExecOutBinary, isAndroidTv } = vi.hoisted(() => ({
  adbShell: vi.fn(async (_serial: string, _cmd: string, _opts?: unknown): Promise<string> => ""),
  adbExecOutBinary: vi.fn(
    async (_serial: string, _cmd: string, _opts?: unknown): Promise<Buffer> => Buffer.from("")
  ),
  isAndroidTv: vi.fn(async (_serial: string): Promise<boolean> => false),
}));
vi.mock("../src/utils/adb", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/adb")>()),
  adbShell,
  adbExecOutBinary,
  isAndroidTv,
}));

// The tvOS probe is what stops an Apple TV udid reaching the HID chord; stub it
// so both sides of that fork are reachable without a booted tvOS simulator.
const { isTvOsSimulator } = vi.hoisted(() => ({
  isTvOsSimulator: vi.fn(async (_udid: string): Promise<boolean> => false),
}));
vi.mock("../src/utils/ios-devices", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/ios-devices")>()),
  isTvOsSimulator,
}));

import { injectVegaNamedKey, injectVegaText } from "../src/utils/vega-input";
import { makeAndroidImpl } from "../src/tools/keyboard/platforms/android";
import { MAX_DELETE_COUNT } from "../src/utils/android-input";
import { makeIosImpl, makeIosRemoteImpl } from "../src/tools/keyboard/platforms/ios";
import { createKeyboardTool } from "../src/tools/keyboard";

const IOS_SIM: DeviceInfo = { id: "TEST-UDID", platform: "ios", kind: "simulator" };
const CHROMIUM: DeviceInfo = { id: "chromium-cdp-9222", platform: "chromium", kind: "app" };
const VEGA: DeviceInfo = { id: "vega-serial", platform: "vega", kind: "vvd" };
const ANDROID: DeviceInfo = { id: "emulator-5554", platform: "android", kind: "emulator" };
const APPLE_TV: DeviceInfo = { id: "TV-UDID", platform: "ios", kind: "simulator" };
const IOS_REMOTE: DeviceInfo = { id: "remote-udid", platform: "ios-remote", kind: "simulator" };

// `2>&1` folds the device's stderr into the stream `adbShell` returns: API 30
// writes its usage dump to stderr, and without the redirect that case looks
// exactly like a success. (`Unknown command: …` is the other wording `input`
// uses for a subcommand it does not have, on stdout — see the test for it.)
const SELECT_ALL_CMD = "input keycombination 113 29 2>&1"; // KEYCODE_CTRL_LEFT + KEYCODE_A
const DEL_CMD = "input keyevent 67"; // KEYCODE_DEL

function registryWith(api: unknown) {
  return { resolveService: vi.fn(async () => api) } as never;
}

describe("keyboard clear — iOS (simulator-server)", () => {
  // Records the HID traffic as an ordered list so a chord (modifier held across
  // the inner key's down/up) is distinguishable from two separate taps.
  function recordingApi() {
    const events: string[] = [];
    return {
      events,
      api: {
        pressKey: (direction: "Down" | "Up", keyCode: number) =>
          events.push(`${direction}:${keyCode}`),
      },
    };
  }

  /**
   * The HID traffic of one run with its leading modifier-release prelude
   * dropped — every run opens by letting go of Shift and Left GUI so a modifier
   * stranded by an earlier run's death cannot chord the next keystroke (see
   * "releases any stranded modifier before pressing anything").
   */
  const pressed = (events: string[]) => {
    expect(events.slice(0, 2)).toEqual(["Up:225", "Up:227"]);
    return events.slice(2);
  };

  it("holds Cmd across A, then presses backspace, before typing any text", async () => {
    const { events, api } = recordingApi();

    const result = await typeSimulatorServer(registryWith(api), IOS_SIM, {
      udid: IOS_SIM.id,
      clear: true,
      text: "a",
      delayMs: 0,
    });

    // Cmd must go down before A and come up after it — a chord, not two taps.
    // The usages are written out rather than imported from the module under
    // test: 227 is Left GUI and 4 is `a` in the USB HID usage tables, and
    // comparing the recorded traffic against the module's own constants would
    // make any value it declared correct by construction — a wrong one (Cmd+B,
    // RightCtrl+A) selects nothing, the backspace then removes a single
    // character, and the tool still reports `cleared: true`.
    const hid = pressed(events);
    expect(hid.slice(0, 4)).toEqual(["Down:227", "Down:4", "Up:4", "Up:227"]);
    // Then the delete that removes the now-selected contents (usage 42).
    expect(hid.slice(4, 6)).toEqual(["Down:42", "Up:42"]);
    // …and only then the text. Clear-after-text would empty the field the tool
    // just populated, so the ordering is the whole contract.
    expect(hid.slice(6)).toEqual(["Down:4", "Up:4"]);
    expect(result.cleared).toBe(true);
  });

  it("lets Command go even when the write inside the chord throws", async () => {
    // Modifier state lives in the GUEST and a modifier left down stays down, so
    // a transport that dies between `Down 227` and the A it is holding for
    // latches Command there: the next `{ text: "h" }` reaches the device as
    // Cmd+H, which backgrounds the app, and the call reports the character as
    // typed. Only the `finally` in `pressKeyCode` covers that — the existing iOS
    // failure test rejects before any write, so deleting the try/finally stayed
    // green.
    const events: string[] = [];
    const api = {
      pressKey: (direction: "Down" | "Up", keyCode: number) => {
        events.push(`${direction}:${keyCode}`);
        // The A of the select-all chord, with Left GUI already down.
        if (direction === "Down" && keyCode === 4) throw new Error("simulator-server: EPIPE");
      },
    };

    await expect(
      typeSimulatorServer(registryWith(api), IOS_SIM, {
        udid: IOS_SIM.id,
        clear: true,
        delayMs: 0,
      })
    ).rejects.toThrow(/EPIPE/);

    // The failure propagates, but the guest is not left holding Command.
    expect(events).toEqual(["Up:225", "Up:227", "Down:227", "Down:4", "Up:227"]);
  });

  it("serializes overlapping calls so a keystroke never lands inside the chord", async () => {
    // The modifier is held across awaits, and nothing else serializes tool calls
    // against a device. A `{ text: "w" }` arriving inside that window used to be
    // delivered as Cmd+W — a system shortcut — while still being reported as
    // typed. Interleaving shows up as `Down:26` between `Down:227` and `Up:227`.
    const { events, api } = recordingApi();
    const registry = registryWith(api);

    const clearing = typeSimulatorServer(registry, IOS_SIM, {
      udid: IOS_SIM.id,
      clear: true,
      delayMs: 5,
    });
    const typing = typeSimulatorServer(registry, IOS_SIM, {
      udid: IOS_SIM.id,
      text: "w",
      delayMs: 5,
    });
    await Promise.all([clearing, typing]);

    // The window is bounded by the clear's own presses, not by the Left GUI
    // down/up pair: every run opens by releasing stranded modifiers, so an
    // `Up:227` from the SECOND call's prelude lands inside the first call's
    // chord and would close the window early — the same trap the test three
    // down records. `Down:227` opens the chord and `Up:42` ends the backspace
    // that finishes the clear, so this spans the whole first call.
    const guiDown = events.indexOf("Down:227");
    const clearEnd = events.indexOf("Up:42");
    expect(guiDown).toBeGreaterThanOrEqual(0);
    expect(clearEnd).toBeGreaterThan(guiDown);
    expect(events.slice(guiDown, clearEnd)).not.toContain("Down:26");
    // The second call still ran, in full, after the first finished.
    expect(events.slice(clearEnd)).toContain("Down:26");
  });

  it("serializes two SPELLINGS of one udid onto the same chain", async () => {
    // The chain is keyed on a case-folded id because `device.id` is the caller's
    // own string verbatim — `resolveDevice` classifies an iOS UDID by shape and
    // never canonicalises it — while the modifier state being serialized lives
    // in the GUEST, which has exactly one of it however the caller spelled the
    // address. Keyed on the raw id, these two take different chains and the `w`
    // lands inside the Left GUI hold as Cmd+W: measured 7/7 on an iPhone 17 Pro
    // simulator, never reaching the field while the call reported it typed.
    //
    // Nothing else in this file drives one device under two spellings, so
    // without this the fold is free to be deleted.
    const { events, api } = recordingApi();
    const registry = registryWith(api);
    const lower: DeviceInfo = { ...IOS_SIM, id: IOS_SIM.id.toLowerCase() };
    expect(lower.id).not.toBe(IOS_SIM.id);

    const clearing = typeSimulatorServer(registry, IOS_SIM, {
      udid: IOS_SIM.id,
      clear: true,
      delayMs: 5,
    });
    const typing = typeSimulatorServer(registry, lower, { udid: lower.id, text: "w", delayMs: 5 });
    await Promise.all([clearing, typing]);

    // Same window as the single-spelling test above: `Down:227` opens the chord
    // and `Up:42` ends the backspace that finishes the clear.
    const guiDown = events.indexOf("Down:227");
    const clearEnd = events.indexOf("Up:42");
    expect(guiDown).toBeGreaterThanOrEqual(0);
    expect(clearEnd).toBeGreaterThan(guiDown);
    expect(events.slice(guiDown, clearEnd)).not.toContain("Down:26");
    expect(events.slice(clearEnd)).toContain("Down:26");
  });

  it("keeps a THIRD call behind the one in flight, not alongside it", async () => {
    // The chain slot is dropped only when nothing is queued behind the call that
    // drained it. Deleting it unconditionally is invisible while every call is
    // issued up front — they have all chained by then. It shows up when a call
    // arrives AFTER an earlier one drained but while a later one is still
    // running: it then finds no chain and starts alongside that run, putting a
    // keystroke back inside the held Left GUI chord.
    const { events, api } = recordingApi();
    const registry = registryWith(api);

    // A is instant, B holds the chord, C arrives once A has drained.
    const a = typeSimulatorServer(registry, IOS_SIM, { udid: IOS_SIM.id, text: "a", delayMs: 0 });
    const b = typeSimulatorServer(registry, IOS_SIM, {
      udid: IOS_SIM.id,
      clear: true,
      delayMs: 40,
    });
    await a;
    // A macrotask, so A's chain-slot bookkeeping (a `.then` two microtasks
    // behind its result) has actually run before C asks for the chain.
    await new Promise((r) => setTimeout(r, 0));
    const c = typeSimulatorServer(registry, IOS_SIM, { udid: IOS_SIM.id, text: "w", delayMs: 0 });
    await Promise.all([b, c]);

    // Usage 42 is the backspace that ends B's clear, and 26 is C's `w`. C may
    // only press after B is done; an overtaking C lands its `w` first. (The
    // Left GUI down/up pair is not the marker to use here — C's own opening
    // modifier release emits an `Up:227` that would sit inside B's chord.)
    expect(events.indexOf("Down:26")).toBeGreaterThan(events.indexOf("Up:42"));
    expect(events).toContain("Down:26");
  });

  describe("giving up when the client does", () => {
    // The chain is what stops a concurrent keystroke landing inside the clear's
    // Command hold, and until now there was no way out of it. Each character
    // costs `2 × delayMs`, `text` has no length cap and `delayMs` may be 5000, so
    // one call can hold a device's keyboard for minutes — and `longRunning: true`
    // means the MCP adapter no longer bounds it with its 30s fetch timeout.
    // Measured on an iPhone 17e (iOS 26.5): `{ text: <40 chars>, delayMs: 2000 }`
    // ran 160.5s, an `{ key: "escape" }` fired 1s behind it returned in 159.5s
    // (~440× the 0.36s control), and aborting the long call at 2s left the run
    // going and the chain held — so the caller could not even bail out with the
    // `escape` it would send to do so.
    it("stops an in-flight run within about one keypress of the abort", async () => {
      const { events, api } = recordingApi();
      const controller = new AbortController();
      const run = typeSimulatorServer(
        registryWith(api),
        IOS_SIM,
        { udid: IOS_SIM.id, text: "abcdefghij", delayMs: 20 },
        controller.signal
      );
      // Let a couple of characters go out, then hang up.
      await new Promise((r) => setTimeout(r, 60));
      controller.abort();

      await expect(run).rejects.toThrow();
      const downs = events.filter((e) => e.startsWith("Down:") && e !== "Down:227").length;
      // Some characters were typed — this is a real run, not a no-op — but not
      // all ten of them.
      expect(downs).toBeGreaterThan(0);
      expect(downs).toBeLessThan(10);
    });

    it("never leaves a key or a modifier held down when it stops", async () => {
      // The signal is checked BETWEEN presses, never inside `pressKeyCode`:
      // cutting the wait between a key's Down and its Up would strand that key in
      // the guest, which is the exact failure `releaseHeldModifiers` exists to
      // heal.
      const { events, api } = recordingApi();
      const controller = new AbortController();
      const run = typeSimulatorServer(
        registryWith(api),
        IOS_SIM,
        { udid: IOS_SIM.id, clear: true, text: "abcdefghij", delayMs: 20 },
        controller.signal
      );
      await new Promise((r) => setTimeout(r, 80));
      controller.abort();
      await expect(run).rejects.toThrow();

      // Every `Down:<usage>` has a matching `Up:<usage>` after it.
      const held = new Set<string>();
      for (const event of events) {
        const [direction, usage] = event.split(":");
        if (direction === "Down") held.add(usage!);
        else held.delete(usage!);
      }
      expect([...held]).toEqual([]);
    });

    it("hands the device's keyboard straight on when a QUEUED call was abandoned", async () => {
      // The point of the chain check: a request the client has already given up
      // on must not spend the device's keyboard when its turn comes. Without it a
      // queue of hung-up calls still typed every one of them out in full, and the
      // caller waiting behind them paid for all of it.
      const { events, api } = recordingApi();
      const registry = registryWith(api);
      const controller = new AbortController();

      const first = typeSimulatorServer(
        registry,
        IOS_SIM,
        { udid: IOS_SIM.id, text: "a", delayMs: 30 },
        undefined
      );
      const abandoned = typeSimulatorServer(
        registry,
        IOS_SIM,
        { udid: IOS_SIM.id, text: "bbbbbbbbbb", delayMs: 30 },
        controller.signal
      );
      const last = typeSimulatorServer(registry, IOS_SIM, {
        udid: IOS_SIM.id,
        text: "c",
        delayMs: 0,
      });
      controller.abort();

      await first;
      await expect(abandoned).rejects.toThrow();
      expect(await last).toMatchObject({ typed: "c", keys: 1 });
      // Usage 5 is `b`: not one of the abandoned call's characters was typed…
      expect(events).not.toContain("Down:5");
      // …and the call behind it still ran (6 is `c`).
      expect(events).toContain("Down:6");
    });
  });

  it("does not let a rejected call block the ones queued behind it", async () => {
    // The chain stores a tail that never rejects, so a 400 (or a transport
    // failure) on one call cannot wedge the device's queue — while the caller
    // of the failing call still gets its own rejection.
    const { events, api } = recordingApi();
    const registry = registryWith(api);

    const rejected = typeSimulatorServer(registry, IOS_SIM, {
      udid: IOS_SIM.id,
      key: "no-such-key",
      delayMs: 0,
    });
    const queued = typeSimulatorServer(registry, IOS_SIM, {
      udid: IOS_SIM.id,
      text: "b",
      delayMs: 0,
    });

    await expect(rejected).rejects.toThrow(/Unknown key/);
    expect(await queued).toMatchObject({ typed: "b", keys: 1 });
    // Only the second call's keystroke reached the device (the rejected call
    // never got past validation, so it wrote nothing at all).
    expect(pressed(events)).toEqual(["Down:5", "Up:5"]);
  });

  it("releases any stranded modifier before pressing anything", async () => {
    // Modifier state lives in the guest and the `finally` that releases it only
    // covers a throw — not the process dying inside the ~83ms window the clear
    // holds Left GUI. Measured on an iPhone 16: kill the tool-server there and
    // Command stays latched, so the next `{ text: "h" }` returns
    // `{"typed":"h","keys":1}` while Cmd+H sends the app to the Home screen and
    // the page never sees the character. It survives a restart, and nothing
    // reads modifier state back — so every run starts by letting go of both
    // modifiers it is capable of holding. `Up` on a key that is not down is a
    // no-op, so this is free on the normal path.
    const { events, api } = recordingApi();

    await typeSimulatorServer(registryWith(api), IOS_SIM, {
      udid: IOS_SIM.id,
      text: "a",
      delayMs: 0,
    });

    expect(events.slice(0, 2)).toEqual(["Up:225", "Up:227"]);
  });

  it("clears with no text and reports cleared", async () => {
    const { events, api } = recordingApi();

    const result = await typeSimulatorServer(registryWith(api), IOS_SIM, {
      udid: IOS_SIM.id,
      clear: true,
      delayMs: 0,
    });

    expect(pressed(events)).toEqual(["Down:227", "Down:4", "Up:4", "Up:227", "Down:42", "Up:42"]);
    // `keys` counts what the caller asked to ENTER, so a clear contributes 0 —
    // the same number Android and Chromium report for the same call. Counting
    // the clear's own presses here would make one request report a different
    // `keys` per platform, which is the cross-platform divergence this feature
    // exists to avoid.
    expect(result).toEqual({ typed: "", keys: 0, cleared: true });
  });

  it("reports the same `keys` for a clear as the other backends", async () => {
    const { api } = recordingApi();

    const ios = await typeSimulatorServer(registryWith(api), IOS_SIM, {
      udid: IOS_SIM.id,
      clear: true,
      text: "abc",
      delayMs: 0,
    });
    const android = await makeAndroidImpl(registryWith({})).handler(
      {},
      { udid: ANDROID.id, clear: true, text: "abc" },
      ANDROID
    );
    const chromium = await makeChromiumImpl(
      registryWith({ dispatchKeyEvent: async () => {} })
    ).handler({}, { udid: CHROMIUM.id, clear: true, text: "abc", delayMs: 0 }, CHROMIUM);

    expect(ios).toEqual({ typed: "abc", keys: 3, cleared: true });
    expect(android).toEqual(ios);
    expect(chromium).toEqual(ios);
  });

  it("orders clear → key in a single call", async () => {
    // `key`, not `text`: clear-then-text is pinned by the test above, and the
    // tool rejects `{ text, key }`, so clear-then-KEY is the second combination
    // a caller can actually send and the only one still unpinned. A backend that
    // pressed the key before emptying the field would submit the OLD value.
    const { events, api } = recordingApi();

    await typeSimulatorServer(registryWith(api), IOS_SIM, {
      udid: IOS_SIM.id,
      clear: true,
      key: "enter",
      delayMs: 0,
    });

    // Left GUI, `a`, backspace (the select-all chord and its delete), then
    // enter — HID usages spelled out for the same reason as above.
    const downs = events.filter((e) => e.startsWith("Down:"));
    expect(downs).toEqual(["Down:227", "Down:4", "Down:42", "Down:40"]);
  });

  it("rejects an unknown key before clearing anything", async () => {
    const { events, api } = recordingApi();

    await expect(
      typeSimulatorServer(registryWith(api), IOS_SIM, {
        udid: IOS_SIM.id,
        clear: true,
        key: "bogus",
        delayMs: 0,
      })
    ).rejects.toThrow(/Unknown key "bogus"/);
    expect(events).toEqual([]);
  });

  it("rejects un-typeable text BEFORE clearing (never destroys the old value)", async () => {
    const { events, api } = recordingApi();

    await expect(
      typeSimulatorServer(registryWith(api), IOS_SIM, {
        udid: IOS_SIM.id,
        clear: true,
        text: "café",
        delayMs: 0,
      })
    ).rejects.toThrow(/No keycode for character "é"/);
    // Clearing and THEN rejecting on character 4 would empty the field, leave
    // "caf" behind, and return 400 — the caller's original value destroyed by a
    // call that failed. Nothing may reach the device.
    expect(events).toEqual([]);
  });

  it("omits `cleared` entirely when clear was not requested", async () => {
    const { api } = recordingApi();

    const result = await typeSimulatorServer(registryWith(api), IOS_SIM, {
      udid: IOS_SIM.id,
      text: "a",
      delayMs: 0,
    });

    expect(result).not.toHaveProperty("cleared");
  });

  it("holds shift down across a capital's whole down/up pair", async () => {
    const { events, api } = recordingApi();

    await typeSimulatorServer(registryWith(api), IOS_SIM, {
      udid: IOS_SIM.id,
      text: "A",
      delayMs: 0,
    });

    // 225 is SHIFT_KEYCODE — held across A's down/up, and NOT the Cmd keycode.
    expect(pressed(events)).toEqual(["Down:225", "Down:4", "Up:4", "Up:225"]);
  });
});

describe("keyboard clear — Android (adb input)", () => {
  // `mockReset` (not `mockClear`): several tests queue a one-shot
  // implementation, and a queued entry that goes unconsumed would leak into the
  // next test and fail it somewhere unrelated. Reset drops the queue, then the
  // default "exit 0, no output" behaviour is restored — which is what a device
  // that supports `keycombination` actually returns.
  beforeEach(() => {
    adbShell.mockReset();
    adbShell.mockImplementation(async () => "");
    adbExecOutBinary.mockReset();
    adbExecOutBinary.mockImplementation(async () => Buffer.from(""));
    isAndroidTv.mockReset();
    isAndroidTv.mockImplementation(async () => false);
  });

  /** The `input` command lines, in order. The dump is not one of them. */
  const inputCmds = () => adbShell.mock.calls.map((c) => c[1]);
  /** Keycodes of the fallback's single `input keyevent <MOVE_END> <DEL>…` run. */
  const deleteRun = (cmd: string) => {
    expect(cmd.startsWith("input keyevent 123 ")).toBe(true);
    const dels = cmd.split(" ").slice(3);
    expect(dels.every((d) => d === "67")).toBe(true);
    return dels;
  };
  const seedLegacyLevel = () => adbShell.mockImplementationOnce(async () => "Usage: input …");
  const seedDump = (xml: string) =>
    adbExecOutBinary.mockImplementationOnce(async () => Buffer.from(xml));

  it("selects all then deletes, before typing any text", async () => {
    const result = await makeAndroidImpl(registryWith({})).handler(
      {},
      { udid: ANDROID.id, clear: true, text: "abc" },
      ANDROID
    );

    expect(adbShell.mock.calls.map((c) => c[1])).toEqual([
      SELECT_ALL_CMD,
      DEL_CMD,
      "input text 'abc'",
    ]);
    expect(result.cleared).toBe(true);
  });

  it("orders clear → key in a single call", async () => {
    // The clear-then-text order is pinned above; `{ text, key }` is rejected by
    // the tool, so this is the other combination a caller can send. Pressing
    // Enter before the delete run would submit the field's OLD contents.
    await makeAndroidImpl(registryWith({})).handler(
      {},
      { udid: ANDROID.id, clear: true, key: "enter" },
      ANDROID
    );

    expect(adbShell.mock.calls.map((c) => c[1])).toEqual([
      SELECT_ALL_CMD,
      DEL_CMD,
      "input keyevent 66",
    ]);
  });

  // uiautomator dump for a focused EditText holding `text`. `password="true"`
  // makes its contents unreadable, which is what forces the blind count.
  const dumpWith = (text: string, password = false) =>
    `<?xml version='1.0' encoding='UTF-8'?><hierarchy rotation="0">` +
    `<node index="0" text="${text}" resource-id="email" class="android.widget.EditText" ` +
    `password="${password}" focused="true" bounds="[0,0][100,50]" />` +
    `</hierarchy>`;

  it("falls back to a measured delete run when `keycombination` is unavailable", async () => {
    // An older level has no `keycombination` subcommand — and still EXITS 0,
    // printing a usage dump (to stderr, hence the `2>&1` on the probe). The
    // fallback measures the field instead of guessing: a fixed run would leave
    // a longer field's head in place and append the new text to that residue.
    seedLegacyLevel();
    seedDump(dumpWith("abcdefghij")); // 10 chars

    await makeAndroidImpl(registryWith({})).handler({}, { udid: ANDROID.id, clear: true }, ANDROID);

    const cmds = inputCmds();
    expect(cmds[0]).toBe(SELECT_ALL_CMD);
    // MOVE_END (123) so the caret is past the last character, then one DEL per
    // measured character plus a small margin — all in ONE `input` invocation.
    expect(deleteRun(cmds[1]!)).toHaveLength(10 + 8);
    // The standalone post-select DEL must NOT also fire on this path.
    expect(cmds).not.toContain(DEL_CMD);
  });

  it("reads the hierarchy over exec-out, never over `adb shell`", async () => {
    // `adb shell 'uiautomator dump /dev/tty'` exits 0 and returns only a status
    // line, so a dump read that way measures every field as unreadable and the
    // run silently degrades to the blind count. Pin the transport, not just the
    // resulting number.
    seedLegacyLevel();
    seedDump(dumpWith("abcdefghij"));

    await makeAndroidImpl(registryWith({})).handler({}, { udid: ANDROID.id, clear: true }, ANDROID);

    expect(adbExecOutBinary).toHaveBeenCalledTimes(1);
    expect(adbExecOutBinary.mock.calls[0]![1]).toMatch(/^uiautomator dump /);
    expect(inputCmds().some((c) => c.includes("uiautomator"))).toBe(false);
  });

  it("shares one deadline across the clear's legs instead of a timeout each", async () => {
    // The budget is what has to hold ON THE DEVICE, whatever the client waits
    // for: sizing each leg against the adapter's 30s independently is what
    // produced a 60s worst case, with adb still deleting long after the run was
    // meant to be over. Time spent on an earlier leg comes off the next one's.
    let clock = 1_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => clock);
    try {
      adbShell.mockImplementationOnce(async () => {
        clock += 3_000; // a slow probe
        return "Usage: input …";
      });
      adbExecOutBinary.mockImplementationOnce(async () => {
        clock += 4_000; // a slow dump
        return Buffer.from(dumpWith("abc"));
      });

      await makeAndroidImpl(registryWith({})).handler(
        {},
        { udid: ANDROID.id, clear: true },
        ANDROID
      );

      const timeoutOf = (call: [string, string, unknown?]) =>
        (call[2] as { timeoutMs: number }).timeoutMs;
      // The probe is a READ leg too, and the FIRST one — if it kept a cap of its
      // own the shared deadline would never bind, which is the whole mechanism
      // this block introduced. 26s budget − 0s spent − 11s reserved, which is
      // exactly ADB_INPUT_TIMEOUT_MS: the probe is one ordinary `input`
      // invocation, and starving it below that made `{ clear: true }` fail on a
      // device where `{ text: "…" }` succeeds. The budget is derived from those
      // two constants so the equality holds by construction.
      expect(timeoutOf(adbShell.mock.calls[0]!)).toBe(15_000);
      // The dump is a READ leg, so it gets what is left MINUS the reserve held
      // back for the delete run: 26s budget − 3s spent − 11s reserved. Without
      // that subtraction a slow dump can spend the whole budget and the run it
      // measured for then starts with nothing left.
      expect(timeoutOf(adbExecOutBinary.mock.calls[0]!)).toBe(12_000);
      // The delete run is the MUTATING leg, so it gets everything remaining
      // (26s − 7s) rather than a fresh full-size cap — being killed part-way
      // through is what leaves a half-deleted field.
      expect(timeoutOf(adbShell.mock.calls[1]!)).toBe(19_000);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it.each([
    // A warm probe leaves ~24s of budget, and the DEL is capped at the ordinary
    // per-`input` budget instead of taking all of it: one `keyevent` has no
    // reason to outlive ADB_INPUT_TIMEOUT_MS, and 10s past it is 10s past what
    // this file says every `input` call gets.
    ["the ordinary per-`input` cap when the budget is roomier", 2_000, 15_000],
    // A slow probe leaves less than that cap, and the shared deadline still
    // binds — a fresh full-size cap here would stack 15s on top of the probe's
    // 15s and the text injection's 15s, which is the 30s-per-request overrun the
    // shared budget exists to prevent.
    ["the shared deadline when that is tighter", 14_000, 12_000],
  ])("gives the modern path's DEL %s", async (_label, probeMs, expected) => {
    let clock = 1_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => clock);
    try {
      adbShell.mockImplementationOnce(async () => {
        clock += probeMs; // a level that supports the subcommand
        return "";
      });

      await makeAndroidImpl(registryWith({})).handler(
        {},
        { udid: ANDROID.id, clear: true },
        ANDROID
      );

      const timeoutOf = (call: [string, string, unknown?]) =>
        (call[2] as { timeoutMs: number }).timeoutMs;
      expect(adbShell.mock.calls[1]![1]).toBe(DEL_CMD);
      expect(timeoutOf(adbShell.mock.calls[1]!)).toBe(expected);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("reports a killed modern DEL as INTERRUPTED, naming the surviving selection", async () => {
    // The select-all has already landed when this leg runs, and it SURVIVES the
    // kill — verified on API 36: the field still held its whole value and the
    // next character typed into it replaced the lot. `adbShell`'s own error says
    // only that `input keyevent 67` was killed, so a caller reads a transport
    // fault and retries against a field it believes is untouched. The legacy
    // path's delete run has been rewrapped for this since it shipped; this leg
    // had no equivalent.
    adbShell.mockImplementationOnce(async () => ""); // the level supports the chord
    adbShell.mockImplementationOnce(async () => {
      throw new FailureError("adb -s emulator-5554 shell input keyevent 67 failed (killed=true)", {
        error_code: FAILURE_CODES.ANDROID_ADB_COMMAND_FAILED,
        failure_stage: "android_adb_command",
        failure_area: "tool_server",
        error_kind: "timeout",
      });
    });

    const err = await makeAndroidImpl(registryWith({}))
      .handler({}, { udid: ANDROID.id, clear: true, text: "replacement" }, ANDROID)
      .then(
        () => {
          throw new Error("expected the call to reject, but it resolved");
        },
        (e: unknown) => e as Error
      );

    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.KEYBOARD_CLEAR_INTERRUPTED);
    // The kind is carried through, so a killed leg still reads as a timeout.
    expect(getFailureSignal(err)?.error_kind).toBe("timeout");
    expect(err.message).toMatch(/all of it SELECTED/);
    expect(err.message).not.toMatch(/input keyevent/);
    // Refused before the typing: the replacement must not land on a selection.
    expect(inputCmds().some((cmd) => cmd.includes("input text"))).toBe(false);
  });

  it("floors an overrun leg at 1s rather than handing adb no timeout at all", async () => {
    // `runAdb` forwards this straight to `execFile`'s `timeout`, and
    // `??`-defaulting preserves a `0` — which Node reads as NO timeout. An
    // already-overrun budget would therefore hand the last leg an unbounded adb
    // child instead of failing it fast.
    let clock = 1_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => clock);
    try {
      adbShell.mockImplementationOnce(async () => {
        clock += 60_000; // the probe alone blows the whole budget
        return "";
      });

      await makeAndroidImpl(registryWith({})).handler(
        {},
        { udid: ANDROID.id, clear: true },
        ANDROID
      );

      const timeoutOf = (call: [string, string, unknown?]) =>
        (call[2] as { timeoutMs: number }).timeoutMs;
      expect(timeoutOf(adbShell.mock.calls[1]!)).toBe(1_000);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("retries a dump the device refused before falling back to the blind count", async () => {
    // The device serves one UiAutomation connection, so concurrent readers race
    // and the loser gets a bare `Killed` with adb still exiting 0. Degrading
    // straight to the blind count there truncates any field longer than it,
    // while still reporting `cleared: true`.
    seedLegacyLevel();
    seedDump("Killed");
    seedDump(dumpWith("abcdefghij")); // the retry succeeds

    await makeAndroidImpl(registryWith({})).handler({}, { udid: ANDROID.id, clear: true }, ANDROID);

    expect(adbExecOutBinary).toHaveBeenCalledTimes(2);
    expect(deleteRun(inputCmds()[1]!)).toHaveLength(10 + 8);
  });

  it("retries a dump that THREW as well as one that answered uselessly", async () => {
    // `dumpAndroidUiXml` throws on any transport failure — a dropped socket, an
    // `adb` still attaching to a just-booted device — and those fail FAST, so an
    // unguarded throw escaped the loop, skipped the backoff retry entirely, and
    // dropped to the blind count with almost the whole budget unspent. A
    // transient reader is exactly what the retry is for.
    seedLegacyLevel();
    adbExecOutBinary.mockImplementationOnce(async () => {
      throw new Error("adb: device 'emulator-5554' not found");
    });
    seedDump(dumpWith("abcdefghij"));

    await makeAndroidImpl(registryWith({})).handler({}, { udid: ANDROID.id, clear: true }, ANDROID);

    expect(adbExecOutBinary).toHaveBeenCalledTimes(2);
    expect(deleteRun(inputCmds()[1]!)).toHaveLength(10 + 8);
  }, 10_000);

  it("falls back to the blind count when BOTH dump attempts throw", async () => {
    seedLegacyLevel();
    adbExecOutBinary.mockImplementation(async () => {
      throw new Error("adb: device offline");
    });

    await makeAndroidImpl(registryWith({})).handler({}, { udid: ANDROID.id, clear: true }, ANDROID);

    expect(adbExecOutBinary).toHaveBeenCalledTimes(2);
    expect(deleteRun(inputCmds()[1]!)).toHaveLength(MAX_DELETE_COUNT + 8);
  }, 10_000);

  it("does not spend the retry backoff when the budget cannot fit another dump", async () => {
    // The backoff has to be counted BEFORE it is slept, not after: sleeping and
    // then discovering there is no budget left spends the wait out of the delete
    // run's reserve, which is the one thing the reserve exists to stop. Both
    // orderings decline the retry here — the difference is only whether 2.5s of
    // the reserve is burned first, so this measures real elapsed time.
    let clock = 1_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => clock);
    try {
      adbShell.mockImplementationOnce(async () => "Usage: input …");
      adbExecOutBinary.mockImplementationOnce(async () => {
        clock += 11_000; // leaves too little for a backoff plus another dump
        return Buffer.from("Killed");
      });

      const startedAt = process.hrtime.bigint();
      await makeAndroidImpl(registryWith({})).handler(
        {},
        { udid: ANDROID.id, clear: true },
        ANDROID
      );
      const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;

      expect(adbExecOutBinary).toHaveBeenCalledTimes(1);
      // Generous, but still well under DUMP_RETRY_BACKOFF_MS, so a loaded box
      // cannot flake this while a real backoff would still fail it.
      expect(elapsedMs).toBeLessThan(2_000);
      // …and it still clears, blind, rather than failing.
      expect(deleteRun(inputCmds()[1]!)).toHaveLength(MAX_DELETE_COUNT + 8);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("waits out the dump's holder before retrying, rather than re-racing it", async () => {
    // The winner of a UiAutomation race holds the connection for the whole dump
    // (~2s) while the loser is refused in ~0.27s, so an immediate retry re-races
    // the same holder and loses again — measured 3/3. Without a real wait the
    // retry is decoration and every lost race still degrades to the blind count.
    // Real elapsed time, because the backoff is a `sleep`, not a deadline read.
    seedLegacyLevel();
    seedDump("Killed");
    seedDump(dumpWith("abcdefghij"));

    const startedAt = process.hrtime.bigint();
    await makeAndroidImpl(registryWith({})).handler({}, { udid: ANDROID.id, clear: true }, ANDROID);
    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;

    expect(adbExecOutBinary).toHaveBeenCalledTimes(2);
    // Comfortably below DUMP_RETRY_BACKOFF_MS (2.5s) so a fast box cannot flake
    // it, and far above the ~0ms a dropped backoff would take.
    expect(elapsedMs).toBeGreaterThan(1_500);
  }, 10_000);

  it("removes the on-device dump file even when reading it back fails", async () => {
    // The dump is written to /data/local/tmp and `cat`ed back. Joining the two
    // with `&&` would skip the cleanup on exactly the failures that recur —
    // keyguard/MFA flaps once leaked a file per attempt — and the clear now runs
    // this path up to twice per call on top of describe and the TV blueprint.
    seedLegacyLevel();
    seedDump(dumpWith("abc"));

    await makeAndroidImpl(registryWith({})).handler({}, { udid: ANDROID.id, clear: true }, ANDROID);

    const dumpCmd = adbExecOutBinary.mock.calls[0]![1];
    expect(dumpCmd).toMatch(/;\s*rm -f /);
    expect(dumpCmd).not.toMatch(/&&\s*rm -f /);
  });

  it("writes each dump to its own file, so concurrent readers cannot race", async () => {
    // A shared path means one caller's `cat` reads another's write mid-flight,
    // and this clear is now a THIRD concurrent reader alongside `describe` and
    // the Android-TV blueprint — the reason the helper mints a per-call name.
    // Two whole clears, so `mockImplementationOnce` queues are not enough: the
    // delete run between them would eat the second level probe's answer.
    adbShell.mockImplementation(async (_serial: string, cmd: string) =>
      cmd.includes("keycombination") ? "Usage: input …" : ""
    );
    seedDump(dumpWith("abc"));
    seedDump(dumpWith("abc"));

    await makeAndroidImpl(registryWith({})).handler({}, { udid: ANDROID.id, clear: true }, ANDROID);
    await makeAndroidImpl(registryWith({})).handler({}, { udid: ANDROID.id, clear: true }, ANDROID);

    const paths = adbExecOutBinary.mock.calls.map(
      (call) => (call[1] as string).match(/\/data\/local\/tmp\/\S+\.xml/)?.[0]
    );
    expect(paths).toHaveLength(2);
    expect(paths[0]).toBeDefined();
    expect(paths[0]).not.toBe(paths[1]);
  });

  it("omits `cleared` entirely when clear was not requested", async () => {
    // `cleared` is defined as present only for a call that asked for a clear, so
    // an emitted `cleared: false` reads to an agent as "the clear ran and
    // failed" on a call that never requested one.
    const result = await makeAndroidImpl(registryWith({})).handler(
      {},
      { udid: ANDROID.id, text: "hi" },
      ANDROID
    );

    expect(result).not.toHaveProperty("cleared");
  });

  it("gives up after one retry rather than dumping forever", async () => {
    seedLegacyLevel();
    seedDump("Killed");
    seedDump("Killed");

    await makeAndroidImpl(registryWith({})).handler({}, { udid: ANDROID.id, clear: true }, ANDROID);

    expect(adbExecOutBinary).toHaveBeenCalledTimes(2);
    expect(deleteRun(inputCmds()[1]!)).toHaveLength(MAX_DELETE_COUNT + 8);
  });

  describe("reading the hierarchy from the connection's holder", () => {
    // The device serves ONE UiAutomation connection and argent's own
    // `android-devtools` helper holds it for ~60s per `describe` (measured 61.2s
    // on API 30). Inside that window every `uiautomator dump` returns a bare
    // `Killed` with adb still exiting 0, so the measurement fails, the run falls
    // to BLIND_DELETE_COUNT, and a long field is truncated with the new text
    // appended — reported as `cleared: true`, and with the MAX_DELETE_COUNT
    // refusal bypassed. Measured end to end 6/6: a 200-character field kept 72
    // characters. `describe` → tap → `keyboard` is the ordinary call order, so
    // asking the holder rather than racing it is the whole fix.
    // Typed WITH the options argument so the call site's `clearCache` is visible
    // to the assertions below — a zero-parameter stub makes it invisible, and
    // `toHaveBeenCalledTimes` alone would hold nothing.
    // RUNNING and IDLE are not the whole vocabulary: `isLiveServiceState` also
    // admits STARTING, and the gate is what decides whether a clear consults the
    // helper at all. Modelled as a third state rather than a second boolean so a
    // gate narrowed to `=== RUNNING` shows up here.
    const registryInState = (
      state: ServiceState,
      getHierarchy: (options?: { clearCache?: boolean }) => Promise<{ xml: string }>
    ) =>
      ({
        getServiceState: () => state,
        resolveService: vi.fn(async () => ({
          getHierarchy: async (options?: { clearCache?: boolean }) => ({
            windowCount: 1,
            truncated: false,
            ...(await getHierarchy(options)),
          }),
        })),
      }) as never;

    const registryWithDevtools = (
      getHierarchy: (options?: { clearCache?: boolean }) => Promise<{
        xml: string;
        // The two signals that tell a content-free helper reply from a real one.
        // Defaulted by the stub below, since most cases here are about the xml.
        windowCount?: number;
        truncated?: boolean;
      }>,
      live = true
    ) =>
      ({
        getServiceState: () => (live ? ServiceState.RUNNING : ServiceState.IDLE),
        resolveService: vi.fn(async () => ({
          getHierarchy: async (options?: { clearCache?: boolean }) => ({
            windowCount: 1,
            truncated: false,
            ...(await getHierarchy(options)),
          }),
        })),
      }) as never;

    it("measures from the helper, without racing it for a dump", async () => {
      seedLegacyLevel();
      const getHierarchy = vi.fn(async () => ({ xml: dumpWith("y".repeat(200)) }));

      await expect(
        makeAndroidImpl(registryWithDevtools(getHierarchy)).handler(
          {},
          { udid: ANDROID.id, clear: true },
          ANDROID
        )
        // Measured, so the length gate fires — where a blind run would have
        // deleted 158 and left 42 characters behind.
      ).rejects.toThrow(/reports 200 characters/);

      expect(getHierarchy).toHaveBeenCalledTimes(1);
      // `clearCache`, and not the blueprint's default: the helper caches
      // accessibility nodes, so a `describe` → tap → `keyboard` run — the order
      // this block calls the ordinary one — otherwise sizes the delete run from
      // the text that `describe` read, before the tap changed it. That
      // under-deletes a field whose value moved on, which is the truncation the
      // measurement exists to prevent.
      expect(getHierarchy).toHaveBeenCalledWith({ clearCache: true });
      expect(adbExecOutBinary).not.toHaveBeenCalled();
    });

    it("reads from a helper that is still STARTING, which is also live", async () => {
      // A helper mid-start already holds (or is about to hold) the UiAutomation
      // connection, so a dump raced against it loses exactly as it does against a
      // RUNNING one — and `isLiveServiceState` admits both.
      seedLegacyLevel();
      const getHierarchy = vi.fn(async () => ({ xml: dumpWith("y".repeat(200)) }));

      await expect(
        makeAndroidImpl(registryInState(ServiceState.STARTING, getHierarchy)).handler(
          {},
          { udid: ANDROID.id, clear: true },
          ANDROID
        )
      ).rejects.toThrow(/reports 200 characters/);

      expect(getHierarchy).toHaveBeenCalledTimes(1);
      expect(adbExecOutBinary).not.toHaveBeenCalled();
    });

    it("does not wake the helper when it is not already running", async () => {
      // With nothing holding the connection the dump works, and a clear must
      // never pay to spawn (or install) the helper.
      seedLegacyLevel();
      seedDump(dumpWith("abc"));
      const getHierarchy = vi.fn(async () => ({ xml: dumpWith("z".repeat(200)) }));

      await makeAndroidImpl(registryWithDevtools(getHierarchy, false)).handler(
        {},
        { udid: ANDROID.id, clear: true },
        ANDROID
      );

      expect(getHierarchy).not.toHaveBeenCalled();
      expect(deleteRun(inputCmds()[1]!)).toHaveLength(3 + 8);
    });

    it("does not let a wedged helper spend the delete run's reserve", async () => {
      // The helper's own `getHierarchy` RPC timeout is 15s — longer than the
      // whole read share of the clear's 26s budget — so an unbounded await here
      // would eat the 11s the delete run is guaranteed.
      seedLegacyLevel();
      seedDump(dumpWith("abcde"));
      const getHierarchy = vi.fn(() => new Promise<{ xml: string }>(() => {}));

      const startedAt = Date.now();
      await makeAndroidImpl(registryWithDevtools(getHierarchy)).handler(
        {},
        { udid: ANDROID.id, clear: true },
        ANDROID
      );

      // The read share is the budget minus the reserve, so the wait is bounded
      // well under the helper's own 15s — and the dump still measured the field.
      expect(Date.now() - startedAt).toBeLessThan(14_000);
      expect(deleteRun(inputCmds()[1]!)).toHaveLength(5 + 8);
    }, 20_000);

    describe("the budget algebra the read legs share", () => {
      // Three branches decide how the clear's 26s is split, and mutation left all
      // three green: the `Math.min` clamp on the helper read, the `> 0` guard that
      // decides whether to consult it at all, and the retry loop's attempt-0 arm.
      // Each one below fails on the corresponding mutation.
      it("clamps the helper's share to PREFERRED_READ_BUDGET_MS, not to what is left", async () => {
        // With a fresh deadline the read legs could fund 12.5s (26 − 11 reserve −
        // 2.5 for one dump), and a wedged helper must still be abandoned at 5s so
        // the dump fallback keeps its share.
        vi.useFakeTimers();
        try {
          seedLegacyLevel();
          seedDump(dumpWith("abcd"));
          const getHierarchy = vi.fn(() => new Promise<{ xml: string }>(() => {}));

          const run = makeAndroidImpl(registryWithDevtools(getHierarchy)).handler(
            {},
            { udid: ANDROID.id, clear: true },
            ANDROID
          );

          await vi.advanceTimersByTimeAsync(4_900);
          // Still waiting on the helper: no dump has gone out yet.
          expect(adbExecOutBinary).not.toHaveBeenCalled();
          await vi.advanceTimersByTimeAsync(200);
          expect(adbExecOutBinary).toHaveBeenCalledTimes(1);

          await vi.runAllTimersAsync();
          await run;
          expect(deleteRun(inputCmds()[1]!)).toHaveLength(4 + 8);
        } finally {
          vi.useRealTimers();
        }
      });

      it("takes the REMAINDER when that is smaller than the helper's own cap", async () => {
        // A slow probe leaves less than 5s of read share, and the helper read must
        // shrink to it — spending the full cap would come out of the dump's share
        // and the delete run's reserve.
        let clock = 1_000_000;
        const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => clock);
        const realNow = performance.now();
        try {
          adbShell.mockImplementationOnce(async () => {
            clock += 10_000; // a slow probe: 16s left, so 2.5s of read share
            return "Usage: input …";
          });
          seedDump(dumpWith("abcd"));
          const getHierarchy = vi.fn(() => new Promise<{ xml: string }>(() => {}));

          await makeAndroidImpl(registryWithDevtools(getHierarchy)).handler(
            {},
            { udid: ANDROID.id, clear: true },
            ANDROID
          );

          // Real elapsed time, since the race runs on a real timer: ~2.5s, not the
          // 5s cap.
          expect(performance.now() - realNow).toBeLessThan(4_000);
          expect(getHierarchy).toHaveBeenCalledTimes(1);
          expect(deleteRun(inputCmds()[1]!)).toHaveLength(4 + 8);
        } finally {
          nowSpy.mockRestore();
        }
      }, 20_000);

      it("does not even ISSUE the helper read once its share is gone", async () => {
        // The guard is not just about how long to wait: the RPC serialises on one
        // chain with `describe`, so a read nobody can wait for still holds that
        // chain until the helper's own 15s timeout.
        let clock = 1_000_000;
        const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => clock);
        try {
          adbShell.mockImplementationOnce(async () => {
            clock += 14_000; // 12s left: less than reserve + one dump
            return "Usage: input …";
          });
          const getHierarchy = vi.fn(async () => ({ xml: dumpWith("abcd") }));

          await makeAndroidImpl(registryWithDevtools(getHierarchy)).handler(
            {},
            { udid: ANDROID.id, clear: true },
            ANDROID
          );

          expect(getHierarchy).not.toHaveBeenCalled();
          // No dump either — there is no share left for one — so the blind count.
          expect(adbExecOutBinary).not.toHaveBeenCalled();
          expect(deleteRun(inputCmds()[1]!)).toHaveLength(MAX_DELETE_COUNT + 8);
        } finally {
          nowSpy.mockRestore();
        }
      });

      it("does not charge the FIRST dump the retry backoff", async () => {
        // `attempt > 0 ? DUMP_RETRY_BACKOFF_MS : 0` — with the backoff applied on
        // attempt 0 as well, a budget that funds exactly one dump declines it and
        // the clear falls to the blind count.
        let clock = 1_000_000;
        const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => clock);
        try {
          adbShell.mockImplementationOnce(async () => {
            clock += 12_500; // 13.5s left: reserve + exactly one dump
            return "Usage: input …";
          });
          seedDump(dumpWith("abcdef"));

          await makeAndroidImpl(registryWith({})).handler(
            {},
            { udid: ANDROID.id, clear: true },
            ANDROID
          );

          expect(adbExecOutBinary).toHaveBeenCalledTimes(1);
          expect(deleteRun(inputCmds()[1]!)).toHaveLength(6 + 8);
        } finally {
          nowSpy.mockRestore();
        }
      });
    });

    it("disarms the budget timer the helper's answer beat", async () => {
      // The loser of a race is abandoned, not cancelled, and an armed
      // `setTimeout` holds the event loop open by itself — so the read that WON
      // used to leave a 5s handle behind. Invisible in the long-lived
      // tool-server; it delays the exit of any short-lived process instead.
      vi.useFakeTimers();
      try {
        seedLegacyLevel();
        const getHierarchy = vi.fn(async () => ({ xml: dumpWith("abc") }));

        const run = makeAndroidImpl(registryWithDevtools(getHierarchy)).handler(
          {},
          { udid: ANDROID.id, clear: true },
          ANDROID
        );
        // Let the microtasks settle: the helper answers on one, so the race is
        // decided without any timer firing.
        await vi.advanceTimersByTimeAsync(0);
        const armed = vi.getTimerCount();
        await vi.runAllTimersAsync();
        await run;

        expect(getHierarchy).toHaveBeenCalledTimes(1);
        expect(armed).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it("falls back to the dump when the helper answers without a hierarchy", async () => {
      // The helper can answer SUCCESSFULLY and still carry no tree: a `Killed`
      // from a lost UiAutomation race, an empty reply, a truncated file. Every
      // other stub here either returns a valid dump or fails outright, so a
      // check of "did it answer" rather than "did it answer with a hierarchy"
      // reads identically — and takes `Killed` as the measurement, which lands
      // on BLIND_DELETE_COUNT and truncates a long field while reporting
      // `cleared: true`.
      seedLegacyLevel();
      seedDump(dumpWith("abcd"));
      const getHierarchy = vi.fn(async () => ({ xml: "Killed" }));

      await makeAndroidImpl(registryWithDevtools(getHierarchy)).handler(
        {},
        { udid: ANDROID.id, clear: true },
        ANDROID
      );

      expect(getHierarchy).toHaveBeenCalledTimes(1);
      // The DUMP's four characters, not the blind count.
      expect(deleteRun(inputCmds()[1]!)).toHaveLength(4 + 8);
    });

    it.each([
      // `captureXml` writes its `<hierarchy rotation="…">` wrapper
      // unconditionally, so unlike a dump the helper does NOT announce a failed
      // capture: it answers successfully with an empty tree when it saw no
      // windows, and with a partial one when the walk truncated or a node refused
      // to refresh — dropping exactly the subtree the focused `EditText` is in.
      // Every such reply passed the "carries a hierarchy" test, both dumps were
      // skipped, and the clear became the blind count that truncates a long field
      // while reporting `cleared: true`.
      ["saw no windows", { xml: `<hierarchy rotation="0" />`, windowCount: 0, truncated: false }],
      ["truncated its walk", { xml: dumpWith("ab"), windowCount: 1, truncated: true }],
      [
        "answered with no nodes at all",
        { xml: `<hierarchy rotation="0"></hierarchy>`, windowCount: 1, truncated: false },
      ],
    ])("falls back to the dump when the helper %s", async (_label, reply) => {
      seedLegacyLevel();
      seedDump(dumpWith("abcd"));
      const getHierarchy = vi.fn(async () => reply);

      await makeAndroidImpl(registryWithDevtools(getHierarchy)).handler(
        {},
        { udid: ANDROID.id, clear: true },
        ANDROID
      );

      expect(getHierarchy).toHaveBeenCalledTimes(1);
      // The DUMP's four characters, not the blind count — and not the two the
      // truncated reply happened to carry.
      expect(deleteRun(inputCmds()[1]!)).toHaveLength(4 + 8);
    });

    it("falls back to the dump when the helper cannot answer", async () => {
      seedLegacyLevel();
      seedDump(dumpWith("abcd"));
      const getHierarchy = vi.fn(async () => {
        throw new Error("helper died mid-request");
      });

      await makeAndroidImpl(registryWithDevtools(getHierarchy)).handler(
        {},
        { udid: ANDROID.id, clear: true },
        ANDROID
      );

      expect(getHierarchy).toHaveBeenCalledTimes(1);
      expect(deleteRun(inputCmds()[1]!)).toHaveLength(4 + 8);
    });

    it("still gets BOTH dumps after a live helper has spent its whole share", async () => {
      // The combination neither neighbour covers, and the one H3 reproduces: a
      // helper that is ALIVE but never answers, so it burns
      // PREFERRED_READ_BUDGET_MS, AND dumps that come back `Killed` because
      // something else holds the UiAutomation connection. The read legs then
      // have to fund a dump, the backoff and a second dump out of what the
      // preferred read left — which is what the budget's own comments claim,
      // and what a flat 20s budget could not actually do, which is why the
      // budget derives from the two constants instead: the retry guard
      // declined, leaving one attempt and the blind count.
      //
      // Real timers, because both the 5s race budget and the 2.5s backoff are
      // real waits — which is also what makes this pin the CONSTANTS rather
      // than an arithmetic restatement of them.
      seedLegacyLevel();
      seedDump("Killed");
      seedDump(dumpWith("abcdefghij")); // the retry wins once the holder lets go
      const getHierarchy = vi.fn(() => new Promise<{ xml: string }>(() => {}));

      await makeAndroidImpl(registryWithDevtools(getHierarchy)).handler(
        {},
        { udid: ANDROID.id, clear: true },
        ANDROID
      );

      expect(getHierarchy).toHaveBeenCalledTimes(1);
      expect(adbExecOutBinary).toHaveBeenCalledTimes(2);
      // The retry's ten characters — not BLIND_DELETE_COUNT.
      expect(deleteRun(inputCmds()[1]!)).toHaveLength(10 + 8);
    }, 30_000);
  });

  it("falls back to the blind count when the dump cannot be parsed", async () => {
    // A reply that carries `<hierarchy` but no parseable tree — a truncated
    // dump, a device that wrote half a file. Returning a measured 0 there would
    // be the worst of both: `??` does not fire on 0, so the run would be
    // DELETE_MARGIN backspaces against a field of unknown length and the tool
    // would report `cleared: true` over most of the value. Unmeasurable has to
    // mean the blind count.
    //
    // And that count is MAX_DELETE_COUNT, in every assertion of this shape:
    // every length below it is one this path accepts whenever it CAN measure
    // it, so a blind run that stops short truncates a field the tool otherwise
    // supports — silently, since the call still returns `cleared: true`. At the
    // 120 this PR shipped with, a 140-character field kept its first 12
    // characters with the new text appended (reproduced 2/3 on a live API 30
    // emulator against three competing `uiautomator dump` loops).
    seedLegacyLevel();
    seedDump('<hierarchy rotation="0"');

    await makeAndroidImpl(registryWith({})).handler({}, { udid: ANDROID.id, clear: true }, ANDROID);

    expect(deleteRun(inputCmds()[1]!)).toHaveLength(MAX_DELETE_COUNT + 8);
  });

  it("measures only a FOCUSED editable, ignoring other fields on screen", async () => {
    // Every other fixture marks every node focused, so without this the focus
    // test itself is unpinned: a screen with a longer unfocused EditText would
    // be measured at that field's length — over-deleting, or tripping the
    // length refusal on a clear that works today.
    seedLegacyLevel();
    seedDump(
      `<?xml version='1.0' encoding='UTF-8'?><hierarchy rotation="0">` +
        `<node index="0" text="${"u".repeat(120)}" class="android.widget.EditText" password="false" focused="false" />` +
        `<node index="1" text="${"f".repeat(12)}" class="android.widget.EditText" password="false" focused="true" />` +
        `</hierarchy>`
    );

    await makeAndroidImpl(registryWith({})).handler({}, { udid: ANDROID.id, clear: true }, ANDROID);

    expect(deleteRun(inputCmds()[1]!)).toHaveLength(12 + 8);
  });

  it("scales the delete run to a long field rather than truncating it", async () => {
    seedLegacyLevel();
    seedDump(dumpWith("x".repeat(140)));

    await makeAndroidImpl(registryWith({})).handler({}, { udid: ANDROID.id, clear: true }, ANDROID);

    expect(deleteRun(inputCmds()[1]!)).toHaveLength(140 + 8);
  });

  it("refuses a field too long to delete instead of half-deleting it", async () => {
    // Every DEL is delivered to the app, so a very long field's run overruns the
    // budget mid-way and leaves a partly-deleted value — the corruption this
    // path exists to prevent. Refuse before touching the field instead.
    seedLegacyLevel();
    seedDump(dumpWith("x".repeat(1200)));

    await expect(
      makeAndroidImpl(registryWith({})).handler({}, { udid: ANDROID.id, clear: true }, ANDROID)
    ).rejects.toThrow(/1200 characters.*Nothing was modified and nothing was typed/s);
    // Probe only — no delete run was issued.
    expect(inputCmds()).toEqual([SELECT_ALL_CMD]);
    // And the refusal is decided from a READ, so this 400 is reached only after
    // two round trips have already gone to the device — the one rejection the
    // tool description cannot claim never reaches it. Neither changes the field:
    // the probe is the `keycombination` this level has no subcommand for, and
    // the dump is a screen capture.
    expect(adbExecOutBinary).toHaveBeenCalledTimes(1);
    expect(adbExecOutBinary.mock.calls[0]![1]).toMatch(/^uiautomator dump /);
  });

  it("does not attribute the refused count to the field the caller meant", async () => {
    // The count is a maximum over every focused EditText in the dump, and the
    // dump reports an EMPTY field's placeholder in the same `text` attribute as
    // a real value — on the levels this fallback serves there is no separate
    // `hint` attribute to tell them apart. So the number can come from another
    // window's field, or be a placeholder on an empty one. The refusal stands
    // (deleting on a guess is what truncates), but it must not assert that the
    // target holds it.
    seedLegacyLevel();
    seedDump(dumpWith("x".repeat(200)));

    await expect(
      makeAndroidImpl(registryWith({})).handler({}, { udid: ANDROID.id, clear: true }, ANDROID)
    ).rejects.toThrow(/a focused text field on this screen reports 200 characters/);
  });

  it("says nothing about that length when the text came from a secret", async () => {
    // The count is the FIELD's length, and a `{{secret:…}}` request is usually
    // aimed at the box that already holds a credential — a long API key or
    // token in a plain `type="text"` box, which carries no `password` flag for
    // the dump to hide behind. `redactSecretsFromError` substitutes the
    // resolved value and cannot redact a number, so the count has to be
    // withheld here, exactly as the chromium backend withholds its two.
    seedLegacyLevel();
    seedDump(dumpWith("x".repeat(200)));

    const err = await makeAndroidImpl(registryWith({}))
      .handler({}, { udid: ANDROID.id, clear: true, text: "tok", secretText: true }, ANDROID)
      .then(
        () => {
          throw new Error("expected the call to reject, but it resolved");
        },
        (e: unknown) => e as Error
      );

    expect(err.message).toMatch(/reports more characters than this Android level can clear/);
    expect(err.message).not.toMatch(/\b200\b/);
    // The LIMIT is a constant, not credential material, and it is what tells
    // the caller how far over the field is.
    expect(err.message).toMatch(/past 150/);
  });

  it("uses the blind count for a password field, whose text is unreadable", async () => {
    // uiautomator reports empty text for password nodes, so a measured 0 would
    // clear nothing at all — the one case where a fixed run is the right answer.
    seedLegacyLevel();
    seedDump(dumpWith("", true));

    await makeAndroidImpl(registryWith({})).handler({}, { udid: ANDROID.id, clear: true }, ANDROID);

    expect(deleteRun(inputCmds()[1]!)).toHaveLength(MAX_DELETE_COUNT + 8);
  });

  it("uses the blind count when the dump itself fails", async () => {
    seedLegacyLevel();
    adbExecOutBinary.mockImplementationOnce(async () => {
      throw new Error("uiautomator dump failed");
    });

    await makeAndroidImpl(registryWith({})).handler({}, { udid: ANDROID.id, clear: true }, ANDROID);

    expect(deleteRun(inputCmds()[1]!)).toHaveLength(MAX_DELETE_COUNT + 8);
  });

  it("uses the blind count when the device refused the dump", async () => {
    // adb exits 0 and uiautomator reports the refusal in-band, so this arrives
    // as a successful call carrying no hierarchy.
    seedLegacyLevel();
    seedDump("ERROR: could not get idle state.");

    await makeAndroidImpl(registryWith({})).handler({}, { udid: ANDROID.id, clear: true }, ANDROID);

    expect(deleteRun(inputCmds()[1]!)).toHaveLength(MAX_DELETE_COUNT + 8);
  });

  it("measures the focused EDITABLE node, not a focused container above it", async () => {
    // A dump carries every window, so more than one node can be `focused` — an
    // IME or overlay contributes its own, and a focused non-text container
    // reports its own `text`.
    //
    // Node order and lengths are chosen so that BOTH rules are load-bearing:
    // the WebView's text is the longest, so dropping the `EditText` filter
    // measures 90 rather than 42; and the short EditText is last in document
    // order, so it is the first one the walk reaches — taking "the first
    // focused match" instead of the longest measures 10. Only filtering to
    // editable nodes AND taking the longest yields 42.
    seedLegacyLevel();
    seedDump(
      `<?xml version='1.0' encoding='UTF-8'?><hierarchy rotation="0">` +
        `<node index="0" text="${"y".repeat(42)}" class="android.widget.EditText" password="false" focused="true" />` +
        `<node index="1" text="${"w".repeat(90)}" class="android.webkit.WebView" password="false" focused="true" />` +
        `<node index="2" text="${"z".repeat(10)}" class="android.widget.EditText" password="false" focused="true" />` +
        `</hierarchy>`
    );

    await makeAndroidImpl(registryWith({})).handler({}, { udid: ANDROID.id, clear: true }, ANDROID);

    expect(deleteRun(inputCmds()[1]!)).toHaveLength(42 + 8);
  });

  it("takes the LONGEST focused editable even when a shorter one comes first", async () => {
    // `Math.max`, not last-write-wins. The walk is a DFS over `stack.pop()`, so
    // siblings are visited in reverse document order — every other fixture here
    // happens to put the longest field first, which makes plain assignment look
    // correct. With the short one first, assignment measures 2 and leaves an
    // 80-character residue reported as `cleared: true`, which is exactly the
    // truncation this measurement exists to prevent. The realistic shape is an
    // IME or overlay window contributing its own focused node.
    seedLegacyLevel();
    seedDump(
      `<?xml version='1.0' encoding='UTF-8'?><hierarchy rotation="0">` +
        `<node index="0" text="ab" class="android.widget.EditText" focused="true" bounds="[0,0][100,50]" />` +
        `<node index="1" text="${"x".repeat(90)}" class="android.widget.EditText" focused="true" bounds="[0,60][100,110]" />` +
        `</hierarchy>`
    );

    await makeAndroidImpl(registryWith({})).handler({}, { udid: ANDROID.id, clear: true }, ANDROID);

    expect(deleteRun(inputCmds()[1]!)).toHaveLength(90 + 8);
  });

  it("does not let a short focused sibling downgrade an unmeasurable field", async () => {
    // A focused password field beside a shorter focused EditText. Skipping the
    // unmeasurable one entirely measures 2 and issues ten backspaces, where the
    // password field alone correctly gets the blind count — so a 100-character
    // password would keep 90 characters and still report `cleared: true`. An
    // unmeasurable node has to FLOOR the count, not vanish from it.
    seedLegacyLevel();
    seedDump(
      `<?xml version='1.0' encoding='UTF-8'?><hierarchy rotation="0">` +
        `<node index="0" text="" class="android.widget.EditText" password="true" focused="true" />` +
        `<node index="1" text="ab" class="android.widget.EditText" password="false" focused="true" />` +
        `</hierarchy>`
    );

    await makeAndroidImpl(registryWith({})).handler({}, { udid: ANDROID.id, clear: true }, ANDROID);

    expect(deleteRun(inputCmds()[1]!)).toHaveLength(MAX_DELETE_COUNT + 8);
  });

  it("still prefers a longer measurable field over an unmeasurable one", async () => {
    // The other direction, and the reason the unmeasurable branch cannot simply
    // return: a measurable field longer than the blind count must still drive
    // the run — here past the limit, so the call refuses rather than truncating.
    seedLegacyLevel();
    seedDump(
      `<?xml version='1.0' encoding='UTF-8'?><hierarchy rotation="0">` +
        `<node index="0" text="${"x".repeat(300)}" class="android.widget.EditText" password="false" focused="true" />` +
        `<node index="1" text="" class="android.widget.EditText" password="true" focused="true" />` +
        `</hierarchy>`
    );

    await expect(
      makeAndroidImpl(registryWith({})).handler({}, { udid: ANDROID.id, clear: true }, ANDROID)
    ).rejects.toThrow(/300 characters/);
  });

  it("treats a focused editable with no `text` attribute as unmeasurable", async () => {
    // Absent is not empty. Reading a missing attribute as 0 would issue only
    // the margin against a field that may be full — the silent half-clear the
    // measurement exists to prevent.
    seedLegacyLevel();
    seedDump(
      `<?xml version='1.0' encoding='UTF-8'?><hierarchy rotation="0">` +
        `<node index="0" class="android.widget.EditText" password="false" focused="true" />` +
        `</hierarchy>`
    );

    await makeAndroidImpl(registryWith({})).handler({}, { udid: ANDROID.id, clear: true }, ANDROID);

    expect(deleteRun(inputCmds()[1]!)).toHaveLength(MAX_DELETE_COUNT + 8);
  });

  it("clears a field exactly at the length limit, and refuses one past it", async () => {
    // Pins the boundary itself: without this the limit is only constrained to
    // sit somewhere below the over-length test's value, so it could be lowered
    // to reject fields that work today.
    seedLegacyLevel();
    seedDump(dumpWith("x".repeat(150)));
    await makeAndroidImpl(registryWith({})).handler({}, { udid: ANDROID.id, clear: true }, ANDROID);
    expect(deleteRun(inputCmds()[1]!)).toHaveLength(150 + 8);

    adbShell.mockClear();
    adbExecOutBinary.mockClear();
    seedLegacyLevel();
    seedDump(dumpWith("x".repeat(151)));
    await expect(
      makeAndroidImpl(registryWith({})).handler({}, { udid: ANDROID.id, clear: true }, ANDROID)
    ).rejects.toThrow(/151 characters/);
    expect(inputCmds()).toEqual([SELECT_ALL_CMD]);
  });

  it("measures a field whose text contains a double quote", async () => {
    // uiautomator switches the attribute delimiter to single quotes when the
    // value contains a `"`. A double-quote-only attribute matcher skips the
    // attribute entirely, reads the field as unmeasurable, and degrades to the
    // blind count — which truncates anything longer than it.
    seedLegacyLevel();
    seedDump(
      `<?xml version='1.0' encoding='UTF-8'?><hierarchy rotation="0">` +
        `<node index="0" text='say "hi"' class="android.widget.EditText" password="false" focused="true" />` +
        `</hierarchy>`
    );

    await makeAndroidImpl(registryWith({})).handler({}, { udid: ANDROID.id, clear: true }, ANDROID);

    expect(deleteRun(inputCmds()[1]!)).toHaveLength(8 + 8); // `say "hi"`
  });

  it("decodes XML entities so the measured length is in real characters", async () => {
    // `&amp;` is five characters in the dump and one on screen; measuring the
    // raw attribute would over-count, which is harmless, but under-counting a
    // decoded entity would not be — pin the decode either way. `&#8230;` covers
    // the numeric references a chained per-entity decoder misses.
    seedLegacyLevel();
    seedDump(dumpWith("a&amp;b&lt;c&#8230;"));

    await makeAndroidImpl(registryWith({})).handler({}, { udid: ANDROID.id, clear: true }, ANDROID);

    expect(deleteRun(inputCmds()[1]!)).toHaveLength(6 + 8); // "a&b<c…"
  });

  it("clear+type on a legacy level types only after the delete run", async () => {
    seedLegacyLevel();
    seedDump(dumpWith("old"));

    await makeAndroidImpl(registryWith({})).handler(
      {},
      { udid: ANDROID.id, clear: true, text: "new" },
      ANDROID
    );

    const cmds = inputCmds();
    expect(cmds[0]).toBe(SELECT_ALL_CMD);
    expect(cmds[1]!.startsWith("input keyevent 123 67")).toBe(true);
    expect(cmds[2]).toBe("input text 'new'");
  });

  it("takes the fallback on a level that words the complaint as `Unknown command`", async () => {
    // The other wording `input` uses for a subcommand it does not have. Only the
    // `Usage:` form is exercised elsewhere, so without this the alternative could
    // be dropped from the matcher and `clear` would silently degrade to a
    // one-character backspace on any level that phrases it this way.
    adbShell.mockImplementationOnce(async () => "Unknown command: keycombination");
    seedDump(dumpWith("abc"));

    await makeAndroidImpl(registryWith({})).handler({}, { udid: ANDROID.id, clear: true }, ANDROID);

    const cmds = inputCmds();
    expect(deleteRun(cmds[1]!)).toHaveLength(3 + 8);
    expect(cmds).not.toContain(DEL_CMD);
  });

  it("does NOT reject when `keycombination` is supported (exit 0, no marker)", async () => {
    // Inverse of the detection: a supported device returns no marker, so the
    // select-all stands and the post-select DEL follows. An over-eager matcher
    // would break `clear` on every modern device.
    await makeAndroidImpl(registryWith({})).handler({}, { udid: ANDROID.id, clear: true }, ANDROID);

    expect(adbShell.mock.calls.map((c) => c[1])).toEqual([SELECT_ALL_CMD, DEL_CMD]);
  });

  it("surfaces a transport failure on `keycombination` as-is", async () => {
    adbShell.mockImplementationOnce(async () => {
      throw new Error("device offline");
    });

    await expect(
      makeAndroidImpl(registryWith({})).handler({}, { udid: ANDROID.id, clear: true }, ANDROID)
    ).rejects.toThrow(/device offline/);
    // Exactly one adb call — and not misreported as an API-level problem.
    expect(adbShell).toHaveBeenCalledTimes(1);
  });

  it("rejects an unknown key before clearing anything", async () => {
    await expect(
      makeAndroidImpl(registryWith({})).handler(
        {},
        { udid: ANDROID.id, clear: true, key: "bogus" },
        ANDROID
      )
    ).rejects.toThrow(/Unknown key "bogus"/);
    expect(adbShell).not.toHaveBeenCalled();
  });

  it("rejects un-typeable text before clearing anything", async () => {
    await expect(
      makeAndroidImpl(registryWith({})).handler(
        {},
        { udid: ANDROID.id, clear: true, text: "café" },
        ANDROID
      )
    ).rejects.toThrow();
    // A clear that lands and *then* 400s would leave the field emptied with
    // nothing typed — worse than the original value.
    expect(adbShell).not.toHaveBeenCalled();
  });
});

describe("keyboard clear — tool schema", () => {
  // Every real call is dispatched with the PARSED params (`http.ts` and the
  // registry both replace the raw body with `parseResult.data`), and a zod
  // object strips keys it does not declare. So a `clear` missing from the schema
  // is silently dropped on every device while the backends — which the rest of
  // this file calls directly — keep working. Nothing else in the suite crosses
  // the schema, and TypeScript cannot catch it either: `clear` is optional on
  // `KeyboardParams`, so a schema without it still type-checks.
  const tool = createKeyboardTool({ resolveService: vi.fn() } as never);

  it("carries `clear` through the parse the dispatcher actually uses", () => {
    const parsed = tool.zodSchema!.safeParse({ udid: ANDROID.id, text: "abc", clear: true });

    expect(parsed.success).toBe(true);
    expect(parsed.data).toEqual({ udid: ANDROID.id, text: "abc", clear: true });
  });

  it("accepts `clear` on its own, with no text or key", () => {
    const parsed = tool.zodSchema!.safeParse({ udid: ANDROID.id, clear: true });

    expect(parsed.success).toBe(true);
    expect(parsed.data).toEqual({ udid: ANDROID.id, clear: true });
  });

  it("rejects a non-boolean `clear` rather than coercing it", () => {
    expect(tool.zodSchema!.safeParse({ udid: ANDROID.id, clear: "yes" }).success).toBe(false);
  });

  it("declares itself long-running, since one call budgets a clear and an injection", () => {
    // The clear is capped at 26s on Android and the one injection that can
    // follow it — `text` or `key`, never both — keeps its own 15s cap, so a
    // `{ clear, text }` worst case of ~41s still sums past the MCP adapter's 30s
    // per-request fetch timeout, which abandons the request while adb is still
    // typing on the device.
    expect(tool.longRunning).toBe(true);
  });

  it("bounds `delayMs`, which one device's typing queue now waits on", () => {
    // iOS typing is serialized per device (the clear holds a modifier down
    // across awaits, so a concurrent keystroke would land inside the chord), so
    // an unbounded cadence no longer costs only its own call: it holds that
    // device's keyboard, and everything queued behind it, for the duration.
    expect(tool.zodSchema!.safeParse({ udid: IOS_SIM.id, delayMs: 600_000 }).success).toBe(false);
    expect(tool.zodSchema!.safeParse({ udid: IOS_SIM.id, delayMs: 5000 }).success).toBe(true);
  });

  it("pins the ceiling AT the boundary, not merely far above it", () => {
    // 5000-accepted plus 600 000-rejected leaves the number itself free: raising
    // `.max(5000)` to `.max(10000)` in a scratch copy kept the whole keyboard
    // suite green. `5001` is the only probe that holds the value a future change
    // could otherwise relax silently — and the reason it must not be relaxed is
    // above the `.max()` itself.
    expect(tool.zodSchema!.safeParse({ udid: IOS_SIM.id, delayMs: 5001 }).success).toBe(false);
  });

  it('rejects `{ clear: true, key: "" }` before the clear can empty the field', () => {
    // The empty key is a name no backend has, and every backend dispatches `key`
    // by truthiness — so before it was rejected in `execute` (#579) this ran the
    // clear, emptied the field and reported `cleared: true, keys: 0`: a
    // destructive call reported as a success, without the key it announced.
    // Driven through the tool rather than a backend, because that is where the
    // guard sits and `clear` is the reason it matters here.
    return expect(
      tool.execute({}, { udid: ANDROID.id, clear: true, key: "" } as never)
    ).rejects.toThrow(/names no key/);
  });
});

describe("keyboard clear — Chromium (CDP)", () => {
  // The clear resolves the focused editable and parks it on `window`, then
  // re-reads THAT parked element; the run ends by releasing the slot, so even a
  // bare `{ clear: true }` issues three probes (the test directly below pins the
  // count and the ordering).
  //
  // This stub answers the FIRST probe with `before` and every later one with
  // `after`, so a test can make the field's before/after states disagree.
  // Defaults describe a clear that worked.
  //
  // Probes 2 and 3 therefore share one answer, which is why a case about focus
  // moving DURING the typing needs `splitApi` below instead: given `focused:
  // false` here, the read-back is served it too and the run throws the
  // pre-typing guard with nothing dispatched.
  function recordingApi(
    before: Record<string, unknown> = {
      verdict: "editable",
      label: "INPUT#email",
      length: 8,
      mac: true,
    },
    after: Record<string, unknown> = { tracked: true, length: 0, focused: true }
  ) {
    const events: KeyEventArgs[] = [];
    const probes: string[] = [];
    return {
      events,
      probes,
      api: {
        dispatchKeyEvent: async (e: KeyEventArgs) => void events.push(e),
        // Routed by CALL ORDER, not by matching text in the expression: keying
        // off a substring of the production source would let a reworded probe
        // keep every test green while answering the wrong one.
        evaluate: async (expression: string) => {
          probes.push(expression);
          return JSON.stringify(probes.length === 1 ? before : after);
        },
      },
    };
  }

  it("issues a resolve probe, then a read-back that KEEPS the element, then a release", () => {
    // Guards the routing the rest of this block depends on. If the resolve and
    // read-back probes were the same expression, every "after" case here would
    // silently be testing the "before" one.
    //
    // Three, not two: the read-back leaves the element parked so focus can be
    // asked about again once the typing is done — a blur can land mid-loop,
    // which no single sample before the loop can see — and the last probe is
    // what lets the element go.
    const { probes, api } = recordingApi();
    return makeChromiumImpl(registryWith(api))
      .handler({}, { udid: CHROMIUM.id, clear: true, delayMs: 0 }, CHROMIUM)
      .then(() => {
        expect(probes).toHaveLength(3);
        expect(probes[0]).not.toBe(probes[1]);
        // The read-back keeps the slot; only the release deletes it.
        expect(probes[1]).not.toContain("delete window[");
        expect(probes[2]).toContain("delete window[");
      });
  });

  it("releases the parked element exactly once on a call that also types", async () => {
    // Probe counts were asserted only on `{ clear: true }` calls with no typing,
    // where the release IS the third probe. On a `{ clear, text }` call the
    // release happens inside the post-typing check instead, and the `finally`
    // must then skip it — without the `!released` guard every combined call
    // pays a fourth round trip to re-read an element that is already gone, and
    // nothing noticed.
    const { probes, api } = recordingApi();

    await makeChromiumImpl(registryWith(api)).handler(
      {},
      { udid: CHROMIUM.id, clear: true, text: "ab", delayMs: 0 },
      CHROMIUM
    );

    expect(probes).toHaveLength(3);
    // Resolve, read-back (keeps the element), release.
    expect(probes.filter((p) => p.includes("delete window["))).toHaveLength(1);
  });

  it("parks each clear under its own handle, so two calls cannot collide", async () => {
    // Nothing serializes tool calls against a device, so two clears sharing one
    // slot interleave: B's probe overwrites A's element, or B's release deletes
    // the slot before A re-reads it and A takes the best-effort branch — a
    // silent success on a field that was never emptied. A fixed name is also one
    // the page can squat on with a non-writable decoy.
    const handleOf = (probe: string) => probe.match(/__argentKeyboardClearTarget_\w+/)?.[0];

    const first = recordingApi();
    await makeChromiumImpl(registryWith(first.api)).handler(
      {},
      { udid: CHROMIUM.id, clear: true, delayMs: 0 },
      CHROMIUM
    );
    const second = recordingApi();
    await makeChromiumImpl(registryWith(second.api)).handler(
      {},
      { udid: CHROMIUM.id, clear: true, delayMs: 0 },
      CHROMIUM
    );

    expect(handleOf(first.probes[0]!)).toBeDefined();
    // Both probes of one call share a handle; the two calls must not.
    expect(handleOf(first.probes[1]!)).toBe(handleOf(first.probes[0]!));
    expect(handleOf(second.probes[0]!)).not.toBe(handleOf(first.probes[0]!));
  });

  it("omits `cleared` entirely when clear was not requested", async () => {
    const result = await makeChromiumImpl(registryWith(recordingApi().api)).handler(
      {},
      { udid: CHROMIUM.id, text: "hi", delayMs: 0 },
      CHROMIUM
    );

    expect(result).not.toHaveProperty("cleared");
  });

  it("refuses to type when the clear moved focus off the field", async () => {
    // Emptying a field routinely moves focus — one that blurs when empty, or an
    // app that advances to the next input. The characters are dispatched at the
    // PAGE, so they then land nowhere at all or append to a DIFFERENT field,
    // and both returned the same success a real replacement returns.
    const { events, api } = recordingApi(undefined, { tracked: true, length: 0, focused: false });

    await expect(
      makeChromiumImpl(registryWith(api)).handler(
        {},
        { udid: CHROMIUM.id, clear: true, text: "new@example.com", delayMs: 0 },
        CHROMIUM
      )
    ).rejects.toThrow(/no longer holds focus/);

    // The clear's own rawKeyDown + keyUp, and not one character beyond them.
    expect(events).toHaveLength(2);
  });

  it("fails when the page moved focus away part-way through the typing", async () => {
    // One sample before the loop cannot cover a blur that lands DURING it: the
    // characters go out `delay` apart, so a page that moves focus part-way
    // through splits the value across two fields. On Chrome 150 a field that
    // blurred 300ms after emptying kept `us` and its neighbour got the rest,
    // reported as a clean replacement.
    const events: KeyEventArgs[] = [];
    const probes: string[] = [];
    const api = {
      dispatchKeyEvent: async (e: KeyEventArgs) => void events.push(e),
      evaluate: async (expression: string) => {
        probes.push(expression);
        // 1: resolve. 2: read-back — empty, focus still held. 3: the release
        // after typing — focus has since moved.
        if (probes.length === 1) {
          return JSON.stringify({
            verdict: "editable",
            label: "INPUT#email",
            length: 8,
            mac: true,
            parked: true,
          });
        }
        return JSON.stringify({ tracked: true, length: 0, focused: probes.length === 2 });
      },
    };

    await expect(
      makeChromiumImpl(registryWith(api)).handler(
        {},
        { udid: CHROMIUM.id, clear: true, text: "abc", delayMs: 0 },
        CHROMIUM
      )
    ).rejects.toThrow(/only 0 of the 3 character\(s\)/);
    // The clear went out, and so did every character — the failure reports what
    // already happened rather than pretending the call did nothing.
    expect(events.filter((e) => e.type === "char")).toHaveLength(3);
  });

  /**
   * A stub whose read-back (probe 2) and post-typing release (probe 3) can
   * disagree — the shape every "focus moved DURING the typing" case needs, and
   * the one `recordingApi` cannot express because it answers both from `after`.
   */
  function splitApi(afterTyping: Record<string, unknown>) {
    const events: KeyEventArgs[] = [];
    const probes: string[] = [];
    return {
      events,
      probes,
      api: {
        dispatchKeyEvent: async (e: KeyEventArgs) => void events.push(e),
        evaluate: async (expression: string) => {
          probes.push(expression);
          if (probes.length === 1) {
            return JSON.stringify({
              verdict: "editable",
              label: "INPUT#email",
              length: 8,
              mac: true,
              parked: true,
            });
          }
          // Probe 2 is the read-back inside the clear: empty, focus still held.
          if (probes.length === 2)
            return JSON.stringify({ tracked: true, length: 0, focused: true });
          return JSON.stringify(afterTyping);
        },
      },
    };
  }

  it("does not call it a split when the whole value is in the field", async () => {
    // Focus loss alone is not evidence of a split. A field that advances focus
    // once its value is complete — the OTP / card-number pattern — ends up
    // holding EXACTLY what was asked for, and Chrome 150 reported that as a
    // 500 "the value is split across fields" 5/5 until the length was checked
    // too.
    const { api, events } = splitApi({ tracked: true, length: 3, focused: false });

    const result = await makeChromiumImpl(registryWith(api)).handler(
      {},
      { udid: CHROMIUM.id, clear: true, text: "abc", delayMs: 0 },
      CHROMIUM
    );

    expect(result).toMatchObject({ typed: "abc", keys: 3, cleared: true });
    expect(events.filter((e) => e.type === "char")).toHaveLength(3);
  });

  it("does not call a named key's own focus move a split", async () => {
    // `{ clear, key: "tab" }` could otherwise never succeed: Tab moves focus BY
    // DEFINITION and dispatches no character, so there is no value to split.
    // `{ clear, key: "enter" }` on a search box that blurs on submit is the same
    // shape — both were a deterministic 500 on Chrome 150.
    for (const key of ["tab", "enter"]) {
      const { api } = splitApi({ tracked: true, length: 0, focused: false });

      const result = await makeChromiumImpl(registryWith(api)).handler(
        {},
        { udid: CHROMIUM.id, clear: true, key, delayMs: 0 },
        CHROMIUM
      );

      expect(result).toMatchObject({ typed: key, keys: 1, cleared: true });
    }
  });

  it("does not call a SEGMENTED input's own layout a split", async () => {
    // The OTP shape the exclusion above was measured against is the
    // single-field one, where the whole value fits and the count check saves it.
    // A segmented one — six `<input maxlength="1">` boxes with the standard
    // auto-advance handler — holds 1 of 6 by design, so the count check
    // CONFIRMED the split: measured on Chrome 151, 3/3, the six boxes held the
    // requested code exactly while the tool told the caller it was mis-entered
    // and invited a retype into boxes that were already right.
    const { api, events } = splitApi({
      tracked: true,
      length: 1,
      focused: false,
      full: true,
    });

    const result = await makeChromiumImpl(registryWith(api)).handler(
      {},
      { udid: CHROMIUM.id, clear: true, text: "123456", delayMs: 0 },
      CHROMIUM
    );

    expect(result).toMatchObject({ typed: "123456", keys: 6, cleared: true });
    expect(events.filter((e) => e.type === "char")).toHaveLength(6);
  });

  it("still calls it a split when the short field could have held more", async () => {
    // The other side of the same exclusion: `full` is what makes the shortfall
    // its own explanation, so a field with room left keeps the failure.
    const { api } = splitApi({ tracked: true, length: 1, focused: false, full: false });

    await expect(
      makeChromiumImpl(registryWith(api)).handler(
        {},
        { udid: CHROMIUM.id, clear: true, text: "123456", delayMs: 0 },
        CHROMIUM
      )
    ).rejects.toThrow(/only 1 of the 6 character\(s\)/);
  });

  it.each(["\n", "\r", "\t"])(
    "does not call the same focus move a split when it arrives inside `text` (%j)",
    async (char) => {
      // The named key's twin, by the other spelling. `charToChromiumKey` maps
      // `\n`/`\r` to Enter and `\t` to Tab, so they are dispatched inside the
      // typing loop as those physical keys — delivering no character and moving
      // focus by definition, which is exactly why the named key is excluded.
      // Measured on Chrome 151 against a search box that submits, empties and
      // blurs: `{ clear, text: "query\n" }` was a 500 naming a split 3/3, while
      // the same Enter sent as a named key — `{ clear, text: "query" }` then
      // `{ key: "enter" }`, the two-step form the tool now requires — passed on
      // the identical page, with the page's own state the same in both.
      const { api, events } = splitApi({ tracked: true, length: 0, focused: false });

      const result = await makeChromiumImpl(registryWith(api)).handler(
        {},
        { udid: CHROMIUM.id, clear: true, text: `query${char}`, delayMs: 0 },
        CHROMIUM
      );

      expect(result).toMatchObject({ typed: `query${char}`, keys: 6, cleared: true });
      // Every character still went out — the exclusion is about the verdict, not
      // about skipping the dispatch.
      expect(events.filter((e) => e.type === "char")).toHaveLength(6);
    }
  );

  it("still holds the field to the characters BEFORE an Enter inside `text`", async () => {
    // The exclusion above tested the whole string and skipped every character,
    // so one newline switched the guarantee off for a value of any length — and
    // a `\n` in a `<textarea>` is ordinary content that moves nothing. Measured
    // on Chrome 151 against an exact control pair differing only by that one
    // character, in a textarea whose 4th `input` moves focus to a neighbour:
    // `{ clear, text: "aaaabbbb" }` correctly reported the split while
    // `{ clear, text: "aaaa\nbbbb" }` returned `cleared: true`, and both left
    // the same `["aaa", "abbbb"]` behind.
    //
    // 3 delivered of the 4 before the Enter, so the prefix is short and the
    // field holds less than it: the same two signals the check always needs,
    // counted against what was actually promised.
    const { api } = splitApi({ tracked: true, length: 3, focused: true, delivered: 3 });

    await expect(
      makeChromiumImpl(registryWith(api)).handler(
        {},
        { udid: CHROMIUM.id, clear: true, text: "aaaa\nbbbb", delayMs: 0 },
        CHROMIUM
      )
      // Counted against the prefix, and it says so — quoting the request's own
      // 9 would name characters this never had an opinion about.
    ).rejects.toThrow(/only 3 of the 4 character\(s\) before the first Enter\/Tab of the 9 sent/);
  });

  it("does not hold it to characters sent AFTER the Enter", async () => {
    // The other side of the prefix rule: everything before the Enter arrived,
    // so nothing is reported — whatever the page then did with the rest is the
    // focus move the request asked for. This is the Enter-to-send composer
    // (a `<textarea>` whose page swallows the Enter, empties the field and
    // blurs it), verified on Chrome 151 as a clean pass.
    const { api } = splitApi({ tracked: true, length: 0, focused: false, delivered: 4 });

    const result = await makeChromiumImpl(registryWith(api)).handler(
      {},
      { udid: CHROMIUM.id, clear: true, text: "aaaa\nbbbb", delayMs: 0 },
      CHROMIUM
    );

    expect(result).toMatchObject({ typed: "aaaa\nbbbb", cleared: true });
  });

  it("runs no split check for a clear+key call, so the key's own effect is not a split", async () => {
    // `{ clear, key: "enter" }` is the largest shape a single call can carry now
    // that the tool rejects `{ text, key }`, and it is the "empty the box and
    // submit" one. The standard Enter handler — a search box, a chat composer, a
    // tag input — sends the value and then empties and blurs the field, which is
    // indistinguishable from "the page moved focus mid-request" if the field is
    // sampled afterwards: reproduced 3/3 on Chrome 130 through the branch
    // tool-server, where a request that did exactly what it was asked came back
    // as a 500 naming a cause that never occurred.
    //
    // The split check is gated on `guaranteed > 0` — characters this call
    // promised to deliver — so a key-only request never reaches it. One key
    // event cannot be split across two fields, and for `enter`/`tab` the focus
    // move IS the requested effect. This pins the gate: the page below answers
    // every probe after the clear's own with the blurred, emptied state that
    // WOULD read as a split, and the call still succeeds.
    const trace: string[] = [];
    const api = {
      dispatchKeyEvent: async (e: KeyEventArgs) => {
        trace.push(`key:${e.type}:${e.key ?? ""}`);
      },
      evaluate: async () => {
        trace.push("probe");
        const nth = trace.filter((t) => t === "probe").length;
        if (nth === 1) {
          return JSON.stringify({
            verdict: "editable",
            label: "INPUT#q",
            length: 9,
            mac: true,
            parked: true,
          });
        }
        if (nth === 2) return JSON.stringify({ tracked: true, length: 0, focused: true });
        // Anything past the release is the sample this gate must NOT take: the
        // submit handler has emptied and blurred the field, which would read as
        // a split.
        return JSON.stringify({ tracked: true, length: 0, focused: false });
      },
    };

    const result = await makeChromiumImpl(registryWith(api)).handler(
      {},
      { udid: CHROMIUM.id, clear: true, key: "enter", delayMs: 0 },
      CHROMIUM
    );

    expect(result).toMatchObject({ typed: "enter", keys: 1, cleared: true });
    // The Enter really was dispatched — otherwise a backend that pressed nothing
    // would satisfy the assertion above.
    expect(trace).toContain("key:keyDown:Enter");
    // And the read that follows it is the `finally`'s release, not a verdict:
    // the last probe answers "blurred and empty", the shape a split reports, and
    // the call still came back clean.
    expect(trace.lastIndexOf("probe")).toBeGreaterThan(trace.indexOf("key:keyDown:Enter"));
  });

  // The chain-head check stops a request the client abandoned BEFORE its turn
  // comes round, but the abandonment window does not close there: a long
  // `{ clear, text }` that starts a moment before the hang-up would otherwise
  // type every remaining character out and hold this device's chain for all of
  // it. The CDP transport is only awaits and sleeps, so it is fully cancellable —
  // and the iOS backend, which faces the same window, already checks per
  // character.
  describe("giving up when the client does", () => {
    it("stops an in-flight run within about one keypress of the abort", async () => {
      const { events, api } = recordingApi();
      const controller = new AbortController();
      const run = makeChromiumImpl(registryWith(api)).handler(
        {},
        { udid: CHROMIUM.id, clear: true, text: "abcdefghij", delayMs: 20 },
        CHROMIUM,
        { signal: controller.signal }
      );
      // Let a couple of characters go out, then hang up.
      await new Promise((r) => setTimeout(r, 70));
      controller.abort();

      await expect(run).rejects.toThrow();
      const chars = events.filter((e) => e.type === "char").length;
      // Some characters really went out — this is a live run, not a no-op — but
      // not all ten.
      expect(chars).toBeGreaterThan(0);
      expect(chars).toBeLessThan(10);
    });

    it("never leaves a character's own events half-dispatched", async () => {
      // The signal is checked BETWEEN characters and the cadence wait yields to
      // it, never inside a character's keyDown/char/keyUp — cutting there would
      // leave the page holding a key nothing releases.
      const { events, api } = recordingApi();
      const controller = new AbortController();
      const run = makeChromiumImpl(registryWith(api)).handler(
        {},
        { udid: CHROMIUM.id, clear: true, text: "abcdefghij", delayMs: 20 },
        CHROMIUM,
        { signal: controller.signal }
      );
      await new Promise((r) => setTimeout(r, 70));
      controller.abort();
      await expect(run).rejects.toThrow();

      const held = new Set<string>();
      for (const event of events) {
        if (event.type === "keyDown") held.add(String(event.key));
        if (event.type === "keyUp") held.delete(String(event.key));
      }
      expect([...held]).toEqual([]);
    });

    it("still releases the parked element when it stops", async () => {
      // The `finally` is what guarantees it, and an abort is the path most likely
      // to skip it: the slot is the sole retainer of the parked node, and a
      // per-call name means a leaked one is never overwritten by the next clear.
      const { probes, api } = recordingApi();
      const controller = new AbortController();
      const run = makeChromiumImpl(registryWith(api)).handler(
        {},
        { udid: CHROMIUM.id, clear: true, text: "abcdefghij", delayMs: 20 },
        CHROMIUM,
        { signal: controller.signal }
      );
      await new Promise((r) => setTimeout(r, 70));
      controller.abort();
      await expect(run).rejects.toThrow();

      expect(probes.at(-1)).toContain("delete window[");
    });

    it("dispatches nothing at all when the abort lands before the clear", async () => {
      // The chain-head check covers a call still queued; this covers the same
      // request once its turn HAS come but the signal is already aborted, which
      // is where the clear's own select-all would otherwise go out and leave the
      // field's whole value selected for whatever types next.
      const { events, probes, api } = recordingApi();
      const controller = new AbortController();
      controller.abort();

      await expect(
        makeChromiumImpl(registryWith(api)).handler(
          {},
          { udid: CHROMIUM.id, clear: true, text: "abc", delayMs: 0 },
          CHROMIUM,
          { signal: controller.signal }
        )
      ).rejects.toThrow();
      expect(events).toEqual([]);
      expect(probes).toEqual([]);
    });

    it("leaves a run with no signal alone", async () => {
      // Positive control: `options` is optional on this handler, so a guard that
      // read an absent signal as aborted would break every ordinary call.
      const { events, api } = recordingApi();
      await expect(
        makeChromiumImpl(registryWith(api)).handler(
          {},
          { udid: CHROMIUM.id, clear: true, text: "abc", delayMs: 0 },
          CHROMIUM
        )
      ).resolves.toMatchObject({ typed: "abc", keys: 3, cleared: true });
      expect(events.filter((e) => e.type === "char")).toHaveLength(3);
    });
  });

  it("reports how much of the text landed when the value really was split", async () => {
    const { api } = splitApi({ tracked: true, length: 1, focused: false });

    await expect(
      makeChromiumImpl(registryWith(api)).handler(
        {},
        { udid: CHROMIUM.id, clear: true, text: "abc", delayMs: 0 },
        CHROMIUM
      )
      // The counts are what make the message actionable — "focus moved" alone
      // does not distinguish this from the successful case above.
    ).rejects.toThrow(/only 1 of the 3 character\(s\)/);
  });

  it("files the during-typing split under FOCUS_LOST, not INEFFECTIVE", async () => {
    // Mutation showed this code unpinned — swapping it for INEFFECTIVE changed
    // nothing — which matters because the two must stay distinguishable on the
    // wire: INEFFECTIVE means "re-clear required", this one means "the clear
    // worked, the characters went elsewhere", and `failure_stage` (the only other
    // thing separating them) is not serialized.
    const { api } = splitApi({ tracked: true, length: 1, focused: false });

    const err = await makeChromiumImpl(registryWith(api))
      .handler({}, { udid: CHROMIUM.id, clear: true, text: "abc", delayMs: 0 }, CHROMIUM)
      .then(
        () => {
          throw new Error("expected the call to reject, but it resolved");
        },
        (e: unknown) => e as Error
      );

    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.KEYBOARD_CLEAR_FOCUS_LOST);
  });

  it("reports a split that focus was BACK from by the time it was sampled", async () => {
    // The old rule's blind spot: `focused` is one sample, taken after the last
    // character, so a loss that does not persist to that instant is invisible.
    // Measured on Chrome 151, 3/3 — an autosuggest-shaped handler that focused a
    // neighbour on the 2nd character and returned on its 3rd left `aefgh` in the
    // target and `bcd` next door, and the call reported a clean replacement.
    // What sees it is provenance: 5 of the 8 characters were delivered here.
    const { api } = splitApi({ tracked: true, length: 5, focused: true, delivered: 5 });

    await expect(
      makeChromiumImpl(registryWith(api)).handler(
        {},
        { udid: CHROMIUM.id, clear: true, text: "abcdefgh", delayMs: 0 },
        CHROMIUM
      )
    ).rejects.toThrow(/only 5 of the 8 character\(s\) reached/);
  });

  it("reports a field that REVERTED to its pre-clear value", async () => {
    // The other half of M3, and the one where `cleared: true` was flatly false:
    // an editable data grid / click-to-edit title / controlled input that puts
    // its old value back on blur ends up holding MORE characters than were sent,
    // so "fewer than dispatched" could never fire. Measured 3/3 with six of the
    // eight characters in the neighbour.
    const { api } = splitApi({
      tracked: true,
      length: 18,
      focused: false,
      delivered: 3,
      reverted: true,
    });

    await expect(
      makeChromiumImpl(registryWith(api)).handler(
        {},
        { udid: CHROMIUM.id, clear: true, text: "abcdefgh", delayMs: 0 },
        CHROMIUM
      )
    ).rejects.toThrow(/holds the value it held BEFORE the clear/);
  });

  it("does not call a field that NORMALISES what it receives a split", async () => {
    // Every character was delivered here; the field merely strips or trims what
    // it keeps (`value.replace(/\D/g, "")`, a trim, an upper-case). The old rule
    // could not separate that from a split and reported it as one whenever focus
    // also moved — which the delivery count now settles.
    const { api, events } = splitApi({
      tracked: true,
      length: 6,
      focused: false,
      delivered: 8,
    });

    const result = await makeChromiumImpl(registryWith(api)).handler(
      {},
      { udid: CHROMIUM.id, clear: true, text: "+1 555-0", delayMs: 0 },
      CHROMIUM
    );

    expect(result).toMatchObject({ typed: "+1 555-0", keys: 8, cleared: true });
    expect(events.filter((e) => e.type === "char")).toHaveLength(8);
  });

  // `delivered` counts ARRIVALS, from a capture listener that sees each
  // `beforeinput` before the element's own handler can cancel it — which is what
  // makes it the right evidence for "did focus move", and leaves it unable to say
  // whether anything took EFFECT. A field that refuses every insertion IN PLACE
  // therefore reads as fully delivered while holding nothing, so both halves of
  // the split rule agree the wrong way and it comes back as a clean replacement.
  // Reproduced on Chrome 148 against `<input value="old-value-seeded">` whose
  // `beforeinput` handler `preventDefault()`s every `insert*`, focus retained:
  // `{ clear: true, text: "abc" }` returned `{ typed: "abc", keys: 3,
  // cleared: true }` over an EMPTY field.
  //
  // `applied` counts the `input` events, which Blink fires only for an insertion
  // it carried out, and the guard fires on the corner where the two disagree
  // completely.
  describe("a page that REFUSES the characters in place", () => {
    it("reports the field as empty rather than replaced", async () => {
      const { api, events } = splitApi({
        tracked: true,
        length: 0,
        focused: true,
        delivered: 3,
        applied: 0,
      });

      await expect(
        makeChromiumImpl(registryWith(api)).handler(
          {},
          { udid: CHROMIUM.id, clear: true, text: "abc", delayMs: 0 },
          CHROMIUM
        )
      ).rejects.toThrow(/refused every character/);
      // The characters really did go out — the failure reports what happened
      // rather than pretending the call did nothing.
      expect(events.filter((e) => e.type === "char")).toHaveLength(3);
    });

    it("carries its own code, not the focus-lost one", async () => {
      // Focus never moved, so nothing was split across fields: a client keying on
      // the signal has to tell "go and look in the neighbouring field" from "the
      // field you cleared is empty and this page will not take the value".
      const { api } = splitApi({
        tracked: true,
        length: 0,
        focused: true,
        delivered: 3,
        applied: 0,
      });

      const err = await makeChromiumImpl(registryWith(api))
        .handler({}, { udid: CHROMIUM.id, clear: true, text: "abc", delayMs: 0 }, CHROMIUM)
        .then(
          () => undefined,
          (e: unknown) => e
        );
      expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.KEYBOARD_TEXT_REFUSED);
    });

    it("leaves a page that refuses only SOME insertions alone", async () => {
      // Refusing a character class is how a page normalises — the false-failure
      // class this whole measurement is narrowed to keep out. Only the total
      // corner is unambiguous.
      const { api } = splitApi({
        tracked: true,
        length: 5,
        focused: true,
        delivered: 8,
        applied: 5,
      });

      await expect(
        makeChromiumImpl(registryWith(api)).handler(
          {},
          { udid: CHROMIUM.id, clear: true, text: "+1 555-0", delayMs: 0 },
          CHROMIUM
        )
      ).resolves.toMatchObject({ typed: "+1 555-0", keys: 8, cleared: true });
    });

    it("leaves a page that cancels the event and writes the value ITSELF alone", async () => {
      // The input-mask pattern: `preventDefault()` on `beforeinput`, then assign
      // `el.value`. No `input` fires for the insertion, so `applied` is 0 — and
      // the field is NOT empty, which is what separates it from a refusal.
      const { api } = splitApi({
        tracked: true,
        length: 12,
        focused: true,
        delivered: 8,
        applied: 0,
      });

      await expect(
        makeChromiumImpl(registryWith(api)).handler(
          {},
          { udid: CHROMIUM.id, clear: true, text: "15550123", delayMs: 0 },
          CHROMIUM
        )
      ).resolves.toMatchObject({ cleared: true });
    });

    it("does not fire when the effect count is unreadable", async () => {
      // -1 is "the page would not give up the count", which is not evidence that
      // nothing landed. Without this the guard would fail every clear on a page
      // that refuses the property.
      const { api } = splitApi({
        tracked: true,
        length: 0,
        focused: true,
        delivered: 3,
        applied: -1,
      });

      await expect(
        makeChromiumImpl(registryWith(api)).handler(
          {},
          { udid: CHROMIUM.id, clear: true, text: "abc", delayMs: 0 },
          CHROMIUM
        )
      ).resolves.toMatchObject({ cleared: true });
    });

    it("does not fire when the ARRIVALS were short — that is the split", async () => {
      // The two guards partition the same window: a shortfall in arrivals means
      // the characters went somewhere else, which is the focus message's job and
      // has to keep its own wording.
      const { api } = splitApi({
        tracked: true,
        length: 0,
        focused: false,
        delivered: 1,
        applied: 0,
      });

      await expect(
        makeChromiumImpl(registryWith(api)).handler(
          {},
          { udid: CHROMIUM.id, clear: true, text: "abc", delayMs: 0 },
          CHROMIUM
        )
      ).rejects.toThrow(/the page moved focus away from it/);
    });
  });

  it("falls back to the focus sample when the delivery count is unreadable", async () => {
    // -1 is "the page would not give up the count". Inventing evidence either way
    // would be wrong, so the pre-provenance rule stands.
    const kept = splitApi({ tracked: true, length: 1, focused: true, delivered: -1 });
    const result = await makeChromiumImpl(registryWith(kept.api)).handler(
      {},
      { udid: CHROMIUM.id, clear: true, text: "abc", delayMs: 0 },
      CHROMIUM
    );
    expect(result).toMatchObject({ cleared: true });

    const lost = splitApi({ tracked: true, length: 1, focused: false, delivered: -1 });
    await expect(
      makeChromiumImpl(registryWith(lost.api)).handler(
        {},
        { udid: CHROMIUM.id, clear: true, text: "abc", delayMs: 0 },
        CHROMIUM
      )
    ).rejects.toThrow(/only 1 of the 3 character\(s\) reached/);
  });

  it("never quotes a count when the field was a password when it was CLEARED", async () => {
    // The two reads can disagree, and the split message only ever sees the
    // later one: a show/hide control that switches the field to `type="text"`
    // while the characters go out reports a plain box there. "It was a password
    // field when we cleared it" was dropped between the two messages that apply
    // the same rule, so the count came back.
    const events: KeyEventArgs[] = [];
    const probes: string[] = [];
    const api = {
      dispatchKeyEvent: async (e: KeyEventArgs) => void events.push(e),
      evaluate: async (expression: string) => {
        probes.push(expression);
        if (probes.length === 1) {
          return JSON.stringify({
            verdict: "editable",
            label: "INPUT#pw",
            mac: true,
            parked: true,
            secret: true,
          });
        }
        if (probes.length === 2)
          return JSON.stringify({ tracked: true, length: 0, focused: true, secret: true });
        // The show/hide control has since revealed the field.
        return JSON.stringify({
          tracked: true,
          length: 2,
          focused: false,
          delivered: 2,
          secret: false,
        });
      },
    };

    await expect(
      makeChromiumImpl(registryWith(api)).handler(
        {},
        { udid: CHROMIUM.id, clear: true, text: "hunter2", delayMs: 0 },
        CHROMIUM
      )
    ).rejects.toThrow(/not all of the text reached/);
  });

  it("never quotes a count when the split field is a password", async () => {
    // The same message, for a field whose LENGTH is credential material.
    const { api } = splitApi({ tracked: true, length: 1, focused: false, secret: true });

    await expect(
      makeChromiumImpl(registryWith(api)).handler(
        {},
        { udid: CHROMIUM.id, clear: true, text: "hunter2", delayMs: 0 },
        CHROMIUM
      )
    ).rejects.toThrow(/not all of the text reached/);
  });

  it("fails a clear that left embedded content a text measurement cannot see", async () => {
    // A contenteditable is measured by `textContent`, so an <img> (or a video,
    // an <hr>, an attachment chip) survives a cancelled delete at length 0.
    // Measured on Chrome 150: `cleared: true` with the image untouched, 7/7.
    const { api, events } = recordingApi(
      // The image was there BEFORE the clear, so the probe stamped it...
      { verdict: "editable", label: "DIV#body", mac: true, parked: true, nodes: 1 },
      // ...and the re-read still finds that same stamped element in the field.
      { tracked: true, length: 0, residue: 1, focused: true }
    );

    await expect(
      makeChromiumImpl(registryWith(api)).handler(
        {},
        { udid: CHROMIUM.id, clear: true, text: "replacement", delayMs: 0 },
        CHROMIUM
      )
    ).rejects.toThrow(/still holds 1 embedded element\(s\)/);
    // Refused before the typing, so the surviving content keeps no new text
    // appended beside it.
    expect(events.filter((e) => e.type === "char")).toHaveLength(0);
  });

  it("accepts an empty-state placeholder the page inserts once the field empties", async () => {
    // The other half of the same rule. A composer that inserts an icon-only
    // `<span contenteditable="false">` whenever its editable becomes empty holds
    // one embedded element after a clear that worked perfectly — measured on
    // Chrome 150 as a hard 500 telling the caller the field "was NOT emptied",
    // 5/5, which is the opposite of the truth. Residue means content that was
    // there BEFORE and did not go away, so an unstamped newcomer is not residue.
    const { api } = recordingApi(
      { verdict: "editable", label: "DIV#ph", mac: true, parked: true, nodes: 0 },
      { tracked: true, length: 0, residue: 0, focused: true }
    );

    const result = await makeChromiumImpl(registryWith(api)).handler(
      {},
      { udid: CHROMIUM.id, clear: true, delayMs: 0 },
      CHROMIUM
    );

    expect(result.cleared).toBe(true);
  });

  it("accepts a clear whose embed count is UNCHANGED but whose embed is not", async () => {
    // The state a count cannot reach, and the one that made this a permanent
    // failure on an ordinary page (Chrome 151, 3/3): a composer holding one
    // mention pill that swaps in its own placeholder element once empty goes
    // 1 → 1 across a clear that removed everything. Nothing about the numbers
    // separates it from the surviving-`<img>` case above — only the identity of
    // what the re-read finds, which is why the probe stamps.
    const { api } = recordingApi(
      { verdict: "editable", label: "DIV#composer", mac: true, parked: true, nodes: 1 },
      { tracked: true, length: 0, residue: 0, focused: true }
    );

    const result = await makeChromiumImpl(registryWith(api)).handler(
      {},
      { udid: CHROMIUM.id, clear: true, text: "hi", delayMs: 0 },
      CHROMIUM
    );

    expect(result).toMatchObject({ typed: "hi", keys: 2, cleared: true });
  });

  it("fails a clear that left SOME of the embeds it was asked to delete", async () => {
    // Three embeds before and one stamped survivor after. The count FELL, which
    // the old count rule read as "the delete reached the content" and reported as
    // a clean success — but a pill the delete did not remove is residue whatever
    // happened to its siblings, and a following `text` would land beside it.
    const { api } = recordingApi(
      { verdict: "editable", label: "DIV#composer", mac: true, parked: true, nodes: 3 },
      { tracked: true, length: 0, residue: 1, focused: true }
    );

    await expect(
      makeChromiumImpl(registryWith(api)).handler(
        {},
        { udid: CHROMIUM.id, clear: true, delayMs: 0 },
        CHROMIUM
      )
    ).rejects.toThrow(/still holds 1 embedded element\(s\)/);
  });

  it("settles for its own window, not the caller's typing cadence", async () => {
    // `delayMs` is documented as the delay between key presses. Spending it as
    // the settle before the read-back made it the width of a correctness window
    // as well: on Chrome 150, `{ clear, text }` against a field that moves focus
    // 5ms after emptying wrote text outside the target in 8 of 11 runs at
    // `delayMs: 0` and 0 of 4 at the default — and `delayMs: 0` is what these
    // tests pass throughout.
    const trace: { kind: string; at: number }[] = [];
    const probes: string[] = [];
    const api = {
      dispatchKeyEvent: async () => void trace.push({ kind: "key", at: Date.now() }),
      evaluate: async (expression: string) => {
        probes.push(expression);
        trace.push({ kind: "probe", at: Date.now() });
        return JSON.stringify(
          probes.length === 1
            ? { verdict: "editable", label: "INPUT#email", length: 8, mac: true, parked: true }
            : { tracked: true, length: 0, focused: true }
        );
      },
    };

    await makeChromiumImpl(registryWith(api)).handler(
      {},
      { udid: CHROMIUM.id, clear: true, delayMs: 0 },
      CHROMIUM
    );

    // The window the page gets to react in: the clear's last key event, then the
    // read-back both `cleared` and the focus verdict rest on.
    const lastKey = trace.findLastIndex((e) => e.kind === "key");
    const readBack = trace[lastKey + 1]!;
    expect(readBack.kind).toBe("probe");
    expect(readBack.at - trace[lastKey]!.at).toBeGreaterThanOrEqual(40);
  });

  it("gives a slower caller the longer settle it asked for", async () => {
    // The other half of `Math.max(delayMs, CLEAR_SETTLE_MS)`. Every Chromium
    // test here passes `delayMs: 0`, so only the FLOOR was pinned and
    // `const settleMs = CLEAR_SETTLE_MS` stayed green — silently dropping the
    // longer window on the slow page that asked for it, which is the one case
    // where more settle can only help.
    const trace: { kind: string; at: number }[] = [];
    const probes: string[] = [];
    const api = {
      dispatchKeyEvent: async () => void trace.push({ kind: "key", at: Date.now() }),
      evaluate: async () => {
        probes.push("probe");
        trace.push({ kind: "probe", at: Date.now() });
        return JSON.stringify(
          probes.length === 1
            ? { verdict: "editable", label: "INPUT#email", length: 8, mac: true, parked: true }
            : { tracked: true, length: 0, focused: true }
        );
      },
    };

    await makeChromiumImpl(registryWith(api)).handler(
      {},
      { udid: CHROMIUM.id, clear: true, delayMs: 200 },
      CHROMIUM
    );

    const lastKey = trace.findLastIndex((e) => e.kind === "key");
    const readBack = trace[lastKey + 1]!;
    expect(readBack.kind).toBe("probe");
    expect(readBack.at - trace[lastKey]!.at).toBeGreaterThanOrEqual(180);
  });

  it("refuses to press a named key when the clear moved focus off the field", async () => {
    // The `key` half of the same guard: Enter dispatched at whatever holds focus
    // after the clear submits the wrong form, and reports success doing it.
    const { events, api } = recordingApi(undefined, { tracked: true, length: 0, focused: false });

    await expect(
      makeChromiumImpl(registryWith(api)).handler(
        {},
        { udid: CHROMIUM.id, clear: true, key: "enter", delayMs: 0 },
        CHROMIUM
      )
    ).rejects.toThrow(/no longer holds focus/);

    expect(events).toHaveLength(2); // the clear's own pair, and nothing after it
  });

  it("reports no character count for a password field that survived the clear", async () => {
    // A password's LENGTH is credential material and the failure message reaches
    // the agent's transcript. Both probes compute `secret` for this one line.
    const { api } = recordingApi(
      { verdict: "editable", label: "INPUT#pw", mac: true, parked: true, secret: true },
      { tracked: true, length: 9, focused: true, secret: true }
    );

    await expect(
      makeChromiumImpl(registryWith(api)).handler(
        {},
        { udid: CHROMIUM.id, clear: true, delayMs: 0 },
        CHROMIUM
      )
    ).rejects.toThrow(/still holds its contents/);
  });

  it("still clears when nothing follows, even if the field blurred itself", async () => {
    // A clear-only call has no text to misplace, so losing focus afterwards is
    // not a failure — the field was emptied, which is all that was asked.
    const result = await makeChromiumImpl(
      registryWith(recordingApi(undefined, { tracked: true, length: 0, focused: false }).api)
    ).handler({}, { udid: CHROMIUM.id, clear: true, delayMs: 0 }, CHROMIUM);

    expect(result.cleared).toBe(true);
  });

  it("types after a clear it could not read back, rather than refusing blind", async () => {
    // An unreadable page yields no focus evidence either way. Refusing there
    // would break clears that work today for a check that is merely blind.
    const { events, api } = recordingApi(undefined, { tracked: false });

    const result = await makeChromiumImpl(registryWith(api)).handler(
      {},
      { udid: CHROMIUM.id, clear: true, text: "ab", delayMs: 0 },
      CHROMIUM
    );

    expect(result).toMatchObject({ typed: "ab", keys: 2, cleared: true });
    expect(events.length).toBeGreaterThan(2);
  });

  it("dispatches selectAll+deleteBackward as `commands`, with a real modifier", async () => {
    const { events, api } = recordingApi();

    const result = await makeChromiumImpl(registryWith(api)).handler(
      {},
      { udid: CHROMIUM.id, clear: true, delayMs: 0 },
      CHROMIUM
    );

    const down = events[0]!;
    expect(down.type).toBe("rawKeyDown");
    // THE regression guard: the edit must be named as `commands`. Which
    // modifier reaches Blink's editing layer is build-dependent — on a macOS
    // Chrome 150, Meta+A and Ctrl+A each select ZERO characters, so a delete
    // after one removes a single character while the tool reports success. An
    // implementation that swapped `commands` for `modifiers` fails here.
    expect(down.commands).toEqual(["selectAll", "deleteBackward"]);
    // …and the modifier is set as well. Without it the page receives a bare
    // unmodified `a`, which fires whatever the app binds to that key and lets an
    // app-level preventDefault cancel the clear outright — measured on Chrome
    // 150: the field kept its value and the call still reported success.
    expect(down.modifiers).toBe(4); // Meta — the probe reported a mac renderer
    expect(events.every((e) => e.modifiers === down.modifiers)).toBe(true);
    // `commands` belongs only on the rawKeyDown. Blink honours it on `keyDown`
    // and `char` too, but not `keyUp` — and rawKeyDown is the type a real
    // chord's first event carries, delivering no character of its own.
    expect(events.filter((e) => e.commands !== undefined)).toHaveLength(1);
    expect(result.cleared).toBe(true);
  });

  it("takes the chord's modifier from the RENDERER's platform, not the host's", async () => {
    // The tool-server can reach a renderer running elsewhere — `adb forward` and
    // an SSH tunnel both present as a local CDP port — so the host's own
    // platform is not evidence of which chord that page's users press. The
    // modifier decides which app shortcuts fire, so it has to match the page.
    const { events } = await (async () => {
      const { events, api } = recordingApi({
        verdict: "editable",
        label: "INPUT#email",
        length: 8,
        mac: false,
      });
      await makeChromiumImpl(registryWith(api)).handler(
        {},
        { udid: CHROMIUM.id, clear: true, delayMs: 0 },
        CHROMIUM
      );
      return { events };
    })();

    expect(events[0]!.modifiers).toBe(2); // Ctrl
  });

  it("refuses before dispatching when nothing editable has focus", async () => {
    // Blink's selectAll is not scoped to a field: with focus on the body it
    // selects the whole document and the delete no-ops, so the page is left with
    // a document-wide selection and the field untouched — reported as success.
    const { events, api } = recordingApi({ verdict: "none" });

    await expect(
      makeChromiumImpl(registryWith(api)).handler(
        {},
        { udid: CHROMIUM.id, clear: true, text: "new@example.com", delayMs: 0 },
        CHROMIUM
      )
    ).rejects.toThrow(/no editable element has focus/);
    // Nothing dispatched at all — not the clear, and not the text either.
    expect(events).toEqual([]);
  });

  it("refuses when focus is on a non-editable element", async () => {
    const { events, api } = recordingApi({ verdict: "not-editable", label: "BUTTON#submit" });

    await expect(
      makeChromiumImpl(registryWith(api)).handler(
        {},
        { udid: CHROMIUM.id, clear: true, delayMs: 0 },
        CHROMIUM
      )
    ).rejects.toThrow(/BUTTON#submit/);
    expect(events).toEqual([]);
  });

  it("refuses a readonly field instead of selecting the page around it", async () => {
    // Measured on Chrome 150: the dispatch succeeds against a readonly input,
    // deletes nothing, and leaves the whole field selected. Without this guard
    // the call would fall through to the post-check and be reported as an
    // ineffective clear (a 500) rather than the un-clearable target it is.
    const { events, api } = recordingApi({ verdict: "read-only", label: "INPUT#total" });

    await expect(
      makeChromiumImpl(registryWith(api)).handler(
        {},
        { udid: CHROMIUM.id, clear: true, delayMs: 0 },
        CHROMIUM
      )
    ).rejects.toThrow(/INPUT#total is read-only/);
    expect(events).toEqual([]);
  });

  it("fails loudly when the field still holds text afterwards", async () => {
    // A page that cancels the keydown, a rich-text editor that cancels the
    // `beforeinput`, or a Chromium too old to know `commands` all produce a
    // successful CDP reply and an unchanged field. Reporting `cleared: true`
    // there is what turns `{ clear, text }` into an append onto the old value.
    const { api } = recordingApi(
      { verdict: "editable", label: "INPUT#email", length: 8 },
      { tracked: true, length: 8 }
    );

    await expect(
      makeChromiumImpl(registryWith(api)).handler(
        {},
        { udid: CHROMIUM.id, clear: true, delayMs: 0 },
        CHROMIUM
      )
    ).rejects.toThrow(/still holds 8 character\(s\)/);
  });

  it("does not fail on a stale read of a node the page detached", async () => {
    // A page that replaces the field on edit (the React remount pattern) leaves
    // the parked node detached and holding its OLD value, while the live field
    // really was cleared. The release probe reports that as untracked; treating
    // it as residue would fail a clear that worked.
    const { api } = recordingApi(
      { verdict: "editable", label: "INPUT#q", length: 8, mac: true },
      { tracked: false }
    );

    const result = await makeChromiumImpl(registryWith(api)).handler(
      {},
      { udid: CHROMIUM.id, clear: true, delayMs: 0 },
      CHROMIUM
    );

    expect(result.cleared).toBe(true);
  });

  it("stays best-effort when the page refused the parked handle", async () => {
    // A page can pre-define the slot non-writable; the assignment then fails
    // silently and the release probe would read the page's decoy instead of the
    // field. The probe reports the failed park, and nothing is verified against.
    const { api } = recordingApi(
      { verdict: "editable", label: "INPUT#q", length: 8, mac: true, parked: false },
      { tracked: true, length: 8 }
    );

    const result = await makeChromiumImpl(registryWith(api)).handler(
      {},
      { udid: CHROMIUM.id, clear: true, delayMs: 0 },
      CHROMIUM
    );

    expect(result.cleared).toBe(true);
  });

  it("releases the parked element even when the dispatch throws", async () => {
    // The handle is the sole retainer of the node, so a dispatch failure must
    // not leave it pinning a detached subtree on the page.
    const probes: string[] = [];
    const api = {
      dispatchKeyEvent: async () => {
        throw new Error("CDP socket closed");
      },
      evaluate: async (expression: string) => {
        probes.push(expression);
        return JSON.stringify(
          probes.length === 1
            ? { verdict: "editable", label: "INPUT#q", length: 8, mac: true }
            : { tracked: false }
        );
      },
    };

    await expect(
      makeChromiumImpl(registryWith(api)).handler(
        {},
        { udid: CHROMIUM.id, clear: true, delayMs: 0 },
        CHROMIUM
      )
    ).rejects.toThrow(/CDP socket closed/);
    // Resolve, the read-back that keeps the element, and the release that runs
    // in the caller's `finally` however the call ends.
    expect(probes).toHaveLength(3);
    expect(probes[2]).toContain("delete window[");
  });

  it("does not fail when the field blurred or went away as a result of clearing", async () => {
    // Only positively-observed residue counts as a failure. A page that drops
    // focus once its field empties (or swaps the node out) is reacting to the
    // clear, not ignoring it — failing there would break a working clear.
    const { api } = recordingApi(
      { verdict: "editable", label: "INPUT#q", length: 12 },
      { tracked: true, length: 0 }
    );

    const result = await makeChromiumImpl(registryWith(api)).handler(
      {},
      { udid: CHROMIUM.id, clear: true, delayMs: 0 },
      CHROMIUM
    );

    expect(result.cleared).toBe(true);
  });

  it("stays best-effort when the page cannot be read", async () => {
    // Focus inside a cross-origin iframe, or an `evaluate` that throws. There is
    // nothing to verify against, so refusing would break clears that work today.
    const { events, api } = recordingApi({ verdict: "unknown" });

    const result = await makeChromiumImpl(registryWith(api)).handler(
      {},
      { udid: CHROMIUM.id, clear: true, delayMs: 0 },
      CHROMIUM
    );

    expect(events.map((e) => e.type)).toEqual(["rawKeyDown", "keyUp"]);
    expect(result.cleared).toBe(true);
  });

  it("still sends the host's native chord when `evaluate` itself fails", async () => {
    // The probe's own catch carries `mac`, but a failed `evaluate` never runs
    // it. The chord is dispatched on that path regardless, so it should still be
    // the one that machine's users press rather than defaulting to Ctrl.
    //
    // BOTH platforms are driven here rather than mirroring the expression under
    // test with `process.platform === "darwin" ? 4 : 2`: that form re-derives
    // the answer from the same input, so a `mac: false` mutation passes
    // vacuously on a non-darwin runner — and CI is not a Mac.
    const chordOn = async (platform: string) => {
      const original = Object.getOwnPropertyDescriptor(process, "platform")!;
      Object.defineProperty(process, "platform", { ...original, value: platform });
      try {
        const events: KeyEventArgs[] = [];
        const api = {
          dispatchKeyEvent: async (e: KeyEventArgs) => void events.push(e),
          evaluate: async () => {
            throw new Error("Runtime.evaluate: main world detached");
          },
        };
        await makeChromiumImpl(registryWith(api)).handler(
          {},
          { udid: CHROMIUM.id, clear: true, delayMs: 0 },
          CHROMIUM
        );
        return events[0]!.modifiers;
      } finally {
        Object.defineProperty(process, "platform", original);
      }
    };

    expect(await chordOn("darwin")).toBe(4); // Meta
    expect(await chordOn("linux")).toBe(2); // Ctrl
  });

  it("treats an unreadable page as unknown rather than failing the call", async () => {
    const events: KeyEventArgs[] = [];
    const api = {
      dispatchKeyEvent: async (e: KeyEventArgs) => void events.push(e),
      evaluate: async () => {
        throw new Error("Runtime.evaluate: main world detached");
      },
    };

    const result = await makeChromiumImpl(registryWith(api)).handler(
      {},
      { udid: CHROMIUM.id, clear: true, delayMs: 0 },
      CHROMIUM
    );

    expect(events.map((e) => e.type)).toEqual(["rawKeyDown", "keyUp"]);
    expect(result.cleared).toBe(true);
  });

  it.each([
    // `evaluateJson` insists the probes return a JSON STRING, and the probes'
    // own doc calls that contract load-bearing: it is what makes an unreadable
    // page fall to the best-effort branch. Both ways of breaking it were
    // unexecuted by the suite, so a probe rewritten to return an object — the
    // shape the sibling CDP helpers use with `returnByValue` — would have put
    // every clear on the best-effort branch silently.
    ["an object instead of a JSON string", { verdict: "editable", label: "INPUT#q" }],
    ["a string that is not JSON", "verdict=editable"],
    ["nothing at all", undefined],
  ])("treats %s from a probe as unknown rather than failing the call", async (_case, raw) => {
    const events: KeyEventArgs[] = [];
    const api = {
      dispatchKeyEvent: async (e: KeyEventArgs) => void events.push(e),
      evaluate: async () => raw,
    };

    const result = await makeChromiumImpl(registryWith(api)).handler(
      {},
      { udid: CHROMIUM.id, clear: true, text: "hi", delayMs: 0 },
      CHROMIUM
    );

    // Dispatched anyway (best effort), and the text still typed.
    expect(events.filter((e) => e.type === "rawKeyDown")).toHaveLength(1);
    expect(result).toMatchObject({ typed: "hi", keys: 2, cleared: true });
  });

  it("keeps a successful clear successful when the release read fails", async () => {
    // The release runs from a `finally`, so a throw there would replace the
    // call's real outcome with a teardown error. Nothing else in the suite
    // drives a clear whose LAST probe fails.
    const events: KeyEventArgs[] = [];
    let calls = 0;
    const api = {
      dispatchKeyEvent: async (e: KeyEventArgs) => void events.push(e),
      evaluate: async () => {
        calls++;
        if (calls === 1) return JSON.stringify({ verdict: "editable", label: "INPUT#q" });
        if (calls === 2) return JSON.stringify({ tracked: true, length: 0, focused: true });
        throw new Error("Runtime.evaluate: target closed");
      },
    };

    const result = await makeChromiumImpl(registryWith(api)).handler(
      {},
      { udid: CHROMIUM.id, clear: true, delayMs: 0 },
      CHROMIUM
    );

    expect(calls).toBe(3);
    expect(result).toMatchObject({ typed: "", keys: 0, cleared: true });
  });

  it("pairs the rawKeyDown with a keyUp and nothing else when text is absent", async () => {
    const { events, api } = recordingApi();

    await makeChromiumImpl(registryWith(api)).handler(
      {},
      { udid: CHROMIUM.id, clear: true, delayMs: 0 },
      CHROMIUM
    );

    expect(events.map((e) => e.type)).toEqual(["rawKeyDown", "keyUp"]);
  });

  it("orders clear → key in a single call", async () => {
    // The clear-then-text order is pinned above; the tool rejects `{ text, key }`,
    // so this is the other combination a caller can send. Dispatching Enter
    // before the select-all chord would submit the field's OLD contents.
    const { events, api } = recordingApi();

    await makeChromiumImpl(registryWith(api)).handler(
      {},
      { udid: CHROMIUM.id, clear: true, key: "enter", delayMs: 0 },
      CHROMIUM
    );

    // The clear's rawKeyDown, then Enter.
    expect(events.filter((e) => e.type === "rawKeyDown").length).toBe(1);
    const typedOrder = events
      .filter((e) => e.type === "rawKeyDown" || e.type === "keyDown")
      .map((e) => e.key);
    expect(typedOrder).toEqual(["a", "Enter"]);
  });

  it("rejects an unknown key before clearing anything", async () => {
    const dispatchKeyEvent = vi.fn(async () => {});

    await expect(
      makeChromiumImpl(registryWith({ dispatchKeyEvent })).handler(
        {},
        { udid: CHROMIUM.id, clear: true, key: "bogus", delayMs: 0 },
        CHROMIUM
      )
    ).rejects.toThrow(/Unknown key "bogus"/);
    expect(dispatchKeyEvent).not.toHaveBeenCalled();
  });

  it("rejects un-typeable text BEFORE clearing (never destroys the old value)", async () => {
    const dispatchKeyEvent = vi.fn(async () => {});

    await expect(
      makeChromiumImpl(registryWith({ dispatchKeyEvent })).handler(
        {},
        { udid: CHROMIUM.id, clear: true, text: "café", delayMs: 0 },
        CHROMIUM
      )
    ).rejects.toThrow(/No CDP key descriptor for character "é"/);
    // Same hazard as the iOS case: a clear that lands and then 400s leaves the
    // field holding "caf" instead of its original value.
    expect(dispatchKeyEvent).not.toHaveBeenCalled();
  });

  // The blueprint half of this guarantee — that `commands` actually survives
  // the payload builder on the way to `Input.dispatchKeyEvent` — is pinned in
  // chromium-cdp-blueprint.test.ts against a fake CDP server.
});

describe("keyboard clear — unsupported platforms", () => {
  // The rejections are `InvalidToolInputError`, not `UnsupportedOperationError`:
  // the TOOL is supported on both targets — its own description and
  // `argent-tv-interact` send the agent here to type — and one parameter of the
  // request is not. `UnsupportedOperationError` says the opposite in its first
  // clause and hard-codes TOOL_CAPABILITY_UNSUPPORTED_OPERATION, which files a
  // refused `clear` under the same code as a tool that cannot run here at all.
  it("vega rejects clear with no injection attempted", async () => {
    vi.mocked(injectVegaText).mockClear();
    vi.mocked(injectVegaNamedKey).mockClear();

    await expect(
      vegaImpl.handler({}, { udid: VEGA.id, clear: true, text: "hi" }, VEGA)
    ).rejects.toBeInstanceOf(InvalidToolInputError);
    // A silent no-op here is exactly the #449 failure mode: the caller believes
    // the field was emptied and the new text replaced the old.
    expect(injectVegaText).not.toHaveBeenCalled();
    expect(injectVegaNamedKey).not.toHaveBeenCalled();
  });

  it("vega's refusal only promises a re-send when there is something to re-send", async () => {
    // One blanket "send the same call without `clear`" is wrong for the two
    // shapes that carry nothing else: `{ clear: true }` alone — the
    // empty-the-field call the parameter exists for — and `{ clear: true,
    // text: "" }`, which the injection guard no-ops. Re-sending either does
    // nothing, so the field is left neither emptied nor typed into.
    await expect(vegaImpl.handler({}, { udid: VEGA.id, clear: true }, VEGA)).rejects.toThrow(
      /Nothing else in this request needs re-sending/
    );
    await expect(
      vegaImpl.handler({}, { udid: VEGA.id, clear: true, text: "" }, VEGA)
    ).rejects.toThrow(/Nothing else in this request needs re-sending/);
    // The two that DO have a remainder keep the advice. Unlike a TV, Vega
    // accepts `key`, so a clear+key request has a real second half.
    await expect(
      vegaImpl.handler({}, { udid: VEGA.id, clear: true, text: "hi" }, VEGA)
    ).rejects.toThrow(/Typing works: send the same call without `clear`/);
    await expect(
      vegaImpl.handler({}, { udid: VEGA.id, clear: true, key: "enter" }, VEGA)
    ).rejects.toThrow(/The key press works: send the same call without `clear`/);
  });

  it("vega still types normally when clear is absent", async () => {
    vi.mocked(injectVegaText).mockClear();

    await vegaImpl.handler({}, { udid: VEGA.id, text: "hi" }, VEGA);

    expect(injectVegaText).toHaveBeenCalledWith("hi");
  });

  it("tv rejects clear with no typing attempted", async () => {
    const type = vi.fn(async () => {});

    await expect(
      typeTv(registryWith({ type }), APPLE_TV, { udid: APPLE_TV.id, clear: true, text: "hi" })
    ).rejects.toBeInstanceOf(InvalidToolInputError);
    expect(type).not.toHaveBeenCalled();
  });

  it("tv still types normally when clear is absent", async () => {
    const type = vi.fn(async () => {});

    const result = await typeTv(registryWith({ type }), APPLE_TV, {
      udid: APPLE_TV.id,
      text: "hi",
    });

    expect(type).toHaveBeenCalledWith("hi");
    expect(result).toEqual({ typed: "hi", keys: 2 });
  });

  it("an Android TV target routes clear to the TV rejection, not to adb", async () => {
    // Joins the two halves the other tests check separately: `makeAndroidImpl`
    // routes a TV target to `typeTv`, and `typeTv` rejects clear. Without it an
    // Android TV serial reaches `typeAndroidPhone` instead — where the chord
    // would in fact go over the wire, since Android TV shares the phone's
    // on-device `input` sink. That is exactly why routing is what has to be
    // pinned: nothing downstream would refuse the call.
    adbShell.mockClear();
    isAndroidTv.mockResolvedValueOnce(true);

    await expect(
      makeAndroidImpl(registryWith({ type: vi.fn() })).handler(
        {},
        { udid: ANDROID.id, clear: true, text: "hi" },
        ANDROID
      )
    ).rejects.toBeInstanceOf(InvalidToolInputError);
    expect(adbShell).not.toHaveBeenCalled();
  });

  it("an Apple TV udid routes clear to the TV rejection, not to the HID chord", async () => {
    // The tvOS mirror of the case above, and the reason the iOS dispatcher is
    // exercised at all: a tvOS sim classifies as platform "ios" by udid shape,
    // so without the `isTvOsSimulator` probe an Apple TV would reach
    // `typeSimulatorServer` and fire Cmd+A at a device whose focus-driven
    // backend cannot use it.
    isTvOsSimulator.mockResolvedValueOnce(true);
    const pressKey = vi.fn();
    const type = vi.fn(async () => {});

    await expect(
      makeIosImpl(registryWith({ pressKey, type })).handler(
        {},
        { udid: APPLE_TV.id, clear: true, text: "hi" },
        APPLE_TV
      )
    ).rejects.toBeInstanceOf(InvalidToolInputError);
    expect(pressKey).not.toHaveBeenCalled();
    expect(type).not.toHaveBeenCalled();
  });

  it("an iPhone udid routes clear to the simulator-server chord", async () => {
    // The other side of the same probe — the routing has to send a non-TV iOS
    // target to the HID transport, or `clear` would be rejected on the platform
    // the tool description says supports it.
    isTvOsSimulator.mockResolvedValueOnce(false);
    const events: string[] = [];
    const pressKey = (direction: "Down" | "Up", keyCode: number) =>
      events.push(`${direction}:${keyCode}`);

    const result = await makeIosImpl(registryWith({ pressKey })).handler(
      {},
      { udid: IOS_SIM.id, clear: true, delayMs: 0 },
      IOS_SIM
    );

    // Past the leading modifier-release prelude every run opens with.
    expect(events.slice(2, 6)).toEqual(["Down:227", "Down:4", "Up:4", "Up:227"]);
    expect(result.cleared).toBe(true);
  });

  it("a remote iOS sim clears over the same transport, without a tvOS probe", async () => {
    // `makeIosRemoteImpl` deliberately skips the probe (remote sims are never
    // tvOS, and the probe shells out to local `xcrun`). Nothing else asserts
    // what `clear` does over the sim-remote transport, which the tool
    // description presents as supported without qualification.
    isTvOsSimulator.mockClear();
    const events: string[] = [];
    const pressKey = (direction: "Down" | "Up", keyCode: number) =>
      events.push(`${direction}:${keyCode}`);

    const result = await makeIosRemoteImpl(registryWith({ pressKey })).handler(
      {},
      { udid: IOS_REMOTE.id, clear: true, delayMs: 0 },
      IOS_REMOTE
    );

    expect(events.slice(2, 6)).toEqual(["Down:227", "Down:4", "Up:4", "Up:227"]);
    expect(isTvOsSimulator).not.toHaveBeenCalled();
    expect(result.cleared).toBe(true);
  });
});
