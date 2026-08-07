import { describe, it, expect, beforeEach, vi } from "vitest";
import type { DeviceInfo, Registry } from "@argent/registry";

// Capture the adb command strings instead of shelling out. Keep `shellQuote` real
// (android-input relies on it) and stub only the transport plus the `isAndroidTv`
// probe, so the phone branch is deterministic. Mirrors keyboard-android.test.ts.
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
  plannedUndoDeletions,
} from "../src/tools/keyboard/platforms/android-verify";
import { makeAndroidImpl } from "../src/tools/keyboard/platforms/android";
import { createKeyboardTool } from "../src/tools/keyboard";
import { injectAndroidKeycodeRepeated } from "../src/utils/android-input";
import type { KeyboardParams, KeyboardResult } from "../src/tools/keyboard/types";

const SERIAL = "emulator-5554";
const PHONE = { id: SERIAL, platform: "android", kind: "handset" } as unknown as DeviceInfo;
const FIELD_RID = "com.example:id/search";

// A uiautomator-schema hierarchy holding one focused view, shaped like the real
// android-devtools dump (attribute names and order taken from a Pixel 6 / API 34
// capture of the Settings search box).
function hierarchy(
  opts: {
    text?: string;
    cls?: string;
    focused?: boolean;
    password?: boolean;
    rid?: string;
    bounds?: string;
    /** A SECOND focused editable node, listed after the first in document order. */
    alsoFocused?: { text?: string; rid?: string; bounds?: string };
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
  } = opts;
  const field = (t: string, r: string, b: string, pw: boolean) =>
    `<node index="0" text="${t}" resource-id="${r}" class="${cls}" package="com.example" ` +
    `content-desc="" checkable="false" checked="false" clickable="true" enabled="true" ` +
    `focusable="true" focused="${focused}" scrollable="false" long-clickable="true" ` +
    `password="${pw}" selected="false" bounds="${b}" />`;
  return (
    `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0">` +
    `<node index="0" text="" resource-id="" class="android.widget.FrameLayout" ` +
    `package="com.example" content-desc="" focusable="false" focused="false" ` +
    `password="false" bounds="[0,0][1080,2400]">` +
    field(text, rid, bounds, password) +
    (alsoFocused
      ? field(
          alsoFocused.text ?? "",
          alsoFocused.rid ?? "",
          alsoFocused.bounds ?? "[126,900][1080,1000]",
          false
        )
      : "") +
    `</node></hierarchy>`
  );
}

/**
 * A registry whose android-devtools service serves a scripted sequence of
 * hierarchies — one per `getHierarchy` call — so a corrupted read-back can be
 * injected at a chosen point in the type/verify/repair sequence.
 */
function registryServing(xmls: string[]): {
  registry: Registry;
  getHierarchy: ReturnType<typeof vi.fn>;
} {
  const queue = [...xmls];
  const getHierarchy = vi.fn(async (_opts?: unknown) => {
    const xml = queue.shift();
    if (xml === undefined) throw new Error("test: getHierarchy called more times than scripted");
    return { xml, captureMode: "active-window", windowCount: 1, nodeCount: 2, elapsedMs: 1 };
  });
  return {
    registry: { resolveService: vi.fn(async () => ({ getHierarchy })) } as unknown as Registry,
    getHierarchy,
  };
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
});

describe("findFocusedTextField", () => {
  it("returns the focused editable field's text, identity attributes and password flag", () => {
    const field = findFocusedTextField(hierarchy({ text: "hello" }));
    expect(field).toEqual({
      text: "hello",
      resourceId: FIELD_RID,
      className: "android.widget.EditText",
      origin: "126,149",
      password: false,
    });
  });

  it("returns null when the focused view is not editable (a focused Button)", () => {
    // A focused non-editable view receives no characters from `input text`, so
    // treating it as "the field" would compare against something the injection
    // never touched and report a bogus mismatch.
    expect(findFocusedTextField(hierarchy({ cls: "android.widget.Button" }))).toBeNull();
  });

  it("returns null when nothing holds input focus", () => {
    expect(findFocusedTextField(hierarchy({ focused: false }))).toBeNull();
  });

  it("recognises the EditText subclasses whose name lacks `EditText`", () => {
    // AutoCompleteTextView and SearchView$SearchAutoComplete extend EditText and
    // take typed characters, but a bare /EditText/ probe misses both — which
    // would silently disable verification on any search box built from them.
    for (const cls of [
      "android.widget.AutoCompleteTextView",
      "android.widget.SearchView$SearchAutoComplete",
    ]) {
      expect(findFocusedTextField(hierarchy({ cls, text: "q" }))?.text, cls).toBe("q");
    }
  });

  it("reports a password field so the caller can decline to verify it", () => {
    expect(findFocusedTextField(hierarchy({ password: true }))?.password).toBe(true);
  });

  it("returns null for unparseable output rather than throwing", () => {
    expect(findFocusedTextField("")).toBeNull();
  });
});

