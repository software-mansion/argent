import { describe, expect, it } from "vitest";
import {
  escapeAppleScript,
  shellQuote,
  flattenLine,
  buildSpawnScript,
  buildWriteScript,
  buildFocusScript,
  buildReadScript,
  buildEnterScript,
  buildCaptureScript,
  detectHostTerminal,
  parseCapture,
  parseAliveTtys,
  shortTty,
  resolveTerminal,
  isITermInstalled,
  type TerminalSession,
} from "../src/lens-terminal.js";

describe("escapeAppleScript", () => {
  it("escapes backslashes then double-quotes", () => {
    expect(escapeAppleScript('a"b\\c')).toBe('a\\"b\\\\c');
  });
  it("leaves a plain string untouched", () => {
    expect(escapeAppleScript("hello world")).toBe("hello world");
  });
});

describe("shellQuote", () => {
  it("single-quotes and escapes embedded single quotes", () => {
    expect(shellQuote("it's a path")).toBe("'it'\\''s a path'");
  });
  it("wraps a normal path", () => {
    expect(shellQuote("/Users/me/dev")).toBe("'/Users/me/dev'");
  });
});

describe("flattenLine", () => {
  it("collapses newlines and surrounding whitespace into single spaces", () => {
    expect(flattenLine("a\n  b\r\n   c")).toBe("a b c");
  });
  it("trims the result", () => {
    expect(flattenLine("  \n hi \n ")).toBe("hi");
  });
});

describe("buildSpawnScript", () => {
  it("iTerm: creates a window, writes the command, returns wid|sid|tty", () => {
    const s = buildSpawnScript("iterm", "echo hi");
    expect(s).toContain('tell application "iTerm"');
    expect(s).toContain("create window with default profile");
    expect(s).toContain('write text "echo hi"');
    expect(s).toContain('return _wid & "|" & _sid & "|" & _tty');
  });
  it("Terminal: do script + tty of tab, empty middle field", () => {
    const s = buildSpawnScript("terminal", "echo hi");
    expect(s).toContain('tell application "Terminal"');
    expect(s).toContain('do script "echo hi"');
    expect(s).toContain("tty of _tab");
    expect(s).toContain('return _wid & "||" & _tty');
  });
  it("escapes quotes in the command", () => {
    const s = buildSpawnScript("iterm", 'claude "$(cat x)"');
    expect(s).toContain('write text "claude \\"$(cat x)\\""');
  });
});

describe("buildWriteScript", () => {
  const iterm: TerminalSession = {
    app: "iterm",
    windowId: "1",
    sessionId: "GUID-9",
    tty: "/dev/ttys003",
  };
  const term: TerminalSession = {
    app: "terminal",
    windowId: "42",
    sessionId: "",
    tty: "/dev/ttys004",
  };

  it("iTerm sends a leading Esc, then the flattened text, then a separate Enter", () => {
    const s = buildWriteScript(iterm, "line one\nline two");
    expect(s).toContain('if (id of s) is "GUID-9" then');
    // Leading Esc (raw, no newline) interrupts any blocked turn / clears the composer.
    expect(s).toContain("tell s to write text (character id 27) newline no");
    expect(s).toContain('tell s to write text "line one line two"');
    // A standalone empty write is the submit Enter — a TUI composer ignores the
    // first chunk's trailing newline, so the message stays unsent without it.
    expect(s).toContain('tell s to write text ""');
    expect(s).toContain("delay 0.2");
    expect(s).toContain('error "session gone"');
  });
  it("Terminal sends a leading Esc, the text via do script, then a separate Enter", () => {
    const s = buildWriteScript(term, "do it");
    expect(s).toContain('if (id of w as string) is "42" then');
    expect(s).toContain("do script (character id 27) in (selected tab of w)");
    expect(s).toContain('do script "do it" in (selected tab of w)');
    expect(s).toContain('do script "" in (selected tab of w)');
    expect(s).toContain("delay 0.2");
    expect(s).toContain('error "window gone"');
  });
});

describe("buildReadScript", () => {
  it("iTerm returns the session text by id", () => {
    const s = buildReadScript({ app: "iterm", windowId: "1", sessionId: "G", tty: "" });
    expect(s).toContain('if (id of s) is "G" then return (text of s)');
  });
  it("Terminal returns the selected tab contents by window id", () => {
    const s = buildReadScript({ app: "terminal", windowId: "42", sessionId: "", tty: "" });
    expect(s).toContain('if (id of w as string) is "42"');
    expect(s).toContain("contents of selected tab of w");
  });
});

