import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { FAILURE_CODES, FailureError } from "@argent/registry";
import { deviceSetForUdid, simctlPrefix } from "./ios-device-sets";
import { SIMCTL_KILL_SIGNAL, SIMCTL_SPAWN_TIMEOUT_MS } from "./simctl-config";
import { InvalidToolInputError } from "./capability";
import { appendDyldInsertLibrary, audioDir, runningAppPid } from "./ios-host";
import { audioDylibPath } from "@argent/native-devtools-ios";
import { isTvOsSimulator } from "./ios-devices";
import type { NativeDevtoolsApi } from "../blueprints/native-devtools";
import {
  InputFeeder,
  OutputRecorder,
  readClipInfo,
  STREAM_RATE,
  type FeederSource,
} from "./ios-audio-rings";

const execFileAsync = promisify(execFile);

/**
 * Host side of the iOS Simulator audio mock. The other side is the audio hook in argent-private, a
 * dylib injected into the app that replaces the microphone samples it reads and copies out the
 * speaker samples it plays. The two sides talk through plain files in a per-simulator directory
 * that the hook polls (simulator processes share the host filesystem):
 *
 *   input           host -> app   source=stream  ring=<in ring>   (absent: the real microphone)
 *   rec.<bundleId>  host -> app   id=<s>  ring=<out ring>  mute=0|1  (present: record the app's output)
 *   st.<bundleId>   app -> host   key=value status the app rewrites when it changes
 *
 * The samples travel through the two ring files of `ios-audio-rings.ts`: this process feeds the in
 * ring and drains the out ring, so the hook only copies. Every control write is a temp file plus
 * rename, so the hook never reads a half-written file.
 */

/** Set in the simulator's launchd environment to arm the guest hook in apps launched afterwards. */
const AUDIO_DIR_ENV = "ARGENT_AUDIO_DIR";
/**
 * Contract version the hook reports as `proto` in its status file (ArgentAudio.c `PROTO`). A hook with another
 * version, or none (built before it existed), is refused at once instead of waiting for acknowledgements it may
 * not give.
 */
export const AUDIO_HOOK_PROTO = 1;
const POLL_INTERVAL_MS = 50;
/** The guest polls every 50 ms and reacts to a request within a couple of polls. */
const ACK_TIMEOUT_MS = 4_000;
/** Clips are streamed from disk, so this only bounds the converted copy: 10 minutes is about 115 MB. */
const MAX_CLIP_SECONDS = 600;
/** One feeder per simulator and one recorder per app, alive in this process only. */
const feeders = new Map<string, InputFeeder>();
const recorders = new Map<string, OutputRecorder>();
/** Simulators whose launchd environment this process verified; a reboot wipes it, which {@link armAudio} re-checks. */
const envVerified = new Set<string>();
const BUNDLE_ID_PATTERN = /^[A-Za-z0-9.-]+$/;

export { audioDir };

export function assertBundleId(bundleId: string): void {
  if (!BUNDLE_ID_PATTERN.test(bundleId)) {
    throw new InvalidToolInputError(
      `Invalid bundleId '${bundleId}': expected letters, digits, dots and hyphens only.`
    );
  }
}

