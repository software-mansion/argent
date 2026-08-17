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

import { execFile } from "node:child_process";
import { isFeatureEnabled } from "@argent/configuration-core";
import { runAdb } from "../src/utils/adb";
import {
  animationScript,
  shakeHostWindow,
  MICROINTERACTIONS_FLAG,
} from "../src/utils/window-shake";

type ExecCb = (err: Error | null, stdout: string, stderr: string) => void;

/**
 * Stand-in for the `osascript` child: records what was piped to stdin and
 * settles the callback with the caller's chosen outcome.
 */
function stubOsascript(outcome: { err?: Error; stderr?: string } = {}) {
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

const originalPlatform = process.platform;
const originalNoWindow = process.env.ARGENT_SIMULATOR_NO_WINDOW;

function setPlatform(value: string) {
  Object.defineProperty(process, "platform", { value, configurable: true });
}

beforeEach(() => {
  vi.mocked(execFile).mockReset();
  vi.mocked(runAdb).mockClear();
  vi.mocked(isFeatureEnabled).mockReturnValue(true);
  setPlatform("darwin");
  delete process.env.ARGENT_SIMULATOR_NO_WINDOW;
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  setPlatform(originalPlatform);
  if (originalNoWindow === undefined) delete process.env.ARGENT_SIMULATOR_NO_WINDOW;
  else process.env.ARGENT_SIMULATOR_NO_WINDOW = originalNoWindow;
  vi.restoreAllMocks();
});

describe("shakeHostWindow — the gate", () => {
  it("does nothing at all when the flag is off", async () => {
    vi.mocked(isFeatureEnabled).mockReturnValue(false);
    stubOsascript();
    await shakeHostWindow({ kind: "ios" });
    expect(execFile).not.toHaveBeenCalled();
  });

  it("reads the flag the CLI writes", async () => {
    stubOsascript();
    await shakeHostWindow({ kind: "ios" });
    expect(isFeatureEnabled).toHaveBeenCalledWith(MICROINTERACTIONS_FLAG);
    expect(MICROINTERACTIONS_FLAG).toBe("microinteractions");
  });

  it("does nothing off macOS — the animation is AppleScript", async () => {
    setPlatform("linux");
    stubOsascript();
    await shakeHostWindow({ kind: "ios" });
    expect(execFile).not.toHaveBeenCalled();
  });

  it("skips a headless simulator boot, which has no window to move", async () => {
    // Same env var `boot-device` honours before `open -a Simulator.app`.
    process.env.ARGENT_SIMULATOR_NO_WINDOW = "1";
    stubOsascript();
    await shakeHostWindow({ kind: "ios" });
    expect(execFile).not.toHaveBeenCalled();
  });

  it("still animates an emulator when the iOS headless var is set", async () => {
    // ARGENT_SIMULATOR_NO_WINDOW is the iOS switch; an emulator window opened
    // regardless of it, so it must not suppress the Android animation.
    process.env.ARGENT_SIMULATOR_NO_WINDOW = "1";
    stubOsascript();
    await shakeHostWindow({ kind: "android", serial: "emulator-5554" });
    expect(execFile).toHaveBeenCalledTimes(1);
  });
});

describe("shakeHostWindow — never fails the shake", () => {
  it("resolves and warns when osascript is refused Accessibility permission", async () => {
    stubOsascript({
      err: new Error("Command failed"),
      stderr: "execution error: … is not allowed assistive access. (-1743)",
    });
    await expect(shakeHostWindow({ kind: "ios" })).resolves.toBeUndefined();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("-1743"));
  });

  it("resolves when the child cannot be spawned at all", async () => {
    vi.mocked(execFile).mockImplementation((() => {
      throw new Error("EPERM");
    }) as never);
    await expect(shakeHostWindow({ kind: "ios" })).resolves.toBeUndefined();
    expect(console.warn).toHaveBeenCalled();
  });
});

describe("shakeHostWindow — iOS window lookup", () => {
  it("targets Simulator, falling back to Xcode 27's Device Hub", async () => {
    const scripts = stubOsascript();
    await shakeHostWindow({ kind: "ios" });

    const [file, args] = vi.mocked(execFile).mock.calls[0]!;
    expect(file).toBe("/usr/bin/osascript");
    // `-` reads the script from stdin, so nothing has to survive shell quoting.
    expect(args).toEqual(["-"]);
    expect(scripts[0]).toContain('{"Simulator", "Device Hub"}');
    // A shake with no window to move must error out inside AppleScript rather
    // than silently "succeeding" against a stale reference.
    expect(scripts[0]).toContain("if win is missing value then error");
  });

  it("returns the window to its exact starting position, twice", async () => {
    // The window server lags behind a burst of moves, so a single re-assert can
    // be overtaken and leave the window a few points adrift.
    const scripts = stubOsascript();
    await shakeHostWindow({ kind: "ios" });
    const reasserts = scripts[0]!.match(/set position of win to \{ox, oy\}/g);
    expect(reasserts).toHaveLength(2);
  });
});

describe("shakeHostWindow — Android window lookup", () => {
  it("matches the emulator window by console port and AVD name", async () => {
    const scripts = stubOsascript();
    await shakeHostWindow({ kind: "android", serial: "emulator-5554" });

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

  it("falls back to the port alone when the AVD name can't be read", async () => {
    vi.mocked(runAdb).mockRejectedValueOnce(new Error("console: connection refused"));
    const scripts = stubOsascript();
    await shakeHostWindow({ kind: "android", serial: "emulator-5556" });
    expect(scripts[0]).toContain('set needles to {":5556"}');
  });

  it("ignores the console's OK verdict line when reading the AVD name", async () => {
    vi.mocked(runAdb).mockResolvedValueOnce({ stdout: "\nMy_AVD\nOK\n", stderr: "" });
    const scripts = stubOsascript();
    await shakeHostWindow({ kind: "android", serial: "emulator-5554" });
    expect(scripts[0]).toContain('"My_AVD"');
    expect(scripts[0]).not.toContain('"OK"');
  });

  it("skips rather than shaking an arbitrary window it cannot identify", async () => {
    // A serial with no console port isn't an emulator; without a needle the
    // lookup would match the first qemu window on the host, which may belong to
    // somebody else's emulator.
    vi.mocked(runAdb).mockRejectedValueOnce(new Error("no console"));
    stubOsascript();
    await shakeHostWindow({ kind: "android", serial: "R5CT30ABCDE" });
    expect(execFile).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("R5CT30ABCDE"));
  });
});

describe("animationScript", () => {
  it("escapes a needle so a quote in an AVD name can't break out of the literal", () => {
    const script = animationScript({ kind: "android", serial: "emulator-5554" }, ['a"b\\c']);
    expect(script).toContain('"a\\"b\\\\c"');
  });

  it("is a complete script: a run handler plus the sine helper it calls", () => {
    // AppleScript has no sin(), so the wobble carries its own Taylor series.
    const script = animationScript({ kind: "ios" }, []);
    expect(script).toContain("on run");
    expect(script).toContain("end run");
    expect(script).toContain("on sinOf(x)");
    expect(script).toContain("my sinOf(phase)");
  });
});
