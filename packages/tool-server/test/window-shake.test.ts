import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";

// The animation is one `osascript` invocation reading its script from stdin.
// Capture that script instead of scripting a real window.
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFile: vi.fn(),
}));

// The gate reads flags.json off disk; pin it so the suite never depends on
// whether the developer running it has the flag enabled.
vi.mock("@argent/configuration-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@argent/configuration-core")>()),
  isFeatureEnabled: vi.fn(() => true),
}));

vi.mock("../src/utils/adb", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/adb")>()),
  runAdb: vi.fn(async () => ({ stdout: "Pixel_7_API_34\nOK\n", stderr: "" })),
}));

// Device-set membership normally costs a simctl probe; pin it to the default
// set so the iOS gate stays open unless a test says otherwise.
vi.mock("../src/utils/ios-device-sets", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/ios-device-sets")>()),
  deviceSetForUdid: vi.fn(async () => null),
}));

import { execFile } from "node:child_process";
import { isFeatureEnabled } from "@argent/configuration-core";
import { runAdb } from "../src/utils/adb";
import { deviceSetForUdid } from "../src/utils/ios-device-sets";
import {
  animationScript,
  prepareHostWindowShake,
  MICROINTERACTIONS_FLAG,
  type HostWindowTarget,
} from "../src/utils/window-shake";

type ExecCb = (err: Error | null, stdout: string, stderr: string) => void;

const IOS: HostWindowTarget = { kind: "ios", udid: "UDID-1234", name: "iPhone 16 Pro" };
const ANDROID: HostWindowTarget = { kind: "android", serial: "emulator-5554" };

/**
 * Stand-in for the `osascript` child: records what was piped to stdin and
 * settles the callback with the caller's chosen outcome.
 */
function stubOsascript(
  outcome: { err?: Error & { killed?: boolean; signal?: string }; stderr?: string } = {}
) {
  const scripts: string[] = [];
  vi.mocked(execFile).mockImplementation(((
    _file: string,
    _args: string[],
    _opts: unknown,
    cb: ExecCb
  ) => {
    const child = new EventEmitter() as EventEmitter & { stdin: EventEmitter & { end: unknown } };
    const stdin = new EventEmitter() as EventEmitter & { end: (s: string) => void };
    stdin.end = (script: string) => {
      scripts.push(script);
      // The real callback is async; keep that ordering so an awaiting caller
      // can't observe a resolved promise before stdin has been written.
      setImmediate(() => cb(outcome.err ?? null, "", outcome.stderr ?? ""));
    };
    child.stdin = stdin as never;
    return child;
  }) as never);
  return scripts;
}

/** prepare + begin + settle in one go, for tests that only inspect the outcome. */
async function shakeOnce(target: HostWindowTarget): Promise<void> {
  const shaker = await prepareHostWindowShake(target);
  shaker.begin();
  await shaker.settle();
}

const originalPlatform = process.platform;
const originalIosNoWindow = process.env.ARGENT_SIMULATOR_NO_WINDOW;
const originalAndroidNoWindow = process.env.ARGENT_EMULATOR_NO_WINDOW;

function setPlatform(value: string) {
  Object.defineProperty(process, "platform", { value, configurable: true });
}

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

let stderrWrite: ReturnType<typeof vi.spyOn>;

function warnings(): string[] {
  return stderrWrite.mock.calls
    .map((call: unknown[]) => String(call[0]))
    .filter((line: string) => line.startsWith("[shake:window]"));
}

beforeEach(() => {
  vi.mocked(execFile).mockReset();
  vi.mocked(runAdb).mockClear();
  vi.mocked(isFeatureEnabled).mockReturnValue(true);
  vi.mocked(deviceSetForUdid).mockReset();
  vi.mocked(deviceSetForUdid).mockResolvedValue(null);
  setPlatform("darwin");
  delete process.env.ARGENT_SIMULATOR_NO_WINDOW;
  delete process.env.ARGENT_EMULATOR_NO_WINDOW;
  // Diagnostics go to stderr (stdout carries JSON-RPC); capture them there.
  stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true) as never;
});

afterEach(() => {
  setPlatform(originalPlatform);
  restoreEnv("ARGENT_SIMULATOR_NO_WINDOW", originalIosNoWindow);
  restoreEnv("ARGENT_EMULATOR_NO_WINDOW", originalAndroidNoWindow);
  vi.restoreAllMocks();
});

