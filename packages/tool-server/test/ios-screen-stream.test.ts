import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "events";
import { PassThrough } from "stream";
import { existsSync, promises as fs } from "fs";
import os from "os";
import path from "path";
import { getFailureSignal, FAILURE_CODES } from "@argent/registry";

vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("child_process")>();
  return { ...actual, spawn: vi.fn(), execFile: vi.fn() };
});

import { execFile, spawn } from "child_process";
import {
  ensureHelperBinary,
  resolveSourceDir,
  startIosScreenStream,
} from "../src/tools/screen-recording/ios-device-stream/ios-screen-stream";

const mockSpawn = vi.mocked(spawn);
const mockExecFile = vi.mocked(execFile);

type ExecCb = (err: Error | null, out?: { stdout: string; stderr: string }) => void;

/** Make each execFile call run `impl(file, args)`; a thrown error fails that call. */
function execFileRuns(impl: (file: string, args: string[]) => Promise<void> | void) {
  mockExecFile.mockImplementation(((file: string, args: string[], _opts: unknown, cb: ExecCb) => {
    Promise.resolve()
      .then(() => impl(file, args))
      .then(
        () => cb(null, { stdout: "", stderr: "" }),
        (err: Error) => cb(err)
      );
  }) as never);
}

/** The `-o` target swiftc is asked to write. */
const outputOf = (args: string[]) => args[args.indexOf("-o") + 1]!;

class FakeHelper extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  kill = vi.fn((signal?: NodeJS.Signals) => {
    this.killed.push(signal ?? "SIGTERM");
    return true;
  });
  killed: string[] = [];
  get stdinEnded() {
    return this.stdin.writableEnded;
  }
  line(obj: unknown) {
    this.stdout.write(JSON.stringify(obj) + "\n");
  }
  exit(code: number | null, signal: NodeJS.Signals | null = null) {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
  }
}

let home: string;
let savedHome: string | undefined;
let sourceDir: string;

beforeEach(async () => {
  mockSpawn.mockReset();
  mockExecFile.mockReset();
  home = await fs.mkdtemp(path.join(os.tmpdir(), "argent-iss-home-"));
  savedHome = process.env.HOME;
  // os.homedir() reads HOME first, so the helper cache lands in the scratch dir.
  process.env.HOME = home;
  sourceDir = path.join(home, "src");
  await fs.mkdir(sourceDir);
  await fs.writeFile(path.join(sourceDir, "ios-screen-stream.swift"), "// swift");
  await fs.writeFile(path.join(sourceDir, "Info.plist"), "<plist/>");
});

afterEach(async () => {
  vi.useRealTimers();
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  await fs.rm(home, { recursive: true, force: true });
});

async function cacheEntries(): Promise<string[]> {
  const root = path.join(home, ".argent", "ios-screen-stream");
  if (!existsSync(root)) return [];
  const out: string[] = [];
  for (const key of await fs.readdir(root)) {
    for (const f of await fs.readdir(path.join(root, key))) out.push(path.join(key, f));
  }
  return out;
}

describe("resolveSourceDir", () => {
  it("prefers the bundled assets directory next to dist/", async () => {
    const dist = path.join(home, "pkg", "dist");
    const assets = path.join(home, "pkg", "assets", "ios-screen-stream");
    await fs.mkdir(dist, { recursive: true });
    await fs.mkdir(assets, { recursive: true });
    await fs.writeFile(path.join(assets, "ios-screen-stream.swift"), "// swift");
    await fs.writeFile(path.join(dist, "ios-screen-stream.swift"), "// swift");
    expect(resolveSourceDir(dist)).toBe(assets);
  });

  it("falls back to the module's own directory in dev", () => {
    expect(resolveSourceDir(sourceDir)).toBe(sourceDir);
  });

  it("fails with the build-failed code and the paths it tried", () => {
    const empty = path.join(home, "nothing", "dist");
    try {
      resolveSourceDir(empty);
      expect.unreachable();
    } catch (err) {
      expect(getFailureSignal(err)?.error_code).toBe(
        FAILURE_CODES.SCREEN_RECORDING_DEVICE_HELPER_BUILD_FAILED
      );
      expect((err as Error).message).toContain(empty);
    }
  });
});