function writeAtomic(file: string, text: string): void {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

async function waitFor<T>(poll: () => T | undefined, timeoutMs: number): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = poll();
    if (value !== undefined || Date.now() >= deadline) return value;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

/**
 * Creates the control directory, inserts the audio dylib into the simulator's launchd environment
 * and points it at the directory. Nothing audio-related is loaded into any process before this runs,
 * so a simulator where audio is never mocked is untouched. Apps launched from now on carry the hook;
 * apps that were already running keep their old environment and need a restart (see
 * {@link readAppStatus} for telling them apart).
 */
export async function ensureAudioEnv(udid: string): Promise<void> {
  const dir = audioDir(udid);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (envVerified.has(udid)) return;
  const prefix = simctlPrefix(await deviceSetForUdid(udid));
  const options = { timeout: SIMCTL_SPAWN_TIMEOUT_MS, killSignal: SIMCTL_KILL_SIGNAL };
  const getenv = async (name: string) =>
    (
      await execFileAsync("xcrun", [...prefix, "spawn", udid, "launchctl", "getenv", name], {
        encoding: "utf8",
        ...options,
      }).catch(() => ({ stdout: "" }))
    ).stdout.trim();
  const setenv = (name: string, value: string) =>
    execFileAsync("xcrun", [...prefix, "spawn", udid, "launchctl", "setenv", name, value], options);

  // launchctl, not `simctl getenv`: the latter truncates the colon-separated list past 127 bytes.
  const inserted = await getenv("DYLD_INSERT_LIBRARIES");
  const withAudio = appendDyldInsertLibrary(inserted, audioDylibPath());
  if (withAudio !== inserted) await setenv("DYLD_INSERT_LIBRARIES", withAudio);
  if ((await getenv(AUDIO_DIR_ENV)) !== dir) await setenv(AUDIO_DIR_ENV, dir);
  envVerified.add(udid);
}

/**
 * Arms the mock in the simulator: the native-devtools service keeps the simulator's injection environment
 * healthy (it re-applies its own dylib after a reboot), and {@link ensureAudioEnv} adds the audio dylib next
 * to it. tvOS is refused: the dylib has no tvOS build.
 */
export async function armAudio(
  udid: string,
  devtools: Pick<NativeDevtoolsApi, "reverifyEnv" | "getInitFailure">
): Promise<void> {
  if (await isTvOsSimulator(udid)) {
    throw new InvalidToolInputError(`The audio mock does not support tvOS simulators (${udid}).`);
  }
  // A reboot wipes launchd's environment; native-devtools notices (it re-applies its own entry), and the audio
  // entry has to be re-applied with it. Check cheaply through the status files: live apps prove the env.
  if (envVerified.has(udid) && listLiveApps(udid).length === 0) envVerified.delete(udid);
  await devtools.reverifyEnv().catch(() => {});
  const failure = devtools.getInitFailure();
  if (failure) {
    throw new FailureError(
      `Could not set up the simulator's injection environment for ${udid}: ${failure.lastError}. ` +
        `Try shutting down and re-booting the simulator.`,
      {
        error_code: FAILURE_CODES.AUDIO_ENV_SETUP_FAILED,
        failure_stage: "audio_env_setup",
        failure_area: "tool_server",
        error_kind: "subprocess",
        failure_command: "xcrun_simctl",
      }
    );
  }
  await ensureAudioEnv(udid);
}

/** Live view of one app's hook, parsed from its `st.<bundleId>` file. */
interface AppAudioStatus {
  /** Contract version of the hook; 0 when the hook predates it. */
  proto: number;
  /** `dormant`: hook loaded, the app has not opened audio yet (no helper, no acknowledgements). */
  state: "dormant" | "active";
  pid: number;
  /** Sample rate of the app's audio device; 0 until the app opens audio. */
  sampleRate: number;
  /** Audio streams the app has opened since launch. */
  streams: number;
  input: "microphone" | "stream";
  /** The app received our samples within the last 300 ms. */
  inputActive: boolean;
  /** Callbacks that found the in ring empty and played silence: this process did not keep up. */
  underruns: number;
  recording: boolean;
  recordingId: string;
  recordedFrames: number;
  /** The app stopped writing to the recording's ring. */
  recordingDone: boolean;
  error: string;
}

export function parseAppStatus(text: string): AppAudioStatus {
  const kv = new Map<string, string>();
  for (const line of text.split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0) kv.set(line.slice(0, eq), line.slice(eq + 1));
  }
  const num = (key: string) => Number(kv.get(key) ?? 0) || 0;
  const input = kv.get("input");
  return {
    proto: num("proto"),
    state: kv.get("state") === "dormant" ? "dormant" : "active",
    pid: num("pid"),
    sampleRate: num("rate"),
    streams: num("streams"),
    input: input === "stream" ? input : "microphone",
    inputActive: num("inputActive") === 1,
    underruns: num("underruns"),
    recording: num("recording") === 1,
    recordingId: kv.get("recId") ?? "",
    recordedFrames: num("recFrames"),
    recordingDone: num("recDone") === 1,
    error: kv.get("error") ?? "",
  };
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * The app's hook status, or null when the hook is not live in it: the app never loaded the hook
 * (launched before {@link ensureAudioEnv}, or by something that replaced the injected libraries), or
 * the process that wrote the file is gone. Simulator apps are host processes, so a pid probe works.
 */
export function readAppStatus(udid: string, bundleId: string): AppAudioStatus | null {
  let text: string;
  try {
    text = fs.readFileSync(path.join(audioDir(udid), `st.${bundleId}`), "utf8");
  } catch {
    return null;
  }
  const status = parseAppStatus(text);
  return status.pid > 0 && processAlive(status.pid) ? status : null;
}

/**
 * Whether the hook is loaded in the app, from its status file alone:
 *   none       no file: the app was launched before arming, or by something that replaced the injected libraries
 *   stale      the file's process is gone, or is not the app's running process (relaunched, not written yet)
 *   old-proto  a hook speaking another contract version
 *   dormant    loaded, the app has not opened audio yet: requests apply when it does
 *   active     loaded and running its helper: requests are acknowledged
 */
export type HookState = "none" | "stale" | "old-proto" | "dormant" | "active";

export function decideHookState(
  status: AppAudioStatus | null,
  pidAlive: boolean,
  runningPid: number | null
): HookState {
  if (!status) return "none";
  if (!(status.pid > 0) || !pidAlive || runningPid === null || runningPid !== status.pid) return "stale";
  if (status.proto !== AUDIO_HOOK_PROTO) return "old-proto";
  return status.state;
}

export async function readAppHook(
  udid: string,
  bundleId: string
): Promise<{ state: HookState; status: AppAudioStatus | null }> {
  let status: AppAudioStatus | null = null;
  try {
    status = parseAppStatus(fs.readFileSync(path.join(audioDir(udid), `st.${bundleId}`), "utf8"));
  } catch {
    return { state: "none", status: null };
  }
  const running = await runningAppPid(udid, bundleId).catch(() => null);
  return { state: decideHookState(status, status.pid > 0 && processAlive(status.pid), running), status };
}

/** Bundle ids of the apps whose hook is live, for telling the caller which apps can be driven. */
export function listLiveApps(udid: string): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(audioDir(udid));
  } catch {
    return [];
  }
  return names
    .filter((name) => name.startsWith("st.") && !name.endsWith(".tmp"))
    .map((name) => name.slice(3))
    .filter((bundleId) => readAppStatus(udid, bundleId) !== null);
}