describe("classifyTypedText", () => {
  it("accepts an insertion into existing content at any cursor position", () => {
    expect(classifyTypedText("XY", "XYabc", "abc")).toBe("landed"); // cursor at end
    expect(classifyTypedText("XY", "abcXY", "abc")).toBe("landed"); // cursor at start
    expect(classifyTypedText("XY", "XabcY", "abc")).toBe("landed"); // cursor in the middle
  });

  it("rejects a dropped character (the reported bug)", () => {
    // The corruption QA reported, shortened: characters missing from the middle.
    expect(classifyTypedText("", "abdef", "abcdef")).toBe("not-landed");
    expect(classifyTypedText("XY", "XYabdef", "abcdef")).toBe("not-landed");
  });

  it("rejects a right-length field whose content is not the text, contiguously", () => {
    // The length check alone cannot catch this: an input mask (a phone-number or
    // card field) swallowed characters and inserted its own separators, so the
    // field grew by exactly text.length while holding something else. Only the
    // contiguous-substring half rejects it.
    expect(classifyTypedText("", "ab-cd-", "abcdef")).toBe("not-landed");
    expect(classifyTypedText("XY", "XYab-cd-", "abcdef")).toBe("not-landed");
    // Same length, right characters, wrong order — a substring check is not a
    // character-set check.
    expect(classifyTypedText("", "fedcba", "abcdef")).toBe("not-landed");
  });

  it("rejects a doubled injection", () => {
    // Present as a contiguous substring, but the field grew by twice the text.
    expect(classifyTypedText("", "abcabc", "abc")).toBe("not-landed");
  });

  it("accepts a replaced field, so an empty field reporting its hint verifies", () => {
    // An empty EditText reports its HINT as `text` (confirmed on API 34: the
    // empty Settings search box reads "Search settings"), so the length
    // arithmetic cannot apply to the most common case of all. The hint shares no
    // prefix or suffix with the typed text, which is what makes this decidable.
    expect(classifyTypedText("Search settings", "abc", "abc")).toBe("landed");
  });

  it("refuses to decide when the field did not change but already matched", () => {
    // A `selectAllOnFocus` field already reading "abc": typing "abc" into it
    // succeeds and changes nothing, and typing "abc" and having every key event
    // dropped also changes nothing. Calling this a failure and retyping is what
    // enters the text TWICE, so it must be neither "landed" nor "not-landed".
    expect(classifyTypedText("abc", "abc", "abc")).toBe("indeterminate");
    // Same shape when the hint happens to equal the text.
    expect(classifyTypedText("Search settings", "Search settings", "Search settings")).toBe(
      "indeterminate"
    );
    // The case ONLY this clause covers: unchanged, contains the text, but is not
    // exactly the text — "abc" was the selection inside "xabcx" and was replaced
    // by an identical "abc". The exact-match clause cannot see this one.
    expect(classifyTypedText("xabcx", "xabcx", "abc")).toBe("indeterminate");
  });

  it("refuses to decide when the field reads as the text but its old value survived", () => {
    // "abc" + a correct replacement by "abcdef" is byte-identical to "abc" plus a
    // partial landing of just "def" out of "abcdef". Treating it as success hides
    // a 3-character loss; treating it as failure retypes over a correct field.
    expect(classifyTypedText("abc", "abcdef", "abcdef")).toBe("indeterminate");
    expect(classifyTypedText("def", "abcdef", "abcdef")).toBe("indeterminate");
  });

  it("still decides `landed` when the field is empty and the text arrived whole", () => {
    // The empty-and-no-hint baseline: nothing survived because there was nothing.
    expect(classifyTypedText("", "abcdef", "abcdef")).toBe("landed");
  });
});

