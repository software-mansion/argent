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

vi.mock("../src/utils/ios-device-sets", () => ({
  deviceSetForUdid: async () => null,
  simctlPrefix: () => ["simctl"],
  simctlArgsForUdid: async (_udid: string, args: readonly string[]) => ["simctl", ...args],
}));

vi.mock("@argent/native-devtools-ios", () => ({
  audioDylibPath: () => "/argent/dylibs/libArgentAudio.dylib",
}));

import {
  assertBundleId,
  disposeAudio,
  audioDir,
  clearAudioInput,
  ensureAudioEnv,
  listLiveApps,
  assertHookProto,
  decideHookState,
  parseAppStatus,
  readAppHook,
  readAppStatus,
  setAudioInput,
  startRecording,
  stopRecording,
} from "../src/utils/ios-audio";

const BUNDLE = "com.example.app";
// Unique per run so parallel test files and leftovers never share a control directory.
const UDID = `${Math.random().toString(16).slice(2, 10).padEnd(8, "0")}-0000-0000-0000-000000000000`;
const dir = audioDir(UDID);

function statusText(fields: Record<string, string | number>): string {
  const all = {
    proto: 1,
    pid: process.pid,
    rate: 48000,
    streams: 1,
    input: "mic",
    inputActive: 0,
    recording: 0,
    recId: "",
    recFrames: 0,
    underruns: 0,
    recDone: 0,
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

/** Plays the part of the hook in the app: answers rec.<bundle> requests the way it does. */
function fakeGuest(opts: { failWith?: string } = {}): () => void {
  const recFile = path.join(dir, `rec.${BUNDLE}`);
  let seen = "";
  const timer = setInterval(() => {
    if (!fs.existsSync(recFile)) {
      if (seen) {
        writeStatus({ recId: seen, recording: 0, recDone: 1, recFrames: 4_800 });
        seen = "";
      }
      return;
    }
    const text = fs.readFileSync(recFile, "utf8");
    const id = /^id=(.*)$/m.exec(text)![1];
    const ring = /^ring=(.*)$/m.exec(text)![1];
    if (id === seen) return;
    seen = id;
    if (opts.failWith) {
      writeStatus({ recId: id, error: opts.failWith });
      return;
    }
    // The app plays 100 ms of stereo 0.5 into the ring.
    const fd = fs.openSync(ring, "r+");
    const frame = Buffer.alloc(8);
    frame.writeFloatLE(0.5, 0);
    frame.writeFloatLE(0.5, 4);
    for (let i = 0; i < 4_800; i++) fs.writeSync(fd, frame, 0, 8, 128 + i * 8);
    const counters = Buffer.alloc(12);
    counters.writeUInt32LE(2, 0);
    counters.writeUInt32LE(48_000, 4);
    counters.writeUInt32LE(4_800, 8);
    fs.writeSync(fd, counters, 0, 12, 16);
    fs.closeSync(fd);
    writeStatus({ recId: id, recording: 1 });
  }, 10);
  return () => clearInterval(timer);
}

beforeEach(() => {
  execFileMock.mockReset();
  execFileMock.mockImplementation(defaultExec);
  fs.mkdirSync(dir, { recursive: true });
});

afterEach(() => {
  clearAudioInput(UDID); // stops the feeder timer before its files go
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("parseAppStatus", () => {
  it("maps the guest's key=value file", () => {
    const status = parseAppStatus(
      statusText({ input: "stream", inputActive: 1, recording: 1, recId: "ab12", recFrames: 480 })
    );
    expect(status).toMatchObject({
      pid: process.pid,
      sampleRate: 48000,
      streams: 1,
      input: "stream",
      inputActive: true,
      recording: true,
      recordingId: "ab12",
      recordedFrames: 480,
      recordingDone: false,
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

  it("fails a recording at once, without writing a request, for an app on an older hook", async () => {
    fs.writeFileSync(path.join(dir, `st.${BUNDLE}`), statusText({}).replace(/^proto=1\n/, ""));
    const t0 = Date.now();
    const err = await startRecording(UDID, BUNDLE, path.join(dir, "out.wav"), false).catch(
      (e: unknown) => e
    );
    expect(Date.now() - t0).toBeLessThan(500);
    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.AUDIO_HOOK_NOT_ACTIVE);
    expect((err as Error).message).toContain("older audio hook");
    expect(fs.existsSync(path.join(dir, `rec.${BUNDLE}`))).toBe(false);
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
    expect(decideHookState(status({ state: "dormant" }), false, pid)).toBe("stale"); // its process is gone
    expect(decideHookState(status({ state: "dormant" }), true, pid + 1)).toBe("stale"); // relaunched, not written yet
    expect(decideHookState(status({ state: "dormant" }), true, null)).toBe("stale"); // the app is not running
    expect(decideHookState(status({ proto: 2 }), true, pid)).toBe("old-proto");
    expect(decideHookState(parseAppStatus(`pid=${pid}\n`), true, pid)).toBe("old-proto"); // pre-proto hook
  });

  it("reads none without a file and dormant/active/stale/old-proto from one", async () => {
    expect((await readAppHook(UDID, BUNDLE)).state).toBe("none");
    writeStatus({ state: "dormant" });
    expect((await readAppHook(UDID, BUNDLE)).state).toBe("dormant");
    writeStatus({ state: "active" });
    expect((await readAppHook(UDID, BUNDLE)).state).toBe("active");
    writeStatus({ state: "dormant", pid: 2 ** 22 + 1 }); // dead pid
    expect((await readAppHook(UDID, BUNDLE)).state).toBe("stale");
    writeStatus({ proto: 0 });
    expect((await readAppHook(UDID, BUNDLE)).state).toBe("old-proto");
    runningPid = process.pid + 1; // the app was relaunched; the file is the old process's
    try {
      writeStatus({ state: "active" });
      expect((await readAppHook(UDID, BUNDLE)).state).toBe("stale");
      runningPid = null;
      expect((await readAppHook(UDID, BUNDLE)).state).toBe("stale");
    } finally {
      runningPid = process.pid;
    }
  });

  it("refuses to record an app whose status is not its running process's", async () => {
    writeStatus({ state: "active" });
    runningPid = process.pid + 1;
    try {
      const err = await startRecording(UDID, BUNDLE, path.join(dir, "out.wav"), false).catch(
        (e: unknown) => e
      );
      expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.AUDIO_HOOK_NOT_ACTIVE);
      expect(fs.existsSync(path.join(dir, `rec.${BUNDLE}`))).toBe(false);
    } finally {
      runningPid = process.pid;
    }
  });

  it("queues a recording for a dormant hook without waiting for an acknowledgement", async () => {
    writeStatus({ state: "dormant" });
    const t0 = Date.now();
    await startRecording(UDID, BUNDLE, path.join(dir, "out.wav"), true);
    expect(Date.now() - t0).toBeLessThan(500);
    expect(fs.readFileSync(path.join(dir, `rec.${BUNDLE}`), "utf8")).toMatch(
      /^id=\w+\nring=.*\nmute=1\n$/
    );
    const done = await stopRecording(UDID, BUNDLE); // never opened audio: an empty recording, at once
    expect(done.durationMs).toBe(0);
  });
});

describe("readAppStatus", () => {
  it("is null when the app never wrote a status", () => {
    expect(readAppStatus(UDID, BUNDLE)).toBeNull();
  });

  it("is null when the process that wrote it is gone", () => {
    writeStatus({ pid: 2 ** 22 + 1 }); // above the pid ceiling, so never alive
    expect(readAppStatus(UDID, BUNDLE)).toBeNull();
  });

  it("reads a live app, and lists it", () => {
    writeStatus({});
    writeStatus({ pid: 2 ** 22 + 1 }, "com.example.dead");
    expect(readAppStatus(UDID, BUNDLE)?.pid).toBe(process.pid);
    expect(listLiveApps(UDID)).toEqual([BUNDLE]);
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
    await ensureAudioEnv(udid);
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
    await ensureAudioEnv(udid);
    expect(setenvCalls()).toEqual([]);
  });

  it("replaces an older copy of the dylib and keeps foreign entries", async () => {
    execFileMock.mockImplementation((_cmd, args) => ({
      stdout: args.includes("DYLD_INSERT_LIBRARIES")
        ? `/other/libSimCamLoader.dylib:/old/libArgentAudio.dylib:${bootstrap}\n`
        : "",
      stderr: "",
    }));
    await ensureAudioEnv(fresh());
    expect(setenvCalls()[0]).toEqual([
      "DYLD_INSERT_LIBRARIES",
      `/other/libSimCamLoader.dylib:${bootstrap}:/argent/dylibs/libArgentAudio.dylib`,
    ]);
  });

  it("remembers a verified simulator and skips the round-trips next time", async () => {
    const udid = fresh();
    await ensureAudioEnv(udid);
    execFileMock.mockClear();
    await ensureAudioEnv(udid);
    expect(execFileMock).not.toHaveBeenCalled();
  });
});

/** The ring the host pointed the guest at. */
function inputRing(): string {
  return /^ring=(.*)$/m.exec(fs.readFileSync(path.join(dir, "input"), "utf8"))![1];
}

describe("setAudioInput", () => {
  it("points the guest at a ring that carries the tone", async () => {
    await expect(
      setAudioInput(UDID, { kind: "tone", frequencyHz: 440, amplitude: 0.25 })
    ).resolves.toEqual({ source: "tone" });
    expect(fs.readFileSync(path.join(dir, "input"), "utf8")).toMatch(
      /^source=stream\nring=.+\.ring\n$/
    );
    expect(path.dirname(inputRing())).toBe(dir);
    expect(fs.statSync(inputRing()).size).toBe(128 + 65_536 * 4);
  });

  it("converts a file to mono float32 48 kHz and streams it from the copy", async () => {
    const source = path.join(dir, "speech.mp3");
    fs.writeFileSync(source, "x");
    const result = await setAudioInput(UDID, { kind: "file", path: source, loop: true });

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
    await setAudioInput(UDID, { kind: "file", path: source, loop: false });
    const ring = inputRing();
    const [first] = fs.readdirSync(dir).filter((n) => n.startsWith("clip-"));
    await new Promise((resolve) => setTimeout(resolve, 5)); // clip names carry a millisecond stamp
    await setAudioInput(UDID, { kind: "file", path: source, loop: false });
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
    await expect(setAudioInput(UDID, { kind: "file", path: source, loop: false })).rejects.toThrow(
      "longer than 10 minutes"
    );
    expect(fs.readdirSync(dir).filter((n) => n.startsWith("clip-"))).toEqual([]);
    expect(fs.existsSync(path.join(dir, "input"))).toBe(false);
  });

  it("rejects a missing file before touching the control directory", async () => {
    await expect(
      setAudioInput(UDID, { kind: "file", path: "/nonexistent/clip.wav", loop: false })
    ).rejects.toThrow("Audio file not found");
    expect(fs.existsSync(path.join(dir, "input"))).toBe(false);
  });

  it("reports an undecodable file with afconvert's message", async () => {
    const source = path.join(dir, "bad.bin");
    fs.writeFileSync(source, "x");
    execFileMock.mockImplementationOnce(() => {
      throw Object.assign(new Error("failed"), { stderr: "Error: AudioFileOpen failed" });
    });
    const err = await setAudioInput(UDID, { kind: "file", path: source, loop: false }).catch(
      (e: unknown) => e
    );
    expect((err as Error).message).toContain("AudioFileOpen failed");
    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.AUDIO_CLIP_CONVERSION_FAILED);
  });

  it("clearAudioInput gives the microphone back and removes the ring", async () => {
    await setAudioInput(UDID, { kind: "tone", frequencyHz: 1000, amplitude: 0.4 });
    const ring = inputRing();
    clearAudioInput(UDID);
    expect(fs.existsSync(path.join(dir, "input"))).toBe(false);
    expect(fs.existsSync(ring)).toBe(false);
  });

  it("replaces a feeder whose ring was removed under it", async () => {
    await setAudioInput(UDID, { kind: "tone", frequencyHz: 1000, amplitude: 0.4 });
    const first = inputRing();
    fs.rmSync(dir, { recursive: true, force: true }); // a reboot's cleanup
    await setAudioInput(UDID, { kind: "tone", frequencyHz: 500, amplitude: 0.4 });
    expect(inputRing()).not.toBe(first);
    expect(fs.existsSync(inputRing())).toBe(true);
  });

  it("disposeAudio releases every simulator", async () => {
    await setAudioInput(UDID, { kind: "tone", frequencyHz: 1000, amplitude: 0.4 });
    disposeAudio();
    expect(fs.existsSync(path.join(dir, "input"))).toBe(false);
    expect(fs.readdirSync(dir).filter((n) => n.endsWith(".ring"))).toEqual([]);
  });

  it("starts a fresh ring after the microphone was given back", async () => {
    await setAudioInput(UDID, { kind: "tone", frequencyHz: 1000, amplitude: 0.4 });
    const first = inputRing();
    clearAudioInput(UDID);
    await setAudioInput(UDID, { kind: "tone", frequencyHz: 1000, amplitude: 0.4 });
    expect(inputRing()).not.toBe(first);
  });
});

describe("assertBundleId", () => {
  it("accepts bundle ids and rejects anything that could leave the control directory", () => {
    expect(() => assertBundleId("com.example.My-App")).not.toThrow();
    for (const bad of ["", "../x", "a/b", "a b", "a\nb"]) {
      expect(() => assertBundleId(bad)).toThrow("Invalid bundleId");
    }
  });
});

describe("recording", () => {
  const wav = () => path.join(dir, "out.wav");

  it("starts and stops against a guest that answers", async () => {
    writeStatus({});
    const stopGuest = fakeGuest();
    try {
      await startRecording(UDID, BUNDLE, wav(), true);
      expect(fs.readFileSync(path.join(dir, `rec.${BUNDLE}`), "utf8")).toMatch(
        /^id=.+\nring=.+out-com\.example\.app-.+\.ring\nmute=1\n$/
      );
      const finished = await stopRecording(UDID, BUNDLE);
      expect(finished).toEqual({
        path: wav(),
        durationMs: 100,
        sampleRate: 48000,
        channels: 2,
        droppedFrames: 0,
      });
      expect(fs.existsSync(path.join(dir, `rec.${BUNDLE}`))).toBe(false);
      expect(fs.readdirSync(dir).filter((n) => n.endsWith(".ring"))).toEqual([]);
      const samples = fs.readFileSync(wav());
      expect(samples.length).toBe(44 + 4_800 * 2 * 2);
      expect(samples.readInt16LE(44)).toBe(16384); // 0.5
    } finally {
      stopGuest();
    }
  });

  it("refuses when the app has no live hook", async () => {
    const err = await startRecording(UDID, BUNDLE, wav(), false).catch((e: unknown) => e);
    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.AUDIO_HOOK_NOT_ACTIVE);
    expect((err as Error).message).toContain("restart-app");
    expect(fs.existsSync(path.join(dir, `rec.${BUNDLE}`))).toBe(false);
  });

  it("refuses a second recording of the same app", async () => {
    writeStatus({ recording: 1, recId: "x" });
    const err = await startRecording(UDID, BUNDLE, wav(), false).catch((e: unknown) => e);
    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.AUDIO_RECORDING_ALREADY_ACTIVE);
  });

  it("surfaces the guest's error, withdraws the request and removes the ring", async () => {
    writeStatus({});
    const stopGuest = fakeGuest({ failWith: "cannot open ring: /nope" });
    try {
      const err = await startRecording(UDID, BUNDLE, wav(), false).catch((e: unknown) => e);
      expect((err as Error).message).toContain("cannot open ring: /nope");
      expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.AUDIO_RECORDING_START_FAILED);
      expect(fs.existsSync(path.join(dir, `rec.${BUNDLE}`))).toBe(false);
      expect(fs.readdirSync(dir).filter((n) => n.endsWith(".ring"))).toEqual([]);
    } finally {
      stopGuest();
    }
  });

  it("stop without a recording fails and leaves no request behind", async () => {
    writeStatus({});
    fs.writeFileSync(path.join(dir, `rec.${BUNDLE}`), "id=stale\nring=/tmp/x.ring\nmute=0\n");
    const err = await stopRecording(UDID, BUNDLE).catch((e: unknown) => e);
    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.AUDIO_NO_ACTIVE_RECORDING);
    expect(fs.existsSync(path.join(dir, `rec.${BUNDLE}`))).toBe(false);
  });

  it("stops a recording this process does not know, says its audio is lost and removes its ring", async () => {
    writeStatus({ recording: 1, recId: "earlier" });
    fs.writeFileSync(path.join(dir, `out-${BUNDLE}-earlier.ring`), "");
    const err = await stopRecording(UDID, BUNDLE).catch((e: unknown) => e);
    expect((err as Error).message).toContain("tool-server that has since stopped");
    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.AUDIO_NO_ACTIVE_RECORDING);
    expect(fs.readdirSync(dir).filter((n) => n.endsWith(".ring"))).toEqual([]);
  });

  it("disposeAudio drops a recording this process owns", async () => {
    writeStatus({});
    const stopGuest = fakeGuest();
    try {
      await startRecording(UDID, BUNDLE, wav(), false);
      disposeAudio();
      expect(fs.existsSync(path.join(dir, `rec.${BUNDLE}`))).toBe(false);
      expect(fs.readdirSync(dir).filter((n) => n.endsWith(".ring"))).toEqual([]);
      expect(fs.existsSync(wav())).toBe(false);
    } finally {
      stopGuest();
    }
  });
});
