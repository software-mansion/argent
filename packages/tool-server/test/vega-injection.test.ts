import { describe, it, expect, vi, beforeEach } from "vitest";
import { FAILURE_CODES, FailureError, getFailureSignal } from "@argent/registry";

// Stub the adb round-trip (capture the shell command strings) but keep the real
// `shellQuote` so the text-injection quoting is exercised, not mocked away.
const adbShell = vi.fn();
vi.mock("../src/utils/adb", async (importActual) => {
  const actual = await importActual<typeof import("../src/utils/adb")>();
  return { ...actual, adbShell: (...args: unknown[]) => adbShell(...args) };
});
// Single VVD: the input path derives its serial from the emulator console port.
const { emulatorSerial } = vi.hoisted(() => ({
  emulatorSerial: vi.fn(async () => ({ serial: "emulator-5554", consolePort: 5554 })),
}));
vi.mock("../src/utils/vega-automation", () => ({ emulatorSerial }));

import {
  NAMED_KEYCODES,
  VEGA_CLEAR_TIMEOUT_MS,
  injectVegaButtons,
  injectVegaClear,
  injectVegaNamedKey,
  injectVegaText,
} from "../src/utils/vega-input";
import { CLEAR_KEY_PAIRS } from "../src/tools/keyboard/key-codes";

// Real device output (verified on a VVD): get_screen_size prints this when
// developer mode is ON; when OFF the dev-shell service is down and every
// inputd-cli command (get_screen_size included) returns the error below.
const SIZE_OK = "1920 x 1080";
const DEV_SHELL_DOWN = "Error: No running instances of com.amazon.dev.shell.service found";

/** The single adb shell script for the most recent injection. */
function lastScript(): string {
  return adbShell.mock.calls.at(-1)?.[1] as string;
}

/** An adb failure shaped like `runAdb`'s: only those can have half-emptied it. */
function adbFailure(message: string): FailureError {
  return new FailureError(message, {
    error_code: FAILURE_CODES.ANDROID_ADB_COMMAND_FAILED,
    failure_stage: "android_adb_command",
    failure_area: "tool_server",
    error_kind: "subprocess",
  });
}

/**
 * The message `formatSubprocessFailure` really builds for a failed clear: the
 * whole argv — script and 200 presses — and the reason on the SAME line. A
 * fixture that puts the reason on a second line cannot see a redaction that runs
 * to the newline.
 */
function realAdbFailureMessage(reason: string): string {
  const presses = Array.from(
    { length: 200 },
    () => "button_press KEY_BACKSPACE holdDuration 20"
  ).join(" , ");
  return (
    `adb -s emulator-5554 shell sz=$(inputd-cli get_screen_size 2>&1); ` +
    `case "$sz" in *[0-9]*x*[0-9]*) out=$(inputd-cli series ${presses} 2>&1); ;; esac ` +
    `failed: adb: error: failed to get feature set: ${reason}`
  );
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

// What a healthy clear burst prints back: the gate's size line, then the count
// of presses `inputd-cli` reported actually performing.
const CLEAR_OK = `${SIZE_OK}\nARGENT_VEGA_INJECTED=200`;

beforeEach(() => {
  adbShell.mockReset();
  emulatorSerial.mockResolvedValue({ serial: "emulator-5554", consolePort: 5554 });
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
    // Capital "I" so the fixture also pins the case at the `send_text` sink:
    // with an all-lowercase string a `.toLowerCase()` here emits the identical
    // command, and the keyboard backend's `typed` echoes the request rather
    // than what was sent — the same hole the android `input text` test names.
    await injectVegaText("It's a test");
    expect(lastScript()).toContain("send_text 'It'\\''s a test'");
  });
});

