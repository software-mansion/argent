/**
 * Cosmetic amplifier for `shake`: while the guest shake runs, the host window
 * carrying that device wobbles, so the cause of a dev menu or undo prompt is
 * visible on screen.
 *
 * Gated behind the opt-in `microinteractions` flag, and iOS simulators on
 * macOS only (AppleScript against System Events). Every failure path warns and
 * resolves, because moving a window needs Accessibility permission and a
 * denied prompt must not fail a working shake.
 *
 * The caller fires `begin()` per gesture and `settle()` at the end. Local
 * devices only - a `sim-remote` window lives on another host.
 */

import { execFile } from "node:child_process";
import { isFeatureEnabled } from "@argent/configuration-core";
import { deviceSetForUdid } from "./ios-device-sets";
import { iosHeadlessFromEnv } from "./no-window-env";

/** Registered in `@argent/configuration-core`. */
export const MICROINTERACTIONS_FLAG = "microinteractions";

/**
 * Peak horizontal excursion in points, split across this many window moves. The
 * loop runs roughly 300-500ms, bracketing one gesture (consecutive gestures are
 * spaced 400ms apart).
 */
const AMPLITUDE = 22;
const STEPS = 60;

/** The animation is self-limiting; this only stops a wedged window server from holding the call open. */
const OSASCRIPT_TIMEOUT_MS = 5_000;

/**
 * The script `log`s the window origin on this marker line, which reaches stderr
 * immediately, so a mid-loop SIGTERM (which skips the closing re-asserts) can
 * still be repaired from the accumulated stderr.
 */
const ORIGIN_MARKER = "ARGENT_WINDOW_ORIGIN:";

/**
 * `name` title-matches the Simulator window; the udid never appears in window
 * titles, so it serves only the device-set headless check.
 */
export interface HostWindowTarget {
  kind: "ios";
  udid: string;
  name?: string;
}

interface HostWindowShaker {
  /** Start one wobble. No-op when disabled, already in flight, or after a failure. Never throws. */
  begin(): void;
  /** Await the in-flight wobble, if any. Never rejects. */
  settle(): Promise<void>;
}

function warn(detail: string): void {
  process.stderr.write(`[shake:window] skipped the window animation: ${detail}\n`);
}

/** AppleScript string literal - the only metacharacters in a `"…"` literal are `\` and `"`. */
function asStringLiteral(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Shared title-match walk: leaves the window in `win`, or `missing value`.
 * `procNamesExpr` yields the candidate process names as plain strings.
 *
 * Exactly one window reference is taken, at the end: a live "item N of every
 * process …" reference is re-evaluated on each access and raises "Invalid
 * index" (-1719) if the window list shifts mid-walk.
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
 * The window belongs to Simulator.app, or Device Hub.app under Xcode 27 (the
 * same pair `boot-device` opens), so both are tried, title-matched on the
 * device name because each booted device gets its own window.
 */
function windowLookup(needles: string[]): string {
  if (needles.length === 0) {
    // Unknown device name: window 1 of whichever host app is running. With
    // several booted devices this may wobble a sibling - harmless decoration,
    // and it beats skipping the animation.
    return `
	set win to missing value
	repeat with procRef in {"Simulator", "Device Hub"}
		-- A repeat variable is a reference into the list and "process <ref>"
		-- will not coerce one, so without "contents of" the lookup misses.
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

/**
 * Offsets of the damped sine wobble, precomputed because AppleScript has no
 * `sin`. The vertical component runs at a third of the amplitude and double the
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
 * The closing position is set twice with a pause between, because a single
 * re-assert can be overtaken by a move still queued in the window server,
 * leaving the window a few points off. The origin is `log`ged up front (see
 * ORIGIN_MARKER) so a SIGTERMed run can be repaired from outside.
 */
export function animationScript(needles: string[]): string {
  return `on run
	tell application "System Events"${windowLookup(needles)}
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
function restoreScript(needles: string[], ox: number, oy: number): string {
  return `on run
	tell application "System Events"${windowLookup(needles)}
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
          // The marker is bookkeeping for the repair path, not error detail.
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
      // A broken stdin pipe surfaces through the exec callback instead.
    });
    child.stdin?.end(script);
  });
}

/**
 * A timeout kill lands between window moves, so the closing re-asserts never
 * ran and the window may be left offset. Recover the origin from the logged
 * marker and move it back. Best-effort: its own failure is swallowed.
 */
async function restoreOriginAfterKill(needles: string[], rawStderr: string): Promise<void> {
  const match = rawStderr.match(new RegExp(`${ORIGIN_MARKER}\\s*(-?\\d+)\\s*,\\s*(-?\\d+)`));
  if (!match) return;
  try {
    await runOsascript(restoreScript(needles, Number(match[1]), Number(match[2])));
  } catch {
    /* best-effort */
  }
}

/**
 * Resolve the per-call invariants once: flag, platform, headless env gate,
 * window needles, and the script. Never throws; when the animation is disabled
 * it returns an inert shaker.
 */
export async function prepareHostWindowShake(target: HostWindowTarget): Promise<HostWindowShaker> {
  const inert: HostWindowShaker = { begin: () => {}, settle: () => Promise.resolve() };
  try {
    if (!isFeatureEnabled(MICROINTERACTIONS_FLAG)) return inert;
    if (process.platform !== "darwin") return inert;

    // The same env var `boot-device` honours before `open -a Simulator.app`,
    // so we never script a window that was deliberately never opened.
    if (iosHeadlessFromEnv()) return inert;
    // A device from a non-default CoreSimulator set boots headless
    // unconditionally (the stock Simulator GUI only displays the default set),
    // so it has no window either. A per-call `headless: true` boot is not
    // knowable here; the dead-shaker path below caps that at one failed wobble
    // and one warning.
    let deviceSet: string | null = null;
    try {
      deviceSet = await deviceSetForUdid(target.udid);
    } catch {
      // An unreadable device-set config resolves like the default set.
    }
    if (deviceSet !== null) return inert;
    const needles = target.name ? [target.name] : [];

    const script = animationScript(needles);
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
          dead = true;
          warnOnce(err instanceof Error ? err.message : String(err));
          return;
        }
        inFlight = run.then(
          () => {
            inFlight = null;
          },
          async (err: unknown) => {
            // Usually a denied Accessibility prompt (-1743), a window closed
            // mid-gesture, or a headless boot with no window. None of it says
            // anything about whether the device shook, so mark the shaker dead
            // and let later gestures skip the doomed spawn. `inFlight` clears
            // LAST so settle() still covers the origin repair.
            dead = true;
            const failure = err as Partial<OsascriptError>;
            if (failure.wasKilled && typeof failure.rawStderr === "string") {
              await restoreOriginAfterKill(needles, failure.rawStderr);
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
