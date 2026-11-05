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
import { FAILURE_CODES, getFailureSignal } from "@argent/registry";
import { runAdb, adbShell } from "../../src/utils/adb";
import {
  startPerfetto,
  buildTraceConfig,
  withoutCpuSampling,
} from "../../src/utils/android-profiler/capture";

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

const CONFIG_PATH = /^\/data\/local\/tmp\/argent-20260101-000000-[0-9a-f]{8}\.pbtxt$/;
const MODERN_HELP =
  "  --background-wait -D : Exits once tracing starts\n  --txt : Parse config as pbtxt\n";
const ANDROID_11_HELP = "  --background -d : Exits immediately\n  --txt : Parse config as pbtxt\n";
const ANDROID_9_HELP = "perfetto: unrecognized option\n  --background -b : Exits immediately\n";

function mockShell(help: string): void {
  adbShellMock.mockImplementation(async (_serial: string, command: string) =>
    command.startsWith("perfetto --help") ? help : ""
  );
}

describe("withoutCpuSampling", () => {
  it("removes the marked section of the real template and nothing else", async () => {
    const full = await buildTraceConfig("com.example.app");
    expect(full).toContain("linux.perf");
    const out = withoutCpuSampling(full);
    expect(out).not.toContain("linux.perf");
    expect(out).not.toContain("callstack_sampling");
    expect(out).toContain("linux.ftrace");
    expect(out).toContain("buffers:");
    expect(out.split("{").length).toBe(out.split("}").length);
  });

  it("leaves a config without the markers alone", () => {
    const cfg = 'data_sources: { config: { name: "linux.perf" } }';
    expect(withoutCpuSampling(cfg)).toBe(cfg);
  });
});

describe("startPerfetto", () => {
  beforeEach(() => {
    captureState.lastSpawn = null;
    runAdbMock.mockReset();
    runAdbMock.mockResolvedValue({ stdout: "", stderr: "" });
    adbShellMock.mockReset();
    mockShell(MODERN_HELP);
  });

  it("pushes the config and pipes it into perfetto on the device", async () => {
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
    expect(args.slice(-2)[0]).toBe("shell");
    const command = args[args.length - 1];
    expect(command).toContain(`cat ${onDeviceConfigPath} | perfetto --txt -c - --background-wait`);
    expect(command).toMatch(/-o \/data\/misc\/perfetto-traces\/argent-.*\.pftrace$/);
    // The pushed config is removed once perfetto has read it.
    expect(adbShellMock).toHaveBeenCalledWith(
      "emulator-5554",
      `rm -f ${onDeviceConfigPath}`,
      expect.anything()
    );
  });

  it("uses --background where perfetto has no --background-wait, and checks it stayed up", async () => {
    mockShell(ANDROID_11_HELP);
    const promise = startPerfetto({
      serial: "emulator-5554",
      appPackage: "com.example.app",
      timestamp: "20260101-000000",
    });
    await waitForSpawn();
    lastSpawnRef()!.child.stdout.emit("data", Buffer.from("12345\n"));
    const result = await promise;
    expect(result.cpuSampling).toBe(true);
    expect(lastSpawnRef()!.args.at(-1)!).toContain("perfetto --txt -c - --background -o ");
    expect(adbShellMock).toHaveBeenCalledWith(
      "emulator-5554",
      expect.stringContaining("/proc/12345"),
      expect.anything()
    );
  });

  it("reports a backgrounded perfetto that died right after printing its PID", async () => {
    adbShellMock.mockImplementation(async (_serial: string, command: string) => {
      if (command.startsWith("perfetto --help")) return ANDROID_11_HELP;
      return command.includes("/proc/") ? "gone\n" : "";
    });
    const promise = startPerfetto({
      serial: "emulator-5554",
      appPackage: "com.example.app",
      timestamp: "20260101-000000",
    });
    await waitForSpawn();
    lastSpawnRef()!.child.stdout.emit("data", Buffer.from("12345\n"));
    await expect(promise).rejects.toThrow(/persist\.traced\.enable/);
  });

  it("retries without CPU sampling when perfetto rejects a config field", async () => {
    mockShell(ANDROID_11_HELP);
    const pushes = recordPushes();
    const promise = startPerfetto({
      serial: "emulator-5554",
      appPackage: "com.example.app",
      timestamp: "20260101-000000",
    });
    await waitForSpawn();
    const first = lastSpawnRef()!.child;
    captureState.lastSpawn = null;
    first.stdout.emit("data", Buffer.from('-:38:7 error: No field named "timebase" in proto\n'));
    first.emit("exit", 0, null);
    await waitForSpawn();
    lastSpawnRef()!.child.stdout.emit("data", Buffer.from("777\n"));
    const result = await promise;

    expect(result.pid).toBe(777);
    expect(result.cpuSampling).toBe(false);
    expect(pushes).toHaveLength(2);
    expect(pushes[0].content).toContain("linux.perf");
    expect(pushes[1].content).not.toContain("linux.perf");
    expect(pushes[1].content).not.toContain("callstack_sampling");
    expect(pushes[1].content).toContain("linux.ftrace");
  });

  it("does not count empty --help output as an unsupported device", async () => {
    mockShell("");
    const promise = startPerfetto({
      serial: "emulator-5554",
      appPackage: "com.example.app",
      timestamp: "20260101-000000",
    });
    await waitForSpawn();
    lastSpawnRef()!.child.stdout.emit("data", Buffer.from("12345\n"));
    await promise;
    expect(lastSpawnRef()!.args.at(-1)!).toContain("--background-wait");
  });

  it("stops an on-device perfetto when the start fails", async () => {
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
      "pkill -f '[a]rgent-20260101-000000.pftrace'",
      expect.anything()
    );
  });

  it("refuses a perfetto that cannot read a text config, before pushing anything", async () => {
    mockShell(ANDROID_9_HELP);
    const err = await startPerfetto({
      serial: "emulator-5554",
      appPackage: "com.example.app",
      timestamp: "20260101-000000",
    }).catch((e: unknown) => e);
    expect((err as Error).message).toContain("Android 10 or newer");
    expect(getFailureSignal(err)?.error_code).toBe(
      FAILURE_CODES.NATIVE_PROFILER_PERFETTO_UNSUPPORTED
    );
    expect(runAdbMock).not.toHaveBeenCalled();
    expect(lastSpawnRef()).toBeNull();
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

  it("fails clearly when the push fails, without starting perfetto", async () => {
    runAdbMock.mockRejectedValue(new Error("remote couldn't create file: Permission denied"));
    await expect(
      startPerfetto({
        serial: "emulator-5554",
        appPackage: "com.example.app",
        timestamp: "20260101-000000",
      })
    ).rejects.toThrow(/Failed to push the perfetto config.*Permission denied/);
    expect(lastSpawnRef()).toBeNull();
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
});
