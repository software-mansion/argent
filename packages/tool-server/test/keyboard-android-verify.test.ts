import { describe, it, expect, beforeEach, vi } from "vitest";
import type { DeviceInfo, Registry } from "@argent/registry";

const { adbShell, isAndroidTv } = vi.hoisted(() => ({
  adbShell: vi.fn(async (_serial: string, _cmd: string, _opts?: unknown): Promise<string> => ""),
  isAndroidTv: vi.fn(async (_serial: string): Promise<boolean> => false),
}));
vi.mock("../src/utils/adb", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/adb")>()),
  adbShell,
  isAndroidTv,
}));

import {
  classifyTypedText,
  findFocusedTextField,
  __resetHelperAvailabilityForTests,
} from "../src/tools/keyboard/platforms/android-verify";
import { makeAndroidImpl } from "../src/tools/keyboard/platforms/android";
import { createKeyboardTool } from "../src/tools/keyboard";
import type { KeyboardParams, KeyboardResult } from "../src/tools/keyboard/types";

const SERIAL = "emulator-5554";
const PHONE = { id: SERIAL, platform: "android", kind: "handset" } as unknown as DeviceInfo;
const FIELD_RID = "com.example:id/search";

// Shaped like an android-devtools dump of the API 34 Settings search box.
function hierarchy(
  opts: {
    text?: string;
    cls?: string;
    focused?: boolean;
    password?: boolean;
    rid?: string;
    bounds?: string;
    /** A second focused field in the same window. */
    alsoFocused?: { text?: string; rid?: string; bounds?: string };
    /** A second window holding a field, focused unless `focused: false`. */
    secondWindow?: { text?: string; rid?: string; bounds?: string; focused?: boolean };
  } = {}
): string {
  const {
    text = "",
    cls = "android.widget.EditText",
    focused = true,
    password = false,
    rid = FIELD_RID,
    bounds = "[126,149][1080,275]",
    alsoFocused,
    secondWindow,
  } = opts;
  const field = (t: string, r: string, b: string, pw: boolean, isFocused = focused) =>
    `<node index="0" text="${t}" resource-id="${r}" class="${cls}" package="com.example" ` +
    `content-desc="" checkable="false" checked="false" clickable="true" enabled="true" ` +
    `focusable="true" focused="${isFocused}" scrollable="false" long-clickable="true" ` +
    `password="${pw}" selected="false" bounds="${b}" />`;
  const window = (index: number, inner: string) =>
    `<node index="${index}" text="" resource-id="" class="android.widget.FrameLayout" ` +
    `package="com.example" content-desc="" focusable="false" focused="false" ` +
    `password="false" bounds="[0,0][1080,2400]">${inner}</node>`;
  return (
    `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0">` +
    window(
      0,
      field(text, rid, bounds, password) +
        (alsoFocused
          ? field(
              alsoFocused.text ?? "",
              alsoFocused.rid ?? "",
              alsoFocused.bounds ?? "[126,900][1080,1000]",
              false
            )
          : "")
    ) +
    (secondWindow
      ? window(
          1,
          field(
            secondWindow.text ?? "",
            secondWindow.rid ?? "",
            secondWindow.bounds ?? "[126,1400][1080,1526]",
            false,
            secondWindow.focused ?? focused
          )
        )
      : "") +
    `</hierarchy>`
  );
}

/** A registry whose android-devtools helper serves one scripted hierarchy per read. */
function registryServing(reads: (string | Error)[]): {
  registry: Registry;
  getHierarchy: ReturnType<typeof vi.fn>;
  resolveService: ReturnType<typeof vi.fn>;
} {
  const queue = [...reads];
  const getHierarchy = vi.fn(async (_opts?: unknown) => {
    const next = queue.shift();
    if (next === undefined) throw new Error("test: getHierarchy called more times than scripted");
    if (next instanceof Error) throw next;
    return { xml: next, captureMode: "interactive-windows", windowCount: 3, nodeCount: 2 };
  });
  const resolveService = vi.fn(async () => ({ getHierarchy }));
  return { registry: { resolveService } as unknown as Registry, getHierarchy, resolveService };
}