describe("injectVegaNamedKey", () => {
  it("maps a known key to its KEY_ code", async () => {
    await injectVegaNamedKey("enter");
    expect(lastScript()).toContain("button_press KEY_ENTER");
  });

  it("presses each named key with its own keycode (not one hardcoded value)", async () => {
    // Half of a two-part scheme, and vacuous without the other half: this
    // compares the emitted code against the same map the resolver reads, so it
    // pins that the lookup READS the map, for every entry in it — not that any
    // entry holds the right value. vega-input.test.ts pins all 24 literals; it
    // used to spot-check 8, which left a wrong value for `backspace`, `delete`,
    // `tab`, `space`, three of the arrows or f2–f10 satisfying both tests.
    //
    // What this half catches is a lookup that resolved every name to one code —
    // the realistic fold/refactor slip. Only `enter` and `arrow-down` are
    // pressed by other tests in this file, so such a fold is green everywhere
    // else while `backspace`, `escape`, `tab` and f1–f12 all submit the field
    // instead of navigating. Twin of the android exhaustive test.
    for (const [name, keycode] of Object.entries(NAMED_KEYCODES)) {
      adbShell.mockClear();
      adbShell.mockResolvedValue(SIZE_OK);
      await injectVegaNamedKey(name);
      expect(lastScript().match(/button_press \S+/g), `wrong keycode for "${name}"`).toEqual([
        `button_press ${keycode}`,
      ]);
    }
  });

  it("case-folds the named key, like every other backend", async () => {
    // `keyboard`'s `key` is a free `z.string()`, and the sim-server/android
    // backends fold case, so an uppercase name must not read as unknown here.
    await injectVegaNamedKey("Arrow-Down");
    expect(lastScript()).toContain(`button_press ${NAMED_KEYCODES["arrow-down"]}`);
  });

  it("names the offending key when it is unknown, instead of dropping it", async () => {
    // f1–f12 are mapped; f13 is the first out-of-range function key.
    // The NAME is part of the contract — it is what a caller needs to retry, and
    // a bare `/Unknown Vega key/` prefix leaves stripping it green here, which
    // is the only place this backend's message is asserted at all.
    await expect(injectVegaNamedKey("f13")).rejects.toThrow(/Unknown Vega key "f13"/);
    expect(adbShell).not.toHaveBeenCalled();
  });
});

