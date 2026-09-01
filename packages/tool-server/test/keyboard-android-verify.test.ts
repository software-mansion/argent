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
  ping: ReturnType<typeof vi.fn>;
} {
  const queue = [...xmls];
  const ping = vi.fn(async () => ({ ok: true, idleMs: 0, protocol: "1" }));
  const getHierarchy = vi.fn(async (_opts?: unknown) => {
    const xml = queue.shift();
    if (xml === undefined) throw new Error("test: getHierarchy called more times than scripted");
    return { xml, captureMode: "active-window", windowCount: 1, nodeCount: 2, elapsedMs: 1 };
  });
  return {
    registry: {
      resolveService: vi.fn(async () => ({ getHierarchy, ping })),
    } as unknown as Registry,
    getHierarchy,
    ping,
  };
}

function type(registry: Registry, text: string): Promise<KeyboardResult> {
  return makeAndroidImpl(registry).handler({}, { udid: SERIAL, text } as KeyboardParams, PHONE);
}

const cmds = () => adbShell.mock.calls.map((c) => c[1]);

// The whole INDETERMINATE_NOTE, so a clause silently dropped from it fails here.
const INDETERMINATE_TEXT =
  "The typed text was not verified against the screen: what the field holds is equally " +
  "consistent with the text having landed and with it having been dropped — it did not change " +
  "and already contained the text, or it now reads exactly as the text while its previous value " +
  "could have been part of the result, or it holds the whole of the text with the rest of its " +
  "content around it (what replacing a selected word looks like), or it holds every character " +
  "typed, in order, among characters of its own (what a field that reformats a phone or card " +
  "number does). Nothing was retyped, because doing so on this evidence risks entering the text " +
  "twice or overwriting a value that is already correct. Read the field with `describe` to " +
  "confirm.";

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
      idShared: false,
    });
  });

  it("marks an id that another editable view in the same capture also carries", () => {
    // A layout id, not this field's identity: `isSameField` must fall back to
    // position for it, or the boxes of an OTP form all match each other.
    const shared = findFocusedTextField(
      hierarchy({ text: "hello", alsoFocused: { rid: FIELD_RID } })
    );
    expect(shared?.idShared).toBe(true);
    const alone = findFocusedTextField(
      hierarchy({ text: "hello", alsoFocused: { rid: "com.example:id/other" } })
    );
    expect(alone?.idShared).toBe(false);
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
    // The empty-and-no-hint baseline: the field grew by exactly `text`, which the
    // insertion branch takes on its own — `beforeSurvived` is true of an empty
    // baseline, so it decides nothing here.
    expect(classifyTypedText("", "abcdef", "abcdef")).toBe("landed");
  });
});

