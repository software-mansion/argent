/**
 * Spawn, track, and write into a detached agent terminal session — the
 * new-window path of `argent lens`. Drives `/usr/bin/osascript` and `/bin/ps`,
 * keeping no long-lived handle to the terminal. macOS only (the caller guards
 * `process.platform`).
 *
 * Why osascript and not a tty write: writing to a tty from another process
 * injects into the terminal's OUTPUT, not the foreground program's stdin
 * (feeding input would need TIOCSTI, which macOS has locked down). The terminal
 * apps' own scripting — iTerm `write text`, Terminal `do script … in <tab>` —
 * delivers the string to the session as if typed, so a running TUI receives it
 * as a queued prompt.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

/** iTerm is preferred; Terminal.app is the always-present fallback and the more
 * limited write path. */
export type TerminalApp = "iterm" | "terminal";

/** OS-level handles captured at spawn time — enough to write into the session
 * and probe its liveness. */
export interface TerminalSession {
  app: TerminalApp;
  /** Terminal window id (string form) — Terminal.app's script target. */
  windowId: string;
  /** iTerm session id (GUID); "" for Terminal.app (no stable session id). */
  sessionId: string;
  /** Controlling tty, e.g. "/dev/ttys016" — the liveness probe. */
  tty: string;
}

/** Terminal.app ships with macOS, so only iTerm needs detecting. */
const ITERM_PATHS = ["/Applications/iTerm.app", `${process.env.HOME ?? ""}/Applications/iTerm.app`];

export function isITermInstalled(existsSync: (p: string) => boolean = defaultExists): boolean {
  return ITERM_PATHS.some((p) => p && existsSync(p));
}

function defaultExists(p: string): boolean {
  return existsSync(p);
}

/** The preferred terminal if usable, else Terminal.app. */
export function resolveTerminal(
  preferred: TerminalApp = "iterm",
  existsSync: (p: string) => boolean = defaultExists
): TerminalApp {
  if (preferred === "iterm" && isITermInstalled(existsSync)) return "iterm";
  return "terminal";
}

