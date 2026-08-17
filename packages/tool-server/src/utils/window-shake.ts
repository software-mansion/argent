/**
 * Cosmetic amplifier for the `shake` tool: while the *guest* shake runs (a
 * Darwin notification on iOS, an accelerometer burst on Android), the *host*
 * window carrying that device wobbles on screen with a damped oscillation.
 *
 * The functional shake is invisible from the outside — an app pops its dev menu
 * or an undo prompt with nothing on screen to explain why. This makes the cause
 * visible. It is decoration and nothing else, so:
 *
 *   - it is gated behind the opt-in `microinteractions` flag (off by default),
 *   - it is macOS-only (the animation is AppleScript against System Events),
 *   - and it NEVER fails a shake. Every failure path here warns once and
 *     resolves, because moving a window needs macOS Accessibility permission
 *     for the host process and a denied prompt must not turn a working shake
 *     into a reported failure.
 *
 * Local devices only. A `sim-remote` simulator's window lives on another host,
 * so the remote iOS backend does not call in here.
 */

import { execFile } from "node:child_process";
import { isFeatureEnabled } from "@argent/configuration-core";
import { consolePortFromAdbSerial, runAdb } from "./adb";

/** The flag that turns the whole thing on. Registered in `@argent/configuration-core`. */
export const MICROINTERACTIONS_FLAG = "microinteractions";

/**
 * Peak horizontal excursion in points, and how many window moves the wobble is
 * split into. 60 moves land the animation at roughly 300-500ms depending on how
 * fast the window server drains them, which brackets one shake gesture: iOS
 * spaces gestures 400ms apart and an Android burst is 8 swings x 50ms.
 */
const AMPLITUDE = 22;
const STEPS = 60;

/**
 * Ceiling on the whole AppleScript. The animation is self-limiting, so this only
 * exists so a wedged window server can't hold the tool call open.
 */
const OSASCRIPT_TIMEOUT_MS = 5_000;

export type HostWindowTarget = { kind: "ios" } | { kind: "android"; serial: string };

/**
 * True unless this is a headless simulator boot. `boot-device` skips the
 * `open -a Simulator.app` GUI attach on the same env var, so honouring it here
 * keeps us from scripting a window that was deliberately never opened.
 * Truthy values match boot-device's: "1" / "true" / "yes".
 */
function simulatorWindowExpected(): boolean {
  const trimmed = (process.env.ARGENT_SIMULATOR_NO_WINDOW ?? "").trim().toLowerCase();
  return !["1", "true", "yes"].includes(trimmed);
}

function warn(detail: string): void {
  console.warn(`[shake:window] skipped the window animation: ${detail}`);
}

/** AppleScript string literal — the only metacharacters in a `"…"` literal are `\` and `"`. */
function asStringLiteral(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * The emulator window's title is `Android Emulator - <avd>:<port>`, so either
 * half identifies it. The port comes free from the serial; the AVD name costs
 * one console round trip and is the fallback if a future emulator build drops
 * the port from the title. A failed read is not fatal — the port alone is
 * enough to pick the right window out of several running emulators.
 */
async function androidWindowNeedles(serial: string): Promise<string[]> {
  const needles: string[] = [];
  const port = consolePortFromAdbSerial(serial);
  if (port !== null) needles.push(`:${port}`);
  try {
    const { stdout } = await runAdb(["-s", serial, "emu", "avd", "name"], { timeoutMs: 5_000 });
    // `adb emu` answers with the value then a bare `OK` verdict line.
    const name = stdout
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0 && line !== "OK" && !line.startsWith("KO"));
    if (name) needles.push(name);
  } catch {
    // Port-only matching is still correct; nothing to report.
  }
  return needles;
}

/**
 * AppleScript that leaves the window to animate in `win`, or `missing value`.
 *
 * iOS: Simulator.app owns the window, except under Xcode 27 where Device Hub.app
 * hosts it instead (the same pair `boot-device` opens), so both are tried.
 *
 * Android: the emulator's GUI process is the `qemu-system-*` QEMU binary, and one
 * host can run several at once — hence matching on the title rather than taking
 * `window 1` of the first match, which would shake somebody else's emulator.
 */