describe("prepareHostWindowShake — the gate", () => {
  it("yields an inert shaker when the flag is off", async () => {
    vi.mocked(isFeatureEnabled).mockReturnValue(false);
    stubOsascript();
    await shakeOnce(IOS);
    expect(execFile).not.toHaveBeenCalled();
    expect(runAdb).not.toHaveBeenCalled();
  });

  it("reads the flag the CLI writes", async () => {
    stubOsascript();
    await shakeOnce(IOS);
    expect(isFeatureEnabled).toHaveBeenCalledWith(MICROINTERACTIONS_FLAG);
    expect(MICROINTERACTIONS_FLAG).toBe("microinteractions");
  });

  it("does nothing off macOS — the animation is AppleScript", async () => {
    setPlatform("linux");
    stubOsascript();
    await shakeOnce(IOS);
    expect(execFile).not.toHaveBeenCalled();
  });

  it("skips a headless simulator boot, which has no window to move", async () => {
    // Same env var `boot-device` honours before `open -a Simulator.app`.
    process.env.ARGENT_SIMULATOR_NO_WINDOW = "1";
    stubOsascript();
    await shakeOnce(IOS);
    expect(execFile).not.toHaveBeenCalled();
  });

  it("skips a headless emulator boot on ARGENT_EMULATOR_NO_WINDOW", async () => {
    // `-no-window` boots select the headless qemu binary; there is no window.
    process.env.ARGENT_EMULATOR_NO_WINDOW = "true";
    stubOsascript();
    await shakeOnce(ANDROID);
    expect(execFile).not.toHaveBeenCalled();
    expect(runAdb).not.toHaveBeenCalled();
  });

  it("still animates an emulator when the iOS headless var is set", async () => {
    // ARGENT_SIMULATOR_NO_WINDOW is the iOS switch; an emulator window opened
    // regardless of it, so it must not suppress the Android animation.
    process.env.ARGENT_SIMULATOR_NO_WINDOW = "1";
    stubOsascript();
    await shakeOnce(ANDROID);
    expect(execFile).toHaveBeenCalledTimes(1);
  });

  it("still animates a simulator when the Android headless var is set", async () => {
    process.env.ARGENT_EMULATOR_NO_WINDOW = "1";
    stubOsascript();
    await shakeOnce(IOS);
    expect(execFile).toHaveBeenCalledTimes(1);
  });

  it("skips a device from an additional device set — those boots never get a GUI window", async () => {
    vi.mocked(deviceSetForUdid).mockResolvedValue("/tmp/radon-set/Devices");
    stubOsascript();
    await shakeOnce(IOS);
    expect(deviceSetForUdid).toHaveBeenCalledWith("UDID-1234");
    expect(execFile).not.toHaveBeenCalled();
  });

  it("treats a rejecting device-set probe as the default set", async () => {
    vi.mocked(deviceSetForUdid).mockRejectedValue(new Error("simctl exploded"));
    stubOsascript();
    await expect(shakeOnce(IOS)).resolves.toBeUndefined();
    expect(execFile).toHaveBeenCalledTimes(1);
  });
});

describe("prepareHostWindowShake — never fails the shake", () => {
  it("settles and warns when osascript is refused Accessibility permission", async () => {
    stubOsascript({
      err: new Error("Command failed"),
      stderr: "execution error: … is not allowed assistive access. (-1743)",
    });
    await expect(shakeOnce(IOS)).resolves.toBeUndefined();
    expect(warnings().join("\n")).toContain("-1743");
  });

  it("settles when the child cannot be spawned at all", async () => {
    vi.mocked(execFile).mockImplementation((() => {
      throw new Error("EPERM");
    }) as never);
    await expect(shakeOnce(IOS)).resolves.toBeUndefined();
    expect(warnings()).toHaveLength(1);
  });

  it("goes dead after one failed wobble: no further spawns, exactly one warning", async () => {
    stubOsascript({ err: new Error("Command failed"), stderr: "boom" });
    const shaker = await prepareHostWindowShake(IOS);
    shaker.begin();
    await shaker.settle();
    shaker.begin();
    await shaker.settle();
    shaker.begin();
    await shaker.settle();
    expect(execFile).toHaveBeenCalledTimes(1);
    expect(warnings()).toHaveLength(1);
  });

  it("ignores begin() while a wobble is already in flight", async () => {
    // Hold the child open across both begins, then settle it manually.
    const callbacks: ExecCb[] = [];
    vi.mocked(execFile).mockImplementation(((
      _file: string,
      _args: string[],
      _opts: unknown,
      cb: ExecCb
    ) => {
      const child = new EventEmitter() as EventEmitter & { stdin: EventEmitter & { end: unknown } };
      const stdin = new EventEmitter() as EventEmitter & { end: (s: string) => void };
      stdin.end = () => callbacks.push(cb);
      child.stdin = stdin as never;
      return child;
    }) as never);

    const shaker = await prepareHostWindowShake(IOS);
    shaker.begin();
    shaker.begin();
    expect(execFile).toHaveBeenCalledTimes(1);
    callbacks[0]!(null, "", "");
    await shaker.settle();
    // A finished wobble makes room for the next gesture's wobble.
    shaker.begin();
    expect(execFile).toHaveBeenCalledTimes(2);
  });
});

