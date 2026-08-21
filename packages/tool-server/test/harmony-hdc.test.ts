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
    // Matched at the start of a line, not as a substring: a device log or a test
    // name containing the token must not read as hdc losing the connection.
    expect(hdcFailure({ stdout: "test case [Fail]ing on purpose\n", stderr: "" })).toBeNull();
    // Nor an INDENTED one. `hdc` writes its own `[Fail]…` flush left (measured
    // on 3.2.0d), while `runHdcShell` passes the remote command's combined
    // output through here — where a padded log line is ordinary, and trimming
    // before the prefix check handed it the meaning of a lost connection.
    expect(hdcFailure({ stdout: "    [Fail] assertion 3 of 7\n", stderr: "" })).toBeNull();
    expect(hdcFailure({ stdout: "\t[Fail]ed to open cache\n", stderr: "" })).toBeNull();
  });
});

describe("shellQuote", () => {
  // `hdc shell` takes a command LINE, not an argv, so every caller-supplied
  // value lands in a device-side /bin/sh. Each of these was round-tripped
  // through a real device via `echo` and came back byte-identical.
  it.each([
    ["hello world", `'hello world'`],
    ["a'b", `'a'\\''b'`],
    // The only row with two quotes: at one, a first-match-only replace produces
    // identical bytes, so nothing else here separates it from `replaceAll`.
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
    // The single quote is the whole defence; if it were double quotes the
    // backticks below would execute on the device as the `shell` user.
    expect(shellQuote("`id`")).toBe("'`id`'");
  });
});

describe("toDevicePoint", () => {
  const display = { width: 1216, height: 2688 };

  it("scales a normalized point into device pixels", () => {
    expect(toDevicePoint(0.5, 0.5, display)).toEqual({ x: 608, y: 1344 });
  });

  it("keeps the far edge inside the display", () => {
    // `uitest` accepts an off-screen coordinate, returns `No Error` and does
    // nothing — so 1.0 must land on the last addressable pixel, not one past it,
    // or a tap on a right-edge element silently misses while reporting success.
    expect(toDevicePoint(1, 1, display)).toEqual({ x: 1215, y: 2687 });
  });

  it("clamps a point outside the unit square instead of going negative", () => {
    // `uitest` *does* reject negative coordinates, so an un-clamped caller would
    // turn an out-of-range frame into a hard error rather than an edge tap.
    expect(toDevicePoint(-0.2, 1.4, display)).toEqual({ x: 0, y: 2687 });
  });

  it("puts the origin at the first pixel", () => {
    expect(toDevicePoint(0, 0, display)).toEqual({ x: 0, y: 0 });
  });

  it("collapses every point onto the origin when the display has no size", () => {
    // Not a behaviour to rely on — the reason `assertHarmonyDisplayReady` refuses
    // a 0x0 read before any of this runs. The clamp has no in-range pixel to
    // pick, so a tap anywhere on the screen becomes a tap on the top-left one.
    expect(toDevicePoint(0.83, 0.42, { width: 0, height: 0 })).toEqual({ x: 0, y: 0 });
  });
});

describe("assertHarmonyDisplayReady", () => {
  const awake = { width: 1216, height: 2688, screenOn: true };

  it("passes a panel that has a size and is on", () => {
    expect(() => assertHarmonyDisplayReady(awake, "tap")).not.toThrow();
  });

  it("refuses a non-positive panel, naming the size the render service reported", () => {
    // `render resolution=0x0` is what a guest prints while its compositor is
    // still coming up, and `harmonyDisplay` parses it without complaint. Every
    // coordinate then collapses onto the origin (above) while `uitest uiInput`
    // answers `No Error`, so the injection reports the tap that was asked for
    // and lands somewhere else entirely.
    const err = (() => {
      try {
        assertHarmonyDisplayReady({ width: 0, height: 0, screenOn: true }, "tap");
      } catch (e) {
        return e as Error;
      }
      throw new Error("expected a 0x0 display to be refused");
    })();

    expect(getFailureSignal(err)?.failure_stage).toBe("harmony_display_zero");
    // Its own code, not `uitest`'s: `failedMsg` renders the bare code to the
    // agent, and a panel that has not composited is neither a `uitest` that ran
    // and failed nor the same condition as a screen the user switched off.
    expect(getFailureSignal(err)?.error_code).toBe("HARMONY_DISPLAY_UNREADABLE");
    expect(err.message).toContain("0x0 display");
    expect(err.message).toContain("Cannot tap");
  });

  it("does not blame coordinates for an action that has none", () => {
    // `keyboard` and `button` reach this same guard, and neither takes a
    // coordinate. Opening with "there are no coordinates to aim at" states a
    // reason that is false for both — the panel not having composited is the
    // one that holds for all four actions.
    const err = (() => {
      try {
        assertHarmonyDisplayReady({ width: 0, height: 0, screenOn: true }, "type");
      } catch (e) {
        return e as Error;
      }
      throw new Error("expected a 0x0 display to be refused");
    })();

    expect(err.message).not.toMatch(/display: there are no coordinates to aim at/);
    // The coordinate consequence is still recorded, scoped to the actions that
    // have coordinates rather than given as the reason this call was refused.
    expect(err.message).toMatch(/a tap or swipe would additionally/);
  });

  it("refuses a half-read panel too", () => {
    // One dimension is enough: a 1216x0 read makes every y collapse onto the top
    // row while x still scales, which reads as a working tap on the wrong element
    // rather than an obviously broken one.
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
    // The clock is frozen so the deadline lands on 0 left and not 1ms either
    // side of it, which is the only value telling a `> 0` clamp from a `>= 0`
    // one — and the value that matters, since `execFile` reads `timeout: 0` as
    // NO timeout. Pass it through and the leg it bounds runs unbounded, which
    // is the outcome every caller of this helper is spending a deadline to
    // avoid.
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