describe("plannedUndoDeletions", () => {
  it("counts the observed growth when the prior content survived (plan A)", () => {
    // 8 of 12 characters landed after "XY": deleting 8 restores "XY" exactly.
    expect(plannedUndoDeletions("XY", "XYabcdefgh", "abcdefghijkl")).toBe(8);
  });

  it("refuses to delete when the baseline is equally a prior character and a hint", () => {
    // Both proofs apply and they disagree: if "a" was really in the field, 8
    // characters are ours; if "a" was the hint of an empty field, 9 are. Acting
    // on either reading is a coin flip with the user's content, and taking the
    // smaller count is the worse half — it leaves the hint text behind as real
    // content, the retype appends to it, and the doubled result is shaped to
    // satisfy classifyTypedText's first branch (see the end-to-end test below).
    expect(plannedUndoDeletions("a", "abcdefghi", "abcdefghijkl")).toBeNull();
  });

  it("still counts the growth when the field cannot have been empty", () => {
    // "XY" is not a subsequence of the typed text, so the hint reading is ruled
    // out and plan A is the only live one. This is what keeps the overlap guard
    // from disabling the undo wherever the prior content is real.
    expect(plannedUndoDeletions("XY", "XYabcdefgh", "abcdefghijkl")).toBe(8);
  });

  it("empties the field when everything in it came from this injection (plan B)", () => {
    // Baseline was the hint, so it shares no prefix or suffix with the typed
    // text and plan A cannot apply; the field holds only a subsequence of what
    // we typed, which proves it was empty before.
    expect(plannedUndoDeletions("Search settings", "abcdefgh", "abcdefghijkl")).toBe(8);
  });

  it("refuses the hint overlaps that make the undo double the value", () => {
    // Each pair is an empty field whose hint shares an edge with the typed text,
    // and a first burst that dropped characters. Plan A reads the hint as prior
    // content and under-deletes by exactly its length, so the retype lands on
    // top of it. These are the real-world shapes: a URL bar, a phone field, a
    // quantity box.
    expect(plannedUndoDeletions("https://", "https://exam", "https://example.com")).toBeNull();
    expect(plannedUndoDeletions("+48", "+48501", "+48501234567")).toBeNull();
    expect(plannedUndoDeletions("0", "10", "100")).toBeNull();
  });

  it("recognises scattered drops as this injection's own output", () => {
    // Dropped key events delete characters without reordering or inventing any,
    // so real corruption is always a subsequence of the input.
    const text = "The quick brown fox jumps over the lazy dog.";
    const corrupted = "The quicbrown fox jmpover the lazy dog";
    expect(plannedUndoDeletions("Search", corrupted, text)).toBe(corrupted.length);
  });

  it("refuses to delete when the field shrank", () => {
    // Something other than our injection changed the field; a deletion count
    // derived from it would eat real content.
    expect(plannedUndoDeletions("abcdef", "abc", "xyz")).toBeNull();
  });

  it("refuses to delete when the change is not one inserted block", () => {
    // An input mask or autocorrect rewrote the field. The prior content is not
    // recoverable by backspacing, so the field is left exactly as it is.
    expect(plannedUndoDeletions("12345", "1-2-3-45xyz", "xyz")).toBeNull();
  });

  it("refuses to delete more characters than the call asked to type", () => {
    // The field grew by more than we typed, so something else wrote into it too.
    expect(plannedUndoDeletions("", "abcdefghijkl", "abc")).toBeNull();
  });
});

describe("injectAndroidKeycodeRepeated", () => {
  it("presses the keycode `count` times in ONE adb call", async () => {
    adbShell.mockClear();
    await injectAndroidKeycodeRepeated(SERIAL, 67, 3);
    expect(cmds()).toEqual(["input keyevent 67 67 67"]);
  });

  it("is a no-op for a non-positive count (never a bare `input keyevent`)", async () => {
    adbShell.mockClear();
    await injectAndroidKeycodeRepeated(SERIAL, 67, 0);
    await injectAndroidKeycodeRepeated(SERIAL, 67, -1);
    expect(adbShell).not.toHaveBeenCalled();
  });
});

describe("android keyboard read-back — verified success", () => {
  it("reports verified:true with no note when the text lands, typing it once", async () => {
    const { registry } = registryServing([
      hierarchy({ text: "Search settings" }), // before: empty field showing its hint
      hierarchy({ text: "abcdefghijkl" }), // after: exactly what we typed
    ]);
    const res = await type(registry, "abcdefghijkl");
    expect(res).toEqual({ typed: "abcdefghijkl", keys: 12, verified: true });
    // One `input text`: verification must not change the injection on the happy path.
    expect(cmds()).toEqual(["input text 'abcdefghijkl'"]);
  });

  it("reads the hierarchy with clearCache:true on every read", async () => {
    // The helper's long-lived UiAutomation connection serves stale
    // AccessibilityNodeInfo text. Without clearCache the "after" read can return
    // the pre-typing value, which would make every verdict here meaningless.
    const { registry, getHierarchy } = registryServing([
      hierarchy({ text: "" }),
      hierarchy({ text: "abc" }),
    ]);
    await type(registry, "abc");
    expect(getHierarchy).toHaveBeenCalledTimes(2);
    for (const call of getHierarchy.mock.calls) {
      expect(call[0]).toMatchObject({ clearCache: true });
    }
  });

  it("verifies an insertion into a field that already had content", async () => {
    const { registry } = registryServing([hierarchy({ text: "XY" }), hierarchy({ text: "XYabc" })]);
    await expect(type(registry, "abc")).resolves.toMatchObject({ verified: true });
  });
});

