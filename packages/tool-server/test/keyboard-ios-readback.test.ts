import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeviceInfo } from "@argent/registry";
import type { AXTreeNode } from "../src/blueprints/ax-service";
import {
  capitalizedByIos,
  READBACK_MISMATCH_WARNING,
  READBACK_TIMING,
  spreadAcrossInputs,
  typeWithReadback,
} from "../src/tools/keyboard/ios-readback";
import { SHIFT_KEYCODE } from "../src/tools/keyboard/key-codes";
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
  Object.assign(READBACK_TIMING, { resolveMs: 50, precheckMs: 50, checkMs: 300, treeMs: 50 });
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

  // The daemon answers "no" only after its own wait for the text runs out,
  // so the check after typing has to outlast that wait to see the mismatch.
  it("warns when the mismatch answer comes back late", async () => {
    let typed = false;
    const { api } = fakeAx(async (text) => {
      if (text === "") return { focused: true, verified: !typed };
      await new Promise((r) => setTimeout(r, 120));
      return { focused: true, verified: false };
    });

    const out = await typeWithReadback(registryWith(api), IOS_SIM, "general", async () => {
      typed = true;
      return { typed: "general", keys: 7 };
    });

    expect(out.readback).toEqual({ verified: false, warning: READBACK_MISMATCH_WARNING });
  });

  it("checks the field once after typing", async () => {
    let typed = false;
    const { api, fill } = fakeAx((text) => ({
      focused: true,
      verified: text === "" ? !typed : typed,
    }));

    await typeWithReadback(registryWith(api), IOS_SIM, "hi", async () => {
      typed = true;
      return { typed: "hi", keys: 2 };
    });

    expect(fill.mock.calls.map((c) => c[0])).toEqual(["", "hi"]);
  });

  // A field that holds text answers the empty check only after the daemon's
  // wait: appending must not pay for that.
  it("gives up on a slow empty-field check and types unchecked", async () => {
    const { api, fill } = fakeAx(async () => {
      await new Promise((r) => setTimeout(r, 1_000));
      return { focused: true, verified: false };
    });
    const type = vi.fn(async () => ({ typed: "xyz", keys: 3 }));

    const started = Date.now();
    const out = await typeWithReadback(registryWith(api), IOS_SIM, "xyz", type);

    expect(out.readback).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(500);
    expect(type).toHaveBeenCalledTimes(1);
    expect(fill).toHaveBeenCalledTimes(1);
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

  // A code screen moves focus to the next box after each digit, so the
  // check after typing reads the last box only.
  describe("on a screen that moves focus from box to box", () => {
    const box = (value: string, elementType = 49) =>
      value
        ? { index: 0, elementType, value }
        : { index: 0, elementType, value: "", hintShowing: true };

    async function typeIntoBoxes(boxes: AXTreeNode[]) {
      let typed = false;
      const { api } = fakeAx((text) => ({ focused: true, verified: text === "" && !typed }));
      const tree = vi.fn(async () => ({ alertVisible: false, nodes: boxes, truncated: false }));
      const out = await typeWithReadback(
        registryWith({ ...api, tree }),
        IOS_SIM,
        "12",
        async () => {
          typed = true;
          return { typed: "12", keys: 2 };
        }
      );
      return { out, tree };
    }

    it("says nothing when the boxes hold the text between them", async () => {
      const { out, tree } = await typeIntoBoxes([box("1"), box("2"), box("")]);
      expect(out.readback).toBeUndefined();
      expect(tree).toHaveBeenCalledTimes(1);
    });

    it("still warns when the boxes do not add up to the text", async () => {
      const { out } = await typeIntoBoxes([box("1"), box("3"), box("")]);
      expect(out.readback).toEqual({ verified: false, warning: READBACK_MISMATCH_WARNING });
    });
  });

  // The tree shows the focused field's text, so it answers before the check,
  // whose "no" waits out the daemon's 1 s.
  describe("reading the focused field in the tree", () => {
    const field = (value: string, extra: Partial<AXTreeNode> = {}): AXTreeNode => ({
      index: 0,
      elementType: 49,
      value,
      traits: ["isEditing"],
      ...extra,
    });

    /** Types `text`; the tree answers from `trees`, one per read, the last one repeating. */
    async function typeWithTree(text: string, trees: AXTreeNode[][], checkSays = false) {
      let typed = false;
      const { api, fill } = fakeAx((asked) => ({
        focused: true,
        verified: asked === "" ? !typed : checkSays,
      }));
      let reads = 0;
      const tree = vi.fn(async () => ({
        alertVisible: false,
        nodes: trees[Math.min(reads++, trees.length - 1)]!,
        truncated: false,
      }));
      const out = await typeWithReadback(
        registryWith({ ...api, tree }),
        IOS_SIM,
        text,
        async () => {
          typed = true;
          return { typed: text, keys: text.length };
        }
      );
      return { out, fill, tree };
    }

    it("verifies a capital iOS put at the start of a sentence, without the slow check", async () => {
      const { out, fill } = await typeWithTree("hello world", [[field("Hello world")]]);
      expect(out.readback).toEqual({ verified: true });
      // Only the empty-field check before typing.
      expect(fill.mock.calls.map((c) => c[0])).toEqual([""]);
    });

    it("verifies the exact text from the tree as well", async () => {
      const { out, fill } = await typeWithTree("hello", [[field("hello")]]);
      expect(out.readback).toEqual({ verified: true });
      expect(fill).toHaveBeenCalledTimes(1);
    });

    it("warns for a field that capitalizes every letter: that reads like a held Shift", async () => {
      const { out } = await typeWithTree("general", [[field("GENERAL")]]);
      expect(out.readback).toEqual({ verified: false, warning: READBACK_MISMATCH_WARNING });
    });

    it("leaves a field the app has not caught up with to the check", async () => {
      const { out, fill } = await typeWithTree("hello", [[field("hel")]], true);
      expect(out.readback).toEqual({ verified: true });
      expect(fill.mock.calls.map((c) => c[0])).toEqual(["", "hello"]);
    });

    it("reads the tree again after the check's wait, for an app that capitalizes late", async () => {
      const { out, tree } = await typeWithTree("hello", [[field("hel")], [field("Hello")]]);
      expect(out.readback).toEqual({ verified: true });
      expect(tree).toHaveBeenCalledTimes(2);
    });

    it("leaves a secure field, which shows bullets, to the check", async () => {
      const { out, fill } = await typeWithTree("s3cret", [[field("••••••", { elementType: 50 })]]);
      expect(out.readback).toEqual({ verified: false, warning: READBACK_MISMATCH_WARNING });
      expect(fill).toHaveBeenCalledTimes(2);
    });

    it("ignores a field that is not the focused one", async () => {
      const { out } = await typeWithTree("hello", [[field("Hello", { traits: [] })]]);
      expect(out.readback).toEqual({ verified: false, warning: READBACK_MISMATCH_WARNING });
    });
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

describe("spreadAcrossInputs", () => {
  const node = (elementType: number, value = "", extra: Partial<AXTreeNode> = {}): AXTreeNode => ({
    index: 0,
    elementType,
    value,
    ...extra,
  });

  it("finds the text in boxes that follow one another, past other elements", () => {
    const nodes = [
      node(48, "Enter the code"),
      node(49, "4"),
      node(1),
      node(49, "2"),
      node(49, "7"),
    ];
    expect(spreadAcrossInputs(nodes, "427")).toBe(true);
    expect(spreadAcrossInputs(nodes, "27")).toBe(true);
  });

  it("needs two inputs: one input holding the text is the check's job", () => {
    expect(spreadAcrossInputs([node(49, "12")], "12")).toBe(false);
  });

  it("does not match across an empty box or a wrong part", () => {
    expect(spreadAcrossInputs([node(49, "1"), node(49, ""), node(49, "2")], "12")).toBe(false);
    expect(spreadAcrossInputs([node(49, "1"), node(49, "3")], "12")).toBe(false);
    expect(spreadAcrossInputs([node(49, "1"), node(49, "23")], "12")).toBe(false);
  });

  it("reads a placeholder as empty and a secure box by its length", () => {
    const placeholder = node(49, "0", { hintShowing: true });
    expect(spreadAcrossInputs([node(49, "1"), placeholder], "10")).toBe(false);
    expect(spreadAcrossInputs([node(50, "•"), node(50, "•")], "12")).toBe(true);
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
