import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "events";

class FakeChild extends EventEmitter {
  pid = 9000;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killed = false;
  kill = vi.fn();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  stdinWritten = "";
  stdin = Object.assign(new EventEmitter(), {
    write: (chunk: string | Buffer) => {
      this.stdinWritten += chunk.toString();
    },
    end: () => {},
  });
}

// Pop a fresh state holder before each test — vi.mock is hoisted, so any
// references made via vi.hoisted survive the hoist.
const captureState = vi.hoisted(() => ({
  lastSpawn: null as { args: string[]; child: unknown } | null,
}));

vi.mock("child_process", () => ({
  spawn: (_path: string, args: string[]) => {
    // Use eval to lazy-construct so the FakeChild reference isn't hoisted.

    const Mod = require("events");
    const child: FakeChild = new (class extends (Mod.EventEmitter as typeof EventEmitter) {
      pid = 9000;
      stdout = new Mod.EventEmitter();
      stderr = new Mod.EventEmitter();
      killed = false;
      kill = vi.fn();
      exitCode: number | null = null;
      signalCode: NodeJS.Signals | null = null;
      stdinWritten = "";
      stdin = Object.assign(new Mod.EventEmitter(), {
        write: (chunk: string | Buffer) => {
          this.stdinWritten += chunk.toString();
        },
        end: () => {},
      });
    })() as unknown as FakeChild;
    captureState.lastSpawn = { args, child };
    return child;
  },
}));
const lastSpawnRef = () => captureState.lastSpawn as { args: string[]; child: FakeChild } | null;
vi.mock("../../src/utils/android-binary", () => ({
  resolveAndroidBinary: vi.fn(async () => "/fake/adb"),
}));
vi.mock("../../src/utils/adb", () => ({
  runAdb: vi.fn(async () => ({ stdout: "", stderr: "" })),
  adbShell: vi.fn(async () => ""),
}));

import { startPerfetto, buildTraceConfig } from "../../src/utils/android-profiler/capture";

// Poll on a wall-clock deadline rather than a fixed tick budget: startPerfetto
// does real async work (resolveAndroidBinary + buildTraceConfig's fs.readFile)
// before it calls spawn. A fixed setImmediate count can elapse before that I/O
// lands on a loaded/cold-cache CI box, leaving lastSpawn null and the test
// dereferencing it (TypeError reading 'child') or hanging to the 5s timeout. A
// timed poll waits for the actual spawn regardless of host speed.
async function waitForSpawn(): Promise<void> {
  const deadline = Date.now() + 4000;
  while (!lastSpawnRef() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5));
  }
  if (!lastSpawnRef()) {
    throw new Error("waitForSpawn: spawn was never called within 4s");
  }
}

describe("buildTraceConfig", () => {
  it("substitutes both target placeholders", async () => {
    const tpl =
      'target_cmdline: "TARGET_CMDLINE_PLACEHOLDER"\natrace_apps: "TARGET_PACKAGE_PLACEHOLDER"';
    const out = await buildTraceConfig("com.example.app", tpl);
    expect(out).toContain('target_cmdline: "com.example.app"');
    expect(out).toContain('atrace_apps: "com.example.app"');
  });

  it("replaces all occurrences (replaceAll, not just the first)", async () => {
    const tpl = "TARGET_PACKAGE_PLACEHOLDER TARGET_PACKAGE_PLACEHOLDER";
    const out = await buildTraceConfig("pkg.a", tpl);
    expect(out).toBe("pkg.a pkg.a");
  });
});