/** Escape a string for embedding inside an AppleScript double-quoted literal. */
export function escapeAppleScript(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** POSIX single-quote a string for safe embedding in a shell command. */
export function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

/** Collapse a multi-line string into one line: AppleScript literals can't carry
 * raw newlines, and a composer reads an embedded CR *or* LF as an Enter that
 * submits a partial prompt. Interior tabs and single spaces survive. */
export function flattenLine(s: string): string {
  return s.replace(/\s*[\r\n]+\s*/g, " ").trim();
}

/**
 * AppleScript that opens a NEW terminal window running `shellCommand` and prints
 * `windowId|sessionId|tty` on stdout so the caller can track the session.
 */
export function buildSpawnScript(app: TerminalApp, shellCommand: string): string {
  const esc = escapeAppleScript(shellCommand);
  if (app === "iterm") {
    return [
      'tell application "iTerm"',
      "  activate",
      "  set w to (create window with default profile)",
      '  set _sid to ""',
      '  set _tty to ""',
      "  tell current session of w",
      `    write text "${esc}"`,
      "    set _tty to tty",
      "    set _sid to id",
      "  end tell",
      "  set _wid to (id of w) as string",
      "end tell",
      'return _wid & "|" & _sid & "|" & _tty',
    ].join("\n");
  }
  return [
    'tell application "Terminal"',
    "  activate",
    `  set _tab to do script "${esc}"`,
    "  set _tty to tty of _tab",
    "  set _wid to (id of front window) as string",
    "end tell",
    'return _wid & "||" & _tty',
  ].join("\n");
}

/**
 * AppleScript that writes `text` (one line) into an EXISTING tracked session as
 * if typed. iTerm targets the session by GUID; Terminal.app the window by id.
 *
 * Three keystroke beats, not one:
 *
 *  1. A leading Esc. `await_user_selection` is hidden in a CLI session, so the
 *     agent may still be mid-turn or holding a half-typed composer when feedback
 *     arrives; Esc clears that so the feedback lands as a clean new prompt, and
 *     is a no-op on an idle composer. Terminal.app has no newline-suppressing
 *     write, so there it is only a best-effort Esc char.
 *  2. The feedback text. A composer reads one injected `text + newline` chunk as
 *     CONTENT and does not submit it.
 *  3. A standalone newline a beat later — the distinct Enter that submits. For a
 *     program reading the tty directly it is a harmless blank line.
 *
 * The `delay`s let the composer register each beat before the next lands.
 */
export function buildWriteScript(session: TerminalSession, text: string): string {
  const esc = escapeAppleScript(flattenLine(text));
  if (session.app === "iterm") {
    return [
      'tell application "iTerm"',
      "  set _found to false",
      "  repeat with w in windows",
      "    repeat with t in tabs of w",
      "      repeat with s in sessions of t",
      `        if (id of s) is "${session.sessionId}" then`,
      "          tell s to write text (character id 27) newline no",
      "          delay 0.15",
      `          tell s to write text "${esc}"`,
      "          delay 0.2",
      '          tell s to write text ""',
      "          set _found to true",
      "        end if",
      "      end repeat",
      "    end repeat",
      "  end repeat",
      '  if not _found then error "session gone"',
      "end tell",
    ].join("\n");
  }
  return [
    'tell application "Terminal"',
    "  set _found to false",
    "  repeat with w in windows",
    `    if (id of w as string) is "${session.windowId}" then`,
    "      do script (character id 27) in (selected tab of w)",
    "      delay 0.15",
    `      do script "${esc}" in (selected tab of w)`,
    "      delay 0.2",
    '      do script "" in (selected tab of w)',
    "      set _found to true",
    "    end if",
    "  end repeat",
    '  if not _found then error "window gone"',
    "end tell",
  ].join("\n");
}

/** AppleScript returning a tracked session's visible text — used to spot a
 * first-run "trust this folder?" prompt before relaying anything. */
export function buildReadScript(session: TerminalSession): string {
  if (session.app === "iterm") {
    return [
      'tell application "iTerm"',
      "  repeat with w in windows",
      "    repeat with t in tabs of w",
      "      repeat with s in sessions of t",
      `        if (id of s) is "${session.sessionId}" then return (text of s)`,
      "      end repeat",
      "    end repeat",
      "  end repeat",
      '  return ""',
      "end tell",
    ].join("\n");
  }
  return [
    'tell application "Terminal"',
    "  repeat with w in windows",
    `    if (id of w as string) is "${session.windowId}" then return ((contents of selected tab of w) as text)`,
    "  end repeat",
    '  return ""',
    "end tell",
  ].join("\n");
}

/** AppleScript sending a lone Enter to a tracked session — accepts a first-run
 * menu whose default option is the desired one. */
export function buildEnterScript(session: TerminalSession): string {
  if (session.app === "iterm") {
    return [
      'tell application "iTerm"',
      "  repeat with w in windows",
      "    repeat with t in tabs of w",
      "      repeat with s in sessions of t",
      `        if (id of s) is "${session.sessionId}" then tell s to write text ""`,
      "      end repeat",
      "    end repeat",
      "  end repeat",
      "end tell",
    ].join("\n");
  }
  return [
    'tell application "Terminal"',
    "  repeat with w in windows",
    `    if (id of w as string) is "${session.windowId}" then do script "" in (selected tab of w)`,
    "  end repeat",
    "end tell",
  ].join("\n");
}

/** Split osascript's `wid|sid|tty` line. Terminal.app leaves the middle field
 * empty; missing fields degrade to "". */
export function parseCapture(out: string): { windowId: string; sessionId: string; tty: string } {
  const parts = out.trim().split("|");
  return {
    windowId: parts[0]?.trim() ?? "",
    sessionId: parts[1]?.trim() ?? "",
    tty: parts[2]?.trim() ?? "",
  };
}

/** The tty as `ps` reports it (no `/dev/` prefix). */
export function shortTty(tty: string): string {
  return tty.startsWith("/dev/") ? tty.slice(5) : tty;
}

/** Parse `ps -A -o tty=` output into the set of ttys backing a live process. */
export function parseAliveTtys(psOutput: string): Set<string> {
  const set = new Set<string>();
  for (const line of psOutput.split("\n")) {
    const t = line.trim();
    if (t && t !== "??") set.add(t);
  }
  return set;
}

// Side-effecting runners

function runOsascript(script: string): string {
  try {
    return execFileSync("/usr/bin/osascript", ["-e", script], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    const e = err as { stderr?: Buffer | string; message?: string };
    const stderr = (typeof e.stderr === "string" ? e.stderr : e.stderr?.toString()) ?? "";
    throw new Error(`osascript failed: ${stderr.trim() || e.message || "unknown error"}`, {
      cause: err,
    });
  }
}

/** Open a new terminal window running `command`, returning the tracked session. */
export function spawnTerminalSession(command: string, app: TerminalApp): TerminalSession {
  const out = runOsascript(buildSpawnScript(app, command));
  const { windowId, sessionId, tty } = parseCapture(out);
  return { app, windowId, sessionId, tty };
}

/** Write one line into a tracked session as if typed, queuing it to the agent.
 * Returns false (instead of throwing) when the session/window is gone. */
export function writeToSession(session: TerminalSession, text: string): boolean {
  try {
    runOsascript(buildWriteScript(session, text));
    return true;
  } catch {
    return false;
  }
}

/** Returns null when the text can't be read (window gone, scripting
 * unavailable), so callers can fall back. */
export function readSessionText(session: TerminalSession): string | null {
  try {
    return runOsascript(buildReadScript(session));
  } catch {
    return null;
  }
}

/** Send a lone Enter to a tracked session. Returns false if it's gone. */
export function pressEnter(session: TerminalSession): boolean {
  try {
    runOsascript(buildEnterScript(session));
    return true;
  } catch {
    return false;
  }
}

/** Every controlling tty currently backing a live process. One `ps` call. */
function aliveTtys(): Set<string> {
  try {
    const out = execFileSync("/bin/ps", ["-A", "-o", "tty="], { encoding: "utf8" });
    return parseAliveTtys(out);
  } catch {
    return new Set();
  }
}

/** True while the session's tty is still backed by a live process — its window
 * is open and the agent (or its shell) is still running. */
export function isSessionAlive(session: TerminalSession): boolean {
  if (!session.tty) return false;
  return aliveTtys().has(shortTty(session.tty));
}
