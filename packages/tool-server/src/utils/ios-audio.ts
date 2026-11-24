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
import { InputFeeder, readClipInfo, STREAM_RATE, type FeederSource } from "./ios-audio-rings";
import { OWNER_LINE, processAlive } from "./ios-audio-leftovers";

const execFileAsync = promisify(execFile);

/**
 * Host side of the iOS Simulator audio mock. The other side is the audio hook in argent-private, a
 * dylib injected into the app that replaces the microphone samples it reads. The two sides talk
 * through plain files in a per-simulator directory that the hook polls (simulator processes share
 * the host filesystem):
 *
 *   input           host -> app   source=stream  ring=<in ring>   (absent: the real microphone)
 *   st.<bundleId>   app -> host   key=value status the app rewrites when it changes
 *
 * The host's files carry its pid (`host=<pid>`, or in the name), so a later tool-server can clear what a killed one
 * left behind without touching what a live one owns (`ios-audio-leftovers.ts`).
 *
 * The samples travel through the ring file of `ios-audio-rings.ts`: this process feeds it, so the
 * hook only copies. Every control write is a temp file plus rename, so the hook never reads a
 * half-written file.
 */

/** Set in the simulator's launchd environment to arm the guest hook in apps launched afterwards. */
const AUDIO_DIR_ENV = "ARGENT_AUDIO_DIR";
/**
 * Contract version the hook reports as `proto` in its status file (ArgentAudio.c `PROTO`). A hook with another
 * version, or none (built before it existed), is refused at once.
 */
export const AUDIO_HOOK_PROTO = 1;
/** Clips are streamed from disk, so this only bounds the converted copy: 10 minutes is about 115 MB. */
const MAX_CLIP_SECONDS = 600;

export { audioDir };

/** What this process holds for one simulator's audio mock: the api of its `IosAudioSession` service. */
export interface AudioSession {
  /** The id the tools were called with. */
  readonly udid: string;
  /** Control directory, named after the simulator's own UDID like the one ios-host.ts arms. */
  readonly dir: string;
  /** Feeds the in ring while an input source is set. */
  feeder: InputFeeder | null;
  /** This process verified the simulator's launchd environment; a reboot wipes it, which {@link armAudio} re-checks. */
  envVerified: boolean;
}

export function createAudioSession(udid: string): AudioSession {
  return {
    udid,
    dir: audioDir(externalNativeId(udid)),
    feeder: null,
    envVerified: false,
  };
}

function writeAtomic(file: string, text: string): void {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
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
        "Build it with `bun run build:ios-binaries`, or download it with `scripts/download-native-binaries.sh`.",
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

/**
 * Gives the simulator its microphone back. Run when the session is disposed (tool-server exit,
 * stop-all-simulator-servers): a ring nobody feeds would leave the apps silent until the next tool call.
 * An input that another tool-server set meanwhile stays.
 */
export function releaseAudio(session: AudioSession): void {
  if (session.feeder) clearAudioInput(session, true);
}
