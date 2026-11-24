import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { FAILURE_CODES, getFailureSignal } from "@argent/registry";

// `xcrun simctl spawn ... launchctl` and `afconvert` are the only subprocesses; record them and fake their effects.
/** A mono float32 48 kHz WAV of `frames` silent frames, laid out like afconvert's (padding before `data`). */
function wavFile(file: string, frames: number): void {
  const pad = 4044;
  const h = Buffer.alloc(36 + 8 + pad + 8);
  h.write("RIFF", 0, "ascii");
  h.write("WAVEfmt ", 8, "ascii");
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(3, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(48_000, 24);
  h.writeUInt16LE(32, 34);
  h.write("FLLR", 36, "ascii");
  h.writeUInt32LE(pad, 40);
  h.write("data", 36 + 8 + pad, "ascii");
  h.writeUInt32LE(frames * 4, 36 + 8 + pad + 4);
  fs.writeFileSync(file, h);
  fs.truncateSync(file, h.length + frames * 4); // sparse zeros
}

/** Pid the fake simulator's launchd reports for the app under test; null: not running. */
let runningPid: number | null = process.pid;
const defaultExec = (cmd: string, args: readonly string[]) => {
  if (cmd === "afconvert") wavFile(args[args.length - 1], 48_000); // 1 s
  if (args.includes("launchctl") && args.includes("list")) {
    const row =
      runningPid === null
        ? ""
        : `${runningPid}\t0\tUIKitApplication:com.example.app[1a2b][rb-legacy]\n`;
    return { stdout: `PID\tStatus\tLabel\n${row}`, stderr: "" };
  }
  return { stdout: "", stderr: "" };
};
const execFileMock = vi.fn(defaultExec);

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    execFile: (
      cmd: string,
      args: readonly string[],
      opts: unknown,
      cb?: (err: Error | null, out: { stdout: string; stderr: string }) => void
    ) => {
      const callback = typeof opts === "function" ? opts : cb!;
      try {
        callback(null, execFileMock(cmd, args));
      } catch (err) {
        callback(err as Error, { stdout: "", stderr: "" });
      }
    },
  };
});

/** The grant each simctl target was resolved under; an `ext:` id resolves to its native UDID, as in ios-device-sets. */
const simctlGrants: unknown[] = [];
vi.mock("../src/utils/ios-device-sets", () => ({
  simctlTargetForUdid: async (udid: string, options?: unknown) => {
    simctlGrants.push(options);
    return { nativeId: udid.replace(/^ext:[^:]+:/, ""), prefix: ["simctl"] };
  },
  simctlArgsForUdid: async (_udid: string, args: readonly string[]) => ["simctl", ...args],
}));

let audioDylibMissing = false;
vi.mock("@argent/native-devtools-ios", () => ({
  audioDylibPath: () => {
    if (audioDylibMissing) {
      throw new Error("Native devtools dylib not found: /argent/dylibs/libArgentAudio.dylib");
    }
    return "/argent/dylibs/libArgentAudio.dylib";
  },
}));

import {
  armAudio,
  audioDir,
  clearAudioInput,
  createAudioSession,
  ensureAudioEnv,
  releaseAudio,
  type AudioSession,
  listLiveApps,
  assertHookProto,
  decideHookState,
  parseAppStatus,
  readAppHook,
  readAppStatus,
  setAudioInput,
} from "../src/utils/ios-audio";

const BUNDLE = "com.example.app";
// Unique per run so parallel test files and leftovers never share a control directory.
const UDID = `${Math.random().toString(16).slice(2, 10).padEnd(8, "0")}-0000-0000-0000-000000000000`;
const dir = audioDir(UDID);
/** A fresh one per test, as the `IosAudioSession` service is per simulator. */
let session: AudioSession;

function statusText(fields: Record<string, string | number>): string {
  const all = {
    proto: 1,
    pid: process.pid,
    rate: 48000,
    streams: 1,
    input: "mic",
    inputActive: 0,
    underruns: 0,
    error: "",
    ...fields,
  };
  return Object.entries(all)
    .map(([k, v]) => `${k}=${v}\n`)
    .join("");
}

function writeStatus(fields: Record<string, string | number>, bundle = BUNDLE): void {
  fs.writeFileSync(path.join(dir, `st.${bundle}`), statusText(fields));
}

beforeEach(() => {
  execFileMock.mockReset();
  execFileMock.mockImplementation(defaultExec);
  fs.mkdirSync(dir, { recursive: true });
  session = createAudioSession(UDID);
});