describe("startPerfetto", () => {
  beforeEach(() => {
    captureState.lastSpawn = null;
  });

  it("invokes adb with --background-wait and -c - (stdin config)", async () => {
    const promise = startPerfetto({
      serial: "emulator-5554",
      appPackage: "com.example.app",
      timestamp: "20260101-000000",
    });
    await waitForSpawn();
    lastSpawnRef()!.child.stdout.emit("data", Buffer.from("12345\n"));
    const result = await promise;

    expect(result.pid).toBe(12345);
    const args = lastSpawnRef()!.args;
    expect(args).toContain("--background-wait");
    expect(args).toContain("-c");
    const cIdx = args.indexOf("-c");
    expect(args[cIdx + 1]).toBe("-");
    const oIdx = args.indexOf("-o");
    expect(args[oIdx + 1]).toMatch(/^\/data\/misc\/perfetto-traces\/argent-.*\.pftrace$/);
    const stdinText = (lastSpawnRef()!.child as { stdinWritten: string }).stdinWritten;
    expect(stdinText).toContain("data_sources");
    expect(stdinText).toContain("com.example.app");
  });

  it("tolerates warning text preceding the PID — parses the last non-empty stdout line", async () => {
    const promise = startPerfetto({
      serial: "emulator-5554",
      appPackage: "com.example.app",
      timestamp: "20260101-000000",
    });
    await waitForSpawn();
    lastSpawnRef()!.child.stdout.emit(
      "data",
      Buffer.from("[warning] something benign happened\n67890\n")
    );
    const result = await promise;
    expect(result.pid).toBe(67890);
  });

  it("rejects when perfetto exits without printing a PID", async () => {
    const promise = startPerfetto({
      serial: "emulator-5554",
      appPackage: "com.example.app",
      timestamp: "20260101-000000",
    });
    await waitForSpawn();
    lastSpawnRef()!.child.stderr.emit("data", Buffer.from("ERROR: target_cmdline not found\n"));
    lastSpawnRef()!.child.emit("exit", 1, null);
    await expect(promise).rejects.toThrow(/perfetto exited|did not return a PID/);
  });

  // stability_analysis.md #4 — a chunk split mid-number must NOT resolve a
  // truncated PID, or stop signals the wrong process and the daemon orphans.
  it("does not resolve a partial PID when a chunk ends mid-number", async () => {
    const promise = startPerfetto({
      serial: "emulator-5554",
      appPackage: "com.example.app",
      timestamp: "20260101-000000",
    });
    await waitForSpawn();
    const child = lastSpawnRef()!.child;
    // First chunk ends mid-number, no trailing newline — must be ignored.
    child.stdout.emit("data", Buffer.from("123"));
    // Second chunk completes the line.
    child.stdout.emit("data", Buffer.from("45\n"));
    const result = await promise;
    expect(result.pid).toBe(12345);
  });

  it("parses a trailing PID with no newline once the process exits", async () => {
    const promise = startPerfetto({
      serial: "emulator-5554",
      appPackage: "com.example.app",
      timestamp: "20260101-000000",
    });
    await waitForSpawn();
    const child = lastSpawnRef()!.child;
    child.stdout.emit("data", Buffer.from("4242"));
    child.emit("exit", 0, null);
    const result = await promise;
    expect(result.pid).toBe(4242);
  });

  // stability_analysis.md #1 — a spawn/exec 'error' with no listener throws as
  // an uncaught exception; it must reject the start promise instead.
  it("rejects (does not throw uncaught) when the child emits 'error'", async () => {
    const promise = startPerfetto({
      serial: "emulator-5554",
      appPackage: "com.example.app",
      timestamp: "20260101-000000",
    });
    await waitForSpawn();
    lastSpawnRef()!.child.emit("error", new Error("spawn EACCES"));
    await expect(promise).rejects.toThrow(/Failed to launch adb for perfetto.*EACCES/);
  });

  it("rejects when writing the config to a broken stdin emits 'error'", async () => {
    const promise = startPerfetto({
      serial: "emulator-5554",
      appPackage: "com.example.app",
      timestamp: "20260101-000000",
    });
    await waitForSpawn();
    lastSpawnRef()!.child.stdin.emit("error", new Error("EPIPE"));
    await expect(promise).rejects.toThrow(/Failed to write perfetto config.*EPIPE/);
  });
});
