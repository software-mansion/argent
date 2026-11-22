import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { FAILURE_CODES, FailureError } from "@argent/registry";
import { audioDylibPath } from "@argent/native-devtools-ios";
import { simctlTargetForUdid } from "./ios-device-sets";
import { SIMCTL_KILL_SIGNAL, SIMCTL_SPAWN_TIMEOUT_MS } from "./simctl-config";
import { InvalidToolInputError } from "./capability";
import { appendDyldInsertLibrary, audioDir, runningAppPid } from "./ios-host";
import { externalNativeId } from "./external-devices";
import type { NativeDevtoolsApi } from "../blueprints/native-devtools";
import {
  InputFeeder,
  OutputRecorder,
  readClipInfo,
  type FinishedWav,
  STREAM_RATE,
  type FeederSource,
} from "./ios-audio-rings";
import { OWNER_LINE, processAlive } from "./ios-audio-leftovers";

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
 * The host's files carry its pid (`host=<pid>`, or in the name), so a later tool-server can clear what a killed one
 * left behind without touching what a live one owns (`ios-audio-leftovers.ts`).
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
const BUNDLE_ID_PATTERN = /^[A-Za-z0-9.-]+$/;

export { audioDir };

/** What this process holds for one simulator's audio mock: the api of its `IosAudioSession` service. */
export interface AudioSession {
  /** The id the tools were called with. */
  readonly udid: string;
  /** Control directory, named after the simulator's own UDID like the one ios-host.ts arms. */
  readonly dir: string;
  /** Feeds the in ring while an input source is set. */
  feeder: InputFeeder | null;
  /** One per app being recorded, by bundle id. */
  readonly recorders: Map<string, OutputRecorder>;
  /** Recordings requested from a dormant hook, not acknowledged yet: their id, by bundle id. */
  readonly pendingIds: Map<string, string>;
  /** This process verified the simulator's launchd environment; a reboot wipes it, which {@link armAudio} re-checks. */
  envVerified: boolean;
}

export function createAudioSession(udid: string): AudioSession {
  return {
    udid,
    dir: audioDir(externalNativeId(udid)),
    feeder: null,
    recorders: new Map(),
    pendingIds: new Map(),
    envVerified: false,
  };
}

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
 * and points it at the directory. Arming already did all of this unless the `ios-audio-always-inserted`
 * flag is off (see ios-host.ts); then this is the first insertion. Apps launched from now on carry the hook;
 * apps that were already running keep their old environment and need a restart (see
 * {@link readAppStatus} for telling them apart).
 */
export async function ensureAudioEnv(session: AudioSession): Promise<void> {
  const { dir } = session;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (session.envVerified) return;
  const dylib = requireAudioDylib();
  // Part of native devtools' arming, so its grant covers these spawns.
  const { nativeId, prefix } = await simctlTargetForUdid(session.udid, {
    granted: "native-devtools",
  });
  const options = { timeout: SIMCTL_SPAWN_TIMEOUT_MS, killSignal: SIMCTL_KILL_SIGNAL };
  const getenv = async (name: string) =>
    (
      await execFileAsync("xcrun", [...prefix, "spawn", nativeId, "launchctl", "getenv", name], {
        encoding: "utf8",
        ...options,
      }).catch(() => ({ stdout: "" }))
    ).stdout.trim();
  const setenv = (name: string, value: string) =>
    execFileAsync(
      "xcrun",
      [...prefix, "spawn", nativeId, "launchctl", "setenv", name, value],
      options
    );

  // launchctl, not `simctl getenv`: the latter truncates the colon-separated list past 127 bytes.
  const inserted = await getenv("DYLD_INSERT_LIBRARIES");
  const withAudio = appendDyldInsertLibrary(inserted, dylib);
  if (withAudio !== inserted) await setenv("DYLD_INSERT_LIBRARIES", withAudio);
  if ((await getenv(AUDIO_DIR_ENV)) !== dir) await setenv(AUDIO_DIR_ENV, dir);
  session.envVerified = true;
}

