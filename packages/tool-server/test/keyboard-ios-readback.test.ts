import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeviceInfo } from "@argent/registry";
import type { AXFillResponse, AXTreeNode } from "../src/blueprints/ax-service";
import {
  capitalizedByIos,
  holdsTyped,
  READBACK_MISMATCH_WARNING,
  READBACK_TIMING,
  typeWithReadback,
} from "../src/tools/keyboard/ios-readback";
import { SHIFT_KEYCODE } from "../src/tools/keyboard/key-codes";
import { KEY_HOLD, typeSimulatorServer } from "../src/tools/keyboard/simulator-server-keys";

// #2030: a stalled simulator drops or repeats keys while every key is acked,
// so `keyboard` reads the field back where the answer means something.

const IOS_SIM: DeviceInfo = { id: "TEST-UDID", platform: "ios", kind: "simulator" };

const TEXT_FIELD = 49;
const SECURE_TEXT_FIELD = 50;

/** A text input on screen; `slot` places it left to right, as code boxes sit. */
function input(
  value: string,
  { focused = false, slot = 0, elementType = TEXT_FIELD } = {}
): AXTreeNode {
  return {
    index: slot,
    elementType,
    // As the daemon sends it: fractions of the screen.
    frame: { x: 0.1 + 0.17 * slot, y: 0.14, width: 0.15, height: 0.05 },
    ...(value ? { value } : { value: "Placeholder", hintShowing: true }),
    ...(focused ? { traits: ["isEditing"] } : {}),
  };
}

/**
 * A screen the tree reads from, and the ax-service check answers about: the
 * focused input holds the text, a secure one as many bullets. `checkSays`
 * overrides that answer, for an app that applies input late.
 */
function fakeScreen(nodes: AXTreeNode[], opts: { checkMs?: number } = {}) {
  const screen = { nodes, checkSays: undefined as AXFillResponse | undefined };
  const tree = vi.fn(async () => ({ alertVisible: false, nodes: screen.nodes, truncated: false }));
  const fill = vi.fn(async (text: string, _opts?: { check?: boolean }) => {
    if (opts.checkMs) await new Promise((r) => setTimeout(r, opts.checkMs));
    if (screen.checkSays) return screen.checkSays;
    const focused = screen.nodes.find((n) => n.traits?.includes("isEditing"));
    if (!focused) return { focused: false, verified: false };
    const held = focused.hintShowing ? "" : (focused.value ?? "");
    const verified =
      focused.elementType === SECURE_TEXT_FIELD ? held.length === text.length : held === text;
    return { focused: true, verified };
  });
  return { screen, api: { degraded: false, tree, fill }, tree, fill };
}

function registryWith(api: unknown) {
  return { resolveService: vi.fn(async () => api) } as never;
}

/** Types `text`, which leaves the screen showing `after`. */
async function typeOn(fake: ReturnType<typeof fakeScreen>, text: string, after: AXTreeNode[]) {
  return typeWithReadback(registryWith(fake.api), IOS_SIM, text, async () => {
    fake.screen.nodes = after;
    return { typed: text, keys: text.length };
  });
}

const saved = { ...READBACK_TIMING };
beforeEach(() => {
  Object.assign(READBACK_TIMING, { resolveMs: 50, treeMs: 50, checkMs: 300 });
});
afterEach(() => {
  Object.assign(READBACK_TIMING, saved);
});