function type(registry: Registry, text: string): Promise<KeyboardResult> {
  return makeAndroidImpl(registry).handler({}, { udid: SERIAL, text } as KeyboardParams, PHONE);
}

const cmds = () => adbShell.mock.calls.map((c) => c[1]);

beforeEach(() => {
  adbShell.mockClear();
  adbShell.mockResolvedValue("");
  isAndroidTv.mockReset();
  isAndroidTv.mockResolvedValue(false);
  __resetHelperAvailabilityForTests();
});

describe("classifyTypedText", () => {
  it.each([
    ["an empty field", "", "abc", "abc"],
    ["an empty field reporting its hint", "Search settings", "display", "display"],
    ["an insertion mid-field", "ab", "aXYb", "XY"],
    ["an append", "XY", "XYabc", "abc"],
    ["a select-all replaced", "old value", "new", "new"],
  ])("accepts %s", (_name, before, after, text) => {
    expect(classifyTypedText(before, after, text)).toBe("landed");
  });

  it.each([
    ["dropped leading characters (#562)", "Search settings", "splay", "display"],
    ["a dropped middle character", "", "abcefgh", "abcdefgh"],
    ["a doubled injection", "", "abcabc", "abc"],
    ["residue that contains the text", "abc", "abcac", "abc"],
    ["a right-length field without the text", "", "abd", "abc"],
    ["a doubled injection into a field already holding the text", "abc", "abcabcabc", "abc"],
    ["the text where no selection could have put it", "kab", "kXab", "ab"],
  ])("rejects %s", (_name, before, after, text) => {
    expect(classifyTypedText(before, after, text)).toBe("not-landed");
  });

  it.each([
    ["an unchanged field already holding the text", "argent", "argent", "argent"],
    ["a selection replaced by the whole text", "aa bb", "aaa bb", "aaa"],
    ["a field that reformats its input", "Phone", "(555) 123-4567", "5551234567"],
    ["prior content that is an edge of the text", "abc", "abcdef", "abcdef"],
  ])("cannot decide %s", (_name, before, after, text) => {
    expect(classifyTypedText(before, after, text)).toBe("indeterminate");
  });
});

describe("findFocusedTextField", () => {
  it("returns the focused field", () => {
    expect(findFocusedTextField(hierarchy({ text: "hello" }))).toEqual({
      text: "hello",
      resourceId: FIELD_RID,
      className: "android.widget.EditText",
      bounds: { x: 126, y: 149, w: 954, h: 126 },
    });
  });

  it("matches EditText subclasses whose name lacks `EditText`", () => {
    const xml = hierarchy({ cls: "android.widget.SearchView$SearchAutoComplete", text: "q" });
    expect(findFocusedTextField(xml)).toMatchObject({ text: "q" });
  });

  it.each([
    ["nothing is focused", hierarchy({ focused: false }), "no focused text field was found."],
    [
      "the focused view is not a text field",
      hierarchy({ cls: "android.widget.Button" }),
      "no focused text field was found.",
    ],
    ["the field masks its input", hierarchy({ password: true }), "the field masks its input."],
    [
      "two windows have a focused field",
      hierarchy({ secondWindow: {} }),
      "more than one window has a focused text field.",
    ],
  ])("gives a reason when %s", (_name, xml, reason) => {
    expect(findFocusedTextField(xml)).toBe(reason);
  });

  it("takes the first of two focused fields in one window", () => {
    const xml = hierarchy({ text: "first", alsoFocused: { text: "second" } });
    expect(findFocusedTextField(xml)).toMatchObject({ text: "first" });
  });

  it("ignores an unfocused second window", () => {
    expect(
      findFocusedTextField(hierarchy({ text: "a", secondWindow: { focused: false } }))
    ).toMatchObject({
      text: "a",
    });
  });
});