/** The audio hook's dylib, or a failure that says how to get it. */
function requireAudioDylib(): string {
  try {
    return audioDylibPath();
  } catch (err) {
    throw new FailureError(
      `The audio hook (libArgentAudio.dylib) is not installed: ${(err as Error).message}. ` +
        "Build it with `npm run build:ios-binaries`, or download it with `scripts/download-native-binaries.sh`.",
      {
        error_code: FAILURE_CODES.AUDIO_HOOK_UNAVAILABLE,
        failure_stage: "audio_env_setup",
        failure_area: "tool_server",
        error_kind: "dependency_missing",
      }
    );
  }
}

/**
 * Arms the mock in the simulator: the native-devtools service keeps the simulator's injection environment
 * healthy (it re-applies its own dylib after a reboot), and {@link ensureAudioEnv} adds the audio dylib next
 * to it. A simulator whose injection a device provider armed is refused: its launchd environment is not ours.
 */
export async function armAudio(
  session: AudioSession,
  devtools: Pick<NativeDevtoolsApi, "reverifyEnv" | "getInitFailure" | "armsEnv">
): Promise<void> {
  if (!devtools.armsEnv) {
    throw new FailureError(
      `The provider that supplied ${session.udid} armed its injection, so Argent cannot add the audio hook to it.`,
      {
        error_code: FAILURE_CODES.AUDIO_INJECTION_NOT_OURS,
        failure_stage: "audio_env_setup",
        failure_area: "tool_server",
        error_kind: "unsupported",
      }
    );
  }
  // A reboot wipes launchd's environment; native-devtools notices (it re-applies its own entry), and the audio
  // entry has to be re-applied with it. Check cheaply through the status files: live apps prove the env.
  if (session.envVerified && listLiveApps(session).length === 0) session.envVerified = false;
  await devtools.reverifyEnv().catch(() => {});
  const failure = devtools.getInitFailure();
  if (failure) {
    throw new FailureError(
      `Could not set up audio injection for ${session.udid} (${failure.lastError}): ` +
        (failure.givenUp
          ? `call stop-all-simulator-servers with devices: ["${session.udid}"], then retry.`
          : `retry, or reboot the simulator with boot-device.`),
      {
        error_code: FAILURE_CODES.AUDIO_ENV_SETUP_FAILED,
        failure_stage: "audio_env_setup",
        failure_area: "tool_server",
        error_kind: "subprocess",
        failure_command: "xcrun_simctl",
      }
    );
  }
  await ensureAudioEnv(session);
}

/** Live view of one app's hook, parsed from its `st.<bundleId>` file. */
interface AppAudioStatus {
  /** Contract version of the hook; 0 when the hook predates it. */
  proto: number;
  /** Optional parts of the contract the hook has (`features=`, comma-separated): `rec` when it can record. */
  features: string[];
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
    features: (kv.get("features") ?? "").split(",").filter(Boolean),
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

/**
 * The app's hook status, or null when the hook is not live in it: the app never loaded the hook
 * (launched before {@link ensureAudioEnv}, or by something that replaced the injected libraries), or
 * the process that wrote the file is gone. Simulator apps are host processes, so a pid probe works.
 */
export function readAppStatus(session: AudioSession, bundleId: string): AppAudioStatus | null {
  let text: string;
  try {
    text = fs.readFileSync(path.join(session.dir, `st.${bundleId}`), "utf8");
  } catch {
    return null;
  }
  const status = parseAppStatus(text);
  return status.pid > 0 && processAlive(status.pid) ? status : null;
}

/**
 * Whether the hook is loaded in the app, from its status file alone:
 *   none       no file, or one a dead process left: the app was launched before arming, or by something that
 *              replaced the injected libraries
 *   stale      the file's live process is not the app's running process (relaunched, not written yet)
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
  if (!status || !(status.pid > 0) || !pidAlive) return "none";
  if (runningPid === null || runningPid !== status.pid) return "stale";
  if (status.proto !== AUDIO_HOOK_PROTO) return "old-proto";
  return status.state;
}

export async function readAppHook(
  session: AudioSession,
  bundleId: string
): Promise<{ state: HookState; status: AppAudioStatus | null }> {
  let text: string;
  try {
    text = fs.readFileSync(path.join(session.dir, `st.${bundleId}`), "utf8");
  } catch {
    return { state: "none", status: null };
  }
  const status = parseAppStatus(text);
  const running = await runningAppPid(session.udid, bundleId).catch(() => null);
  return {
    state: decideHookState(status, status.pid > 0 && processAlive(status.pid), running),
    status,
  };
}

/** Bundle ids of the apps whose hook is live, for telling the caller which apps can be driven. */
export function listLiveApps(session: AudioSession): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(session.dir);
  } catch {
    return [];
  }
  return names
    .filter((name) => name.startsWith("st.") && !name.endsWith(".tmp"))
    .map((name) => name.slice(3))
    .filter((bundleId) => readAppStatus(session, bundleId) !== null);
}