describe("prepareHostWindowShake — iOS window lookup", () => {
  it("title-matches the device's window across Simulator and Device Hub", async () => {
    const scripts = stubOsascript();
    await shakeOnce(IOS);

    const [file, args] = vi.mocked(execFile).mock.calls[0]!;
    expect(file).toBe("/usr/bin/osascript");
    // `-` reads the script from stdin, so nothing has to survive shell quoting.
    expect(args).toEqual(["-"]);
    // The device display name is the needle: with several booted devices each
    // window is titled with its device's name, so window 1 is not safe.
    expect(scripts[0]).toContain('set needles to {"iPhone 16 Pro"}');
    expect(scripts[0]).toContain('every process whose name is "Simulator" or name is "Device Hub"');
    // A shake with no window to move must error out inside AppleScript rather
    // than silently "succeeding" against a stale reference.
    expect(scripts[0]).toContain("if win is missing value then error");
  });

  it("falls back to window 1 of Simulator/Device Hub when the name is unknown", async () => {
    const scripts = stubOsascript();
    await shakeOnce({ kind: "ios", udid: "UDID-1234" });
    expect(scripts[0]).toContain('{"Simulator", "Device Hub"}');
    expect(scripts[0]).not.toContain("set needles to");
  });

  it("returns the window to its exact starting position, twice", async () => {
    // The window server lags behind a burst of moves, so a single re-assert can
    // be overtaken and leave the window a few points adrift.
    const scripts = stubOsascript();
    await shakeOnce(IOS);
    const reasserts = scripts[0]!.match(/set position of win to \{ox, oy\}/g);
    expect(reasserts).toHaveLength(2);
  });
});

describe("prepareHostWindowShake — Android window lookup", () => {
  it("matches the emulator window by console port and AVD name", async () => {
    const scripts = stubOsascript();
    await shakeOnce(ANDROID);

    expect(runAdb).toHaveBeenCalledWith(
      ["-s", "emulator-5554", "emu", "avd", "name"],
      expect.anything()
    );
    // Title is `Android Emulator - <avd>:<port>`; either half identifies it.
    expect(scripts[0]).toContain('set needles to {":5554", "Pixel_7_API_34"}');
    // Several emulators can be running, so the right window is chosen by title
    // rather than by taking window 1 of the first qemu process found.
    expect(scripts[0]).toContain('every process whose name starts with "qemu-system"');
    expect(scripts[0]).not.toContain('{"Simulator", "Device Hub"}');
  });

  it("resolves the needles once per prepare, however many wobbles follow", async () => {
    stubOsascript();
    const shaker = await prepareHostWindowShake(ANDROID);
    shaker.begin();
    await shaker.settle();
    shaker.begin();
    await shaker.settle();
    expect(runAdb).toHaveBeenCalledTimes(1);
    expect(execFile).toHaveBeenCalledTimes(2);
  });

  it("falls back to the port alone when the AVD name can't be read", async () => {
    vi.mocked(runAdb).mockRejectedValueOnce(new Error("console: connection refused"));
    const scripts = stubOsascript();
    await shakeOnce({ kind: "android", serial: "emulator-5556" });
    expect(scripts[0]).toContain('set needles to {":5556"}');
  });

  it("ignores the console's OK verdict line when reading the AVD name", async () => {
    vi.mocked(runAdb).mockResolvedValueOnce({ stdout: "\nMy_AVD\nOK\n", stderr: "" });
    const scripts = stubOsascript();
    await shakeOnce(ANDROID);
    expect(scripts[0]).toContain('"My_AVD"');
    expect(scripts[0]).not.toContain('"OK"');
  });

  it("skips rather than shaking an arbitrary window it cannot identify", async () => {
    // A serial with no console port isn't an emulator; without a needle the
    // lookup would match the first qemu window on the host, which may belong to
    // somebody else's emulator.
    vi.mocked(runAdb).mockRejectedValueOnce(new Error("no console"));
    stubOsascript();
    await shakeOnce({ kind: "android", serial: "R5CT30ABCDE" });
    expect(execFile).not.toHaveBeenCalled();
    expect(warnings().join("\n")).toContain("R5CT30ABCDE");
  });
});

