import { describe, it, expect, vi } from "vitest";
import { FAILURE_CODES, getFailureSignal } from "@argent/registry";
import { hdcFailure, shellQuote } from "../src/utils/harmony-hdc";
import {
  assertHarmonyDisplayReady,
  remainingBudget,
  toDevicePoint,
} from "../src/utils/harmony-uitest";

describe("hdcFailure", () => {
  it("reports the `[Fail]` line hdc printed", () => {
    // hdc exits 0 for this, so the prefix is the only failure signal there is.
    expect(
      hdcFailure({
        stdout: "[Fail]Not match target founded, check connect-key please\n",
        stderr: "",
      })
    ).toBe("[Fail]Not match target founded, check connect-key please");
  });

  it("reads a failure written to stderr", () => {
    expect(hdcFailure({ stdout: "", stderr: "[Fail]Error opening file: no such file\n" })).toBe(
      "[Fail]Error opening file: no such file"
    );
  });

  it("returns null when nothing failed", () => {
    expect(hdcFailure({ stdout: "hi\n", stderr: "" })).toBeNull();
    expect(hdcFailure({ stdout: "[Empty]\n", stderr: "" })).toBeNull();
  });

  it("does not let a remote command's own output forge a transport failure", () => {
    expect(hdcFailure({ stdout: "test case [Fail]ing on purpose\n", stderr: "" })).toBeNull();
    // Nor an indented one: `hdc` writes its own flush left, and remote output passes through here.
    expect(hdcFailure({ stdout: "    [Fail] assertion 3 of 7\n", stderr: "" })).toBeNull();
    expect(hdcFailure({ stdout: "\t[Fail]ed to open cache\n", stderr: "" })).toBeNull();
  });
});

describe("shellQuote", () => {
  // `hdc shell` takes a command line, so every value lands in a device-side /bin/sh.
  it.each([
    ["hello world", `'hello world'`],
    ["a'b", `'a'\\''b'`],
    // The only row with two quotes, separating `replace` from `replaceAll`.
    ["a'b'c", `'a'\\''b'\\''c'`],
    ['a"b', `'a"b'`],
    ["a$b", `'a$b'`],
    ["a;echo PWNED", `'a;echo PWNED'`],
    ["a`echo X`b", "'a`echo X`b'"],
    ["ünïcode 中文", `'ünïcode 中文'`],
  ])("quotes %j", (input, expected) => {
    expect(shellQuote(input)).toBe(expected);
  });

  it("neutralises a command substitution rather than letting it run", () => {
    expect(shellQuote("`id`")).toBe("'`id`'");
  });
});

describe("toDevicePoint", () => {
  const display = { width: 1216, height: 2688 };

  it("scales a normalized point into device pixels", () => {
    expect(toDevicePoint(0.5, 0.5, display)).toEqual({ x: 608, y: 1344 });
  });

  it("keeps the far edge inside the display", () => {
    // `uitest` accepts an off-screen coordinate and silently does nothing.
    expect(toDevicePoint(1, 1, display)).toEqual({ x: 1215, y: 2687 });
  });

  it("clamps a point outside the unit square onto an addressable pixel", () => {
    expect(toDevicePoint(-0.2, 1.4, display)).toEqual({ x: 1, y: 2687 });
  });

  it("keeps a screen-edge point off the rejected zero coordinate", () => {
    // The device refuses 0 on either axis, yet 0 is a documented-valid input.
    expect(toDevicePoint(0, 0, display)).toEqual({ x: 1, y: 1 });
    expect(toDevicePoint(0.5, 0, { width: 1320, height: 2856 })).toEqual({ x: 660, y: 1 });
  });

  it("collapses every point onto one pixel when the display has no size", () => {
    expect(toDevicePoint(0.83, 0.42, { width: 0, height: 0 })).toEqual({ x: 1, y: 1 });
  });
});

describe("assertHarmonyDisplayReady", () => {
  const awake = { width: 1216, height: 2688, screenOn: true };

  it("passes a panel that has a size and is on", () => {
    expect(() => assertHarmonyDisplayReady(awake, "tap")).not.toThrow();
  });

  it("refuses a non-positive panel, naming the size the render service reported", () => {
    const err = (() => {
      try {
        assertHarmonyDisplayReady({ width: 0, height: 0, screenOn: true }, "tap");
      } catch (e) {
        return e as Error;
      }
      throw new Error("expected a 0x0 display to be refused");
    })();

    expect(getFailureSignal(err)?.failure_stage).toBe("harmony_display_zero");
    expect(getFailureSignal(err)?.error_code).toBe("HARMONY_DISPLAY_UNREADABLE");
    expect(err.message).toContain("0x0 display");
    expect(err.message).toContain("Cannot tap");
  });

  it("does not blame coordinates for an action that has none", () => {
    const err = (() => {
      try {
        assertHarmonyDisplayReady({ width: 0, height: 0, screenOn: true }, "type");
      } catch (e) {
        return e as Error;
      }
      throw new Error("expected a 0x0 display to be refused");
    })();

    expect(err.message).not.toMatch(/display: there are no coordinates to aim at/);
    expect(err.message).toMatch(/a tap or swipe would additionally/);
  });

  it("refuses a half-read panel too", () => {
    expect(() => assertHarmonyDisplayReady({ ...awake, height: 0 }, "swipe")).toThrow(
      /1216x0 display/
    );
  });

  it("refuses a suspended panel with the wake-it advice", () => {
    const err = (() => {
      try {
        assertHarmonyDisplayReady({ ...awake, screenOn: false }, "type");
      } catch (e) {
        return e as Error;
      }
      throw new Error("expected a suspended display to be refused");
    })();

    expect(getFailureSignal(err)?.failure_stage).toBe("harmony_screen_off");
    expect(getFailureSignal(err)?.error_code).toBe("HARMONY_SCREEN_OFF");
    expect(err.message).toMatch(/Wake it with `button` \(power\)/);
  });
});

describe("remainingBudget", () => {
  it("refuses a deadline that has exactly arrived rather than passing the zero on", () => {
    // Frozen so exactly 0ms remains: `execFile` reads `timeout: 0` as no timeout.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const err = (() => {
        try {
          remainingBudget("dev-a", Date.now(), "the capture");
        } catch (e) {
          return e as Error;
        }
        throw new Error("expected a spent budget to be refused");
      })();

      expect(getFailureSignal(err)).toMatchObject({
        error_code: FAILURE_CODES.HARMONY_HDC_COMMAND_FAILED,
        failure_stage: "harmony_budget_exhausted",
        error_kind: "timeout",
      });
      expect(err.message).toContain("Ran out of time before the capture");
    } finally {
      vi.useRealTimers();
    }
  });

  it("hands on what is left when the deadline is still ahead", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      expect(remainingBudget("dev-a", Date.now() + 750, "the layout dump")).toBe(750);
    } finally {
      vi.useRealTimers();
    }
  });
});