type AudioInputSource =
  | { kind: "file"; path: string; plays: number }
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
 * audio input stopped for half a second; a clip plays `plays` times, then silence.
 */
export async function setAudioInput(
  session: AudioSession,
  source: AudioInputSource
): Promise<AudioInputResult> {
  const { dir } = session;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  let feederSource: FeederSource;
  let clipName: string | undefined;
  let durationMs: number | undefined;
  if (source.kind === "tone") {
    feederSource = { kind: "tone", frequencyHz: source.frequencyHz, amplitude: source.amplitude };
  } else {
    clipName = `clip-${process.pid}-${Date.now()}.wav`;
    const clipPath = path.join(dir, clipName);
    await convertClip(source.path, clipPath);
    const fd = fs.openSync(clipPath, "r");
    try {
      const info = readClipInfo(fd);
      if (info.frames > MAX_CLIP_SECONDS * STREAM_RATE) {
        throw new InvalidToolInputError(
          `${source.path} is longer than ${MAX_CLIP_SECONDS / 60} minutes.`
        );
      }
      feederSource = { kind: "clip", fd, info, plays: source.plays };
      durationMs = Math.round((info.frames * 1000) / STREAM_RATE);
    } catch (err) {
      fs.closeSync(fd);
      fs.rmSync(clipPath, { force: true });
      throw err;
    }
  }
  let feeder = session.feeder;
  if (feeder?.running && !fs.existsSync(feeder.ringPath)) {
    // The control directory was removed under it (a simulator reboot, a cleanup): its ring is an unlinked file
    // nobody can map any more.
    feeder.stop();
    feeder = null;
  }
  if (feeder?.running) {
    feeder.setSource(feederSource);
  } else {
    removeFiles(dir, `in-${process.pid}-`);
    feeder = new InputFeeder(
      path.join(dir, `in-${process.pid}-${randomUUID().slice(0, 8)}.ring`),
      feederSource
    );
    feeder.start();
    session.feeder = feeder;
  }
  const inputFile = path.join(dir, "input");
  // A new ring path is what makes the apps map it; rewriting the same one would restart nothing.
  const control = `source=stream\nring=${feeder.ringPath}\n${OWNER_LINE}`;
  if (!fs.existsSync(inputFile) || fs.readFileSync(inputFile, "utf8") !== control) {
    writeAtomic(inputFile, control);
  }
  // The feeder has closed the previous clip, so it can be deleted. Other tool-servers' clips are theirs.
  removeFiles(dir, `clip-${process.pid}-`, clipName);
  return { source: source.kind, durationMs };
}

/**
 * Gives the microphone back to every app, whichever tool-server set the input: the explicit `source=microphone`.
 * With `ownedOnly` (the implicit release on dispose) an `input` that another tool-server wrote since stays, as that
 * one still feeds its ring. One without a `host=` line is not ours either: `clearAudioLeftovers` judges it.
 */
