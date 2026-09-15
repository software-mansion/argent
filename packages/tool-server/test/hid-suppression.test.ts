import { describe, expect, it, vi } from "vitest";

vi.mock("@argent/native-devtools-ios", () => ({
  simulatorServerBinaryPath: () => "/fake/bin/simulator-server",
}));

import { __testing } from "../src/utils/hid-suppression";

const { DELIVERY_TRACES, hidCaveat, isLogPreamble, matchTraces } = __testing;

/**
 * Real `backboardd` lines, captured from a live simulator while the probe was
 * sending release-without-press events, one per service.
 *
 * These are verbatim on purpose. The bug this file exists to prevent was keying
 * the probe on traces that only a *real press* produces, which made every
 * healthy simulator report that its taps were broken. Nothing but a fixture of
 * genuine orphan-release lines catches that — the code typechecks either way.
 */
const HEALTHY_ORPHAN_RELEASE_LINES = [
  "2026-09-14 22:41:03.118 Df backboardd[123:4a1] [com.apple.BackBoard:TouchEvents] didn't see a previous touch down or range-in event for pathIndex:0; skipping event",
  "2026-09-14 22:41:03.119 Df backboardd[123:4a1] [com.apple.BackBoard:Button] Home page:0xC usage:0x40 downEvent:0 up",
  "2026-09-14 22:41:03.121 Df backboardd[123:4a1] [com.apple.BackBoard:Keyboard] missing a sequence for <senderID: 0x1234>",
];

/** What a *real* press logs. The probe never produces these. */
const REAL_PRESS_LINES = [
  "2026-09-14 22:41:09.400 Df backboardd[123:4a1] [com.apple.BackBoard:TouchEvents] contact 1 presence: touching",
  "2026-09-14 22:41:09.401 Df backboardd[123:4a1] [com.apple.BackBoard:Button] Home page:0xC usage:0x40 downEvent:1 down",
  "2026-09-14 22:41:09.402 Df SpringBoard[456:5b2] [com.apple.UIKit:KeyboardUI] Keyboard receives keyEvent",
];

describe("hid-suppression — delivery traces", () => {
  it("sees all three services in real orphan-release output", () => {
    expect(matchTraces(HEALTHY_ORPHAN_RELEASE_LINES)).toEqual({
      touch: true,
      buttons: true,
      keyboard: true,
    });
  });

  it("sees nothing when the services are suppressed", () => {
    expect(matchTraces([])).toEqual({ touch: false, buttons: false, keyboard: false });
  });

  // The regression: every trace must be one the probe's own events actually
  // produce. Keyed on press-only traces, `touch` could never be true and
  // `keyboard` was true only via an unrelated key-down frame kick on attach.
  it("does not key any service on a trace only a real press produces", () => {
    expect(matchTraces(REAL_PRESS_LINES)).toEqual({
      touch: false,
      buttons: false,
      keyboard: false,
    });
  });

  // `downEvent:0` appears on touch lines too, so an unscoped match would report
  // a live digitizer whenever the buttons happen to be alive.
  it("requires the subsystem bracket, not just the trace text", () => {
    const buttonsOnly = [
      "2026-09-14 22:41:03.119 Df backboardd[123:4a1] [com.apple.BackBoard:Button] Home page:0xC usage:0x40 downEvent:0 up",
    ];
    expect(matchTraces(buttonsOnly).touch).toBe(false);
    expect(matchTraces(buttonsOnly).buttons).toBe(true);
  });

  it("scopes every trace to its own subsystem", () => {
    for (const [service, [scope, trace]] of Object.entries(DELIVERY_TRACES)) {
      expect(scope, `${service} scope`).toMatch(/^\[com\.apple\./);
      expect(trace.length, `${service} trace`).toBeGreaterThan(0);
    }
  });
});

describe("hid-suppression — log preamble", () => {
  // `log show` echoes its own predicate back in the preamble, so a trace string
  // that also appears in the filter would match the filter text itself and
  // report every simulator healthy, dead ones included.
  it("drops the lines log show prints about itself", () => {
    expect(isLogPreamble('Filtering the log data using "process == \\"backboardd\\""')).toBe(true);
    expect(isLogPreamble("Timestamp                       Ty Process[PID:TID]")).toBe(true);
    expect(isLogPreamble("Skipping info and debug messages, pass --info…")).toBe(true);
    expect(isLogPreamble(HEALTHY_ORPHAN_RELEASE_LINES[0]!)).toBe(false);
  });
});

describe("hid-suppression — caveat wording", () => {
  it("says nothing when every service is alive", () => {
    expect(hidCaveat({ touch: true, buttons: true, keyboard: true })).toBeUndefined();
  });

  it.each([
    [{ touch: false, buttons: true, keyboard: true }, "taps and gestures are not reaching"],
    [{ touch: true, buttons: false, keyboard: true }, "hardware buttons are not reaching"],
    [{ touch: true, buttons: true, keyboard: false }, "typed text is not reaching"],
    [
      { touch: true, buttons: false, keyboard: false },
      "hardware buttons and typed text are not reaching",
    ],
    [
      { touch: false, buttons: false, keyboard: false },
      "taps and gestures, hardware buttons and typed text are not reaching",
    ],
  ])("names exactly what is dead, with the right verb: %j", (health, expected) => {
    expect(hidCaveat(health)).toContain(expected);
  });

  it("tells the agent what to do about it", () => {
    const caveat = hidCaveat({ touch: true, buttons: false, keyboard: false });
    expect(caveat).toContain("boot-device");
    expect(caveat).toContain("force=true");
  });
});
