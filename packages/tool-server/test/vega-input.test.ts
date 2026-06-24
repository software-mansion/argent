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

  it("maps named keys, including Vega's KEY_FN_F<n> function keys and aliases", () => {
    expect(NAMED_KEYCODES.enter).toBe("KEY_ENTER");
    expect(NAMED_KEYCODES.return).toBe("KEY_ENTER");
    expect(NAMED_KEYCODES.escape).toBe("KEY_BACK");
    expect(NAMED_KEYCODES.esc).toBe("KEY_BACK");
    expect(NAMED_KEYCODES["arrow-up"]).toBe("KEY_UP");
    expect(NAMED_KEYCODES.f1).toBe("KEY_FN_F1");
    expect(NAMED_KEYCODES.f11).toBe("KEY_FN_F11");
    expect(NAMED_KEYCODES.f12).toBe("KEY_FN_F12");
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