describe("typeWithReadback", () => {
  it("verifies a field that was empty and now holds the text, from the tree alone", async () => {
    const fake = fakeScreen([input("", { focused: true })]);

    const out = await typeOn(fake, "Ab@1", [input("Ab@1", { focused: true })]);

    expect(out).toEqual({ result: { typed: "Ab@1", keys: 4 }, readback: { verified: true } });
    expect(fake.fill).not.toHaveBeenCalled();
  });

  it("warns, without quoting the text, when the field holds something else", async () => {
    const fake = fakeScreen([input("", { focused: true })]);

    const out = await typeOn(fake, "s3cret!", [input("s3cret", { focused: true })]);

    expect(out.readback).toEqual({ verified: false, warning: READBACK_MISMATCH_WARNING });
    expect(READBACK_MISMATCH_WARNING).not.toContain("s3cret");
    // Only ever a check: the read-back never writes the field.
    expect(fake.fill.mock.calls).toEqual([["s3cret!", { check: true }]]);
  });

  // The daemon answers "no" only after its own wait for the text runs out,
  // so the check after typing has to outlast that wait to see the mismatch.
  it("warns when the mismatch answer comes back late", async () => {
    const fake = fakeScreen([input("", { focused: true })], { checkMs: 120 });

    const out = await typeOn(fake, "general", [input("generl", { focused: true })]);

    expect(out.readback).toEqual({ verified: false, warning: READBACK_MISMATCH_WARNING });
  });

  // The check's "no" for a field holding text comes after the daemon's 1 s
  // wait, and the daemon serves one request at a time: a check given up on
  // before typing would hold up the next requests, a touch's orientation
  // read among them.
  it("does not ask the ax-service check about a field that holds text", async () => {
    const fake = fakeScreen([input("seed", { focused: true })]);

    const out = await typeOn(fake, "a", [input("seeda", { focused: true })]);

    expect(out.readback).toBeUndefined();
    expect(fake.fill).not.toHaveBeenCalled();
    expect(fake.tree).toHaveBeenCalledTimes(1);
  });

  it("skips the check when no input is focused", async () => {
    const fake = fakeScreen([input("")]);

    const out = await typeOn(fake, "hi", [input("")]);

    expect(out.readback).toBeUndefined();
    expect(fake.fill).not.toHaveBeenCalled();
  });

  it("types unchecked when the tree does not answer in time", async () => {
    const fake = fakeScreen([input("", { focused: true })]);
    fake.tree.mockImplementation(() => new Promise(() => {}));

    const out = await typeOn(fake, "hi", [input("hi", { focused: true })]);

    expect(out.readback).toBeUndefined();
    expect(fake.fill).not.toHaveBeenCalled();
  });

  // A code screen moves focus to the next box after each digit, so the
  // focused input after typing is not the one typed into.
  describe("when focus moves to another input while typing", () => {
    const boxes = (values: string[], focus: number) =>
      values.map((value, slot) => input(value, { slot, focused: slot === focus }));

    it("says nothing when one digit moved focus to the next box", async () => {
      const fake = fakeScreen(boxes(["", "", ""], 0));
      const out = await typeOn(fake, "1", boxes(["1", "", ""], 1));
      expect(out.readback).toBeUndefined();
      expect(fake.fill).not.toHaveBeenCalled();
    });

    it("says nothing when several digits moved focus box by box", async () => {
      const fake = fakeScreen(boxes(["", "", ""], 0));
      const out = await typeOn(fake, "12", boxes(["1", "2", ""], 2));
      expect(out.readback).toBeUndefined();
    });

    it("verifies the last box, where focus stays", async () => {
      const fake = fakeScreen(boxes(["1", "2", ""], 2));
      const out = await typeOn(fake, "3", boxes(["1", "2", "3"], 2));
      expect(out.readback).toEqual({ verified: true });
    });

    it("says nothing when focus left every input", async () => {
      const fake = fakeScreen([input("", { focused: true })]);
      const out = await typeOn(fake, "hi", [input("hi")]);
      expect(out.readback).toBeUndefined();
    });

    it("says nothing when the app moved focus only after the check's wait", async () => {
      const fake = fakeScreen(boxes(["", ""], 0));
      fake.fill.mockImplementation(async () => {
        fake.screen.nodes = boxes(["1", ""], 1);
        return { focused: true, verified: false };
      });
      const out = await typeOn(fake, "1", boxes(["", ""], 0));
      expect(out.readback).toBeUndefined();
    });
  });

  // A search field narrows for its clear button once it holds text, and
  // slides over a little.
  it("judges a field that moved and changed size a little as it filled", async () => {
    const field = input("", { focused: true, elementType: 45 });
    const fake = fakeScreen([field]);
    const narrowed = { ...field, value: "general", hintShowing: undefined };
    narrowed.frame = { x: 0.11, y: 0.141, width: 0.11, height: 0.048 };

    const out = await typeOn(fake, "general", [narrowed]);

    expect(out.readback).toEqual({ verified: true });
  });

  describe("text iOS changes as the keys arrive", () => {
    it.each([
      ["hello world", "Hello world"],
      ["hi. see you", "Hi. See you"],
      ["don't", "don’t"],
      ["a--b", "a—b"],
      ['say "hi"', "say „hi”"],
      ['say "hi"', "say «hi»"],
      ['say "hi"', "say «\u00A0hi\u00A0»"],
      ["it's 'ok'", "it’s ‹ok›"],
      ["don't go", "Don’t go"],
    ])("verifies %s held as %s, without the slow check", async (typed, held) => {
      const fake = fakeScreen([input("", { focused: true })]);
      const out = await typeOn(fake, typed, [input(held, { focused: true })]);
      expect(out.readback).toEqual({ verified: true });
      expect(fake.fill).not.toHaveBeenCalled();
    });

    it("warns for a field that capitalizes every letter: that reads like a held Shift", async () => {
      const fake = fakeScreen([input("", { focused: true })]);
      const out = await typeOn(fake, "general", [input("GENERAL", { focused: true })]);
      expect(out.readback).toEqual({ verified: false, warning: READBACK_MISMATCH_WARNING });
    });
  });

  it("leaves a field the app has not caught up with to the check", async () => {
    const fake = fakeScreen([input("", { focused: true })]);
    fake.screen.checkSays = { focused: true, verified: true };

    const out = await typeOn(fake, "hello", [input("hel", { focused: true })]);

    expect(out.readback).toEqual({ verified: true });
    expect(fake.fill.mock.calls.map((c) => c[0])).toEqual(["hello"]);
  });

  it("reads the tree again after the check's wait, for an app that capitalizes late", async () => {
    const fake = fakeScreen([input("", { focused: true })]);
    fake.fill.mockImplementation(async () => {
      fake.screen.nodes = [input("Hello", { focused: true })];
      return { focused: true, verified: false };
    });

    const out = await typeOn(fake, "hello", [input("hel", { focused: true })]);

    expect(out.readback).toEqual({ verified: true });
    expect(fake.tree).toHaveBeenCalledTimes(3);
  });

  // The ax-service check compares exactly, so it says "no" to a capital iOS
  // added; a busy app that also misses the late tree read must not get the
  // mismatch warning for it.
  it("says nothing when the late tree read times out after the check says no", async () => {
    const fake = fakeScreen([input("", { focused: true })]);
    fake.fill.mockImplementation(async () => {
      fake.tree.mockImplementation(() => new Promise(() => {}));
      return { focused: true, verified: false };
    });

    const out = await typeOn(fake, "hello", [input("hel", { focused: true })]);

    expect(out.readback).toBeUndefined();
  });

  it("leaves a secure field, which shows bullets, to the check", async () => {
    const secure = (value: string) =>
      input(value, { focused: true, elementType: SECURE_TEXT_FIELD });

    const ok = fakeScreen([secure("")]);
    expect((await typeOn(ok, "s3cret", [secure("••••••")])).readback).toEqual({ verified: true });
    expect(ok.fill).toHaveBeenCalledTimes(1);

    const short = fakeScreen([secure("")]);
    expect((await typeOn(short, "s3cret", [secure("•••••")])).readback).toEqual({
      verified: false,
      warning: READBACK_MISMATCH_WARNING,
    });
  });

  it("does not check text with Return or Tab, which can move focus or submit", async () => {
    const fake = fakeScreen([input("", { focused: true })]);
    for (const text of ["a\nb", "a\tb", "a\rb"]) {
      expect((await typeOn(fake, text, [input("", { focused: true })])).readback).toBeUndefined();
    }
    expect(fake.tree).not.toHaveBeenCalled();
    expect(fake.fill).not.toHaveBeenCalled();
  });

  it("types unchecked when the ax-service is degraded, missing or hangs", async () => {
    const type = vi.fn(async () => ({ typed: "hi", keys: 2 }));

    const degraded = fakeScreen([input("", { focused: true })]);
    const degradedApi = { ...degraded.api, degraded: true };
    expect((await typeWithReadback(registryWith(degradedApi), IOS_SIM, "hi", type)).readback).toBe(
      undefined
    );
    expect(degraded.tree).not.toHaveBeenCalled();

    const failing = { resolveService: vi.fn(async () => Promise.reject(new Error("no ax"))) };
    expect((await typeWithReadback(failing as never, IOS_SIM, "hi", type)).readback).toBe(
      undefined
    );

    // A service without `tree` throws synchronously; that is unchecked too.
    expect((await typeWithReadback(registryWith({}), IOS_SIM, "hi", type)).readback).toBe(
      undefined
    );

    const hanging = { resolveService: vi.fn(() => new Promise(() => {})) };
    expect((await typeWithReadback(hanging as never, IOS_SIM, "hi", type)).readback).toBe(
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

describe("holdsTyped", () => {
  it("accepts smart punctuation: curly apostrophes and quotes, a dash for two hyphens", () => {
    expect(holdsTyped("it's O'Brien", "it’s O’Brien")).toBe(true);
    expect(holdsTyped('"hi"', "“hi”")).toBe(true);
    expect(holdsTyped("'hi'", "‘hi’")).toBe(true);
    expect(holdsTyped("a -- b", "a – b")).toBe(true);
  });

  it("accepts smart punctuation and a capital together", () => {
    expect(holdsTyped("don't go", "Don’t go")).toBe(true);
  });

  it("rejects what a held Shift or a dropped key leaves", () => {
    expect(holdsTyped("don't", 'don"t')).toBe(false);
    expect(holdsTyped("a--b", "a-b")).toBe(false);
    expect(holdsTyped("a-b", "a—b")).toBe(false);
    expect(holdsTyped("a--b", "a__b")).toBe(false);
  });
});

describe("capitalizedByIos", () => {
  it("accepts capitals at the start of sentences and words", () => {
    expect(capitalizedByIos("hello world", "Hello world")).toBe(true);
    expect(capitalizedByIos("hi. there", "Hi. There")).toBe(true);
    expect(capitalizedByIos("new york", "New York")).toBe(true);
    expect(capitalizedByIos('say "yes"', 'Say "Yes"')).toBe(true);
  });

  it("rejects the same text, which is no capitalization", () => {
    expect(capitalizedByIos("hello", "hello")).toBe(false);
  });

  it("rejects capitals inside a word, as a held Shift leaves them", () => {
    expect(capitalizedByIos("general", "GENERAL")).toBe(false);
    expect(capitalizedByIos("xyz", "xYZ")).toBe(false);
  });

  it("rejects a dropped, repeated or changed key", () => {
    expect(capitalizedByIos("hello", "Helo")).toBe(false);
    expect(capitalizedByIos("hello", "Helllo")).toBe(false);
    expect(capitalizedByIos("hello", "Jello")).toBe(false);
    expect(capitalizedByIos("Hello", "hello")).toBe(false);
    expect(capitalizedByIos("1abc", "!abc")).toBe(false);
  });
});

describe("typeSimulatorServer on a failed press", () => {
  // Releasing a key still down is the socket's job: it writes the Up behind
  // the unanswered Down, where a new socket could not
  // (test/simulator-command-ack.test.ts).
  it("stops at the failed press and sends no further keys", async () => {
    const sent: Array<[string, number]> = [];
    const api = {
      pressKey: async (direction: string, code: number) => {
        sent.push([direction, code]);
        if (direction === "Down" && code !== SHIFT_KEYCODE) throw new Error("no ack");
      },
    };

    await expect(
      typeSimulatorServer(registryWith(api), IOS_SIM, { udid: IOS_SIM.id, text: "Ab" })
    ).rejects.toThrow("no ack");

    expect(sent).toEqual([
      ["Down", SHIFT_KEYCODE],
      ["Down", sent[1]![1]],
    ]);
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
