import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureSpawnHelperExecutable,
  ptyInjectBeats,
  loadNodePty,
  startPtyProxy,
  type NodePty,
  type IPty,
  type ProxyInput,
  type ProxyOutput,
} from "../src/lens-pty.js";

describe("ptyInjectBeats", () => {
  it("emits Esc, the flattened text, then a separate Enter", () => {
    const beats = ptyInjectBeats("line one\nline two");
    expect(beats.map((b) => b.data)).toEqual(["\x1b", "line one line two", "\r"]);
  });

  it("spaces the beats: 0 before Esc, then 150ms, then 200ms", () => {
    expect(ptyInjectBeats("x").map((b) => b.delayBeforeMs)).toEqual([0, 150, 200]);
  });

  it("flattens so an embedded newline can't submit the composer early", () => {
    // The middle (text) beat must carry no raw newline.
    expect(ptyInjectBeats("a\nb\nc")[1].data).toBe("a b c");
  });
});

describe("loadNodePty", () => {
  it("returns the module when require yields one with spawn()", () => {
    const fake = { spawn: () => ({}) } as unknown as NodePty;
    expect(loadNodePty(((): unknown => fake) as unknown as NodeRequire)).toBe(fake);
  });

  it("returns null when require throws (not installed / broken native addon)", () => {
    const req = (() => {
      throw new Error("Cannot find module 'node-pty'");
    }) as unknown as NodeRequire;
    expect(loadNodePty(req)).toBeNull();
  });

  it("returns null when the module has no spawn()", () => {
    expect(loadNodePty(((): unknown => ({})) as unknown as NodeRequire)).toBeNull();
  });

  it("tolerates a req seam without resolve() — module still returned", () => {
    // loadNodePty calls ensureSpawnHelperExecutable, whose req.resolve access
    // must stay best-effort so bare-function seams (and exotic runtimes) work.
    const fake = { spawn: () => ({}) } as unknown as NodePty;
    expect(loadNodePty(((): unknown => fake) as unknown as NodeRequire)).toBe(fake);
  });
});

// ── ensureSpawnHelperExecutable (the old postinstall chmod, now at load time) ─

