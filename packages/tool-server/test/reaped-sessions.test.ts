/**
 * The breadcrumb store's key semantics. Three tools read it — screen-recording
 * stop, native-profiler stop, debugger-log-registry — and each was tested only
 * against its own kind and its own single spelling, so nothing pinned what the
 * key itself does: scope by kind, and fold case the way every device-id lookup
 * in the stop tools does.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  recordReapedSession,
  takeReapedSession,
  describeReapedSession,
  __resetReapedSessionsForTesting,
} from "../src/utils/reaped-sessions";

const UDID = "6DBF83B4-0000-0000-0000-000000000000";

beforeEach(() => {
  __resetReapedSessionsForTesting();
});

describe("the reaped-session key", () => {
  it("scopes by kind, so one device's three captures do not collide", () => {
    // A teardown reaps all three of a device's capture services at once, and
    // each owner reads back separately. An unscoped key would let the
    // screen-recording read consume the profiler's explanation.
    recordReapedSession("screen-recording", UDID, "the video");
    recordReapedSession("native-profiler", UDID, "the trace");
    recordReapedSession("js-runtime-debugger", UDID, "the console log");

    expect(takeReapedSession("screen-recording", UDID)?.salvage).toBe("the video");
    // …and taking one leaves the other two intact.
    expect(takeReapedSession("native-profiler", UDID)?.salvage).toBe("the trace");
    expect(takeReapedSession("js-runtime-debugger", UDID)?.salvage).toBe("the console log");
  });

  it("folds case, so a device read back in another spelling still finds it", () => {
    // Device ids reach the two sides from different places — an iOS UDID comes
    // back uppercase from simctl and lowercase from some tool args — and every
    // id lookup in the stop tools already compares case-insensitively. A
    // case-sensitive key here would silently strand the explanation.
    recordReapedSession("native-profiler", UDID.toUpperCase(), "the trace");

    expect(takeReapedSession("native-profiler", UDID.toLowerCase())).toBeDefined();
    // Consumed once, whichever spelling asked.
    expect(takeReapedSession("native-profiler", UDID.toUpperCase())).toBeUndefined();
  });

  it("reports the device id in the spelling the DISPOSER used, not the reader's", () => {
    // The message names the device; it must name the one the teardown actually
    // reaped rather than echoing back whatever the reader happened to type.
    recordReapedSession("screen-recording", UDID.toUpperCase());

    const entry = takeReapedSession("screen-recording", UDID.toLowerCase())!;
    expect(describeReapedSession(entry, "screen recording")).toContain(UDID.toUpperCase());
  });

  it("keeps the newest record when one kind+device is reaped twice", () => {
    recordReapedSession("screen-recording", UDID, "first");
    recordReapedSession("screen-recording", UDID, "second");

    expect(takeReapedSession("screen-recording", UDID)?.salvage).toBe("second");
    expect(takeReapedSession("screen-recording", UDID)).toBeUndefined();
  });

  it("does not pin the teardown on one caller the disposer cannot have seen", () => {
    // A blueprint's dispose() is called by Registry._teardown with no caller, so
    // nothing that writes a breadcrumb knows which tool triggered it.
    // stop-all-simulator-servers is the common one, but stop-simulator-server on
    // Chromium cascades into the debugger through ChromiumCdp, and
    // react-profiler-start { force: true } disposes it to reclaim the session —
    // so the message names the family rather than asserting one member.
    recordReapedSession("js-runtime-debugger", UDID);

    const message = describeReapedSession(
      takeReapedSession("js-runtime-debugger", UDID)!,
      "JS-runtime debugger session"
    );
    expect(message).toContain("stop-all-simulator-servers");
    expect(message).toContain("stop-simulator-server on Chromium");
    expect(message).toContain("react-profiler-start");
    // The claim that made it wrong two ways out of three.
    expect(message).not.toMatch(/torn down \d+s ago by a stop-all-simulator-servers/);
  });

  it("omits the salvage clause entirely when nothing survived", () => {
    recordReapedSession("native-profiler", UDID);

    const entry = takeReapedSession("native-profiler", UDID)!;
    expect(entry.salvage).toBeUndefined();
    const message = describeReapedSession(entry, "native profiling session");
    expect(message).toContain("It was not a session that never started.");
    expect(message).toMatch(/never started\.$/);
  });
});