export function clearAudioInput(session: AudioSession, ownedOnly = false): void {
  const { dir } = session;
  session.feeder?.stop();
  session.feeder = null;
  if (!fs.existsSync(dir)) return;
  const inputFile = path.join(dir, "input");
  // Apps keep their mapping of an unlinked ring until they see the input file gone.
  // Read, then remove: a tool-server that replaces the file in between loses it, and writes it again on its next call.
  if (!ownedOnly || ownsInput(inputFile)) fs.rmSync(inputFile, { force: true });
  removeFiles(dir, `clip-${process.pid}-`);
  removeFiles(dir, `in-${process.pid}-`);
}

function ownsInput(inputFile: string): boolean {
  try {
    return fs.readFileSync(inputFile, "utf8").split("\n").includes(OWNER_LINE.trim());
  } catch {
    return false;
  }
}

/** Fails fast when the app runs a hook that speaks another version of the control protocol. */
export function assertHookProto(status: AppAudioStatus | null, bundleId: string): void {
  if (!status || status.proto === AUDIO_HOOK_PROTO) return;
  throw new FailureError(
    `${bundleId} runs an older audio hook (protocol ${status.proto || "none"}, need ${AUDIO_HOOK_PROTO}): ` +
      `call restart-app for it, then retry.`,
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
    `The audio hook is not live in ${bundleId}: call restart-app for it, then retry.`,
    {
      error_code: FAILURE_CODES.AUDIO_HOOK_NOT_ACTIVE,
      failure_stage: "audio_hook_status",
      failure_area: "tool_server",
      error_kind: "not_found",
    }
  );
}

/**
 * Fails fast when the app's hook is a build without recording: it never reads a recording request, so writing one
 * would only wait for an acknowledgement that does not come.
 */
function assertHookRecords(status: AppAudioStatus | null, bundleId: string): void {
  if (!status || status.features.includes("rec")) return;
  throw new FailureError(
    `The audio hook in ${bundleId} is a build with microphone input only: call restart-app for it, then retry.`,
    {
      error_code: FAILURE_CODES.AUDIO_HOOK_NOT_ACTIVE,
      failure_stage: "audio_hook_status",
      failure_area: "tool_server",
      error_kind: "unsupported",
    }
  );
}