describe("android keyboard read-back", () => {
  it("reports verified:true when the text lands, typing it once", async () => {
    const { registry, getHierarchy } = registryServing([
      hierarchy({ text: "Search settings" }),
      hierarchy({ text: "display" }),
    ]);
    await expect(type(registry, "display")).resolves.toEqual({
      typed: "display",
      keys: 7,
      verified: true,
    });
    expect(cmds()).toEqual(["input text 'display'"]);
    for (const [opts] of getHierarchy.mock.calls) expect(opts).toMatchObject({ clearCache: true });
    const [beforeRead, afterRead] = getHierarchy.mock.invocationCallOrder;
    const [inject] = adbShell.mock.invocationCallOrder;
    expect([beforeRead! < inject!, inject! < afterRead!]).toEqual([true, true]);
  });

  it("reports verified:false with counts, never the field's text, when characters drop", async () => {
    const { registry } = registryServing([
      hierarchy({ text: "Search settings" }),
      hierarchy({ text: "splay" }),
    ]);
    const res = await type(registry, "display");
    expect(res.verified).toBe(false);
    expect(res.note).toBe(
      "7 characters were typed and the field holds 5 in total, counting " +
        "any earlier content or hint. The field dropped part of the key-event burst, or it " +
        "rejected or reformatted the input."
    );
    expect(res.note).not.toContain("splay");
    expect(cmds()).toEqual(["input text 'display'"]);
  });

  it("leaves verified absent for a reading that fits both outcomes", async () => {
    const { registry } = registryServing([
      hierarchy({ text: "Phone" }),
      hierarchy({ text: "(555) 123-4567" }),
    ]);
    const res = await type(registry, "5551234567");
    expect(res.verified).toBeUndefined();
    expect(res.note).toMatch(/fit both a full and a partial landing/);
  });

  it.each([
    ["nothing is focused", [hierarchy({ focused: false })], /no focused text field/],
    ["the field masks its input", [hierarchy({ password: true })], /masks its input/],
    ["the first read fails", [new Error("socket closed")], /reading the field back failed/],
    [
      "the second read fails",
      [hierarchy({ text: "" }), new Error("socket closed")],
      /reading the field back failed/,
    ],
    [
      "focus moved to another field",
      [hierarchy({ text: "" }), hierarchy({ text: "1", rid: "com.example:id/next" })],
      /focus moved to another field/,
    ],
    [
      "a same-id field moved clear of the first",
      [hierarchy({ text: "" }), hierarchy({ text: "1", bounds: "[126,900][1080,1000]" })],
      /focus moved to another field/,
    ],
  ])("types once and leaves verified absent when %s", async (_name, reads, note) => {
    const { registry } = registryServing(reads);
    const res = await type(registry, "123");
    expect(res.verified).toBeUndefined();
    expect(res.note).toMatch(note);
    expect(cmds()).toEqual(["input text '123'"]);
  });

  it("matches a zero-area field to itself after it resizes", async () => {
    const { registry } = registryServing([
      hierarchy({ text: "", rid: "", bounds: "[540,1200][540,1200]" }),
      hierarchy({ text: "abc", rid: "", bounds: "[540,1200][560,1200]" }),
    ]);
    await expect(type(registry, "abc")).resolves.toMatchObject({ verified: true });
  });

  it("types unverified without retrying the helper for a minute after it fails", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    const resolveService = vi.fn(async () => {
      throw new Error("adb install -t refused");
    });
    const registry = { resolveService } as unknown as Registry;

    const first = await type(registry, "ab");
    expect(first.verified).toBeUndefined();
    expect(first.note).toMatch(/android-devtools helper is unavailable/);
    await type(registry, "ab");
    expect(resolveService).toHaveBeenCalledTimes(1);
    now.mockReturnValue(1_060_000);
    await type(registry, "ab");
    expect(resolveService).toHaveBeenCalledTimes(2);
    expect(cmds()).toEqual(["input text 'ab'", "input text 'ab'", "input text 'ab'"]);
    now.mockRestore();
  });

  it("does not read back a named key", async () => {
    const { registry, resolveService } = registryServing([]);
    const res = await makeAndroidImpl(registry).handler(
      {},
      { udid: SERIAL, key: "enter" } as KeyboardParams,
      PHONE
    );
    expect(res).toEqual({ typed: "enter", keys: 1 });
    expect(resolveService).not.toHaveBeenCalled();
  });

  it("is declared longRunning, so the MCP adapter does not replay a slow call", () => {
    expect(createKeyboardTool({} as Registry).longRunning).toBe(true);
  });
});