afterEach(() => {
  releaseAudio(session); // stops the feeder timer before its files go
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("parseAppStatus", () => {
  it("maps the guest's key=value file", () => {
    const status = parseAppStatus(statusText({ input: "stream", inputActive: 1, underruns: 3 }));
    expect(status).toMatchObject({
      pid: process.pid,
      sampleRate: 48000,
      streams: 1,
      input: "stream",
      inputActive: true,
      underruns: 3,
    });
  });

  it("reads an unknown or missing input as the microphone", () => {
    expect(parseAppStatus("pid=1\n").input).toBe("microphone");
    expect(parseAppStatus("input=mic\n").input).toBe("microphone");
  });
});

describe("hook protocol", () => {
  it("parses proto, 0 when missing", () => {
    expect(parseAppStatus(statusText({})).proto).toBe(1);
    expect(parseAppStatus("pid=1\n").proto).toBe(0);
  });

  it("accepts the matching version and no status at all", () => {
    expect(() => assertHookProto(parseAppStatus(statusText({})), BUNDLE)).not.toThrow();
    expect(() => assertHookProto(null, BUNDLE)).not.toThrow();
  });

  it.each([
    ["missing", "pid=1\n", "none"],
    ["mismatched", "proto=2\npid=1\n", "2"],
  ])("refuses a %s version with AUDIO_HOOK_NOT_ACTIVE", (_, text, shown) => {
    const err = (() => {
      try {
        assertHookProto(parseAppStatus(text), BUNDLE);
      } catch (e) {
        return e;
      }
    })();
    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.AUDIO_HOOK_NOT_ACTIVE);
    expect((err as Error).message).toContain(`protocol ${shown}`);
    expect((err as Error).message).toContain("restart-app");
  });
});

describe("hook state", () => {
  const status = (fields: Record<string, string | number>) => parseAppStatus(statusText(fields));
  const pid = process.pid;

  it("decides from the status file, its pid's liveness and the app's running pid", () => {
    expect(decideHookState(null, false, pid)).toBe("none");
    expect(decideHookState(status({ state: "dormant" }), true, pid)).toBe("dormant");
    expect(decideHookState(status({ state: "active" }), true, pid)).toBe("active");
    expect(decideHookState(status({}), true, pid)).toBe("active"); // no state key: a full helper status
    expect(decideHookState(status({ state: "dormant" }), false, pid)).toBe("none"); // its process is gone: a leftover
    expect(decideHookState(status({ state: "dormant" }), true, pid + 1)).toBe("stale"); // relaunched, not written yet
    expect(decideHookState(status({ state: "dormant" }), true, null)).toBe("stale"); // the app is not running
    expect(decideHookState(status({ proto: 2 }), true, pid)).toBe("old-proto");
    expect(decideHookState(parseAppStatus(`pid=${pid}\n`), true, pid)).toBe("old-proto"); // pre-proto hook
  });

  it("reads none without a file or from a dead process's, and dormant/active/stale/old-proto from a live one", async () => {
    expect((await readAppHook(session, BUNDLE)).state).toBe("none");
    writeStatus({ state: "dormant" });
    expect((await readAppHook(session, BUNDLE)).state).toBe("dormant");
    writeStatus({ state: "active" });
    expect((await readAppHook(session, BUNDLE)).state).toBe("active");
    writeStatus({ state: "dormant", pid: 2 ** 22 + 1 }); // dead pid: the app running now never wrote one
    expect((await readAppHook(session, BUNDLE)).state).toBe("none");
    writeStatus({ proto: 0 });
    expect((await readAppHook(session, BUNDLE)).state).toBe("old-proto");
    runningPid = process.pid + 1; // the app was relaunched; the file is the old process's
    try {
      writeStatus({ state: "active" });
      expect((await readAppHook(session, BUNDLE)).state).toBe("stale");
      runningPid = null;
      expect((await readAppHook(session, BUNDLE)).state).toBe("stale");
    } finally {
      runningPid = process.pid;
    }
  });
});

describe("readAppStatus", () => {
  it("is null when the app never wrote a status", () => {
    expect(readAppStatus(session, BUNDLE)).toBeNull();
  });

  it("is null when the process that wrote it is gone", () => {
    writeStatus({ pid: 2 ** 22 + 1 }); // above the pid ceiling, so never alive
    expect(readAppStatus(session, BUNDLE)).toBeNull();
  });

  it("reads a live app, and lists it", () => {
    writeStatus({});
    writeStatus({ pid: 2 ** 22 + 1 }, "com.example.dead");
    expect(readAppStatus(session, BUNDLE)?.pid).toBe(process.pid);
    expect(listLiveApps(session)).toEqual([BUNDLE]);
  });
});

describe("ensureAudioEnv", () => {
  // Each case its own simulator: a verified environment is remembered per udid for the life of the process.
  let n = 0;
  const fresh = () => `${(n++).toString(16).padStart(8, "0")}-0000-0000-0000-00000000aaaa`;
  afterEach(() => {
    for (let i = 0; i < n; i++)
      fs.rmSync(
        `/tmp/argent-audio-${i.toString(16).padStart(8, "0")}-0000-0000-0000-00000000aaaa`,
        {
          recursive: true,
          force: true,
        }
      );
  });
  const setenvCalls = () =>
    execFileMock.mock.calls
      .filter(([, args]) => args.includes("setenv"))
      .map(([, args]) => [args[5], args[6]]);
  const bootstrap = "/argent/dylibs/libArgentInjectionBootstrap.dylib";

  it("inserts the audio dylib after the bootstrap and sets ARGENT_AUDIO_DIR", async () => {
    execFileMock.mockImplementation((_cmd, args) => ({
      stdout:
        args.includes("DYLD_INSERT_LIBRARIES") && args.includes("getenv") ? `${bootstrap}\n` : "",
      stderr: "",
    }));
    const udid = fresh();
    await ensureAudioEnv(createAudioSession(udid));
    expect(setenvCalls()).toEqual([
      ["DYLD_INSERT_LIBRARIES", `${bootstrap}:/argent/dylibs/libArgentAudio.dylib`],
      ["ARGENT_AUDIO_DIR", `/tmp/argent-audio-${udid}`],
    ]);
  });

  it("changes nothing when both are already in place", async () => {
    const udid = fresh();
    execFileMock.mockImplementation((_cmd, args) => ({
      stdout: args.includes("DYLD_INSERT_LIBRARIES")
        ? `${bootstrap}:/argent/dylibs/libArgentAudio.dylib\n`
        : args.includes("ARGENT_AUDIO_DIR")
          ? `/tmp/argent-audio-${udid}\n`
          : "",
      stderr: "",
    }));
    await ensureAudioEnv(createAudioSession(udid));
    expect(setenvCalls()).toEqual([]);
  });

  it("replaces an older copy of the dylib and keeps foreign entries", async () => {
    execFileMock.mockImplementation((_cmd, args) => ({
      stdout: args.includes("DYLD_INSERT_LIBRARIES")
        ? `/other/libSimCamLoader.dylib:/old/libArgentAudio.dylib:${bootstrap}\n`
        : "",
      stderr: "",
    }));
    await ensureAudioEnv(createAudioSession(fresh()));
    expect(setenvCalls()[0]).toEqual([
      "DYLD_INSERT_LIBRARIES",
      `/other/libSimCamLoader.dylib:${bootstrap}:/argent/dylibs/libArgentAudio.dylib`,
    ]);
  });

  it("remembers a verified simulator and skips the round-trips next time", async () => {
    const verified = createAudioSession(fresh());
    await ensureAudioEnv(verified);
    execFileMock.mockClear();
    await ensureAudioEnv(verified);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("resolves the simulator under the native-devtools grant", async () => {
    simctlGrants.length = 0;
    await ensureAudioEnv(createAudioSession(fresh()));
    expect(simctlGrants).toEqual([{ granted: "native-devtools" }]);
  });

  it("spawns on the native UDID of an ext: id and names the directory after it", async () => {
    const native = fresh();
    const external = createAudioSession(`ext:acme:${native}`);
    expect(external.dir).toBe(`/tmp/argent-audio-${native}`);
    await ensureAudioEnv(external);
    const spawned = execFileMock.mock.calls
      .filter(([, args]) => args.includes("spawn"))
      .map(([, args]) => args[args.indexOf("spawn") + 1]);
    expect(spawned.length).toBeGreaterThan(0);
    expect(new Set(spawned)).toEqual(new Set([native]));
    expect(setenvCalls()).toContainEqual(["ARGENT_AUDIO_DIR", `/tmp/argent-audio-${native}`]);
  });

  it("fails with AUDIO_HOOK_UNAVAILABLE and how to get the dylib when it is not installed", async () => {
    audioDylibMissing = true;
    try {
      const err = await ensureAudioEnv(createAudioSession(fresh())).catch((e: unknown) => e);
      expect(getFailureSignal(err)).toMatchObject({
        error_code: FAILURE_CODES.AUDIO_HOOK_UNAVAILABLE,
        error_kind: "dependency_missing",
      });
      expect((err as Error).message).toContain("bun run build:ios-binaries");
      expect((err as Error).message).toContain("download-native-binaries.sh");
      expect(setenvCalls()).toEqual([]);
    } finally {
      audioDylibMissing = false;
    }
  });
});

describe("armAudio", () => {
  const devtools = (armsEnv: boolean) => ({
    armsEnv,
    reverifyEnv: vi.fn(async () => {}),
    getInitFailure: () => null,
  });

  it("refuses a simulator whose injection it did not arm, touching nothing", async () => {
    const lent = devtools(false);
    const err = await armAudio(session, lent).catch((e: unknown) => e);
    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.AUDIO_INJECTION_NOT_OURS);
    expect(lent.reverifyEnv).not.toHaveBeenCalled();
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("re-applies its environment once no app proves it, as after a reboot", async () => {
    const own = devtools(true);
    await armAudio(session, own);
    expect(session.envVerified).toBe(true);
    execFileMock.mockClear();
    await armAudio(session, own); // no live app in the directory: verify again
    expect(execFileMock.mock.calls.some(([, args]) => args.includes("getenv"))).toBe(true);
    expect(own.reverifyEnv).toHaveBeenCalledTimes(2);
  });
});

/** The ring the host pointed the guest at. */
function inputRing(): string {
  return /^ring=(.*)$/m.exec(fs.readFileSync(path.join(dir, "input"), "utf8"))![1];
}

describe("setAudioInput", () => {
  it("points the guest at a ring that carries the tone", async () => {
    await expect(
      setAudioInput(session, { kind: "tone", frequencyHz: 440, amplitude: 0.25 })
    ).resolves.toEqual({ source: "tone" });
    expect(fs.readFileSync(path.join(dir, "input"), "utf8")).toMatch(
      new RegExp(`^source=stream\nring=.+/in-${process.pid}-.+\\.ring\nhost=${process.pid}\n$`)
    );
    expect(path.dirname(inputRing())).toBe(dir);
    expect(fs.statSync(inputRing()).size).toBe(128 + 65_536 * 4);
  });

  it("converts a file to mono float32 48 kHz and streams it from the copy", async () => {
    const source = path.join(dir, "speech.mp3");
    fs.writeFileSync(source, "x");
    const result = await setAudioInput(session, { kind: "file", path: source, plays: 3 });

    const [cmd, args] = execFileMock.mock.calls.find(([c]) => c === "afconvert")!;
    expect(cmd).toBe("afconvert");
    expect(args.slice(0, 6)).toEqual(["-f", "WAVE", "-d", "LEF32@48000", "-c", "1"]);
    expect(result).toEqual({ source: "file", durationMs: 1000 });
    expect(fs.readFileSync(path.join(dir, "input"), "utf8")).toContain("source=stream\n");
    expect(fs.readdirSync(dir).filter((n) => n.startsWith("clip-"))).toHaveLength(1);
  });

  it("keeps one ring while the source changes, and drops the previous clip", async () => {
    const source = path.join(dir, "a.wav");
    fs.writeFileSync(source, "x");
    await setAudioInput(session, { kind: "file", path: source, plays: 1 });
    const ring = inputRing();
    const [first] = fs.readdirSync(dir).filter((n) => n.startsWith("clip-"));
    await new Promise((resolve) => setTimeout(resolve, 5)); // clip names carry a millisecond stamp
    await setAudioInput(session, { kind: "file", path: source, plays: 1 });
    expect(inputRing()).toBe(ring);
    expect(fs.existsSync(path.join(dir, first))).toBe(false);
    expect(fs.readdirSync(dir).filter((n) => n.startsWith("clip-"))).toHaveLength(1);
  });

  it("rejects a clip longer than ten minutes", async () => {
    const source = path.join(dir, "long.wav");
    fs.writeFileSync(source, "x");
    execFileMock.mockImplementationOnce((_cmd, args) => {
      wavFile(args[args.length - 1], 600 * 48_000 + 1);
      return { stdout: "", stderr: "" };
    });
    await expect(setAudioInput(session, { kind: "file", path: source, plays: 1 })).rejects.toThrow(
      "longer than 10 minutes"
    );
    expect(fs.readdirSync(dir).filter((n) => n.startsWith("clip-"))).toEqual([]);
    expect(fs.existsSync(path.join(dir, "input"))).toBe(false);
  });

  it("rejects a missing file before touching the control directory", async () => {
    await expect(
      setAudioInput(session, { kind: "file", path: "/nonexistent/clip.wav", plays: 1 })
    ).rejects.toThrow("Audio file not found");
    expect(fs.existsSync(path.join(dir, "input"))).toBe(false);
  });

  it("reports an undecodable file with afconvert's message", async () => {
    const source = path.join(dir, "bad.bin");
    fs.writeFileSync(source, "x");
    execFileMock.mockImplementationOnce(() => {
      throw Object.assign(new Error("failed"), { stderr: "Error: AudioFileOpen failed" });
    });
    const err = await setAudioInput(session, { kind: "file", path: source, plays: 1 }).catch(
      (e: unknown) => e
    );
    expect((err as Error).message).toContain("AudioFileOpen failed");
    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.AUDIO_CLIP_CONVERSION_FAILED);
  });

  it("clearAudioInput gives the microphone back and removes the ring", async () => {
    await setAudioInput(session, { kind: "tone", frequencyHz: 1000, amplitude: 0.4 });
    const ring = inputRing();
    clearAudioInput(session);
    expect(fs.existsSync(path.join(dir, "input"))).toBe(false);
    expect(fs.existsSync(ring)).toBe(false);
  });

  it("replaces a feeder whose ring was removed under it", async () => {
    await setAudioInput(session, { kind: "tone", frequencyHz: 1000, amplitude: 0.4 });
    const first = inputRing();
    fs.rmSync(dir, { recursive: true, force: true }); // a reboot's cleanup
    await setAudioInput(session, { kind: "tone", frequencyHz: 500, amplitude: 0.4 });
    expect(inputRing()).not.toBe(first);
    expect(fs.existsSync(inputRing())).toBe(true);
  });

  it("releaseAudio gives the microphone back", async () => {
    await setAudioInput(session, { kind: "tone", frequencyHz: 1000, amplitude: 0.4 });
    releaseAudio(session);
    expect(fs.existsSync(path.join(dir, "input"))).toBe(false);
    expect(fs.readdirSync(dir).filter((n) => n.endsWith(".ring"))).toEqual([]);
  });

  it("releaseAudio keeps the input another tool-server set, and that one's ring and clip", async () => {
    await setAudioInput(session, { kind: "tone", frequencyHz: 1000, amplitude: 0.4 });
    const own = inputRing();
    const ownClip = path.join(dir, `clip-${process.pid}-1.wav`);
    const other = process.ppid; // alive, and not this process
    const otherRing = path.join(dir, `in-${other}-b.ring`);
    const otherClip = path.join(dir, `clip-${other}-1.wav`);
    for (const file of [ownClip, otherRing, otherClip]) fs.writeFileSync(file, "");
    const control = `source=stream\nring=${otherRing}\nhost=${other}\n`;
    fs.writeFileSync(path.join(dir, "input"), control);
    releaseAudio(session);
    expect(fs.readFileSync(path.join(dir, "input"), "utf8")).toBe(control);
    expect(fs.readdirSync(dir).sort()).toEqual(
      ["input", path.basename(otherRing), path.basename(otherClip)].sort()
    );
    expect(fs.existsSync(own)).toBe(false);
  });

  it("releaseAudio keeps an input without an owner", async () => {
    await setAudioInput(session, { kind: "tone", frequencyHz: 1000, amplitude: 0.4 });
    const control = `source=stream\nring=${path.join(dir, "in.ring")}\n`;
    fs.writeFileSync(path.join(dir, "input"), control);
    releaseAudio(session);
    expect(fs.readFileSync(path.join(dir, "input"), "utf8")).toBe(control);
  });

  it("clearAudioInput removes the input another tool-server set", async () => {
    await setAudioInput(session, { kind: "tone", frequencyHz: 1000, amplitude: 0.4 });
    const otherRing = path.join(dir, `in-${process.ppid}-b.ring`);
    fs.writeFileSync(otherRing, "");
    fs.writeFileSync(
      path.join(dir, "input"),
      `source=stream\nring=${otherRing}\nhost=${process.ppid}\n`
    );
    clearAudioInput(session);
    expect(fs.existsSync(path.join(dir, "input"))).toBe(false);
    expect(fs.existsSync(otherRing)).toBe(true);
  });

  it("starts a fresh ring after the microphone was given back", async () => {
    await setAudioInput(session, { kind: "tone", frequencyHz: 1000, amplitude: 0.4 });
    const first = inputRing();
    clearAudioInput(session);
    await setAudioInput(session, { kind: "tone", frequencyHz: 1000, amplitude: 0.4 });
    expect(inputRing()).not.toBe(first);
  });
});