describe("buildEnterScript", () => {
  it("iTerm sends a lone newline to the matching session", () => {
    const s = buildEnterScript({ app: "iterm", windowId: "1", sessionId: "G", tty: "" });
    expect(s).toContain('if (id of s) is "G" then tell s to write text ""');
  });
  it("Terminal sends a lone return into the selected tab", () => {
    const s = buildEnterScript({ app: "terminal", windowId: "42", sessionId: "", tty: "" });
    expect(s).toContain('do script "" in (selected tab of w)');
  });
});

describe("buildFocusScript", () => {
  it("iTerm selects the matching window", () => {
    const s = buildFocusScript({ app: "iterm", windowId: "7", sessionId: "g", tty: "" });
    expect(s).toContain('if (id of w as string) is "7" then');
    expect(s).toContain("select w");
  });
  it("Terminal raises the matching window", () => {
    const s = buildFocusScript({ app: "terminal", windowId: "7", sessionId: "", tty: "" });
    expect(s).toContain("set frontmost of w to true");
  });
});

describe("parseCapture", () => {
  it("splits wid|sid|tty", () => {
    expect(parseCapture("123|GUID|/dev/ttys001\n")).toEqual({
      windowId: "123",
      sessionId: "GUID",
      tty: "/dev/ttys001",
    });
  });
  it("handles Terminal's empty middle field", () => {
    expect(parseCapture("42||/dev/ttys009")).toEqual({
      windowId: "42",
      sessionId: "",
      tty: "/dev/ttys009",
    });
  });
  it("degrades missing fields to empty strings", () => {
    expect(parseCapture("only")).toEqual({ windowId: "only", sessionId: "", tty: "" });
  });
});

describe("parseAliveTtys", () => {
  it("collects ttys and drops '??' and blanks", () => {
    const set = parseAliveTtys("ttys001\n??\n  ttys002 \n\nttys003\n");
    expect([...set].sort()).toEqual(["ttys001", "ttys002", "ttys003"]);
    expect(set.has("??")).toBe(false);
  });
});

describe("shortTty", () => {
  it("strips the /dev/ prefix", () => {
    expect(shortTty("/dev/ttys016")).toBe("ttys016");
  });
  it("leaves an already-short tty", () => {
    expect(shortTty("ttys016")).toBe("ttys016");
  });
});

describe("resolveTerminal", () => {
  it("uses iTerm when installed", () => {
    expect(resolveTerminal("iterm", () => true)).toBe("iterm");
  });
  it("falls back to Terminal when iTerm is absent", () => {
    expect(resolveTerminal("iterm", () => false)).toBe("terminal");
  });
  it("honours an explicit terminal preference", () => {
    expect(resolveTerminal("terminal", () => true)).toBe("terminal");
  });
});

describe("isITermInstalled", () => {
  it("is true when a known path exists", () => {
    expect(isITermInstalled((p) => p === "/Applications/iTerm.app")).toBe(true);
  });
  it("is false when none exist", () => {
    expect(isITermInstalled(() => false)).toBe(false);
  });
});

describe("buildCaptureScript", () => {
  it("iTerm: matches the session by tty and returns windowId|sessionId", () => {
    const s = buildCaptureScript("iterm", "/dev/ttys004");
    expect(s).toContain('tell application "iTerm"');
    expect(s).toContain('if (tty of s) is "/dev/ttys004"');
    expect(s).toContain('((id of w) as string) & "|" & (id of s)');
    expect(s).toContain('return ""'); // sentinel when no session matches
  });

  it("Terminal: matches the selected tab's tty and returns windowId| (no sid)", () => {
    const s = buildCaptureScript("terminal", "/dev/ttys009");
    expect(s).toContain('tell application "Terminal"');
    expect(s).toContain('if (tty of selected tab of w) is "/dev/ttys009"');
    expect(s).toContain('((id of w) as string) & "|"');
  });

  it("escapes the tty value", () => {
    expect(buildCaptureScript("iterm", 'a"b')).toContain('is "a\\"b"');
  });
});

describe("detectHostTerminal", () => {
  it("maps TERM_PROGRAM to the terminal app", () => {
    expect(detectHostTerminal("iTerm.app")).toBe("iterm");
    expect(detectHostTerminal("Apple_Terminal")).toBe("terminal");
  });
  it("returns null for unscriptable hosts (tmux / VS Code / unset)", () => {
    expect(detectHostTerminal("vscode")).toBeNull();
    expect(detectHostTerminal("tmux")).toBeNull();
    expect(detectHostTerminal(undefined)).toBeNull();
  });
});
