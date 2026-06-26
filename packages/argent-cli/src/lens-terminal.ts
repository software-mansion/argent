/**
 * Spawn, track, and write into a detached `claude` terminal session — the
 * mechanism behind `argent lens` (CLI-driven Argent Lens). It is a faithful
 * TypeScript port of the macOS applet's AppleScript spawner + process tracker
 * (`~/dev/argent-utils-applet`), with one capability added: writing fresh input
 * INTO an already-running session (the applet only ever spawned + focused).
 *
 * Everything here drives `/usr/bin/osascript` and `/bin/ps` — there is no
 * long-lived handle to the detached terminal and no new dependency. macOS only
 * (the caller guards `process.platform`).
 *
 * Why osascript and not a tty write: writing to a tty from another process
 * injects into the terminal's OUTPUT, not the foreground program's stdin
 * (feeding input would need TIOCSTI, which macOS has locked down). The terminal
 * apps' own scripting — iTerm `write text`, Terminal `do script … in <tab>` —
 * delivers the string to the session as if typed, so a running TUI like
 * `claude` receives it as a queued prompt. That is exactly the channel Lens
 * needs to "queue changes to the agent".
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

/** Which terminal app drives the session. iTerm preferred; Terminal is the
 * always-present fallback and the more limited write path. */
export type TerminalApp = "iterm" | "terminal";

/** The OS-level handles captured at spawn time — enough to write into the
 * session, probe its liveness, and bring its window forward later. */
export interface TerminalSession {
  app: TerminalApp;
  /** Terminal window id (string form) — the focus + Terminal.app write target. */
  windowId: string;
  /** iTerm session id (GUID); "" for Terminal.app (no stable session id). */
  sessionId: string;
  /** Controlling tty, e.g. "/dev/ttys016" — the liveness probe. */
  tty: string;
}

/** The name AppleScript addresses each terminal by. */
export function terminalAppName(app: TerminalApp): string {
  return app === "iterm" ? "iTerm" : "Terminal";
}

/** Common install locations for iTerm; Terminal.app is part of macOS so it is
 * always present and needs no detection. */
const ITERM_PATHS = ["/Applications/iTerm.app", `${process.env.HOME ?? ""}/Applications/iTerm.app`];

export function isITermInstalled(existsSync: (p: string) => boolean = defaultExists): boolean {
  return ITERM_PATHS.some((p) => p && existsSync(p));
}

function defaultExists(p: string): boolean {
  return existsSync(p);
}

/** Resolve the terminal to actually drive: the preferred one if usable, else
 * Terminal.app (always installed). */
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

/** Collapse a multi-line string into a single line — AppleScript string
 * literals can't carry raw newlines, and `write text` would treat each embedded
 * newline as a separate Enter (submitting a partial prompt to the TUI). */
export function flattenLine(s: string): string {
  return s.replace(/\s*\r?\n\s*/g, " ").trim();
}

/**
 * AppleScript that opens a NEW terminal window running `shellCommand` and prints
 * `windowId|sessionId|tty` on stdout so the caller can track the session. Port
 * of the applet's `appleScript(for:shellCommand:)`.
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
 * if typed — the "outputting" mechanism. iTerm targets the session by its GUID;
 * Terminal.app targets the window by id and uses `do script … in <tab>`.
 *
 * Submitting takes TWO steps, not one. A TUI like `claude` runs an input
 * composer that treats a single injected `text + newline` chunk as composer
 * CONTENT (the newline becomes a literal line break) and does NOT submit it — so
 * the first write only fills the box. A SEPARATE, standalone newline a beat later
 * is read as a distinct Enter keypress and submits the message (which `claude`
 * then queues to the agent). A program reading the tty directly (a plain shell,
 * `cat`) submits on the first newline already; the second is a harmless blank
 * line. The `delay` lets the composer register the paste before the Enter lands.
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

/** AppleScript that brings a tracked session's window to the front. Errors (so
 * osascript exits non-zero) when the window no longer exists. */
export function buildFocusScript(session: TerminalSession): string {
  if (session.app === "iterm") {
    return [
      'tell application "iTerm"',
      "  activate",
      "  set _found to false",
      "  repeat with w in windows",
      `    if (id of w as string) is "${session.windowId}" then`,
      "      select w",
      "      set _found to true",
      "    end if",
      "  end repeat",
      '  if not _found then error "window gone"',
      "end tell",
    ].join("\n");
  }
  return [
    'tell application "Terminal"',
    "  activate",
    "  set _found to false",
    "  repeat with w in windows",
    `    if (id of w as string) is "${session.windowId}" then`,
    "      set index of w to 1",
    "      set frontmost of w to true",
    "      set _found to true",
    "    end if",
    "  end repeat",
    '  if not _found then error "window gone"',
    "end tell",
  ].join("\n");
}

/** Split osascript's `wid|sid|tty` line. Empty middle field is expected for
 * Terminal.app. Missing fields degrade to "". */
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

// ── Side-effecting runners ───────────────────────────────────────────────

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

/** Write one line into a tracked session as if typed (queues it to `claude`).
 * Returns false (instead of throwing) when the session/window is gone. */
export function writeToSession(session: TerminalSession, text: string): boolean {
  try {
    runOsascript(buildWriteScript(session, text));
    return true;
  } catch {
    return false;
  }
}

/** Bring a tracked session's window forward. Returns false if it's gone. */
export function focusSession(session: TerminalSession): boolean {
  try {
    runOsascript(buildFocusScript(session));
    return true;
  } catch {
    return false;
  }
}

/** Every controlling tty currently backing a live process. One `ps` call. */
export function aliveTtys(): Set<string> {
  try {
    const out = execFileSync("/bin/ps", ["-A", "-o", "tty="], { encoding: "utf8" });
    return parseAliveTtys(out);
  } catch {
    return new Set();
  }
}

/** True while the session's tty is still backed by a live process — i.e. its
 * window is open and `claude` (or its shell) is still running. */
export function isSessionAlive(session: TerminalSession): boolean {
  if (!session.tty) return false;
  return aliveTtys().has(shortTty(session.tty));
}