type AudioInputSource =
  | { kind: "file"; path: string; loop: boolean }
  | { kind: "tone"; frequencyHz: number; amplitude: number };

interface AudioInputResult {
  source: "file" | "tone";
  /** Length of the clip; absent for a tone. */
  durationMs?: number;
}

/** Decode any format afconvert reads (wav, mp3, m4a, caf, aiff, flac...) to mono float32 WAV. */
async function convertClip(inputPath: string, outputPath: string): Promise<void> {
  if (!fs.existsSync(inputPath)) {
    throw new InvalidToolInputError(`Audio file not found: ${inputPath}`);
  }
  try {
    await execFileAsync(
      "afconvert",
      ["-f", "WAVE", "-d", `LEF32@${STREAM_RATE}`, "-c", "1", inputPath, outputPath],
      { timeout: 60_000 }
    );
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr?.trim();
    throw new FailureError(
      `Could not decode ${inputPath} as audio${stderr ? `: ${stderr}` : ""}.`,
      {
        error_code: FAILURE_CODES.AUDIO_CLIP_CONVERSION_FAILED,
        failure_stage: "audio_clip_conversion",
        failure_area: "tool_server",
        error_kind: "subprocess",
      }
    );
  }
}

function removeFiles(dir: string, prefix: string, keep?: string): void {
  for (const name of fs.readdirSync(dir)) {
    if (name.startsWith(prefix) && name !== keep) fs.rmSync(path.join(dir, name), { force: true });
  }
}

/**
 * Makes every app that carries the hook (see {@link armAudio}) hear `source` instead of the
 * microphone. Each app hears it from its beginning from the moment it is set, and again after its
 * audio input stopped for half a second; a clip plays silence after its end unless it loops.
 */
export async function setAudioInput(
  udid: string,
  source: AudioInputSource
): Promise<AudioInputResult> {
  const dir = audioDir(udid);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  let feederSource: FeederSource;
  let clipName: string | undefined;
  let durationMs: number | undefined;
  if (source.kind === "tone") {
    feederSource = { kind: "tone", frequencyHz: source.frequencyHz, amplitude: source.amplitude };
  } else {
    clipName = `clip-${Date.now()}.wav`;
    const clipPath = path.join(dir, clipName);
    await convertClip(source.path, clipPath);
    const fd = fs.openSync(clipPath, "r");
    try {
      const info = readClipInfo(fd);
      if (info.frames > MAX_CLIP_SECONDS * STREAM_RATE) {
        throw new InvalidToolInputError(
          `${source.path} is longer than ${MAX_CLIP_SECONDS / 60} minutes. Cut it shorter.`
        );
      }
      feederSource = { kind: "clip", fd, info, loop: source.loop };
      durationMs = Math.round((info.frames * 1000) / STREAM_RATE);
    } catch (err) {
      fs.closeSync(fd);
      fs.rmSync(clipPath, { force: true });
      throw err;
    }
  }
  let feeder = feeders.get(udid);
  if (feeder?.running && !fs.existsSync(feeder.ringPath)) {
    // The control directory was removed under it (a simulator reboot, a cleanup): its ring is an unlinked file
    // nobody can map any more.
    feeder.stop();
    feeder = undefined;
  }
  if (feeder?.running) {
    feeder.setSource(feederSource);
  } else {
    removeFiles(dir, "in-");
    feeder = new InputFeeder(path.join(dir, `in-${randomUUID().slice(0, 8)}.ring`), feederSource);
    feeder.start();
    feeders.set(udid, feeder);
  }
  const inputFile = path.join(dir, "input");
  // A new ring path is what makes the apps map it; rewriting the same one would restart nothing.
  const control = `source=stream\nring=${feeder.ringPath}\n`;
  if (!fs.existsSync(inputFile) || fs.readFileSync(inputFile, "utf8") !== control) {
    writeAtomic(inputFile, control);
  }
  // The feeder has closed the previous clip, so it can be deleted.
  removeFiles(dir, "clip-", clipName);
  return { source: source.kind, durationMs };
}