describe("android keyboard read-back — fault injection", () => {
  it("detects a dropped-character mismatch, repairs in chunks, and verifies", async () => {
    const { registry } = registryServing([
      hierarchy({ text: "XY" }), // before
      hierarchy({ text: "XYabcdefgh" }), // after: 8 of 12 chars landed
      hierarchy({ text: "XYabcdefghijkl" }), // after the chunked retype: correct
    ]);
    const res = await type(registry, "abcdefghijkl");
    expect(res).toEqual({ typed: "abcdefghijkl", keys: 12, verified: true });
    expect(cmds()).toEqual([
      "input text 'abcdefghijkl'", // the burst that dropped characters
      "input keyevent 67 67 67 67 67 67 67 67", // undo exactly the 8 that landed
      "input text 'abcdefgh'", // retype, 8 chars per call...
      "input text 'ijkl'", // ...at a slower cadence
    ]);
  });

  it("repairs an insertion in the MIDDLE of the field, not just at the end", async () => {
    // The cursor sat between "a" and "b" and one of three characters landed there.
    // The undo is still a backspace count, because backspace deletes at the cursor
    // and the cursor sits after whatever landed — verified on device (Pixel 6 /
    // API 34): with the cursor inside "ab", injecting "XY" yields "aXYb" and two
    // backspaces yield "ab". Nothing else here pins the mid-field case; a planner
    // that assumed the insertion was always a suffix would delete the wrong chars.
    const { registry } = registryServing([
      hierarchy({ text: "ab" }), // before
      hierarchy({ text: "aXb" }), // after: 1 of 3 chars landed, mid-field
      hierarchy({ text: "aabcb" }), // after the retype: "a" + "abc" + "b"
    ]);
    const res = await type(registry, "abc");
    expect(res).toEqual({ typed: "abc", keys: 3, verified: true });
    expect(cmds()).toEqual([
      "input text 'abc'",
      "input keyevent 67", // exactly the ONE character that landed
      "input text 'abc'",
    ]);
  });

  it("reports verified:false with a note when the repair does not fix it", async () => {
    const corrupt = hierarchy({ text: "XYabcdefgh" });
    const { registry } = registryServing([hierarchy({ text: "XY" }), corrupt, corrupt]);
    const res = await type(registry, "abcdefghijkl");
    expect(res.verified).toBe(false);
    expect(res.note).toMatch(/did NOT land/);
    // The counts must not imply an expected total. The field held "XY" before,
    // so 8 of the 12 landed and 4 were lost — but it reads 10, and "10 where 12
    // were expected" would tell the agent 2 were lost. Report what is known:
    // what was typed, and what the field holds in total.
    expect(res.note).toContain("12 characters were typed and the field now holds 10 in total");
    expect(res.note).not.toMatch(/where 12 (was|were) expected/);
    expect(res.note).toMatch(/smaller chunks did not fix it/);
    // The text is still reported as typed and counted — the call did type it.
    expect(res.typed).toBe("abcdefghijkl");
    expect(res.keys).toBe(12);
  });

  it("does not retype onto a hint it mistook for prior content", async () => {
    // The corrupting shape, end to end: an empty URL bar reads back its hint,
    // which opens the typed text. Reading that hint as prior content undercounts
    // the undo by its length, so the retype lands on top of the residue and the
    // field ends up holding "https://https://example.com" — and because that is
    // exactly `before + text`, the success branch calls it landed. The call must
    // touch the device once and report the failure instead.
    const { registry } = registryServing([
      hierarchy({ text: "https://" }), // empty field showing its hint
      hierarchy({ text: "https://exam" }), // first burst dropped the tail
    ]);

    const res = await type(registry, "https://example.com");

    expect(res.verified).toBe(false);
    expect(cmds()).toEqual(["input text 'https://example.com'"]);
    expect(cmds().some((c) => c.includes("keyevent"))).toBe(false);
  });

  it("empties a field whose whole content came from the failed injection", async () => {
    // The empty-field shape: baseline is the hint, so the undo has to delete
    // everything present rather than the length delta (which is negative here).
    const { registry } = registryServing([
      hierarchy({ text: "Search settings" }),
      hierarchy({ text: "abcdefgh" }),
      hierarchy({ text: "abcdefghijkl" }),
    ]);
    await expect(type(registry, "abcdefghijkl")).resolves.toMatchObject({ verified: true });
    expect(cmds()).toEqual([
      "input text 'abcdefghijkl'",
      "input keyevent 67 67 67 67 67 67 67 67",
      "input text 'abcdefgh'",
      "input text 'ijkl'",
    ]);
  });

  it("does not touch a field it cannot safely restore, and says so", async () => {
    // An input mask rewrote the field: the prior content is not recoverable by
    // backspacing, so destroying it to retry is not an option.
    const { registry } = registryServing([
      hierarchy({ text: "12345" }),
      hierarchy({ text: "1-2-3-45abc" }),
    ]);
    const res = await type(registry, "abcdefghijkl");
    expect(res.verified).toBe(false);
    expect(res.note).toMatch(/could not be safely restored/);
    // No backspaces, no retype — only the original injection reached the device.
    expect(cmds()).toEqual(["input text 'abcdefghijkl'"]);
  });

  it("caps the repair at one retry (two injection attempts total)", async () => {
    const corrupt = hierarchy({ text: "XYabcdefgh" });
    const { registry, getHierarchy } = registryServing([
      hierarchy({ text: "XY" }),
      corrupt,
      corrupt,
    ]);
    await type(registry, "abcdefghijkl");
    // 3 reads (before, after, after-repair) and no fourth — a scripted queue of
    // 3 throws if a further read is attempted.
    expect(getHierarchy).toHaveBeenCalledTimes(3);
    expect(cmds().filter((c) => c.startsWith("input keyevent"))).toHaveLength(1);
  });
});