describe("injectVegaClear — the delete burst", () => {
  beforeEach(() => {
    adbShell.mockResolvedValue(CLEAR_OK);
  });

  it("sends CLEAR_KEY_PAIRS * 2 backspaces as ONE `inputd-cli series`", async () => {
    await injectVegaClear();
    const script = lastScript();
    // One `inputd-cli` process for the whole burst, not 200 of them: the
    // per-press form costs ~284ms each on a VVD (57s for the burst), and the
    // `; sleep 0.3;` separator this file pins for `tv-remote` would add another
    // minute on top.
    expect(script.match(/inputd-cli series/g)).toHaveLength(1);
    expect(script).not.toContain("sleep 0.3");
    const presses = script.match(/button_press KEY_BACKSPACE/g) ?? [];
    expect(presses).toHaveLength(CLEAR_KEY_PAIRS * 2);
    // No forward half — see `injectVegaClear`: KEY_DELETE deletes BACKWARD on
    // Vega, so interleaving it would double the cost and reach nothing new.
    expect(script).not.toContain("KEY_DELETE");
    // Still gated on the channel being live, like every other injection.
    expect(script).toContain("inputd-cli get_screen_size");
    expect(script).toContain('case "$sz" in *[0-9]*x*[0-9]*)');
  });

  it("separates the actions with commas, which is what makes them 200 commands", async () => {
    // `series` splits its argv words on commas. Joined with plain spaces the
    // whole burst collapses into ONE malformed action and the field is not
    // cleared — while every count-based assertion above still passes.
    await injectVegaClear();
    const args = lastScript().split("inputd-cli series ")[1]!.split(" 2>&1")[0]!;
    expect(args.split(" , ")).toHaveLength(CLEAR_KEY_PAIRS * 2);
  });

  it("holds each press briefly, so the burst is seconds rather than a minute", async () => {
    await injectVegaClear();
    expect(lastScript()).toContain("button_press KEY_BACKSPACE holdDuration 20");
  });

  it("runs under the clear's own budget, not the per-press one", async () => {
    // The per-press formula sizes a `tv-remote` path from its 0.3s settles; with
    // one subcommand it yields ~15s, which the 9.4s burst can outgrow on a
    // loaded guest. The burst gets Android's 90s instead — pinned as a NUMBER
    // as well as by identity, so shrinking the constant is not silently green.
    expect(VEGA_CLEAR_TIMEOUT_MS).toBe(90_000);
    await injectVegaClear();
    const opts = adbShell.mock.calls.at(-1)?.[2] as { timeoutMs?: number };
    expect(opts.timeoutMs).toBe(VEGA_CLEAR_TIMEOUT_MS);
  });

  it("hands the request's abort down to adb", async () => {
    const controller = new AbortController();
    await injectVegaClear(controller.signal);
    const opts = adbShell.mock.calls.at(-1)?.[2] as { signal?: AbortSignal };
    expect(opts.signal).toBe(controller.signal);
  });

  it("counts the presses the DEVICE reports performing, not the ones it was sent", async () => {
    // `inputd-cli` exits 0 whatever it makes of its arguments — an unknown
    // option prints nothing and still succeeds — and the exit status of the
    // presses is discarded anyway. Counting its own "Injecting Button Press"
    // lines on-device is the only proof the burst did something: measured on a
    // VVD, a good burst reports 200 and a series with an unsupported option
    // reports 0.
    await injectVegaClear();
    expect(lastScript()).toContain("grep -c 'Injecting Button Press'");
    expect(lastScript()).toContain("ARGENT_VEGA_INJECTED=%s");
  });

  it("fails when the device performed NONE of the presses", async () => {
    // The silent failure this verification exists for: adb accepted the command,
    // the channel was live, and the field is untouched. Reported as a success it
    // is worse than the refusal this backend used to give.
    adbShell.mockResolvedValueOnce(`${SIZE_OK}\nARGENT_VEGA_INJECTED=0`);
    const err = await captureError(injectVegaClear());
    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.KEYBOARD_CLEAR_UNCONFIRMED);
    expect(err.message).toMatch(/injected nothing/);
    expect(err.message).toMatch(/the focused field is unchanged/);
    expect(err.message).not.toMatch(/PARTIALLY/);
    // A capability verdict: this device's `inputd-cli` does not accept the
    // command, so retrying it is pointless.
    expect(getFailureSignal(err)?.error_kind).toBe("unsupported");
  });

  it("fails when the device performed only SOME of them", async () => {
    adbShell.mockResolvedValueOnce(`${SIZE_OK}\nARGENT_VEGA_INJECTED=137`);
    const err = await captureError(injectVegaClear());
    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.KEYBOARD_CLEAR_UNCONFIRMED);
    expect(err.message).toMatch(/137 of the 200/);
    expect(err.message).toMatch(/may be PARTIALLY emptied/);
    // NOT "unsupported": this arm's own repair is "read it back and retry", the
    // opposite of "stop trying on this device", and one bucket made them
    // indistinguishable in telemetry.
    expect(getFailureSignal(err)?.error_kind).toBe("subprocess");
  });

  it("carries the device's OWN words back, not the count the sentence already gives", async () => {
    // The `injected === 0` repair asks the operator to "report the device
    // build", and "Device output:" was the only place a reason could travel.
    // `$out` was consumed by `grep -c` and never printed, so what came back was
    // the screen size and the count — the two things already in the sentence.
    adbShell.mockResolvedValueOnce(
      `${SIZE_OK}\nARGENT_VEGA_INJECTED=0\ninputd-cli: unknown option 'holdDuration'`
    );
    const err = await captureError(injectVegaClear());
    expect(err.message).toMatch(/Device output: inputd-cli: unknown option 'holdDuration'/);
    expect(err.message).not.toMatch(/Device output:.*ARGENT_VEGA_INJECTED/);
    expect(err.message).not.toMatch(/Device output:.*1920 x 1080/);
    // And the script has to ask for it: the count alone cannot say why.
    expect(lastScript()).toContain("grep -v 'Injecting Button Press'");
  });

  it("says so when the device printed nothing but its own press lines", async () => {
    adbShell.mockResolvedValueOnce(`${SIZE_OK}\nARGENT_VEGA_INJECTED=0`);
    const err = await captureError(injectVegaClear());
    expect(err.message).toMatch(/printed nothing but its own press lines/);
  });

  it("names the absence when the daemon banner was adb's ONLY output", async () => {
    // Same shape as the Android sibling: the banner is stripped, nothing
    // follows the `failed:`, and the caller was handed a dangling
    // "Underlying failure: adb … failed:" naming no failure at all.
    adbShell.mockRejectedValueOnce(
      new Error(
        "adb -s vega-0 shell inputd-cli series button_press KEY_DELETE holdDuration 1 , " +
          "button_press KEY_DELETE holdDuration 1 failed: " +
          "* daemon not running; starting now at tcp:5037\n* daemon started successfully"
      )
    );
    const err = await captureError(injectVegaClear());
    expect(err.message).not.toMatch(/failed:\s*$/);
    expect(err.message).toMatch(/adb printed only its daemon banner before it stopped/);
  });

  it("fails when the count never came back at all", async () => {
    // A device whose shell dropped the marker line is not a cleared field
    // either, and the old code would have called it a success.
    adbShell.mockResolvedValueOnce(SIZE_OK);
    const err = await captureError(injectVegaClear());
    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.KEYBOARD_CLEAR_UNCONFIRMED);
    // It shares the partial arm's wording, so it shares its kind too.
    expect(getFailureSignal(err)?.error_kind).toBe("subprocess");
  });

  it("reports a failed burst as possibly PARTIAL, keeping adb's own diagnosis", async () => {
    // The burst is not atomic, so a caller told only "adb failed" reads that as
    // "nothing happened" and types over a field that is now shorter. The command
    // line is ~9KB of `button_press`, which `formatSubprocessFailure` and node's
    // own nested "Command failed:" would each repeat into agent context — but
    // the redaction has to stop at the press list: `formatSubprocessFailure`
    // puts `<argv> failed: <stderr>` on ONE line, so a redaction running to the
    // newline ate the diagnosis with it.
    // "connection reset by peer", not "device offline": the latter is one of the
    // adb CLIENT's own pre-delivery refusals, which is classified as "never
    // reached" — the branch below it.
    adbShell.mockRejectedValueOnce(adbFailure(realAdbFailureMessage("connection reset by peer")));
    const err = await captureError(injectVegaClear());
    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.KEYBOARD_CLEAR_UNCONFIRMED);
    expect(err.message).toMatch(/may be PARTIALLY\s+emptied/);
    expect(err.message).toContain("<the delete burst>");
    expect(err.message).not.toContain("button_press KEY_BACKSPACE");
    // The half that matters to a caller.
    expect(err.message).toContain("connection reset by peer");
  });

  it("keeps the diagnosis a COLD adb puts on the next line", async () => {
    // Two `* daemon …` lines precede the error on the first adb call of a
    // tool-server's life, and with them stripped the head ends at its own
    // `failed:`.
    adbShell.mockRejectedValueOnce(
      adbFailure(
        "* daemon not running; starting now at tcp:5037\n* daemon started successfully\n" +
          `${realAdbFailureMessage("").replace(/ failed:.*$/, " failed:")}\n` +
          "adb: error: failed to get feature set: device unauthorized"
      )
    );
    const err = await captureError(injectVegaClear());
    expect(err.message).toContain("device unauthorized");
    expect(err.message).not.toContain("daemon not running");
  });

  it("keeps the exit code and kill signal of the failure it re-states", async () => {
    // The 90s cap kills the adb child with SIGKILL — the failure the budget
    // exists to bound — and by this point `runAdb` has already wrapped the raw
    // error, so a spread of it recovers nothing (a `FailureError` keeps its
    // signal behind a symbol). Without the explicit copy the SIGKILL is
    // unrecoverable from telemetry.
    adbShell.mockRejectedValueOnce(
      new FailureError("adb ... failed: Command failed", {
        error_code: FAILURE_CODES.ANDROID_ADB_COMMAND_FAILED,
        failure_stage: "android_adb_command",
        failure_area: "tool_server",
        error_kind: "timeout",
        failure_command: "adb",
        failure_signal: "SIGKILL",
        failure_exit_code: 1,
      })
    );
    const err = await captureError(injectVegaClear());
    expect(getFailureSignal(err)?.failure_signal).toBe("SIGKILL");
    expect(getFailureSignal(err)?.failure_exit_code).toBe(1);
    expect(getFailureSignal(err)?.failure_command).toBe("adb");
  });

  it("says NOTHING was sent when the request was already aborted", async () => {
    // The one case the code can prove: `execFile` with an already-aborted signal
    // never spawns the child. A mid-flight abort rejects with the SAME shape
    // (`ABORT_ERR`, no `killed`/`signal`), so WHEN the flag is read is the only
    // discriminator — which is why the serial is resolved before it.
    const controller = new AbortController();
    controller.abort();
    adbShell.mockRejectedValueOnce(adbFailure("aborted"));
    const err = await captureError(injectVegaClear(controller.signal));
    expect(err.message).toMatch(/NO delete key was sent and the focused field is unchanged/);
    expect(err.message).not.toMatch(/PARTIALLY/);
  });

  it("samples that abort AFTER the device lookup, not before it", async () => {
    // `emulatorSerial` polls `adb devices` for up to 8s. Sampled at entry, an
    // abort landing inside that window left the flag false and the failure was
    // reported as "may be PARTIALLY emptied" for a field nothing had touched.
    const controller = new AbortController();
    emulatorSerial.mockImplementationOnce(async () => {
      controller.abort();
      return { serial: "emulator-5554", consolePort: 5554 };
    });
    adbShell.mockRejectedValueOnce(adbFailure("aborted"));
    const err = await captureError(injectVegaClear(controller.signal));
    expect(err.message).toMatch(/NO delete key was sent/);
    expect(err.message).not.toMatch(/PARTIALLY/);
  });

  it("says NOTHING was sent when adb refused the device outright", async () => {
    // The adb CLIENT prints this before it delivers anything, so the field is
    // untouched — and the repair is a device one, not a field one. Told the
    // field "may be PARTIALLY emptied", an agent re-reads it with a `describe`
    // that fails on the same dead device.
    adbShell.mockRejectedValueOnce(adbFailure("adb: device 'emulator-5554' not found"));
    const err = await captureError(injectVegaClear());
    expect(err.message).toMatch(/never reached emulator-5554/);
    expect(err.message).toMatch(/check `list-devices`/);
    expect(err.message).not.toMatch(/PARTIALLY/);
  });

  it("keeps the developer-mode diagnosis instead of restating it as a half-clear", async () => {
    // `get_screen_size` runs BEFORE the `case` gate lets any press through, so a
    // dead channel means nothing was injected — and its message is the one that
    // names the fix (`vsm developer-mode enable`). Restating it as "the field
    // may be PARTIALLY emptied" would bury that and send the caller to `describe`
    // on a device whose input channel is down.
    adbShell.mockResolvedValueOnce(DEV_SHELL_DOWN);
    const err = await captureError(injectVegaClear());
    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.VEGA_INPUT_UNAVAILABLE);
    expect(err.message).toMatch(/developer mode is off/);
  });

  it("passes a pre-injection failure through instead of restating it", async () => {
    // `emulatorSerial` runs before the adb command: no running VVD, or two of
    // them, fails there with its own code and its own repair. Restated as a
    // half-emptied field, that fix is buried under a `describe` the caller
    // cannot run either.
    const notFound = new FailureError("No running Vega Virtual Device found.", {
      error_code: FAILURE_CODES.VEGA_DEVICE_NOT_FOUND,
      failure_stage: "vega_discover_console_port",
      failure_area: "tool_server",
      error_kind: "not_found",
    });
    emulatorSerial.mockRejectedValueOnce(notFound);
    const err = await captureError(injectVegaClear());
    expect(err).toBe(notFound);
    expect(err.message).not.toMatch(/PARTIALLY/);
  });
});