describe.runIf(process.platform === "darwin")("ensureSpawnHelperExecutable", () => {
  function makeFakeNodePtyPackage(): { root: string; helper: string } {
    const root = mkdtempSync(join(tmpdir(), "argent-pty-chmod-"));
    const pkgDir = join(root, "node-pty");
    const prebuildDir = join(pkgDir, "prebuilds", "darwin-arm64");
    mkdirSync(prebuildDir, { recursive: true });
    writeFileSync(join(pkgDir, "package.json"), '{"name":"node-pty"}');
    const helper = join(prebuildDir, "spawn-helper");
    writeFileSync(helper, "#!/bin/sh\n", { mode: 0o644 });
    return { root, helper };
  }

  it("restores +x on every prebuild's spawn-helper", () => {
    const { root, helper } = makeFakeNodePtyPackage();
    try {
      const req = {
        resolve: () => join(root, "node-pty", "package.json"),
      } as unknown as NodeRequire;
      expect(statSync(helper).mode & 0o111).toBe(0);
      ensureSpawnHelperExecutable(req);
      expect(statSync(helper).mode & 0o755).toBe(0o755);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("is silent when node-pty cannot be resolved", () => {
    const req = {
      resolve: () => {
        throw new Error("Cannot find module 'node-pty/package.json'");
      },
    } as unknown as NodeRequire;
    expect(() => ensureSpawnHelperExecutable(req)).not.toThrow();
  });
});

// ── startPtyProxy wiring, driven by fakes ────────────────────────────────────

function makeFakePty() {
  const writes: string[] = [];
  let dataCb: ((d: string) => void) | undefined;
  let exitCb: ((e: { exitCode: number }) => void) | undefined;
  const term: IPty = {
    pid: 4242,
    onData(cb) {
      dataCb = cb;
      return { dispose: vi.fn() };
    },
    onExit(cb) {
      exitCb = cb as (e: { exitCode: number }) => void;
      return { dispose: vi.fn() };
    },
    write: vi.fn((d: string) => {
      writes.push(d);
    }),
    resize: vi.fn(),
    kill: vi.fn(),
  };
  const spawn = vi.fn(
    (_file: string, _args: string[] | string, _opts: Record<string, unknown>) => term
  );
  const mod = { spawn } as unknown as NodePty;
  return {
    mod,
    term,
    spawn,
    writes,
    emitData: (d: string) => dataCb?.(d),
    emitExit: (code: number) => exitCb?.({ exitCode: code }),
  };
}

function makeFakeStdin() {
  const listeners: Array<(d: Buffer) => void> = [];
  const state = { isRaw: false };
  return {
    isTTY: true,
    get isRaw() {
      return state.isRaw;
    },
    setRawMode: vi.fn((m: boolean) => {
      state.isRaw = m;
    }),
    resume: vi.fn(),
    pause: vi.fn(),
    on: (_ev: "data", cb: (d: Buffer) => void) => listeners.push(cb),
    off: (_ev: "data", cb: (d: Buffer) => void) => {
      const i = listeners.indexOf(cb);
      if (i >= 0) listeners.splice(i, 1);
    },
    emit: (d: Buffer) => listeners.slice().forEach((cb) => cb(d)),
    listenerCount: () => listeners.length,
  };
}

function makeFakeStdout() {
  const chunks: string[] = [];
  return { columns: 120, rows: 40, write: (c: string) => chunks.push(c), chunks };
}

function makeFakeSignals() {
  const listeners: Array<() => void> = [];
  return {
    on: (_e: "SIGWINCH", cb: () => void) => listeners.push(cb),
    off: (_e: "SIGWINCH", cb: () => void) => {
      const i = listeners.indexOf(cb);
      if (i >= 0) listeners.splice(i, 1);
    },
    emit: () => listeners.slice().forEach((cb) => cb()),
    count: () => listeners.length,
  };
}

function start(overrides: { stdin?: ReturnType<typeof makeFakeStdin> } = {}) {
  const pty = makeFakePty();
  const stdin = overrides.stdin ?? makeFakeStdin();
  const stdout = makeFakeStdout();
  const signals = makeFakeSignals();
  const proxy = startPtyProxy({
    pty: pty.mod,
    command: "cd /x; claude",
    cwd: "/x",
    stdin: stdin as unknown as ProxyInput,
    stdout: stdout as unknown as ProxyOutput,
    signals,
  });
  return { pty, stdin, stdout, signals, proxy };
}

afterEach(() => vi.useRealTimers());

describe("startPtyProxy — spawn", () => {
  it("runs the command under /bin/sh with the host's window size", () => {
    const { pty, stdout } = start();
    expect(pty.spawn).toHaveBeenCalledTimes(1);
    const [file, args, opts] = pty.spawn.mock.calls[0];
    expect(file).toBe("/bin/sh");
    expect(args).toEqual(["-c", "cd /x; claude"]);
    expect(opts).toMatchObject({ cols: stdout.columns, rows: stdout.rows, cwd: "/x" });
  });

  it("exposes the agent pid", () => {
    expect(start().proxy.pid).toBe(4242);
  });
});

describe("startPtyProxy — io forwarding", () => {
  it("puts stdin in raw mode and resumes it", () => {
    const { stdin } = start();
    expect(stdin.setRawMode).toHaveBeenCalledWith(true);
    expect(stdin.resume).toHaveBeenCalled();
  });

  it("forwards stdin keystrokes to the PTY", () => {
    const { stdin, pty } = start();
    stdin.emit(Buffer.from("ab"));
    expect(pty.writes).toContain("ab");
  });

  it("forwards PTY output to stdout and to observers", () => {
    const { pty, stdout, proxy } = start();
    const seen: string[] = [];
    proxy.onData((c) => seen.push(c));
    pty.emitData("hello");
    expect(stdout.chunks).toContain("hello");
    expect(seen).toEqual(["hello"]);
  });

  it("propagates window resize to the PTY", () => {
    const { signals, pty } = start();
    signals.emit();
    expect(pty.term.resize).toHaveBeenCalledWith(120, 40);
  });
});

describe("startPtyProxy — inject", () => {
  it("types Esc, the flattened feedback, then Enter, in order", async () => {
    vi.useFakeTimers();
    const { proxy, pty } = start();
    proxy.inject("pick\nthis");
    await vi.advanceTimersByTimeAsync(500);
    expect(pty.writes).toEqual(["\x1b", "pick this", "\r"]);
  });

  it("serializes two rounds so their beats don't interleave", async () => {
    vi.useFakeTimers();
    const { proxy, pty } = start();
    proxy.inject("one");
    proxy.inject("two");
    await vi.advanceTimersByTimeAsync(2000);
    expect(pty.writes).toEqual(["\x1b", "one", "\r", "\x1b", "two", "\r"]);
  });

  it("write() sends raw bytes with no Esc/Enter framing", () => {
    const { proxy, pty } = start();
    proxy.write("\r");
    expect(pty.writes).toEqual(["\r"]);
  });

  it("holds the inject until the user pauses typing, so Esc can't clobber a live draft", async () => {
    vi.useFakeTimers();
    try {
      const { proxy, pty, stdin } = start();
      stdin.emit(Buffer.from("dr")); // user is mid-keystroke (also echoed to the PTY)
      proxy.inject("feedback");

      // Within the quiet window of the last keystroke: the composer-clearing Esc
      // and the feedback must NOT have been sent yet.
      await vi.advanceTimersByTimeAsync(300);
      expect(pty.writes).toEqual(["dr"]);

      // Another keystroke resets the pause timer — still no inject.
      stdin.emit(Buffer.from("aft"));
      await vi.advanceTimersByTimeAsync(300);
      expect(pty.writes).toEqual(["dr", "aft"]);

      // Once the user goes quiet past the threshold, the beats land in order,
      // after the user's own keystrokes.
      await vi.advanceTimersByTimeAsync(1200);
      expect(pty.writes).toEqual(["dr", "aft", "\x1b", "feedback", "\r"]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("startPtyProxy — teardown", () => {
  it("on agent exit, restores raw mode and fires the exit callback", () => {
    const { proxy, stdin, pty } = start();
    const onExit = vi.fn();
    proxy.onExit(onExit);
    pty.emitExit(7);
    expect(stdin.setRawMode).toHaveBeenLastCalledWith(false);
    expect(stdin.pause).toHaveBeenCalled();
    expect(onExit).toHaveBeenCalledWith(7);
  });

  it("dispose() kills the agent, restores the terminal, and rejects further injects", () => {
    const { proxy, stdin, pty, signals } = start();
    proxy.dispose();
    expect(pty.term.kill).toHaveBeenCalled();
    expect(stdin.setRawMode).toHaveBeenLastCalledWith(false);
    expect(signals.count()).toBe(0); // resize listener removed
    expect(proxy.inject("late")).toBe(false);
    expect(proxy.write("x")).toBe(false);
  });

  it("dispose() after a natural exit does not double-kill", () => {
    const { proxy, pty } = start();
    pty.emitExit(0);
    proxy.dispose();
    expect(pty.term.kill).not.toHaveBeenCalled();
  });
});