/** Starts recording the app's speaker output into `outputPath`; resolves once the app confirms. */
export async function startRecording(
  session: AudioSession,
  bundleId: string,
  outputPath: string,
  muteOutput: boolean
): Promise<void> {
  assertBundleId(bundleId);
  const hook = await readAppHook(session, bundleId);
  if (hook.state === "old-proto") assertHookProto(hook.status, bundleId);
  if (hook.state === "none" || hook.state === "stale") throw noHookError(bundleId);
  const status = hook.status;
  assertHookRecords(status, bundleId);
  // A dormant hook acknowledges nothing until the app opens audio; it reads the request when it does.
  const dormant = hook.state === "dormant";
  const { recorders, pendingIds } = session;
  if (status?.recording || recorders.has(bundleId)) {
    throw new FailureError(`${bundleId} is already being recorded: call audio-record-stop first.`, {
      error_code: FAILURE_CODES.AUDIO_RECORDING_ALREADY_ACTIVE,
      failure_stage: "audio_record_start",
      failure_area: "tool_server",
      error_kind: "validation",
    });
  }
  const id = randomUUID().slice(0, 8);
  const { dir } = session;
  // A ring of an earlier tool-server's recording of this app is nobody's now.
  removeFiles(dir, `out-${bundleId}-`);
  const recorder = new OutputRecorder(path.join(dir, `out-${bundleId}-${id}.ring`), outputPath);
  const recFile = path.join(dir, `rec.${bundleId}`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeAtomic(
    recFile,
    `id=${id}\nring=${recorder.ringPath}\nmute=${muteOutput ? 1 : 0}\n${OWNER_LINE}`
  );
  if (dormant) {
    pendingIds.set(bundleId, id);
    recorders.set(bundleId, recorder);
    return;
  }
  const ack = await waitFor(() => {
    const s = readAppStatus(session, bundleId);
    return s && s.recordingId === id && (s.recording || s.error) ? s : undefined;
  }, ACK_TIMEOUT_MS);
  if (ack?.recording) {
    recorders.set(bundleId, recorder);
    return;
  }
  fs.rmSync(recFile, { force: true });
  recorder.abort();
  throw new FailureError(
    ack?.error
      ? `${bundleId} could not start recording: ${ack.error}`
      : `${bundleId} did not confirm the recording within ${ACK_TIMEOUT_MS / 1000}s; it may be suspended.`,
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
  /** The file is complete as far as the host can tell, but the app did not end it cleanly. */
  warning?: string;
}

function finishedRecording(finished: FinishedWav, warning?: string): FinishedRecording {
  return {
    path: finished.path,
    durationMs: finished.sampleRate
      ? Math.round((finished.frames * 1000) / finished.sampleRate)
      : 0,
    sampleRate: finished.sampleRate,
    channels: finished.channels,
    droppedFrames: finished.droppedFrames,
    ...(warning ? { warning } : {}),
  };
}

/** Stops the app's recording and resolves once the WAV is finalized. */
export async function stopRecording(
  session: AudioSession,
  bundleId: string
): Promise<FinishedRecording> {
  assertBundleId(bundleId);
  const { recorders, pendingIds } = session;
  const recorder = recorders.get(bundleId);
  const status = readAppStatus(session, bundleId);
  const pendingId = pendingIds.get(bundleId);
  pendingIds.delete(bundleId);
  const recFile = path.join(session.dir, `rec.${bundleId}`);
  fs.rmSync(recFile, { force: true });
  if (recorder && pendingId && !(status?.recording && status.recordingId === pendingId)) {
    // Requested from a dormant hook that never opened audio (or did and already stopped): what reached the ring is
    // the recording.
    recorders.delete(bundleId);
    return finishedRecording(recorder.finish());
  }
  if (recorder && !status?.recording) {
    // The app quit or was relaunched while it was recorded: what it played until then reached the ring.
    recorders.delete(bundleId);
    return finishedRecording(
      recorder.finish(),
      `${bundleId} quit or was relaunched while recorded; the file holds what it played until then.`
    );
  }
  if (!recorder || !status) {
    removeFiles(session.dir, `out-${bundleId}-`);
    throw new FailureError(
      status?.recording
        ? `${bundleId} was recorded by a tool-server that has since stopped, so its audio is lost: start a new recording.`
        : `${bundleId} is not being recorded: call audio-record-start first.`,
      {
        error_code: FAILURE_CODES.AUDIO_NO_ACTIVE_RECORDING,
        failure_stage: "audio_record_stop",
        failure_area: "tool_server",
        error_kind: "not_found",
      }
    );
  }
  const done = await waitFor(() => {
    const s = readAppStatus(session, bundleId);
    return s && s.recordingId === status.recordingId && s.recordingDone ? s : undefined;
  }, ACK_TIMEOUT_MS);
  recorders.delete(bundleId);
  return finishedRecording(
    recorder.finish(),
    done
      ? undefined
      : `${bundleId} did not confirm the end of the recording; the file may miss its last moments.`
  );
}

/**
 * Gives the simulator its microphone back and drops every recording this process owns. Run when the session
 * is disposed (tool-server exit, stop-all-simulator-servers): a ring nobody feeds would leave the apps silent
 * until the next tool call. An input that another tool-server set meanwhile stays.
 */
export function releaseAudio(session: AudioSession): void {
  if (session.feeder) clearAudioInput(session, true);
  for (const [bundleId, recorder] of session.recorders) {
    fs.rmSync(path.join(session.dir, `rec.${bundleId}`), { force: true });
    recorder.abort();
  }
  session.recorders.clear();
  session.pendingIds.clear();
}
