/**
 * Cosmetic amplifier for the `shake` tool: while the *guest* shake runs (a
 * Darwin notification on iOS, an accelerometer burst on Android), the *host*
 * window carrying that device wobbles on screen with a damped oscillation.
 *
 * The functional shake is invisible from the outside - an app pops its dev menu
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
 * The entry point is `prepareHostWindowShake(target)`: it resolves everything
 * invariant for one tool call exactly once (flag, platform, headless env,
 * window needles, script) and returns a `HostWindowShaker`. Per gesture, the
 * caller fires `begin()` (spawn one osascript, no-op while one is in flight or
 * after a failure) and `settle()` awaits the in-flight wobble so no osascript
 * outlives the tool call. Neither prepare, begin, nor settle ever throws.
 *
 * Local devices only. A `sim-remote` simulator's window lives on another host,
 * so the remote iOS backend does not call in here.
 */

import { execFile } from "node:child_process";
import { isFeatureEnabled } from "@argent/configuration-core";
import { consolePortFromAdbSerial, runAdb } from "./adb";
import { deviceSetForUdid } from "./ios-device-sets";
import { androidHeadlessFromEnv, iosHeadlessFromEnv } from "./no-window-env";

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

/**
 * The script `log`s the window origin on this marker line the moment it reads
 * it. `log` writes to osascript's stderr immediately, so when the timeout
 * SIGTERMs the script mid-loop (skipping the closing re-asserts) the origin is
 * still recoverable from accumulated stderr and the window can be put back.
 */
const ORIGIN_MARKER = "ARGENT_WINDOW_ORIGIN:";

export type HostWindowTarget =
  /**
   * `name` is the device display name, used to title-match the Simulator
   * window ("iPhone 16 Pro" plus runtime info). The udid never appears in
   * window titles, so it is used only for the device-set headless check.
   */
  { kind: "ios"; udid: string; name?: string } | { kind: "android"; serial: string };

interface HostWindowShaker {
  /**
   * Start one wobble. No-op when disabled, when a wobble is already in
   * flight, or after a previous attempt failed. Never throws.
   */
  begin(): void;
  /** Await the in-flight wobble, if any. Never rejects. */
  settle(): Promise<void>;
}

function warn(detail: string): void {
  // stdout carries JSON-RPC, so diagnostics go straight to stderr.
  process.stderr.write(`[shake:window] skipped the window animation: ${detail}\n`);
}