/** Gives the microphone back to every app. */
export function clearAudioInput(udid: string): void {
  const dir = audioDir(udid);
  feeders.get(udid)?.stop();
  feeders.delete(udid);
  if (!fs.existsSync(dir)) return;
  // Apps keep their mapping of an unlinked ring until they see the input file gone.
  fs.rmSync(path.join(dir, "input"), { force: true });
  removeFiles(dir, "clip-");
  removeFiles(dir, "in-");
}

/** Fails fast when the app runs a hook that speaks another version of the control protocol. */
export function assertHookProto(status: AppAudioStatus | null, bundleId: string): void {
  if (!status || status.proto === AUDIO_HOOK_PROTO) return;
  throw new FailureError(
    `${bundleId} runs an older audio hook (protocol ${status.proto || "none"}, this tool-server needs ` +
      `${AUDIO_HOOK_PROTO}). Call restart-app for ${bundleId} so it loads the current hook, then retry.`,
    {
      error_code: FAILURE_CODES.AUDIO_HOOK_NOT_ACTIVE,
      failure_stage: "audio_hook_status",
      failure_area: "tool_server",
      error_kind: "validation",
    }
  );
}

function noHookError(bundleId: string): FailureError {
  return new FailureError(
    `The audio hook is not live in ${bundleId}. Apps that were running before the first audio tool call ` +
      `(or after a simulator reboot) were launched without it: call restart-app for ${bundleId} and retry. ` +
      `If it still is not live after a restart, the app was launched by a tool that injects its own libraries ` +
      `(Xcode run, Detox, XCUITest), which replaces Argent's; launch it with launch-app instead.`,
    {
      error_code: FAILURE_CODES.AUDIO_HOOK_NOT_ACTIVE,
      failure_stage: "audio_hook_status",
      failure_area: "tool_server",
      error_kind: "not_found",
    }
  );
}

const recorderKey = (udid: string, bundleId: string) => `${udid}/${bundleId}`;
/** Recordings requested from a dormant hook, not acknowledged yet: their id. */
const pendingIds = new Map<string, string>();

