import { describe, it, expect, vi, beforeEach } from "vitest";
import { FAILURE_CODES, getFailureSignal } from "@argent/registry";

// Stub the adb round-trip (capture the shell command strings) but keep the real
// `shellQuote` so the text-injection quoting is exercised, not mocked away.
const adbShell = vi.fn();
vi.mock("../src/utils/adb", async (importActual) => {
  const actual = await importActual<typeof import("../src/utils/adb")>();
  return { ...actual, adbShell: (...args: unknown[]) => adbShell(...args) };
});
// Single VVD: the input path derives its serial from the emulator console port.
vi.mock("../src/utils/vega-automation", () => ({
  emulatorSerial: vi.fn(async () => ({ serial: "emulator-5554", consolePort: 5554 })),
}));

import { injectVegaButtons, injectVegaNamedKey, injectVegaText } from "../src/utils/vega-input";

// Real device output (verified on a VVD): get_screen_size prints this when
// developer mode is ON; when OFF the dev-shell service is down and every
// inputd-cli command (get_screen_size included) returns the error below.
const SIZE_OK = "1920 x 1080";
const DEV_SHELL_DOWN = "Error: No running instances of com.amazon.dev.shell.service found";

/** The single adb shell script for the most recent injection. */
function lastScript(): string {
  return adbShell.mock.calls.at(-1)?.[1] as string;
}

/** Await a promise expected to reject and return the thrown Error. */
async function captureError(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (e) {
    return e as Error;
  }
  throw new Error("expected the promise to reject, but it resolved");
}

beforeEach(() => {
  adbShell.mockReset();
  // Default: developer mode on, channel live.
  adbShell.mockResolvedValue(SIZE_OK);
});

describe("injectViaInputd — developer-mode / liveness gate", () => {
  it("runs the presses when get_screen_size reports a live channel", async () => {
    await expect(injectVegaButtons(["down", "select"])).resolves.toBeUndefined();
    const script = lastScript();
    expect(script).toContain("inputd-cli get_screen_size");
    // Presses are gated behind the size-shape `case` so a dead channel fails fast.
    expect(script).toContain('case "$sz" in *[0-9]*x*[0-9]*)');
    expect(script).toContain("button_press KEY_DOWN >/dev/null 2>&1 || true");
    expect(script).toContain("sleep 0.3");
    // Path order preserved: down before select(=ENTER).
    expect(script.indexOf("KEY_DOWN")).toBeLessThan(script.indexOf("KEY_ENTER"));
  });

  it("fails with an actionable, classified error when developer mode is off", async () => {
    adbShell.mockResolvedValue(DEV_SHELL_DOWN);
    const err = await captureError(injectVegaButtons(["down"]));
    expect(err.message).toMatch(/developer mode is off/i);
    expect(err.message).toContain("vsm developer-mode enable");
    // Classified for telemetry, not a bare 500.
    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.VEGA_INPUT_UNAVAILABLE);
  });

  it("uses the generic channel error (not the dev-mode hint) for an unrelated dead channel", async () => {
    adbShell.mockResolvedValue(""); // no <W>x<H>, no dev-shell signature
    const err = await captureError(injectVegaButtons(["down"]));
    expect(err.message).toMatch(/input channel is not usable/i);
    expect(err.message).not.toMatch(/developer mode/i);
    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.VEGA_INPUT_UNAVAILABLE);
  });
});

describe("injectVegaText", () => {
  it("rejects embedded newlines (send_text would truncate the tail)", async () => {
    await expect(injectVegaText("line1\nline2")).rejects.toThrow(/newline/i);
    // Guard runs before any device round-trip.
    expect(adbShell).not.toHaveBeenCalled();
  });

  it("shell-quotes the text so a quote/space can't break out of the command", async () => {
    await injectVegaText("it's a test");
    expect(lastScript()).toContain("send_text 'it'\\''s a test'");
  });
});

describe("injectVegaNamedKey", () => {
  it("maps a known key to its KEY_ code", async () => {
    await injectVegaNamedKey("enter");
    expect(lastScript()).toContain("button_press KEY_ENTER");
  });

  it("throws on an unknown key instead of silently dropping it", async () => {
    // f1–f12 are mapped; f13 is the first out-of-range function key.
    await expect(injectVegaNamedKey("f13")).rejects.toThrow(/Unknown Vega key/i);
    expect(adbShell).not.toHaveBeenCalled();
  });
});