describe("ensureHelperBinary", () => {
  it("compiles with the embedded Info.plist, signs, and renames into the cache", async () => {
    const calls: Array<[string, string[]]> = [];
    execFileRuns(async (file, args) => {
      calls.push([file, args]);
      if (args[0] === "swiftc") await fs.writeFile(outputOf(args), "bin");
    });

    const binary = await ensureHelperBinary(sourceDir);

    expect(path.basename(binary)).toBe("ios-screen-stream");
    expect(existsSync(binary)).toBe(true);
    expect(calls.map(([file, args]) => `${file} ${args[0]}`)).toEqual([
      "xcrun swiftc",
      "codesign -s",
    ]);
    const swiftArgs = calls[0]![1];
    expect(swiftArgs).toContain("__info_plist");
    expect(swiftArgs).toContain(path.join(sourceDir, "Info.plist"));
    expect(calls[1]![1]).toContain("com.swmansion.argent.ios-screen-stream");
    // Only the final binary is left: the staging file was renamed, not copied.
    expect(await cacheEntries()).toHaveLength(1);
  });

  it("reuses a cached binary without compiling", async () => {
    execFileRuns(async (_file, args) => {
      if (args[0] === "swiftc") await fs.writeFile(outputOf(args), "bin");
    });
    const first = await ensureHelperBinary(sourceDir);
    mockExecFile.mockClear();

    expect(await ensureHelperBinary(sourceDir)).toBe(first);
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it("rebuilds under a new key when the source changes", async () => {
    execFileRuns(async (_file, args) => {
      if (args[0] === "swiftc") await fs.writeFile(outputOf(args), "bin");
    });
    const first = await ensureHelperBinary(sourceDir);
    await fs.writeFile(path.join(sourceDir, "ios-screen-stream.swift"), "// swift v2");
    const second = await ensureHelperBinary(sourceDir);
    expect(second).not.toBe(first);
    expect(path.dirname(second)).not.toBe(path.dirname(first));
  });

  it("removes the staging file and maps the failure when swiftc fails", async () => {
    execFileRuns(async (_file, args) => {
      if (args[0] === "swiftc") {
        await fs.writeFile(outputOf(args), "partial");
        throw Object.assign(new Error("exit 1"), { code: 1, stderr: "error: no such module\n" });
      }
    });

    const err = await ensureHelperBinary(sourceDir).catch((e: unknown) => e);
    const signal = getFailureSignal(err);
    expect(signal?.error_code).toBe(FAILURE_CODES.SCREEN_RECORDING_DEVICE_HELPER_BUILD_FAILED);
    expect(signal?.failure_stage).toBe("screen_recording_device_helper_compile");
    expect((err as Error).message).toContain("error: no such module");
    expect(await cacheEntries()).toEqual([]);
  });

  it("removes the staging file when codesign fails", async () => {
    execFileRuns(async (file, args) => {
      if (args[0] === "swiftc") await fs.writeFile(outputOf(args), "bin");
      if (file === "codesign") throw Object.assign(new Error("codesign failed"), { code: 1 });
    });

    const err = await ensureHelperBinary(sourceDir).catch((e: unknown) => e);
    expect(getFailureSignal(err)?.error_code).toBe(
      FAILURE_CODES.SCREEN_RECORDING_DEVICE_HELPER_BUILD_FAILED
    );
    expect(await cacheEntries()).toEqual([]);
  });
});

describe("startIosScreenStream", () => {
  let helper: FakeHelper;

  beforeEach(async () => {
    // A cached binary, so every start skips the compile.
    execFileRuns(async (_file, args) => {
      if (args[0] === "swiftc") await fs.writeFile(outputOf(args), "bin");
    });
    await ensureHelperBinary(resolveSourceDir());
    mockExecFile.mockClear();
    helper = new FakeHelper();
    mockSpawn.mockReturnValue(helper as never);
  });

  async function spawned() {
    await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalled());
  }

  it("resolves on the ready line, even split across chunks", async () => {
    const pending = startIosScreenStream("Patrick’s iPhone");
    await spawned();
    expect(mockSpawn.mock.calls[0]![1]).toEqual(["--name", "Patrick’s iPhone"]);
    helper.stdout.write("not json\n");
    helper.stdout.write('{"event":"ready","po');
    helper.stdout.write('rt":51234,"device":"Patrick’s iPhone"}\n');

    const stream = await pending;
    expect(stream.streamUrl).toBe("http://127.0.0.1:51234/");
    expect(stream.deviceName).toBe("Patrick’s iPhone");
    expect(helper.killed).toEqual([]);
  });

  it("passes no --name when the phone's name is unknown", async () => {
    const pending = startIosScreenStream(undefined);
    await spawned();
    expect(mockSpawn.mock.calls[0]![1]).toEqual([]);
    helper.line({ event: "ready", port: 1, device: "iPhone" });
    await pending;
  });

  it.each([
    ["device_not_found", FAILURE_CODES.SCREEN_RECORDING_DEVICE_SCREEN_NOT_FOUND],
    ["ambiguous_device", FAILURE_CODES.SCREEN_RECORDING_DEVICE_SCREEN_NOT_FOUND],
    ["camera_permission_denied", FAILURE_CODES.SCREEN_RECORDING_DEVICE_CAMERA_PERMISSION_DENIED],
    ["helper_failed", FAILURE_CODES.SCREEN_RECORDING_DEVICE_HELPER_FAILED],
    ["something_new", FAILURE_CODES.SCREEN_RECORDING_DEVICE_HELPER_FAILED],
  ])("maps the helper's %s error and stops it", async (code, expected) => {
    const pending = startIosScreenStream("iPhone");
    await spawned();
    helper.line({ event: "error", code, message: `helper said ${code}` });

    const err = await pending.catch((e: unknown) => e);
    expect(getFailureSignal(err)?.error_code).toBe(expected);
    expect((err as Error).message).toBe(`helper said ${code}`);
    expect(helper.stdinEnded).toBe(true);
    expect(helper.killed).toContain("SIGTERM");
  });

  it("fails with stderr when the helper exits before it is ready", async () => {
    const pending = startIosScreenStream("iPhone");
    await spawned();
    helper.stderr.write("dyld: missing symbol\n");
    await new Promise((r) => setImmediate(r));
    helper.exit(6);

    const err = await pending.catch((e: unknown) => e);
    expect(getFailureSignal(err)?.error_code).toBe(
      FAILURE_CODES.SCREEN_RECORDING_DEVICE_HELPER_FAILED
    );
    expect((err as Error).message).toContain("code 6");
    expect((err as Error).message).toContain("dyld: missing symbol");
  });

  it("fails at the spawn stage when the binary cannot be launched", async () => {
    const pending = startIosScreenStream("iPhone");
    await spawned();
    helper.emit("error", Object.assign(new Error("spawn EACCES"), { code: "EACCES" }));

    const err = await pending.catch((e: unknown) => e);
    const signal = getFailureSignal(err);
    expect(signal?.error_code).toBe(FAILURE_CODES.SCREEN_RECORDING_DEVICE_HELPER_FAILED);
    expect(signal?.failure_stage).toBe("screen_recording_device_helper_spawn");
  });

  it("times out after 15s without a permission prompt", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const pending = startIosScreenStream("iPhone");
    const settled = pending.catch((e: unknown) => e);
    await spawned();

    await vi.advanceTimersByTimeAsync(15_000);
    const err = await settled;
    expect(getFailureSignal(err)?.failure_stage).toBe("screen_recording_device_helper_ready");
    expect((err as Error).message).toContain("15s");
    expect(helper.killed).toContain("SIGTERM");
  });

  it("waits up to 130s once the helper says the camera prompt is up", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const pending = startIosScreenStream("iPhone");
    let outcome: unknown = "pending";
    pending.then(
      (s) => (outcome = s),
      (e: unknown) => (outcome = e)
    );
    await spawned();
    helper.line({ event: "awaiting_permission" });
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(outcome).toBe("pending");
    await vi.advanceTimersByTimeAsync(70_000);
    expect(getFailureSignal(outcome)?.error_code).toBe(
      FAILURE_CODES.SCREEN_RECORDING_DEVICE_HELPER_FAILED
    );
    expect((outcome as Error).message).toContain("130s");
  });

  it("resolves when the user allows access during the prompt", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const pending = startIosScreenStream("iPhone");
    await spawned();
    helper.line({ event: "awaiting_permission" });
    await vi.advanceTimersByTimeAsync(40_000);
    helper.line({ event: "ready", port: 4000, device: "iPhone" });
    await expect(pending).resolves.toMatchObject({ streamUrl: "http://127.0.0.1:4000/" });
  });

  it("close() ends stdin, sends SIGTERM, and escalates to SIGKILL if the helper hangs", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const pending = startIosScreenStream("iPhone");
    await spawned();
    helper.line({ event: "ready", port: 1, device: "iPhone" });
    const stream = await pending;

    stream.close();
    await vi.advanceTimersByTimeAsync(0);
    expect(helper.stdinEnded).toBe(true);
    expect(helper.killed).toEqual(["SIGTERM"]);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(helper.killed).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("close() does not escalate once the helper has exited", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const pending = startIosScreenStream("iPhone");
    await spawned();
    helper.line({ event: "ready", port: 1, device: "iPhone" });
    const stream = await pending;

    stream.close();
    helper.exit(0);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(helper.killed).toEqual(["SIGTERM"]);
    stream.close();
    expect(helper.killed).toEqual(["SIGTERM"]);
  });
});