describe("plannedUndoDeletions", () => {
  it("counts the observed growth when the prior content survived", () => {
    // 8 of 12 characters landed after "XY": deleting 8 restores "XY" exactly.
    expect(plannedUndoDeletions("XY", "XYabcdefgh", "abcdefghijkl")).toBe(8);
  });

  it("refuses to delete when the baseline is equally a prior character and a hint", () => {
    // Two readings, and they disagree: if "a" was really in the field, 8
    // characters are ours; if "a" was the hint of an empty field, 9 are. Acting
    // on either reading is a coin flip with the user's content, and taking the
    // smaller count is the worse half — it leaves the hint text behind as real
    // content, the retype appends to it, and the doubled result is shaped to
    // satisfy classifyTypedText's first branch (see the end-to-end test below).
    expect(plannedUndoDeletions("a", "abcdefghi", "abcdefghijkl")).toBeNull();
  });

  it("declines a selection at the END of the field, where nothing follows the text", () => {
    // The occurrence sits at the last index the scan reaches, with an empty
    // suffix — the mirror of the leading selection below, and the ordinary
    // editing gesture: tap the field, double-tap the LAST word, retype. Field
    // "bb aa" with "aa" selected and `text: "aaa"` gives the correct "bb aaa",
    // a growth of 1 rather than 3; reading that as this call's whole
    // contribution deletes 1, retypes 3 and leaves "bb aaaaa", which is
    // `before.length + text.length` and so satisfies the `inserted` branch.
    expect(classifyTypedText("bb aa", "bb aaa", "aaa")).toBe("indeterminate");
    expect(plannedUndoDeletions("bb aa", "bb aaa", "aaa")).toBeNull();
  });

  it("still repairs a drop whose residue LEADS the text", () => {
    // The other half of the same proof. Cursor at 0 of a field reading "abc",
    // typing "abc", the burst dropping everything but the final "c": the field
    // reads "cabc", which CONTAINS the text, but "abc" does not start "c", so no
    // selection explains it and the repair must still run. `before.endsWith`
    // proves the trailing-residue case ("abcac" below); this is the one only
    // `before.startsWith` can rule out.
    expect(classifyTypedText("abc", "cabc", "abc")).toBe("not-landed");
    expect(plannedUndoDeletions("abc", "cabc", "abc")).toBe(1);
  });

  it("refuses a reading a replaced selection produces just as well", () => {
    // `input text` replaces a selection, so "cat food" with "cat" double-tap
    // selected and "catt" typed with its last character dropped reads back
    // UNCHANGED — the same reading as a burst that landed nothing. Taking the
    // second retypes onto the "cat" that IS ours, and "catcatt food" is `before`
    // with `text` inserted, which classifyTypedText calls `landed`: a doubled
    // field reported as success, the defect this whole module exists to catch.
    expect(plannedUndoDeletions("cat food", "cat food", "catt")).toBeNull();
    // One character over the selection instead of exactly it: growth of 1, which
    // a plain insertion explains and so does the selection.
    expect(plannedUndoDeletions("cat food", "catt food", "catty")).toBeNull();
    // The measured "aa bb" case, one character short of landing.
    expect(plannedUndoDeletions("aa bb", "aa bb", "aaa")).toBeNull();
  });

  it("refuses a selection whose swallowed run is not the head of the typed text", () => {
    // "Smith" double-tap selected in "John Smith", `text: "John Smithe"`, the
    // final "e" dropped: `input text` replaces the selection, so the field reads
    // "John John Smith". That is equally "John " inserted at the cursor by a
    // burst that dropped the rest, and the two readings disagree — 5 characters
    // are ours under one, 10 under the other. Deleting 5 takes the "Smith" the
    // user selected, and the retype leaves the name three times over, shaped to
    // satisfy the `inserted` branch and reported as landed.
    expect(plannedUndoDeletions("John Smith", "John John Smith", "John Smithe")).toBeNull();
    // The same shape on an unchanged field: "john" wholly selected, `text:
    // "xjohn"`, the leading "x" dropped, so "john" replaced "john". Retyping
    // there leaves "johnxjohn" where the field should hold "xjohn".
    expect(plannedUndoDeletions("john", "john", "xjohn")).toBeNull();
    expect(plannedUndoDeletions("dog", "dog", "hotdog")).toBeNull();
  });

  it("still repairs an unchanged field no selection can explain", () => {
    // The counterpart, and the reason the refusal above is not a blanket one on
    // unchanged fields: no character of "hello" is one this call typed, so no
    // selection could have been replaced by what landed, the reading has one
    // explanation — the burst landed nothing — and retyping cannot double it.
    expect(plannedUndoDeletions("hello", "hello", "abc")).toBe(0);
    // An empty baseline cannot host a selection at all, which is what keeps the
    // reported shape (typed into an empty hint-less box, nothing landed)
    // repairable however the text starts.
    expect(plannedUndoDeletions("", "", "abc")).toBe(0);
  });

  it("gives up the retry on an unchanged field that could have held what landed", () => {
    // The price of the model, pinned so it is a decision rather than a surprise:
    // on an unchanged field every position is a possible selection, so one
    // character the call could have typed is enough to make "a selection was
    // replaced by exactly what it held" as good an explanation as "the burst
    // landed nothing". "hello" holds the "h" of "hat", so the call reports the
    // failure instead of retyping. A hint usually shares a character with the
    // text, so this is most of the total-drop cases — all of them fail loudly.
    expect(plannedUndoDeletions("hello", "hello", "hat")).toBeNull();
    expect(plannedUndoDeletions("Search settings", "Search settings", "sound")).toBeNull();
  });

  it("plans a zero-deletion repair over a non-ASCII baseline", () => {
    // No reading can hand a character the FIELD put there to `KEYCODE_DEL`, whose
    // delete is grapheme-sized: a landed run is a subsequence of `text`, which is
    // printable ASCII. So a localized hint needs no scan of its own to be safe —
    // here nothing is deleted at all, and the text is simply retyped.
    expect(plannedUndoDeletions("José", "José", "argent")).toBe(0);
  });

  it("still counts the growth when the field cannot have been empty", () => {
    // "XY" is not a subsequence of the typed text, so the hint reading is ruled
    // out and one reading is left. This is what keeps the refusal above from
    // disabling the undo wherever the prior content is real.
    expect(plannedUndoDeletions("XY", "XYabcdefgh", "abcdefghijkl")).toBe(8);
  });

  it("empties the field when everything in it came from this injection", () => {
    // Baseline was the hint, so it shares no prefix or suffix with the typed
    // text: the only reading that survives replaces the whole of it with what
    // landed, which is what an empty field under a hint looks like.
    expect(plannedUndoDeletions("Search settings", "abcdefgh", "abcdefghijkl")).toBe(8);
  });

  it("deletes the whole of a hint-less empty baseline, which has one reading", () => {
    // An empty `before` hosts no selection and shares no edge, so the only
    // reading is "everything present is ours". This is the hint-less empty
    // `TextInput` — uiautomator reports text="" for it — and without it the
    // repair never runs for exactly the reported repro shape.
    expect(plannedUndoDeletions("", "abcdefgh", "abcdefghijkl")).toBe(8);
    const sentence = "The quick brown fox jumps over the lazy dog. The quick brown fox";
    const dropped = "The quick brown fox jumps over the lazy dog. ";
    expect(plannedUndoDeletions("", dropped, sentence)).toBe(dropped.length);
  });

  it("refuses the hint overlaps that make the undo double the value", () => {
    // Each pair is an empty field whose hint shares an edge with the typed text,
    // and a first burst that dropped characters. Reading the hint as prior
    // content under-deletes by exactly its length, so the retype would land on
    // top of it — and the reading that empties the field is just as live. These
    // are the real-world shapes: a URL bar, a phone field, a quantity box.
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

  it("gives up on a search past its work cap instead of running it out", () => {
    // A field of one character the call never typed rules out every non-empty
    // run, so nothing decides the search short of its own length: below the cap
    // it answers, above it it refuses — the answer an ambiguous reading gets
    // anyway. The two sizes straddle READING_SEARCH_STEPS; raising that constant
    // must be a deliberate edit, not a silent one.
    const under = "z".repeat(1_999_998);
    expect(plannedUndoDeletions(under, under, "abc")).toBe(0);
    const over = "z".repeat(2_000_002);
    expect(plannedUndoDeletions(over, over, "abc")).toBeNull();
  });

  it("scans `text` only as far as the run it matches, so a big field still answers", () => {
    // Every offset of this field matches its empty run against `text`, and a
    // scan that read to the end of `text` regardless made the search
    // O(field x text): 12.9 s measured on this input, all of it synchronous on
    // the tool-server's only thread — and, once the budget charges what a scan
    // really reads, a refusal where the answer is plain.
    const field = "1234567890".repeat(20_000);
    const text = "abcdefghij".repeat(2_000);
    const started = Date.now();
    expect(plannedUndoDeletions(field, field, text)).toBe(0);
    expect(Date.now() - started).toBeLessThan(2_000);
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
    // A repair that worked still says the field was backspaced and retyped: those
    // presses are app-visible events, and every other post-repair outcome states
    // it. The count is the deletion, not the typed length.
    expect(res).toEqual({
      typed: "abcdefghijkl",
      keys: 12,
      verified: true,
      note:
        "The typed text is in the field, but not from the first attempt: Android's key-event " +
        "burst did not deliver it, so 8 characters were deleted and the text was retyped in " +
        "smaller chunks. Those backspaces reached the app as key events, so the field has been " +
        "modified beyond the original typing and anything watching it saw the intermediate " +
        "states.",
    });
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
      hierarchy({ text: "aXYZb" }), // after the retype: "a" + "XYZ" + "b"
    ]);
    const res = await type(registry, "XYZ");
    expect(res).toMatchObject({ typed: "XYZ", keys: 3, verified: true });
    // Singular, and the ONE character it actually deleted.
    expect(res.note).toContain("so 1 character was deleted");
    expect(cmds()).toEqual([
      "input text 'XYZ'",
      "input keyevent 67", // exactly the ONE character that landed
      "input text 'XYZ'",
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
    // The total is the READ-BACK's, not the baseline's: an agent deciding how many
    // characters to clear before retyping acts on this number, and the note's own
    // next sentence tells it the total is what the field holds.
    expect(res.note).toContain("12 characters were typed and the field now holds 11 in total");
    expect(res.note).toContain("an empty field reads back as its hint");
    expect(res.note).toContain("it is not a count of how many characters were lost");
    // …and what to do about it, which is the half an agent acts on.
    expect(res.note).toMatch(/type in shorter pieces or send a value the field accepts/);
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

  it("declines when focus auto-advances between boxes sharing one layout id", async () => {
    // `<include>`d and RecyclerView-recycled views report the LAYOUT's id, so an
    // OTP form's boxes all read the same `resource-id`. Matching on that id alone
    // made box 2 look like box 1 while focus auto-advanced between the two reads:
    // the repair then typed into the box the caller never targeted and reported
    // the result verified, with box 1 left holding the one character that landed.
    const otpForm = (focusedIndex: number, texts: string[]) =>
      `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0">` +
      `<node index="0" text="" resource-id="" class="android.widget.FrameLayout" ` +
      `package="com.example" content-desc="" focusable="false" focused="false" ` +
      `password="false" bounds="[0,0][1080,2400]">` +
      texts
        .map(
          (t, i) =>
            `<node index="${i}" text="${t}" resource-id="com.example:id/otp_digit" ` +
            `class="android.widget.EditText" package="com.example" content-desc="" ` +
            `checkable="false" checked="false" clickable="true" enabled="true" focusable="true" ` +
            `focused="${i === focusedIndex}" scrollable="false" long-clickable="true" ` +
            `password="false" selected="false" bounds="[${100 + i * 200},149][${260 + i * 200},275]" />`
        )
        .join("") +
      `</node></hierarchy>`;

    const { registry } = registryServing([
      otpForm(0, ["", ""]),
      otpForm(1, ["1", ""]), // the burst put "1" in box 1 and focus moved on
      otpForm(1, ["1", "1234"]), // what the repair would leave, if it ran
    ]);
    const res = await type(registry, "1234");
    // Nothing deleted, nothing retyped: the second box is not the field this
    // call typed into, so its contents prove nothing about the first.
    expect(cmds()).toEqual(["input text '1234'"]);
    expect(res.verified).toBeUndefined();
    expect(res.note).toMatch(/no longer the one the text was typed into/);
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
    const ping = vi.fn(async () => ({ ok: true, idleMs: 0, protocol: "1" }));
    return { resolveService: vi.fn(async () => ({ getHierarchy, ping })) } as unknown as Registry;
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
    // The reported shape: a field at its maxLength accepts nothing, so the read
    // back is byte-identical to the baseline and holds none of the typed text.
    // There is nothing of ours to remove, so the retry must retype with zero
    // backspaces — deleting here would eat the field's own content. No character
    // of the hint is one this call typed, so no selection explains the reading
    // and the count is proven (see the test below for the price of that rule).
    const unchanged = hierarchy({ text: "Enter number" });
    const { registry } = registryServing([unchanged, unchanged, unchanged]);

    const res = await type(registry, "9876543210");

    expect(res.verified).toBe(false);
    expect(cmds().some((c) => c.includes("keyevent"))).toBe(false);
    // One first burst plus the chunked retry (10 chars / 8 per chunk = 2).
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
    // And the verdict travels with it: the last thing measured was a failure, so
    // an absent `verified` here would pass all three step gates and submit the
    // field with the most evidence against it.
    expect(res.verified).toBe(false);
    expect(res.note).toMatch(/did NOT land/);
    // The repair's backspaces and retype went wherever focus was at the time, so
    // the note has to name the field it may have edited instead.
    expect(res.note).toMatch(/reached the field that holds focus now/);
  });

  it("fails the call on every way the confirming read can be blocked", async () => {
    // One case per blocked cause, all after a repair: a read that throws (the
    // stub throws once its queue runs out), one truncated before it reached the
    // field, a lost focus, focus on another field, and a field that has started
    // masking. Each leaves the pre-repair failure as the last measurement, so
    // none of them may report "not checked".
    const baseline = { xml: hierarchy({ text: "XY" }) };
    const partial = { xml: hierarchy({ text: "XYabcdefgh" }) };
    const blocked: Array<{ label: string; reads: Array<{ xml: string; truncated?: boolean }> }> = [
      { label: "read throws", reads: [baseline, partial] },
      {
        label: "truncated",
        reads: [baseline, partial, { xml: hierarchy({ focused: false }), truncated: true }],
      },
      { label: "focus lost", reads: [baseline, partial, { xml: hierarchy({ focused: false }) }] },
      {
        label: "focus moved",
        reads: [baseline, partial, { xml: hierarchy({ rid: "com.example:id/other" }) }],
      },
      {
        label: "masks now",
        reads: [baseline, partial, { xml: hierarchy({ text: "••••", password: true }) }],
      },
    ];
    for (const { label, reads } of blocked) {
      adbShell.mockClear();
      const res = await type(registryServingReads(reads), "abcdefghijkl");
      expect(res.verified, label).toBe(false);
      expect(res.note, label).toMatch(/modified beyond the original typing/);
    }
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
    // The mirror of the after-read case, and the one path where dropping the
    // injection would make "The text was typed" a lie.
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

  it("reports a retry that could not reach the device, and what that leaves behind", async () => {
    // The undo runs before the retype, so a transport failure between them can
    // leave the field emptier than the call found it — and a failure between two
    // chunks leaves a truncated copy of the text. That must not surface as a raw
    // adb error implying nothing happened, nor be swallowed as success.
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
    expect(res.note).toMatch(/anything from less than it did before this call to a truncated copy/);
  });

  it("says what a repair with nothing to delete did, on every outcome", async () => {
    // The module's headline shape: a field that took none of the burst has
    // nothing of ours to remove, so the retype runs with zero backspaces. Every
    // note that follows one must say that rather than assert deletions — the
    // hint shares no character with the text, which is what proves the count.
    const unchanged = hierarchy({ text: "Digits" });

    const worked = await type(
      registryServing([unchanged, unchanged, hierarchy({ text: "97531" })]).registry,
      "97531"
    );
    expect(worked.verified).toBe(true);
    expect(worked.note).toMatch(/Nothing had to be deleted first, but the app saw both rounds/);

    adbShell.mockClear();
    const blocked = await type(
      registryServing([unchanged, unchanged, hierarchy({ focused: false })]).registry,
      "97531"
    );
    expect(blocked.verified).toBe(false);
    expect(blocked.note).toMatch(/Nothing had to be deleted first, but the text had already been/);
    expect(blocked.note).not.toMatch(/deleted and retyped/);

    adbShell.mockClear();
    let bursts = 0;
    adbShell.mockImplementation(async (_serial: string, cmd: string) => {
      if (cmd.includes("input text") && ++bursts === 2) throw new Error("adb: device offline");
      return "";
    });
    const failed = await type(registryServing([unchanged, unchanged]).registry, "97531");
    expect(failed.verified).toBe(false);
    expect(failed.note).toMatch(/nothing had to be deleted first, and the retype did not finish/);
    // No backspace was issued, so the field cannot hold less than it did.
    expect(failed.note).not.toMatch(/less than it did before/);
    expect(cmds().some((c) => c.includes("keyevent"))).toBe(false);
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
    // 70 characters landed, so the undo exceeds the 64-keycodes-per-call cap —
    // the only case in this file that needs more than one keyevent call.
    const long = "y".repeat(70);
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
        // 8 of 12 characters landed, so the repair runs and the note that
        // follows it is built from a third read holding the plaintext.
        "mismatch, repair ran",
        [
          hierarchy({ text: "XY" }),
          hierarchy({ text: "XYabcdefgh" }),
          hierarchy({ text: `XY${onScreen}` }),
        ],
      ],
      [
        // The repair ran and the read that would have confirmed it landed on
        // another field, so the note is the blocked one rather than a count.
        "repair ran, confirming read blocked",
        [
          hierarchy({ text: "XY" }),
          hierarchy({ text: "XYabcdefgh" }),
          hierarchy({ text: onScreen, rid: "com.example:id/other" }),
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

/**
 * An Android `EditText`: content, plus a selection `[selStart, selEnd)`.
 *
 *  - `input text 'X'`     replaces the selection with X; the cursor lands after X.
 *  - `input keyevent 67…` deletes the selection if there is one, else the
 *                         character immediately before the cursor.
 *
 * `render()` is what uiautomator reports — the hint when the content is empty
 * (see `FocusedField.text`). Driving the read-backs off THIS instead of a
 * scripted list is what makes a repair's effect on the field observable: the
 * assertions below are on the field the commands actually produce, not on a
 * third hierarchy the test chose.
 */
class FieldModel {
  text: string;
  selStart: number;
  selEnd: number;
  constructor(
    text: string,
    selStart = text.length,
    selEnd = selStart,
    private readonly hint = ""
  ) {
    this.text = text;
    this.selStart = selStart;
    this.selEnd = selEnd;
  }
  insert(s: string): void {
    this.text = this.text.slice(0, this.selStart) + s + this.text.slice(this.selEnd);
    this.selStart = this.selEnd = this.selStart + s.length;
  }
  backspace(n: number): void {
    for (let i = 0; i < n; i++) {
      if (this.selStart !== this.selEnd) {
        this.text = this.text.slice(0, this.selStart) + this.text.slice(this.selEnd);
      } else if (this.selStart > 0) {
        this.text = this.text.slice(0, this.selStart - 1) + this.text.slice(this.selStart);
        this.selStart -= 1;
      }
      this.selEnd = this.selStart;
    }
  }
  render(): string {
    return this.text === "" ? this.hint : this.text;
  }
}

/** A registry whose every `getHierarchy` re-reads the live model. */
function registryServingLive(read: () => string): Registry {
  return {
    resolveService: vi.fn(async () => ({
      getHierarchy: vi.fn(async () => ({
        xml: hierarchy({ text: read() }),
        captureMode: "active-window",
        windowCount: 1,
        nodeCount: 2,
        elapsedMs: 1,
      })),
      ping: vi.fn(async () => ({ ok: true, idleMs: 0, protocol: "1" })),
    })),
  } as unknown as Registry;
}

/**
 * Apply the adb commands the code issues to `field`. `corruptFirstBurst` models
 * the dropped-keystroke burst: it rewrites the FIRST `input text` only, since the
 * repair's chunks are the slower cadence that lands in full.
 */
function driveFromAdb(field: FieldModel, corruptFirstBurst: (s: string) => string): void {
  let bursts = 0;
  adbShell.mockImplementation(async (_serial: string, cmd: string) => {
    const typed = /^input text '(.*)'$/s.exec(cmd);
    if (typed) {
      bursts += 1;
      field.insert(bursts === 1 ? corruptFirstBurst(typed[1]!) : typed[1]!);
      return "";
    }
    const keys = /^input keyevent ((?:67 ?)+)$/.exec(cmd);
    if (keys) field.backspace(keys[1]!.trim().split(/\s+/).length);
    return "";
  });
}

describe("android keyboard read-back — shapes a repair must not touch", () => {
  it("leaves a selection that swallowed exactly what landed alone", async () => {
    // The partial-landing twin of the case below: "cat" double-tap selected,
    // `text: "catt"`, the last character dropped. `input text` replaced the
    // selection with "cat", so the field reads back UNCHANGED and the growth is
    // 0 — the same reading a burst that landed nothing gives. Retyping there
    // would put "catt" on top of the "cat" that is already ours and leave
    // "catcatt food", which is `before` with `text` inserted and so `landed`.
    const field = new FieldModel("cat food", 0, 3);
    driveFromAdb(field, (s) => s.slice(0, 3));
    const res = await type(
      registryServingLive(() => field.render()),
      "catt"
    );

    expect(field.text).toBe("cat food");
    expect(cmds()).toEqual(["input text 'catt'"]);
    expect(res.verified).toBe(false);
  });

  it("leaves a selection whose swallowed run sits inside the typed text alone", async () => {
    // "Smith" double-tap selected, `text: "John Smithe"`, the final character
    // dropped. `input text` replaced the selection with "John Smith", so the
    // field reads "John John Smith" — indistinguishable from "John " inserted by
    // a burst that dropped the rest. Deleting that growth takes the user's own
    // "Smith" and retyping leaves the name three times over.
    const field = new FieldModel("John Smith", 5, 10);
    driveFromAdb(field, (s) => s.slice(0, -1));
    const res = await type(
      registryServingLive(() => field.render()),
      "John Smithe"
    );

    expect(field.text).toBe("John John Smith");
    expect(cmds()).toEqual(["input text 'John Smithe'"]);
    expect(res.verified).toBe(false);
  });

  it("declines a replaced selection instead of deleting the growth and doubling the value", async () => {
    // Measured on a Pixel-class API 35 emulator: field "aa bb", the word "aa"
    // double-tap selected, `keyboard { text: "aaa" }`. `input text` REPLACES the
    // selection, so the correct outcome is "aaa bb" — and the field grew by 1,
    // not by 3. Reading that growth as this call's whole contribution deleted one
    // character and retyped three, leaving "aaaaa bb" — which satisfies the
    // `inserted` branch, so the doubled field reads as a verified success.
    const field = new FieldModel("aa bb", 0, 2);
    driveFromAdb(field, (s) => s);
    const res = await type(
      registryServingLive(() => field.render()),
      "aaa"
    );

    // One injection, and NOTHING after it.
    expect(cmds()).toEqual(["input text 'aaa'"]);
    // Byte-identical to what the pre-read-back transport leaves.
    expect(field.text).toBe("aaa bb");
    expect(res.verified).toBeUndefined();
    expect(res.note).toContain("equally consistent");
  });

  it("declines it at scale too — a 200-character text over a 2-character selection", async () => {
    const text = "z".repeat(200);
    const field = new FieldModel("aa bb", 0, 2);
    driveFromAdb(field, (s) => s);
    const res = await type(
      registryServingLive(() => field.render()),
      text
    );

    expect(cmds()).toEqual([`input text '${text}'`]);
    expect(field.text).toBe(`${text} bb`);
    expect(field.text.length).toBe(203);
    expect(res.verified).toBeUndefined();
  });

  it("still repairs a drop whose residue merely CONTAINS the text", async () => {
    // The guard is a proof, not a substring test: "abc" typed into a field
    // holding "abc" and landing "ac" reads back "abcac", which contains "abc" —
    // but no selection of "abc" explains it ("abc" does not end "ac"), so the
    // drop reading is the only one and the repair still runs.
    expect(classifyTypedText("abc", "abcac", "abc")).toBe("not-landed");
    const field = new FieldModel("abc");
    driveFromAdb(field, (s) => s.replace("b", ""));
    const res = await type(
      registryServingLive(() => field.render()),
      "abc"
    );

    expect(cmds()).toEqual(["input text 'abc'", "input keyevent 67 67", "input text 'abc'"]);
    expect(field.text).toBe("abcabc");
    expect(res.verified).toBe(true);
  });

  it("declines a field that reformats what it is given, rather than failing the call", async () => {
    // Contacts -> new contact -> Phone on API 35: `keyboard { text: "5551234567" }`
    // is entered correctly and the field shows "(555) 123-4567". Every character
    // typed is present, in order, among separators the field added — which a
    // dropped burst cannot produce, because dropping only removes. Reporting it
    // `verified: false` made every phone, card, date and currency field a hard
    // step failure across run-sequence and both flow gates.
    for (const before of ["", "Phone"]) {
      adbShell.mockClear();
      const { registry } = registryServing([
        hierarchy({ text: before }),
        hierarchy({ text: "(555) 123-4567" }),
      ]);
      const res = await type(registry, "5551234567");
      expect(res, `baseline ${JSON.stringify(before)}`).toEqual({
        typed: "5551234567",
        keys: 10,
        note: INDETERMINATE_TEXT,
      });
      expect(cmds()).toEqual(["input text '5551234567'"]);
    }
  });

  it("still fails a drop INSIDE a reformatting field", async () => {
    // One digit lost on the way in: the field holds "(555) 123-456", which is not
    // every typed character in order, so the reformat reading does not apply.
    const { registry } = registryServing([
      hierarchy({ text: "" }),
      hierarchy({ text: "(555) 123-456" }),
      hierarchy({ text: "(555) 123-456" }),
    ]);
    const res = await type(registry, "5551234567");
    expect(res.verified).toBe(false);
  });

  it("still fails a doubled injection, which the reformat clause must not absorb", async () => {
    // "abc" appears in the field IN ORDER — twice. No single injection explains
    // that, so requiring the text NOT to be present contiguously is what keeps
    // this a failure.
    expect(classifyTypedText("", "abcabc", "abc")).toBe("not-landed");
  });
});

describe("android keyboard read-back — the repair's own outcomes", () => {
  it("does not report a repair that WORKED as a failure", async () => {
    // An empty phone box, text "5551234567", the burst landing only "555". The
    // undo removes those three, the chunked retype lands the whole number, and
    // the field reformats it — so the re-classification is the `reformats`
    // shape, which is `indeterminate`. Collapsing that into `verified: false`
    // would tell the caller to send a value the field accepts, over a field
    // holding precisely what was asked for.
    const { registry } = registryServing([
      hierarchy({ text: "" }),
      hierarchy({ text: "555" }),
      hierarchy({ text: "(555) 123-4567" }),
    ]);
    const res = await type(registry, "5551234567");

    expect(cmds()).toContain("input keyevent 67 67 67");
    expect(res.verified).toBeUndefined();
    expect(res.note).not.toContain("did NOT land");
    // ...and it still says the field was modified, like every other post-repair note.
    expect(res.note).toContain("deleted and retyped in smaller chunks");
  });

  it("still reports a repair that did NOT work as a failure", async () => {
    const corrupt = hierarchy({ text: "XYabcdefgh" });
    const { registry } = registryServing([hierarchy({ text: "XY" }), corrupt, corrupt]);
    const res = await type(registry, "abcdefghijkl");
    expect(res.verified).toBe(false);
  });
});

describe("android keyboard read-back — cancellation", () => {
  const REPAIR_SCRIPT = [
    hierarchy({ text: "XY" }),
    hierarchy({ text: "XYabcdefgh" }), // 8 of 12 landed
    hierarchy({ text: "XYabcdefghijkl" }),
  ];

  it("types nothing at all when the caller has already gone", async () => {
    // Resolving the helper installs an APK and spawns it — minutes on a cold
    // device — so the caller can be gone before anything would be typed, and the
    // keystrokes would land in whatever holds focus by then.
    const { registry } = registryServing(REPAIR_SCRIPT);
    await expect(
      makeAndroidImpl(registry).handler(
        {},
        { udid: SERIAL, text: "abcdefghijkl" } as KeyboardParams,
        PHONE,
        { signal: AbortSignal.abort() }
      )
    ).rejects.toThrow(/abort/i);
    expect(cmds()).toEqual([]);
  });

  it("does not START the destructive repair once the caller has aborted", async () => {
    // The repair deletes before it retypes, so beginning it after the client is
    // gone can leave the field holding LESS than the call found it, with nobody
    // waiting for the result — and the MCP adapter replays an abandoned call.
    // It REJECTS rather than reporting `verified: false`: the gates read that as
    // a verdict about the app, so a cancelled run would record a typing failure
    // where a flow's own abort handling reads a rejection as a skip.
    const controller = new AbortController();
    const reads = REPAIR_SCRIPT.slice(0, 2);
    let served = 0;
    const registry = {
      resolveService: vi.fn(async () => ({
        getHierarchy: vi.fn(async () => {
          const xml = reads[served++]!;
          // The caller gives up between the read that measures the drop and the
          // repair it would trigger.
          if (served === 2) controller.abort();
          return { xml, captureMode: "active-window", windowCount: 1, nodeCount: 2, elapsedMs: 1 };
        }),
        ping: vi.fn(async () => ({ ok: true, idleMs: 0, protocol: "1" })),
      })),
    } as unknown as Registry;

    await expect(
      makeAndroidImpl(registry).handler(
        {},
        { udid: SERIAL, text: "abcdefghijkl" } as KeyboardParams,
        PHONE,
        { signal: controller.signal }
      )
    ).rejects.toThrow(/abort/i);
    // The first burst is on the device; nothing was deleted or retyped over it.
    expect(cmds()).toEqual(["input text 'abcdefghijkl'"]);
  });

  it("types nothing when the caller gives up during the baseline read", async () => {
    // The baseline read is a whole hierarchy dump, and it is the last stretch
    // before the burst, so the caller can give up inside it — after the check
    // that follows the helper resolve has already passed. Both ways out of that
    // read type: the one that measures a field, and the one that gives up on
    // reading it.
    for (const readEnds of [
      async () => ({
        xml: REPAIR_SCRIPT[0]!,
        captureMode: "active-window",
        windowCount: 1,
        nodeCount: 2,
        elapsedMs: 1,
      }),
      async () => {
        throw new Error("helper closed the socket");
      },
    ]) {
      adbShell.mockClear();
      const controller = new AbortController();
      const registry = {
        resolveService: vi.fn(async () => ({
          getHierarchy: vi.fn(async () => {
            controller.abort();
            return await readEnds();
          }),
          ping: vi.fn(async () => ({ ok: true, idleMs: 0, protocol: "1" })),
        })),
      } as unknown as Registry;

      await expect(
        makeAndroidImpl(registry).handler(
          {},
          { udid: SERIAL, text: "abcdefghijkl" } as KeyboardParams,
          PHONE,
          { signal: controller.signal }
        )
      ).rejects.toThrow(/abort/i);
      expect(cmds()).toEqual([]);
    }
  });

  it("rejects rather than reporting a verdict when the caller gives up mid-repair", async () => {
    // The repair runs for tens of seconds and does not watch the signal, so the
    // caller can be gone by the time it ends. Returning a verdict then records a
    // typing failure ABOUT THE APP for a run that was cancelled — all three gates
    // read `verified: false` that way — where a rejection is the aborted skip.
    const controller = new AbortController();
    const { registry } = registryServing(REPAIR_SCRIPT);
    adbShell.mockImplementation(async (_serial: string, cmd: string) => {
      if (cmd === "input text 'abcdefgh'") controller.abort();
      return "";
    });

    await expect(
      makeAndroidImpl(registry).handler(
        {},
        { udid: SERIAL, text: "abcdefghijkl" } as KeyboardParams,
        PHONE,
        { signal: controller.signal }
      )
    ).rejects.toThrow(/abort/i);
    // The repair itself is finished: abandoning it between the delete and the
    // retype would leave the field holding less than the call found it.
    expect(cmds()).toEqual([
      "input text 'abcdefghijkl'",
      "input keyevent 67 67 67 67 67 67 67 67",
      "input text 'abcdefgh'",
      "input text 'ijkl'",
    ]);
  });

  it("rejects rather than reporting a broken repair once the caller has gone", async () => {
    // The same rule where the repair itself failed: `repairFailedNote` describes
    // a field left worse than the call found it, which the gates still read as a
    // verdict on the app rather than as the cancellation it followed.
    const controller = new AbortController();
    const { registry } = registryServing(REPAIR_SCRIPT);
    adbShell.mockImplementation(async (_serial: string, cmd: string) => {
      if (cmd === "input text 'abcdefgh'") {
        controller.abort();
        throw new Error("adb: device offline");
      }
      return "";
    });

    await expect(
      makeAndroidImpl(registry).handler(
        {},
        { udid: SERIAL, text: "abcdefghijkl" } as KeyboardParams,
        PHONE,
        { signal: controller.signal }
      )
    ).rejects.toThrow(/abort/i);
  });

  it("keeps the helper socket alive across a repair longer than its read timeout", async () => {
    // The helper closes a socket left idle for 60 s and the host turns that into
    // a full service teardown, so a repair that sends it nothing for that long
    // guarantees the confirming read fails AND costs every other tool sharing the
    // helper a cold start.
    vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "clearInterval", "Date"] });
    try {
      const { registry, ping } = registryServing(REPAIR_SCRIPT);
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      adbShell.mockImplementation(async (_serial: string, cmd: string) => {
        if (cmd === "input text 'abcdefgh'") await held;
        return "";
      });

      const call = makeAndroidImpl(registry).handler(
        {},
        { udid: SERIAL, text: "abcdefghijkl" } as KeyboardParams,
        PHONE
      );
      await vi.advanceTimersByTimeAsync(31_000);
      expect(ping).toHaveBeenCalled();

      release();
      await vi.advanceTimersByTimeAsync(1_000);
      await call;
      // And it stops with the repair: the interval must not outlive the call.
      const during = ping.mock.calls.length;
      await vi.advanceTimersByTimeAsync(120_000);
      expect(ping.mock.calls.length).toBe(during);
    } finally {
      vi.useRealTimers();
    }
  });

  it("runs the repair normally when the caller has not aborted", async () => {
    const { registry } = registryServing(REPAIR_SCRIPT);
    const res = await makeAndroidImpl(registry).handler(
      {},
      { udid: SERIAL, text: "abcdefghijkl" } as KeyboardParams,
      PHONE,
      { signal: new AbortController().signal }
    );
    expect(cmds()).toEqual([
      "input text 'abcdefghijkl'",
      "input keyevent 67 67 67 67 67 67 67 67",
      "input text 'abcdefgh'",
      "input text 'ijkl'",
    ]);
    expect(res.verified).toBe(true);
  });

  it("declares longRunning, so the MCP adapter does not abandon and replay a repair", async () => {
    // A 600-character repair is 86 adb calls plus the inter-chunk pauses, well
    // past the adapter's 30 s fetch timeout — which does not cancel anything, it
    // re-POSTs the identical body up to five times, and this tool types the whole
    // string again on every one of them.
    expect(createKeyboardTool(registryServing([]).registry).longRunning).toBe(true);
  });
});

describe("android keyboard read-back — what the field's own rewrite does to the undo", () => {
  it("refuses to backspace a run the field rewrote into a multi-unit grapheme", async () => {
    // `KEYCODE_DEL` deletes a whole grapheme cluster; `added` counts UTF-16 code
    // units. A field that turns ":)" into an emoji reads back two units for one
    // grapheme, so two presses would be issued and the second would take the "i"
    // the user typed. `assertTypeableAndroidText` limits what this call can type
    // to printable ASCII, so anything else in the run is the field's own work and
    // proves nothing can be attributed.
    expect(plannedUndoDeletions("hi", "hi\u{1F642}", ":)")).toBeNull();
    const { registry } = registryServing([
      hierarchy({ text: "hi" }),
      hierarchy({ text: "hi\u{1F642}" }),
    ]);
    const res = await type(registry, ":)");
    expect(cmds()).toEqual(["input text ':)'"]);
    expect(res.verified).toBe(false);
    expect(res.note).toContain("nothing was retyped");
  });

  it("still repairs an ASCII run in a field that already holds non-ASCII content", async () => {
    // Only the run the deletion can touch is checked. A partial landing appended
    // to "José" is as repairable as one appended to "Jose".
    expect(plannedUndoDeletions("José", "Joséab", "abc")).toBe(2);
    const { registry } = registryServing([
      hierarchy({ text: "José" }),
      hierarchy({ text: "Joséab" }),
      hierarchy({ text: "Joséabc" }),
    ]);
    const res = await type(registry, "abc");
    expect(cmds()).toEqual(["input text 'abc'", "input keyevent 67 67", "input text 'abc'"]);
    expect(res.verified).toBe(true);
  });
});

describe("android keyboard read-back — which focused view it is looking at", () => {
  it("does not tell the agent to tap a field that already had focus", async () => {
    // `EDITABLE_CLASS_RE` cannot enumerate every focus-taking editor. When it
    // misses one, "no editable field held input focus … Tap the field first" is
    // advice for a screen this is not — the same wrongness TRUNCATED_READ_NOTE
    // exists to avoid.
    const { registry } = registryServing([hierarchy({ cls: "android.webkit.WebView" })]);
    const res = await type(registry, "abc");
    expect(cmds()).toEqual(["input text 'abc'"]);
    expect(res.verified).toBeUndefined();
    expect(res.note).toContain("`android.webkit.WebView`");
    expect(res.note).toContain("do not re-tap the field");
    expect(res.note).not.toContain("Tap the field first");
  });

  it("still says to tap the field when nothing at all holds focus", async () => {
    const { registry } = registryServing([hierarchy({ focused: false })]);
    const res = await type(registry, "abc");
    expect(res.note).toContain("no editable field held input focus");
    expect(res.note).toContain("Tap the field first");
  });

  it("declines a field that started masking between the two reads", async () => {
    // A reveal toggle or a PIN box that masks after its first character keeps its
    // class, id and origin, so `isSameField` matches and the bullets would be
    // compared as content — and the repair would backspace and re-inject the
    // credential in chunks. The baseline read refuses a masked field; so must this
    // one, or the contract holds on only one of the two.
    const masked = hierarchy({ text: "•••••", password: true });
    const { registry } = registryServing([hierarchy({ text: "" }), masked]);
    const res = await type(registry, "abcde");
    expect(cmds()).toEqual(["input text 'abcde'"]);
    expect(res.verified).toBeUndefined();
    expect(res.note).toContain("masks its input now");
    expect(res.note).toContain("Nothing was retyped");
  });
});