describe("prepareHostWindowShake — timeout recovery", () => {
  it("re-asserts the logged origin after a SIGTERMed run", async () => {
    // The 5s timeout kills the script between moves, so the closing re-asserts
    // never ran. The origin was logged to stderr up front exactly for this.
    const scripts = stubOsascript({
      err: Object.assign(new Error("timed out"), { killed: true, signal: "SIGTERM" }),
      stderr: "ARGENT_WINDOW_ORIGIN:120,45\n",
    });
    await shakeOnce(IOS);
    expect(execFile).toHaveBeenCalledTimes(2);
    expect(scripts[1]).toContain("set position of win to {120, 45}");
    // The repair reuses the exact same window lookup as the animation.
    expect(scripts[1]).toContain('set needles to {"iPhone 16 Pro"}');
    // The marker is bookkeeping; the warning carries the real detail only.
    expect(warnings().join("\n")).not.toContain("ARGENT_WINDOW_ORIGIN");
  });

  it("skips the repair when the kill left no origin marker behind", async () => {
    stubOsascript({
      err: Object.assign(new Error("timed out"), { killed: true, signal: "SIGTERM" }),
      stderr: "",
    });
    await shakeOnce(IOS);
    expect(execFile).toHaveBeenCalledTimes(1);
    expect(warnings()).toHaveLength(1);
  });

  it("skips the repair on a plain script error — the closing re-asserts ran", async () => {
    stubOsascript({ err: new Error("Command failed"), stderr: "no matching window" });
    await shakeOnce(IOS);
    expect(execFile).toHaveBeenCalledTimes(1);
  });
});

describe("animationScript", () => {
  it("escapes a needle so a quote in an AVD name can't break out of the literal", () => {
    const script = animationScript(ANDROID, ['a"b\\c']);
    expect(script).toContain('"a\\"b\\\\c"');
  });

  it("carries the wobble as precomputed offsets — no in-script trigonometry", () => {
    const script = animationScript(IOS, ["iPhone 16 Pro"]);
    expect(script).toContain("on run");
    expect(script).toContain("end run");
    // AMPLITUDE and STEPS are compile-time constants, so the damped sine is
    // evaluated in TypeScript; the script only replays the integer offsets.
    expect(script).not.toContain("sinOf");
    expect(script).toContain("repeat with pair in offsets");
    const offsets = script.match(/set offsets to \{(.*)\}/)?.[1] ?? "";
    const pairs = offsets.match(/\{-?\d+, -?\d+\}/g) ?? [];
    expect(pairs).toHaveLength(61); // STEPS + 1 moves, i = 0..60
    expect(pairs[0]).toBe("{0, 0}"); // sin(0) on both axes
    // The wobble must actually move the window in both directions.
    expect(pairs.some((p) => /\{-\d+, /.test(p))).toBe(true);
    expect(pairs.some((p) => /\{[1-9]\d*, /.test(p))).toBe(true);
  });

  it("logs the origin marker before the first move so a kill is repairable", () => {
    const script = animationScript(IOS, ["iPhone 16 Pro"]);
    const markerAt = script.indexOf("ARGENT_WINDOW_ORIGIN:");
    const firstMoveAt = script.indexOf("repeat with pair in offsets");
    expect(markerAt).toBeGreaterThan(-1);
    expect(markerAt).toBeLessThan(firstMoveAt);
  });
});