function windowLookup(target: HostWindowTarget, needles: string[]): string {
  if (target.kind === "ios") {
    return `
	set win to missing value
	repeat with procRef in {"Simulator", "Device Hub"}
		-- A repeat variable is a reference into the list, and "process <ref>"
		-- will not coerce one, so without "contents of" the lookup silently misses.
		set procName to contents of procRef
		if exists (process procName) then
			tell process procName
				if (count of windows) > 0 then set win to window 1
			end tell
		end if
		if win is not missing value then exit repeat
	end repeat`;
  }
  return `
	set win to missing value
	set needles to {${needles.map(asStringLiteral).join(", ")}}
	-- Collect plain strings, then take exactly one window reference at the end.
	-- Holding a live "item N of every process …" reference across the walk is
	-- what breaks: it is re-evaluated on each access, and a process whose window
	-- list shifts mid-walk raises "Invalid index" (-1719).
	set procNames to name of every process whose name starts with "qemu-system"
	repeat with procRef in procNames
		set procName to contents of procRef
		set winTitles to {}
		try
			tell process procName to set winTitles to name of every window
		end try
		repeat with idx from 1 to (count of winTitles)
			set winTitle to item idx of winTitles
			-- An emulator carries an unnamed helper window alongside the real one.
			if winTitle is not missing value then
				repeat with needle in needles
					if winTitle contains (contents of needle) then
						set win to window idx of process procName
						exit repeat
					end if
				end repeat
			end if
			if win is not missing value then exit repeat
		end repeat
		if win is not missing value then exit repeat
	end repeat`;
}

/**
 * A damped sine wobble, driven by repeatedly repositioning the window.
 *
 * The vertical component runs at half the amplitude and double the frequency so
 * the path reads as a jerk rather than a slide. The closing position is set
 * twice with a pause between: the window server lags behind a burst of moves,
 * and a single re-assert can be overtaken by a queued one, leaving the window
 * a few points off where it started.
 *
 * AppleScript has no `sin`, so `sinOf` reduces the angle and evaluates a Taylor
 * series — accurate well past what a 22pt excursion can show.
 */
export function animationScript(target: HostWindowTarget, needles: string[]): string {
  return `on run
	tell application "System Events"${windowLookup(target, needles)}
		if win is missing value then error "no matching window"
		set origin to position of win
		set ox to item 1 of origin
		set oy to item 2 of origin

		repeat with i from 0 to ${STEPS}
			set t to i / ${STEPS}
			set decay to 2.718281828 ^ (-4.0 * t)
			set phase to 6.2831853 * 3.5 * t
			set dx to ${AMPLITUDE}.0 * decay * (my sinOf(phase))
			set dy to (${AMPLITUDE}.0 / 3.0) * decay * (my sinOf(phase * 2.0))
			set position of win to {ox + (dx as integer), oy + (dy as integer)}
		end repeat

		set position of win to {ox, oy}
		delay 0.05
		set position of win to {ox, oy}
	end tell
end run

on sinOf(x)
	set twoPi to 6.283185307179586
	repeat while x > twoPi
		set x to x - twoPi
	end repeat
	repeat while x < 0
		set x to x + twoPi
	end repeat
	if x > 3.141592653589793 then
		return -(my sinOf(x - 3.141592653589793))
	end if
	set x2 to x * x
	return x * (1 - x2 / 6 * (1 - x2 / 20 * (1 - x2 / 42 * (1 - x2 / 72))))
end sinOf
`;
}

/** Run the script through `osascript`, reading it from stdin so nothing needs quoting. */
function runOsascript(script: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "/usr/bin/osascript",
      ["-"],
      { timeout: OSASCRIPT_TIMEOUT_MS },
      (err, _stdout, stderr) => {
        if (err) {
          const detail = String(stderr || err.message).trim();
          reject(new Error(detail || "osascript failed"));
          return;
        }
        resolve();
      }
    );
    child.on("error", (err) => reject(err));
    child.stdin?.on("error", () => {
      // The close-before-write race is reported through the exec callback.
    });
    child.stdin?.end(script);
  });
}

/**
 * Wobble the host window for one shake gesture. Resolves either way — callers
 * await it purely so no `osascript` outlives the tool call.
 */
export async function shakeHostWindow(target: HostWindowTarget): Promise<void> {
  if (!isFeatureEnabled(MICROINTERACTIONS_FLAG)) return;
  if (process.platform !== "darwin") return;
  if (target.kind === "ios" && !simulatorWindowExpected()) return;

  try {
    const needles = target.kind === "android" ? await androidWindowNeedles(target.serial) : [];
    if (target.kind === "android" && needles.length === 0) {
      warn(`no way to identify the emulator window for ${target.serial}`);
      return;
    }
    await runOsascript(animationScript(target, needles));
  } catch (err) {
    // Almost always a denied Accessibility prompt (osascript error -1743) or a
    // window that closed mid-gesture. Neither says anything about whether the
    // device actually shook.
    warn(err instanceof Error ? err.message : String(err));
  }
}
