import { describe, it, expect } from "vitest";
import {
  REMOTE_BUTTONS,
  REMOTE_KEYCODES,
  NAMED_KEYCODES,
  remoteButtonsToKeycodes,
} from "../src/utils/vega-input";

describe("vega-input keycode maps", () => {
  it("exposes every remote button with a KEY_ code", () => {
    expect(REMOTE_BUTTONS.length).toBe(16);
    for (const button of REMOTE_BUTTONS) {
      expect(REMOTE_KEYCODES[button]).toMatch(/^KEY_[A-Z0-9_]+$/);
    }
  });

  it("uses the verified non-obvious codes (select=ENTER, home=HOMEPAGE)", () => {
    // select is KEY_ENTER (KEY_SELECT is a no-op on Vega); home is KEY_HOMEPAGE
    // (KEY_HOME is inert — verified against the VVD remote skin keymap).
    expect(REMOTE_KEYCODES.select).toBe("KEY_ENTER");
    expect(REMOTE_KEYCODES.home).toBe("KEY_HOMEPAGE");
    expect(REMOTE_KEYCODES.next).toBe("KEY_NEXTSONG");
  });

  it("pins the exact KEY_ code for every named key (not self-referential)", () => {
    // EVERY entry, against literals — the twin of keyboard-android.test.ts's
    // ANDROID_NAMED_KEYCODES `toEqual`, and the half that makes
    // vega-injection.test.ts's exhaustive injection loop non-vacuous: that loop
    // compares the emitted code against this same map, so a wrong value here
    // satisfies it. Spot-checking 8 of the 24 left `backspace`, `delete`, `tab`,
    // `space`, the three remaining arrows and f2–f10 pinned by nothing in the
    // repo — setting any of them to KEY_ENTER was green against the whole suite.
    expect(NAMED_KEYCODES).toEqual({
      "enter": "KEY_ENTER",
      "return": "KEY_ENTER", // alias of enter
      // Back is the TV analog of Escape; KEY_ESC is inert for the focus engine.
      "escape": "KEY_BACK",
      "esc": "KEY_BACK", // alias of escape
      "backspace": "KEY_BACKSPACE",
      "delete": "KEY_DELETE",
      "tab": "KEY_TAB",
      "space": "KEY_SPACE",
      "arrow-up": "KEY_UP",
      "arrow-down": "KEY_DOWN",
      "arrow-left": "KEY_LEFT",
      "arrow-right": "KEY_RIGHT",
      // Vega names function keys KEY_FN_F<n>, not KEY_F<n>.
      "f1": "KEY_FN_F1",
      "f2": "KEY_FN_F2",
      "f3": "KEY_FN_F3",
      "f4": "KEY_FN_F4",
      "f5": "KEY_FN_F5",
      "f6": "KEY_FN_F6",
      "f7": "KEY_FN_F7",
      "f8": "KEY_FN_F8",
      "f9": "KEY_FN_F9",
      "f10": "KEY_FN_F10",
      "f11": "KEY_FN_F11",
      "f12": "KEY_FN_F12",
    });
  });
});

describe("remoteButtonsToKeycodes", () => {
  it("maps a button path to inputd-cli KEY_ codes, in order", () => {
    expect(remoteButtonsToKeycodes(["down", "right", "select"])).toEqual([
      "KEY_DOWN",
      "KEY_RIGHT",
      "KEY_ENTER",
    ]);
  });
});