/** Starts recording the app's speaker output into `outputPath`; resolves once the app confirms. */
export async function startRecording(
  udid: string,
  bundleId: string,
  outputPath: string,
  muteOutput: boolean
): Promise<void> {
  assertBundleId(bundleId);
  const hook = await readAppHook(udid, bundleId);
  if (hook.state === "old-proto") assertHookProto(hook.status, bundleId);
  if (hook.state === "none" || hook.state === "stale") throw noHookError(bundleId);
  const status = hook.status;
  // A dormant hook acknowledges nothing until the app opens audio; it reads the request when it does.
  const dormant = hook.state === "dormant";
  const key = recorderKey(udid, bundleId);
  if (status?.recording || recorders.has(key)) {
    throw new FailureError(
      `${bundleId} is already being recorded${recorders.has(key) ? ` to ${recorders.get(key)!.wavPath}` : ""}. Call audio-record-stop first.`,
      {
        error_code: FAILURE_CODES.AUDIO_RECORDING_ALREADY_ACTIVE,
        failure_stage: "audio_record_start",
        failure_area: "tool_server",
        error_kind: "validation",
      }
    );
  }
  const id = randomUUID().slice(0, 8);
  const dir = audioDir(udid);
  // A ring of an earlier tool-server's recording of this app is nobody's now.
  removeFiles(dir, `out-${bundleId}-`);
  const recorder = new OutputRecorder(path.join(dir, `out-${bundleId}-${id}.ring`), outputPath);
  const recFile = path.join(dir, `rec.${bundleId}`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeAtomic(recFile, `id=${id}\nring=${recorder.ringPath}\nmute=${muteOutput ? 1 : 0}\n`);
  if (dormant) {
    pendingIds.set(key, id);
    recorders.set(key, recorder);
    return;
  }
  const ack = await waitFor(() => {
    const s = readAppStatus(udid, bundleId);
    return s && s.recordingId === id && (s.recording || s.error) ? s : undefined;
  }, ACK_TIMEOUT_MS);
  if (ack?.recording) {
    recorders.set(key, recorder);
    return;
  }
  fs.rmSync(recFile, { force: true });
  recorder.abort();
  throw new FailureError(
    ack?.error
      ? `${bundleId} could not start recording: ${ack.error}`
      : `${bundleId} did not confirm the recording within ${ACK_TIMEOUT_MS / 1000}s. The app may be suspended or its process hung.`,
    {
      error_code: FAILURE_CODES.AUDIO_RECORDING_START_FAILED,
      failure_stage: "audio_record_start",
      failure_area: "tool_server",
      error_kind: ack ? "subprocess" : "timeout",
    }
  );
}

interface FinishedRecording {
  path: string;
  durationMs: number;
  sampleRate: number;
  channels: number;
  droppedFrames: number;
}

/** Stops the app's recording and resolves once the WAV is finalized. */
export async function stopRecording(udid: string, bundleId: string): Promise<FinishedRecording> {
  assertBundleId(bundleId);
  const key = recorderKey(udid, bundleId);
  const recorder = recorders.get(key);
  const status = readAppStatus(udid, bundleId);
  const pendingId = pendingIds.get(key);
  pendingIds.delete(key);
  const recFile = path.join(audioDir(udid), `rec.${bundleId}`);
  fs.rmSync(recFile, { force: true });
  if (recorder && pendingId && !(status?.recording && status.recordingId === pendingId)) {
    // Requested from a dormant hook that never opened audio (or did and already stopped): what reached the ring is
    // the recording.
    recorders.delete(key);
    const finished = recorder.finish();
    return {
      path: finished.path,
      durationMs: finished.sampleRate ? Math.round((finished.frames * 1000) / finished.sampleRate) : 0,
      sampleRate: finished.sampleRate,
      channels: finished.channels,
      droppedFrames: finished.droppedFrames,
    };
  }
  if (!status?.recording || !recorder) {
    recorders.delete(key);
    recorder?.abort();
    removeFiles(audioDir(udid), `out-${bundleId}-`);
    throw new FailureError(
      status?.recording
        ? `${bundleId} was recorded by a tool-server that has since stopped, so its audio is lost. The recording has now been stopped; start a new one.`
        : `${bundleId} is not being recorded. Call audio-record-start first${status ? "" : " (the app is not running or its audio hook is not live)"}.`,
      {
        error_code: FAILURE_CODES.AUDIO_NO_ACTIVE_RECORDING,
        failure_stage: "audio_record_stop",
        failure_area: "tool_server",
        error_kind: "not_found",
      }
    );
  }
  const done = await waitFor(() => {
    const s = readAppStatus(udid, bundleId);
    return s && s.recordingId === status.recordingId && s.recordingDone ? s : undefined;
  }, ACK_TIMEOUT_MS);
  recorders.delete(key);
  const finished = recorder.finish();
  if (!done) {
    throw new FailureError(
      `${bundleId} did not confirm the end of the recording within ${ACK_TIMEOUT_MS / 1000}s; ${finished.path} may miss its last moments.`,
      {
        error_code: FAILURE_CODES.AUDIO_RECORDING_STOP_TIMEOUT,
        failure_stage: "audio_record_stop",
        failure_area: "tool_server",
        error_kind: "timeout",
      }
    );
  }
  return {
    path: finished.path,
    durationMs: finished.sampleRate
      ? Math.round((finished.frames * 1000) / finished.sampleRate)
      : 0,
    sampleRate: finished.sampleRate,
    channels: finished.channels,
    droppedFrames: finished.droppedFrames,
  };
}

/**
 * Gives every simulator its microphone back and drops every recording this process owns. Run when the
 * tool-server exits: a ring nobody feeds would leave the apps silent until the next tool call.
 */
export function disposeAudio(): void {
  for (const udid of [...feeders.keys()]) clearAudioInput(udid);
  for (const [key, recorder] of recorders) {
    recorders.delete(key);
    const [udid, bundleId] = key.split("/");
    fs.rmSync(path.join(audioDir(udid), `rec.${bundleId}`), { force: true });
    recorder.abort();
  }
}
