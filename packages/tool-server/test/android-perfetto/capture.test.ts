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

  /**
   * `promisify(execFile)`d at module load by utils/adb, which the mock below
   * pulls in for real. Never called from here.
   */
  execFile: (
    _file: string,
    _args: string[],
    _options: unknown,
    callback: (err: Error | null, result: { stdout: string; stderr: string }) => void
  ) => {
    callback(null, { stderr: "", stdout: "" });
  },
}));
const lastSpawnRef = () => captureState.lastSpawn as { args: string[]; child: FakeChild } | null;
vi.mock("../../src/utils/android-binary", () => ({
  resolveAndroidBinary: vi.fn(async () => "/fake/adb"),
}));

/**
 * Stub only the two runners that would reach a real device. Everything else
 * (notably the argv substitution the capture applies before spawning) stays
 * real, so a listing mock here can't quietly replace it with a no-op.
 */
vi.mock("../../src/utils/adb", async () => ({
  ...(await vi.importActual<typeof import("../../src/utils/adb")>("../../src/utils/adb")),
  runAdb: vi.fn(async () => ({ stdout: "", stderr: "" })),
  adbShell: vi.fn(async () => ""),
}));

import { readFileSync } from "fs";
import { runAdb, adbShell } from "../../src/utils/adb";
import { startPerfetto, buildTraceConfig } from "../../src/utils/android-profiler/capture";

const runAdbMock = vi.mocked(runAdb);
const adbShellMock = vi.mocked(adbShell);

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

/** The `adb push` calls, with the host file's content read while it still exists. */
function recordPushes(): { args: string[]; content: string }[] {
  const pushes: { args: string[]; content: string }[] = [];
  runAdbMock.mockImplementation(async (args: string[]) => {
    if (args.includes("push")) {
      pushes.push({ args, content: readFileSync(args[args.indexOf("push") + 1], "utf8") });
    }
    return { stdout: "", stderr: "" };
  });
  return pushes;
}

const CONFIG_PATH = /^\/data\/misc\/perfetto-configs\/argent-20260101-000000-[0-9a-f]{8}\.pbtxt$/;

describe("startPerfetto", () => {
  beforeEach(() => {
    captureState.lastSpawn = null;
    runAdbMock.mockReset();
    runAdbMock.mockResolvedValue({ stdout: "", stderr: "" });
    adbShellMock.mockReset();
    adbShellMock.mockResolvedValue("");
  });

  it("pushes the config to /data/misc/perfetto-configs and passes that path to -c", async () => {
    const pushes = recordPushes();
    const promise = startPerfetto({
      serial: "emulator-5554",
      appPackage: "com.example.app",
      timestamp: "20260101-000000",
    });
    await waitForSpawn();
    lastSpawnRef()!.child.stdout.emit("data", Buffer.from("12345\n"));
    const result = await promise;

    expect(result.pid).toBe(12345);
    expect(pushes).toHaveLength(1);
    const pushArgs = pushes[0].args;
    expect(pushArgs.slice(0, 3)).toEqual(["-s", "emulator-5554", "push"]);
    const onDeviceConfigPath = pushArgs[4];
    expect(onDeviceConfigPath).toMatch(CONFIG_PATH);
    expect(pushes[0].content).toContain("data_sources");
    expect(pushes[0].content).toContain("com.example.app");

    const args = lastSpawnRef()!.args;
    expect(args).toContain("--background-wait");
    expect(args[args.indexOf("-c") + 1]).toBe(onDeviceConfigPath);
    const oIdx = args.indexOf("-o");
    expect(args[oIdx + 1]).toMatch(/^\/data\/misc\/perfetto-traces\/argent-.*\.pftrace$/);
    // Nothing on stdin: a transport without shell_v2 never delivers its end.
    expect((lastSpawnRef()!.child as { stdinWritten: string }).stdinWritten).toBe("");
    // The pushed config is removed once perfetto has read it.
    expect(adbShellMock).toHaveBeenCalledWith(
      "emulator-5554",
      `rm -f ${onDeviceConfigPath}`,
      expect.anything()
    );
  });

  it("removes the pushed config when perfetto fails to start", async () => {
    const pushes = recordPushes();
    const promise = startPerfetto({
      serial: "emulator-5554",
      appPackage: "com.example.app",
      timestamp: "20260101-000000",
    });
    await waitForSpawn();
    lastSpawnRef()!.child.emit("exit", 1, null);
    await expect(promise).rejects.toThrow(/perfetto exited/);
    expect(adbShellMock).toHaveBeenCalledWith(
      "emulator-5554",
      `rm -f ${pushes[0].args[4]}`,
      expect.anything()
    );
  });

  it("falls back to piping the config on stdin (-c -) when the push fails", async () => {
    runAdbMock.mockRejectedValue(new Error("remote couldn't create file: Permission denied"));
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
    expect(args[args.indexOf("-c") + 1]).toBe("-");
    const stdinText = (lastSpawnRef()!.child as { stdinWritten: string }).stdinWritten;
    expect(stdinText).toContain("data_sources");
    expect(stdinText).toContain("com.example.app");
    // Nothing was pushed, so there is nothing to remove.
    expect(adbShellMock).not.toHaveBeenCalled();
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