describe("android keyboard read-back — cannot verify (never a silent success)", () => {
  it("types and reports the reason when the devtools helper is unavailable", async () => {
    const registry = {
      resolveService: vi.fn(async () => {
        throw new Error("adb install -t rejected");
      }),
    } as unknown as Registry;
    const res = await type(registry, "abc");
    expect(res.verified).toBeUndefined();
    expect(res.note).toMatch(/not verified against the screen/);
    expect(res.note).toMatch(/android-devtools helper could not be reached for this call/);
    // A resolve failure covers a blocked install AND a spawn that timed out, so
    // the note must not report the helper as permanently absent.
    expect(res.note).not.toMatch(/is not available on this device/);
    // The text is still typed — verification is a check on the typing, not a
    // precondition for it.
    expect(cmds()).toEqual(["input text 'abc'"]);
  });

  it("types and reports the reason when no editable field holds focus", async () => {
    const { registry } = registryServing([hierarchy({ focused: false })]);
    const res = await type(registry, "abc");
    expect(res.verified).toBeUndefined();
    expect(res.note).toMatch(/no editable field held input focus/);
    expect(cmds()).toEqual(["input text 'abc'"]);
  });

  it("types and reports the reason for a password field, whose text is masked", async () => {
    const { registry } = registryServing([hierarchy({ password: true })]);
    const res = await type(registry, "abc");
    expect(res.verified).toBeUndefined();
    expect(res.note).toMatch(/masks its input/);
    // The reason given has to be the one that holds: a masked field reads back
    // as bullets, so there is nothing to compare against. Claiming the dump
    // hands back the credential describes the opposite of what the helper does.
    expect(res.note).toMatch(/bullets/);
    expect(cmds()).toEqual(["input text 'abc'"]);
  });

  it("declines to compare when focus moved to a different field while typing", async () => {
    // Typing triggered navigation, so the baseline describes a field that is no
    // longer there: neither the comparison nor a deletion-based repair is valid.
    // The note must name the focus change, not a read failure — telling the agent
    // to hunt dropped characters would bury the actionable fact.
    const { registry } = registryServing([
      hierarchy({ text: "", rid: "com.example:id/first" }),
      hierarchy({ text: "abc", rid: "com.example:id/second" }),
    ]);
    const res = await type(registry, "abc");
    expect(res.verified).toBeUndefined();
    expect(res.note).toMatch(/no longer the one the text was typed into/);
    expect(cmds()).toEqual(["input text 'abc'"]);
  });

  it("detects a focus change between two fields that BOTH lack a resource-id", async () => {
    // An auto-advancing form (an OTP code across boxes, a field that jumps on
    // maxLength) moves focus mid-typing. Every untagged RN `TextInput` and Compose
    // `TextField` dumps `resource-id=""`, so identity on the id alone would call
    // these the same field, and the repair would then retype the whole string into
    // a field the caller never targeted, reporting verified.
    const { registry } = registryServing([
      hierarchy({ text: "", rid: "", bounds: "[126,149][1080,275]" }),
      hierarchy({ text: "", rid: "", bounds: "[126,400][1080,526]" }),
    ]);
    const res = await type(registry, "abcdefghijkl");
    expect(res.verified).toBeUndefined();
    expect(res.note).toMatch(/no longer the one the text was typed into/);
    // Nothing retyped, no backspaces — only the original injection.
    expect(cmds()).toEqual(["input text 'abcdefghijkl'"]);
  });

  it("does not mistake the SAME field for another when typing resizes it", async () => {
    // Typing into the Settings search box moved its right edge from 1080 to 933
    // with the origin unchanged (measured, API 34). Identity must survive that, or
    // every successful type on a field that grows reports a focus change.
    const { registry } = registryServing([
      hierarchy({ text: "Search settings", rid: "", bounds: "[126,149][1080,275]" }),
      hierarchy({ text: "abcdefghijkl", rid: "", bounds: "[126,149][933,275]" }),
    ]);
    await expect(type(registry, "abcdefghijkl")).resolves.toMatchObject({ verified: true });
  });

  it("does not mistake the SAME field for another when typing MOVES it", async () => {
    // A bottom-anchored chat composer grows upward as its text wraps to a second
    // line, so its bounds origin rises between the two reads while it is plainly
    // the same field. Position alone calls that a focus change and refuses to
    // verify; the `resource-id` is what survives it, and most composers have one.
    const { registry } = registryServing([
      hierarchy({ text: "Message", rid: FIELD_RID, bounds: "[126,2100][1080,2226]" }),
      hierarchy({ text: "abcdefghijkl", rid: FIELD_RID, bounds: "[126,1974][1080,2226]" }),
    ]);
    await expect(type(registry, "abcdefghijkl")).resolves.toMatchObject({ verified: true });
  });

  it("still calls it a focus change when the id itself differs, moved or not", async () => {
    // The id is only decisive when it MATCHES. Two ids that differ are two fields
    // however their bounds compare — an OTP form whose boxes share an origin
    // because only one is laid out at a time would otherwise read as one field.
    const { registry } = registryServing([
      hierarchy({ text: "", rid: "com.example:id/otp1", bounds: "[126,149][300,275]" }),
      hierarchy({ text: "abc", rid: "com.example:id/otp2", bounds: "[126,149][300,275]" }),
    ]);
    const res = await type(registry, "abc");
    expect(res.verified).toBeUndefined();
    expect(res.note).toMatch(/no longer the one the text was typed into/);
    expect(cmds()).toEqual(["input text 'abc'"]);
  });

  it("treats a field that gained or lost its id as a different field", async () => {
    // One side tagged and the other not is not a match to fall back to position
    // for: a real view's id does not appear or vanish, so the two reads are
    // looking at different views however their bounds line up.
    const { registry } = registryServing([
      hierarchy({ text: "", rid: "", bounds: "[126,149][1080,275]" }),
      hierarchy({ text: "abc", rid: FIELD_RID, bounds: "[126,149][1080,275]" }),
    ]);
    const res = await type(registry, "abc");
    expect(res.verified).toBeUndefined();
    expect(res.note).toMatch(/no longer the one the text was typed into/);
  });

  it("reports the ambiguous no-change reading WITHOUT retyping (never doubles the text)", async () => {
    // A `selectAllOnFocus` field already holding the text: `input text` replaces
    // the selection, so a fully successful type leaves the field byte-identical —
    // indistinguishable from one that landed nothing. Retyping here would put the
    // text in twice, so the only safe move is to report and stop.
    const { registry } = registryServing([
      hierarchy({ text: "argent" }),
      hierarchy({ text: "argent" }),
    ]);
    const res = await type(registry, "argent");
    expect(res.verified).toBeUndefined();
    expect(res.note).toMatch(/equally consistent with the text having landed/);
    expect(res.note).toMatch(/Nothing was retyped/);
    expect(cmds()).toEqual(["input text 'argent'"]);
  });

  it("reports the ambiguous survived-baseline reading without retyping", async () => {
    // Field held "abc" and now reads exactly "abcdef": either a correct
    // replacement, or "abc" plus a partial landing of "def" out of "abcdef".
    const { registry } = registryServing([
      hierarchy({ text: "abc" }),
      hierarchy({ text: "abcdef" }),
    ]);
    const res = await type(registry, "abcdef");
    expect(res.verified).toBeUndefined();
    expect(res.note).toMatch(/equally consistent/);
    expect(cmds()).toEqual(["input text 'abcdef'"]);
  });

  it("reports a truncated capture as unknown, not as an empty focus", async () => {
    // A dense screen can hit the node cap before the walk reaches the field.
    // "no editable field held input focus … tap the field first" would send the
    // agent to re-tap a field that already had focus.
    const getHierarchy = vi.fn(async () => ({
      xml: hierarchy({ focused: false }),
      truncated: true,
    }));
    const registry = {
      resolveService: vi.fn(async () => ({ getHierarchy })),
    } as unknown as Registry;
    const res = await type(registry, "abc");
    expect(res.verified).toBeUndefined();
    expect(res.note).toMatch(/more elements than one capture returns/);
    expect(res.note).not.toMatch(/Tap the field first/);
    expect(cmds()).toEqual(["input text 'abc'"]);
  });

  /**
   * A stub whose reads carry their own `truncated` flag, so the read-BACK can be
   * made to truncate. `registryServing` never sets it, which is why every case
   * below needs its own service.
   */
  function registryServingReads(reads: Array<{ xml: string; truncated?: boolean }>): Registry {
    const queue = [...reads];
    const getHierarchy = vi.fn(async () => {
      const next = queue.shift();
      if (!next) throw new Error("test: getHierarchy called more times than scripted");
      return { xml: next.xml, truncated: next.truncated ?? false };
    });
    return { resolveService: vi.fn(async () => ({ getHierarchy })) } as unknown as Registry;
  }

  it("reports a truncated read-BACK as unknown, not as a focus change", async () => {
    // Same evidence the baseline read has a dedicated note for. Blaming focus
    // movement here invents a second field and tells the agent the text may be
    // split across it.
    const registry = registryServingReads([
      { xml: hierarchy() },
      { xml: hierarchy({ focused: false }), truncated: true },
    ]);

    const res = await type(registry, "abcdef");

    expect(res.verified).toBeUndefined();
    expect(res.note).toMatch(/more elements than one capture returns/);
    expect(res.note).not.toMatch(/moved to a different field/);
    expect(res.note).not.toMatch(/split across both fields/);
  });

  it("reports focus lost outright without claiming a second field", async () => {
    // Nothing editable holds focus any more (an OTP box that auto-submits).
    // There is no other field, so "split across both fields" would be fiction.
    const registry = registryServingReads([
      { xml: hierarchy() },
      { xml: hierarchy({ focused: false }) },
    ]);

    const res = await type(registry, "abcdef");

    expect(res.verified).toBeUndefined();
    expect(res.note).toMatch(/no editable field held input focus once the text had been typed/);
    expect(res.note).not.toMatch(/split across both fields/);
  });

  it("retypes without deleting when the field received nothing at all", async () => {
    // The reported shape: a digits-only field rejects every letter, so the read
    // back is byte-identical to the baseline and holds none of the typed text.
    // There is nothing of ours to remove, so the retry must retype with zero
    // backspaces — deleting here would eat the field's own content.
    const unchanged = hierarchy({ text: "Enter number" });
    const { registry } = registryServing([unchanged, unchanged, unchanged]);

    const res = await type(registry, "abcdefghijkl");

    expect(res.verified).toBe(false);
    expect(cmds().some((c) => c.includes("keyevent"))).toBe(false);
    // One first burst plus the chunked retry (12 chars / 8 per chunk = 2).
    expect(cmds().filter((c) => c.includes("input text"))).toHaveLength(3);
  });

  it("paces the retype instead of re-sending it as one burst", async () => {
    // The cadence IS the repair: the same string in one `input text` is what
    // dropped characters in the first place. Without a gap between chunks the
    // retry is a blind repeat of the call that already failed.
    const stamps: number[] = [];
    adbShell.mockImplementation(async (_serial: string, cmd: string) => {
      if (cmd.includes("input text")) stamps.push(Date.now());
      return "";
    });
    const { registry } = registryServing([
      hierarchy({ text: "XY" }),
      hierarchy({ text: "XYabcdefgh" }),
      hierarchy({ text: "XYabcdefghijkl" }),
    ]);

    await type(registry, "abcdefghijkl");

    // stamps: [first burst, retry chunk 1, retry chunk 2]
    expect(stamps).toHaveLength(3);
    expect(stamps[2]! - stamps[1]!).toBeGreaterThanOrEqual(80);
  });

  it("does not claim nothing was retyped after the repair already retyped", async () => {
    // The repair backspaces and retypes BEFORE the confirming read, so a blocked
    // read here follows a destructive edit. Saying "nothing was retyped" invites
    // the caller to enter the value a third time.
    const registry = registryServingReads([
      { xml: hierarchy({ text: "XY" }) }, // baseline: real content, not a hint
      { xml: hierarchy({ text: "XYabcdefgh" }) }, // partial landing -> repair runs
      { xml: hierarchy({ rid: "com.example:id/other", bounds: "[126,900][1080,1000]" }) },
    ]);

    const res = await type(registry, "abcdefghijkl");

    expect(cmds().some((c) => c.includes("keyevent"))).toBe(true);
    expect(res.note).toMatch(/no longer the one the text was typed into/);
    expect(res.note).not.toMatch(/Nothing was retyped/);
    expect(res.note).toMatch(/modified beyond the original typing/);
  });

  it("raises the node cap above the helper default so a dense screen is not truncated", () => {
    // The helper defaults to 5000; the flow tree raised the same call to 12000 to
    // avoid truncating mid-walk, and this read has the same problem.
    const { registry, getHierarchy } = registryServing([hierarchy(), hierarchy({ text: "abc" })]);
    return type(registry, "abc").then(() => {
      for (const call of getHierarchy.mock.calls) {
        expect(call[0]).toMatchObject({ maxNodes: 12_000 });
      }
    });
  });

  it("does not fail the call when the FIRST read throws — the text is still typed", async () => {
    // The mirror of the after-read case: nothing pinned the before-read branch, so
    // dropping its injection left the one path where "The text was typed" is a lie.
    const getHierarchy = vi.fn(async () => {
      throw new Error("AndroidDevtools RPC getHierarchy timed out after 15000ms");
    });
    const registry = {
      resolveService: vi.fn(async () => ({ getHierarchy })),
    } as unknown as Registry;
    const res = await type(registry, "abc");
    expect(res).toEqual({
      typed: "abc",
      keys: 3,
      note: expect.stringMatching(/reading the focused field back failed/) as unknown as string,
    });
    expect(cmds()).toEqual(["input text 'abc'"]);
  });

  it("reports a retry that could not reach the device, and says the field may hold less", async () => {
    // The undo runs before the retype, so a transport failure between them can
    // leave the field emptier than the call found it. That must not surface as a
    // raw adb error implying nothing happened, nor be swallowed as success.
    const { registry } = registryServing([
      hierarchy({ text: "XY" }),
      hierarchy({ text: "XYabcdefgh" }),
    ]);
    adbShell.mockImplementation(async (_serial: string, cmd: string) => {
      if (cmd.startsWith("input text 'abcdefgh'")) throw new Error("adb: device offline");
      return "";
    });
    const res = await type(registry, "abcdefghijkl");
    expect(res.verified).toBe(false);
    expect(res.note).toMatch(/retry could not be completed/);
    expect(res.note).toMatch(/may now hold less/);
  });

  it("takes the FIRST focused editable node in document order", async () => {
    // A multi-window dump can carry a stale `focused="true"` in a background
    // window; the frontmost window's node comes first. Walking children in reverse
    // would silently baseline against the wrong field.
    const field = findFocusedTextField(
      hierarchy({ text: "front", alsoFocused: { text: "stale-background" } })
    );
    expect(field?.text).toBe("front");
  });

  it("splits a long undo across calls instead of one unbounded keyevent line", async () => {
    // 70 characters landed, so the undo exceeds the 64-keycodes-per-call cap.
    // Nothing else needs more than 8 backspaces, so the chunking loop was dead.
    const long = "x".repeat(70);
    const { registry } = registryServing([
      hierarchy({ text: "" }),
      hierarchy({ text: long }), // 70 of 80 chars landed
      hierarchy({ text: "y".repeat(80) }),
    ]);
    await type(registry, "y".repeat(80));
    const keyevents = cmds().filter((c) => c.startsWith("input keyevent"));
    expect(keyevents).toHaveLength(2);
    expect(keyevents[0]!.split(" ").length - 2).toBe(64); // "input keyevent" + 64 codes
    expect(keyevents[1]!.split(" ").length - 2).toBe(6);
  });

  it("does not fail the call when the read-back itself errors after typing", async () => {
    // The keystrokes are already on the device by then, so throwing would tell
    // the agent the typing failed when it may well have worked.
    const getHierarchy = vi
      .fn()
      .mockResolvedValueOnce({ xml: hierarchy({ text: "" }) })
      .mockRejectedValueOnce(new Error("AndroidDevtools RPC getHierarchy timed out after 15000ms"));
    const registry = {
      resolveService: vi.fn(async () => ({ getHierarchy })),
    } as unknown as Registry;
    const res = await type(registry, "abc");
    expect(res).toEqual({
      typed: "abc",
      keys: 3,
      note: expect.stringMatching(/reading the focused field back failed/) as unknown as string,
    });
    expect(cmds()).toEqual(["input text 'abc'"]);
  });

  it("never puts the field's text in the result, on any verification outcome", async () => {
    // The read-back holds whatever the field shows — which on a `{{secret:…}}`
    // type is the resolved plaintext. No outcome may echo it, so the notes carry
    // structural facts and counts only. Asserted against the whole serialised
    // result, so a future note that interpolated the field text turns this red.
    const onScreen = "PLAINTEXT-FROM-THE-SCREEN";
    const cases: Array<[string, string[]]> = [
      [
        "mismatch, repair attempted",
        [
          hierarchy({ text: "XY" }),
          hierarchy({ text: `XY${onScreen}` }),
          hierarchy({ text: `XY${onScreen}` }),
        ],
      ],
      [
        "mismatch, repair refused",
        [hierarchy({ text: "12345" }), hierarchy({ text: `1-2-3-45${onScreen}` })],
      ],
      [
        "focus moved away",
        [hierarchy({ text: onScreen, rid: "a" }), hierarchy({ text: onScreen, rid: "b" })],
      ],
      ["password field", [hierarchy({ text: onScreen, password: true })]],
    ];
    for (const [label, xmls] of cases) {
      adbShell.mockClear();
      const { registry } = registryServing(xmls);
      const res = await type(registry, "abcdefghijkl");
      expect(JSON.stringify(res), label).not.toContain(onScreen);
    }
  });

  it("keeps a resolved secret out of the result while reading it back off the screen", async () => {
    // The real Android path, not a stub: `execute` resolves `{{secret:…}}`, the
    // read-back sees the PLAINTEXT in the field, and the mismatch note is built
    // from it. Only the value must never come back. (The counts do reveal its
    // length — as `keys` already does — which is why this asserts the value's
    // absence rather than the note's silence.)
    vi.stubEnv("ARGENT_SECRET_APP_PASSWORD", "hunter2xyz");
    const { registry } = registryServing([
      hierarchy({ text: "" }), // before: empty
      hierarchy({ text: "hunt" }), // after: 4 of 10 chars landed — the secret, on screen
      hierarchy({ text: "hunt" }), // after the retry: still wrong
    ]);
    const tool = createKeyboardTool(registry);
    const res = await tool.execute({}, { udid: SERIAL, text: "{{secret:APP_PASSWORD}}" });
    expect(res.verified).toBe(false);
    expect(res.typed).toBe("{{secret:APP_PASSWORD}}");
    expect(JSON.stringify(res)).not.toContain("hunter2xyz");
    expect(JSON.stringify(res)).not.toContain("hunt");
    vi.unstubAllEnvs();
  });

  it("leaves a named-key-only press unverified and un-noted (nothing to read back)", async () => {
    const { registry } = registryServing([]);
    const res = await makeAndroidImpl(registry).handler(
      {},
      { udid: SERIAL, key: "enter" } as KeyboardParams,
      PHONE
    );
    expect(res).toEqual({ typed: "enter", keys: 1 });
    expect(cmds()).toEqual(["input keyevent 66"]);
  });
});