/** AppleScript string literal - the only metacharacters in a `"…"` literal are `\` and `"`. */
function asStringLiteral(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * The emulator window's title is `Android Emulator - <avd>:<port>`, so either
 * half identifies it. The port comes free from the serial; the AVD name costs
 * one console round trip and is the fallback if a future emulator build drops
 * the port from the title. A failed read is not fatal - the port alone is
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
 * The shared title-match walk: leaves the window to animate in `win`, or
 * `missing value`. `procNamesExpr` is an AppleScript expression yielding the
 * candidate process names as plain strings.
 *
 * Collect plain strings, then take exactly one window reference at the end.
 * Holding a live "item N of every process …" reference across the walk is
 * what breaks: it is re-evaluated on each access, and a process whose window
 * list shifts mid-walk raises "Invalid index" (-1719).
 */
function titleMatchLookup(procNamesExpr: string, needles: string[]): string {
  return `
	set win to missing value
	set needles to {${needles.map(asStringLiteral).join(", ")}}
	set procNames to ${procNamesExpr}
	repeat with procRef in procNames
		set procName to contents of procRef
		set winTitles to {}
		try
			tell process procName to set winTitles to name of every window
		end try
		repeat with idx from 1 to (count of winTitles)
			set winTitle to item idx of winTitles
			-- A GUI app can carry an unnamed helper window alongside the real one.
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
 * AppleScript that leaves the window to animate in `win`, or `missing value`.
 *
 * iOS: Simulator.app owns the window, except under Xcode 27 where Device Hub.app
 * hosts it instead (the same pair `boot-device` opens), so both are tried. The
 * device display name is the needle: each booted device gets its own window
 * titled with that name, so title-matching picks the right one when several
 * are open.
 *
 * Android: the emulator's GUI process is the `qemu-system-*` QEMU binary, and one
 * host can run several at once - hence matching on the title rather than taking
 * `window 1` of the first match, which would shake somebody else's emulator.
 */
function windowLookup(target: HostWindowTarget, needles: string[]): string {
  if (target.kind === "ios") {
    if (needles.length === 0) {
      // Fallback when the device name is unknown: window 1 of whichever of the
      // two host apps is running. With one booted device this is the right
      // window; with several it may wobble a sibling, which is still harmless
      // decoration and beats skipping the animation entirely.
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
    return titleMatchLookup(
      `name of every process whose name is "Simulator" or name is "Device Hub"`,
      needles
    );
  }
  return titleMatchLookup(`name of every process whose name starts with "qemu-system"`, needles);
}

/**
 * The 61 window offsets of the damped sine wobble, precomputed here because
 * AppleScript has no `sin` and AMPLITUDE/STEPS are compile-time constants.
 * The vertical component runs at a third of the amplitude and double the
 * frequency so the path reads as a jerk rather than a slide.
 */
const WOBBLE_OFFSETS: ReadonlyArray<readonly [number, number]> = Array.from(
  { length: STEPS + 1 },
  (_, i) => {
    const t = i / STEPS;
    const decay = Math.exp(-4 * t);
    const phase = 2 * Math.PI * 3.5 * t;
    return [
      Math.round(AMPLITUDE * decay * Math.sin(phase)),
      Math.round((AMPLITUDE / 3) * decay * Math.sin(2 * phase)),
    ] as const;
  }
);

const OFFSETS_LITERAL = WOBBLE_OFFSETS.map(([dx, dy]) => `{${dx}, ${dy}}`).join(", ");

/**
 * A damped sine wobble, driven by repeatedly repositioning the window.
 *
 * The closing position is set twice with a pause between: the window server
 * lags behind a burst of moves, and a single re-assert can be overtaken by a
 * queued one, leaving the window a few points off where it started. The origin
 * is also `log`ged up front (see ORIGIN_MARKER) so a SIGTERMed run can be
 * repaired from outside.
 */
export function animationScript(target: HostWindowTarget, needles: string[]): string {
  return `on run
	tell application "System Events"${windowLookup(target, needles)}
		if win is missing value then error "no matching window"
		set origin to position of win
		set ox to item 1 of origin
		set oy to item 2 of origin
		log "${ORIGIN_MARKER}" & ox & "," & oy

		set offsets to {${OFFSETS_LITERAL}}
		repeat with pair in offsets
			set position of win to {ox + (item 1 of pair), oy + (item 2 of pair)}
		end repeat

		set position of win to {ox, oy}
		delay 0.05
		set position of win to {ox, oy}
	end tell
end run
`;
}

/** One-shot repair script: same window lookup, a single move back to the origin. */
function restoreScript(
  target: HostWindowTarget,
  needles: string[],
  ox: number,
  oy: number
): string {
  return `on run
	tell application "System Events"${windowLookup(target, needles)}
		if win is missing value then error "no matching window"
		set position of win to {${ox}, ${oy}}
	end tell
end run
`;
}

interface OsascriptError extends Error {
  /** True when the child was killed (the 5s timeout SIGTERMs it mid-loop). */
  wasKilled: boolean;
  /** Raw accumulated stderr, marker line included, for origin recovery. */
  rawStderr: string;
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
          const raw = String(stderr ?? "");
          // The origin marker is bookkeeping for the repair path; keep it out
          // of the human-facing error detail.
          const detail =
            raw
              .split("\n")
              .filter((line) => !line.includes(ORIGIN_MARKER))
              .join("\n")
              .trim() ||
            err.message ||
            "osascript failed";
          const failure = new Error(detail) as OsascriptError;
          failure.wasKilled = Boolean(
            (err as { killed?: boolean; signal?: string }).killed ||
            (err as { signal?: string }).signal
          );
          failure.rawStderr = raw;
          reject(failure);
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
 * A timeout kill lands between window moves, so the closing origin re-asserts
 * never ran and the window may be left offset. Recover the origin from the
 * marker line the script logged and move the window back with a minimal
 * follow-up script. Best-effort: its own failure is swallowed.
 */
async function restoreOriginAfterKill(
  target: HostWindowTarget,
  needles: string[],
  rawStderr: string
): Promise<void> {
  const match = rawStderr.match(new RegExp(`${ORIGIN_MARKER}\\s*(-?\\d+)\\s*,\\s*(-?\\d+)`));
  if (!match) return;
  try {
    await runOsascript(restoreScript(target, needles, Number(match[1]), Number(match[2])));
  } catch {
    // The wobble already failed and warned; a failed repair adds nothing.
  }
}

/**
 * Resolve everything invariant for one tool call exactly once: the feature
 * flag, the platform, the headless env gates, the window needles (one adb
 * console round trip on Android), and the AppleScript itself. Never throws or
 * rejects; when the animation is disabled it returns an inert shaker whose
 * begin/settle are no-ops.
 */
export async function prepareHostWindowShake(target: HostWindowTarget): Promise<HostWindowShaker> {
  const inert: HostWindowShaker = { begin: () => {}, settle: () => Promise.resolve() };
  try {
    if (!isFeatureEnabled(MICROINTERACTIONS_FLAG)) return inert;
    if (process.platform !== "darwin") return inert;

    let needles: string[];
    if (target.kind === "ios") {
      // Same env var `boot-device` honours before `open -a Simulator.app`:
      // honouring it here keeps us from scripting a window that was
      // deliberately never opened.
      if (iosHeadlessFromEnv()) return inert;
      // A device from an additional CoreSimulator device set boots headless
      // unconditionally (boot-device skips the GUI attach because the stock
      // Simulator GUI can only display the default set), so it never has a
      // window either. A per-call `headless: true` boot is not knowable from
      // here; that case is capped by the dead-shaker behavior below (one
      // failed wobble, one warning, then silence).
      let deviceSet: string | null = null;
      try {
        deviceSet = await deviceSetForUdid(target.udid);
      } catch {
        // An unreadable device-set config resolves like the default set.
      }
      if (deviceSet !== null) return inert;
      needles = target.name ? [target.name] : [];
    } else {
      // The Android analog: `-no-window` boots have no qemu window to move.
      if (androidHeadlessFromEnv()) return inert;
      needles = await androidWindowNeedles(target.serial);
      if (needles.length === 0) {
        // Without a needle the lookup would match the first qemu window on the
        // host, which may belong to somebody else's emulator.
        warn(`no way to identify the emulator window for ${target.serial}`);
        return inert;
      }
    }

    const script = animationScript(target, needles);
    let inFlight: Promise<void> | null = null;
    let dead = false;
    let warned = false;
    const warnOnce = (detail: string): void => {
      if (warned) return;
      warned = true;
      warn(detail);
    };

    return {
      begin(): void {
        if (dead || inFlight !== null) return;
        let run: Promise<void>;
        try {
          run = runOsascript(script);
        } catch (err) {
          // A synchronously-thrown spawn failure (e.g. EPERM) still counts.
          dead = true;
          warnOnce(err instanceof Error ? err.message : String(err));
          return;
        }
        inFlight = run.then(
          () => {
            inFlight = null;
          },
          async (err: unknown) => {
            // Almost always a denied Accessibility prompt (osascript error
            // -1743), a window that closed mid-gesture, or a headless-param
            // boot with no window at all. Neither says anything about whether
            // the device actually shook; mark the shaker dead so later
            // gestures skip the doomed spawn. `inFlight` is cleared LAST so
            // settle() keeps covering the origin repair below.
            dead = true;
            const failure = err as Partial<OsascriptError>;
            if (failure.wasKilled && typeof failure.rawStderr === "string") {
              await restoreOriginAfterKill(target, needles, failure.rawStderr);
            }
            warnOnce(err instanceof Error ? err.message : String(err));
            inFlight = null;
          }
        );
      },
      settle(): Promise<void> {
        return inFlight ?? Promise.resolve();
      },
    };
  } catch (err) {
    warn(err instanceof Error ? err.message : String(err));
    return inert;
  }
}
