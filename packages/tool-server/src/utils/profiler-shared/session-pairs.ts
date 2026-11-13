import * as path from "path";
import { readCommitTree } from "../react-profiler/debug/dump";
import { readXctraceSessionMetadata } from "../ios-profiler/session-metadata";
import { readAndroidNativeProfilerMetadata } from "../android-profiler/session-metadata";
import { externalNativeId } from "../external-devices";
import { scanProfilerSessions, sessionIdMs } from "./session-ids";

/**
 * A native and a React session of one profiling run have different ids: the
 * native id is the time its recording started, the React id the time its stop
 * ran. They pair by the device and the wall-clock time each one recorded:
 * agents that profile other devices at the same time share the folder.
 */
interface SessionRecording {
  /**
   * The device it recorded on: its list-devices id, or Metro's logicalDeviceId
   * for a React session keyed by that id whose start found no device.
   */
  deviceId: string;
  startMs: number;
  endMs: number;
}

/** The files a native session has: xctrace (iOS, Mac apps) or Android. */
export type NativeTrace = "xctrace" | "android";

/**
 * When and where a React session recorded, from the meta of its commits file:
 * from the start to its id, the stop's second. Null when the meta lacks either.
 * A session keyed by Metro's logicalDeviceId (two or more devices on one Metro)
 * recorded on the device that its start found, the id native sessions use.
 */
export function reactRecording(
  sessionId: string,
  meta:
    | {
        profileStartWallMs?: number | null;
        deviceId?: string | null;
        runtimeDeviceId?: string | null;
      }
    | undefined
): SessionRecording | null {
  const stopMs = sessionIdMs(sessionId);
  const startMs = meta?.profileStartWallMs;
  const deviceId = meta?.runtimeDeviceId ?? meta?.deviceId;
  return typeof startMs === "number" && stopMs !== null && deviceId
    ? { deviceId, startMs, endMs: stopMs + 999 }
    : null;
}

async function readReactRecording(
  debugDir: string,
  sessionId: string
): Promise<SessionRecording | null> {
  try {
    const commits = path.join(debugDir, `react-profiler-${sessionId}_commits.json`);
    return reactRecording(sessionId, (await readCommitTree(commits)).meta);
  } catch {
    return null;
  }
}

/**
 * When and where the native session with this id and these files recorded, from
 * the metadata file its stop saved. An id can hold an xctrace and an Android
 * session that started in the same second. Null for a session saved without the
 * times or the device.
 */
export async function nativeRecording(
  debugDir: string,
  sessionId: string,
  trace: NativeTrace
): Promise<SessionRecording | null> {
  const base = path.join(debugDir, `native-profiler-${sessionId}`);
  try {
    const metadata =
      trace === "xctrace"
        ? await readXctraceSessionMetadata(`${base}.trace`)
        : await readAndroidNativeProfilerMetadata(`${base}.pftrace`);
    return metadata?.deviceId && metadata.wallClockStartMs != null && metadata.stoppedAtMs != null
      ? {
          deviceId: metadata.deviceId,
          startMs: metadata.wallClockStartMs,
          endMs: metadata.stoppedAtMs,
        }
      : null;
  } catch {
    return null; // not valid: no recording
  }
}

/**
 * Whether two ids name one device. A provider's device has an `ext:` id, which
 * the native session saves, and the serial or UDID that Metro and adb know it by.
 */
function sameDevice(a: string, b: string): boolean {
  return a === b || externalNativeId(a) === b || a === externalNativeId(b);
}

/** Whether two sessions recorded on one device at the same time. */
function sameRun(a: SessionRecording, b: SessionRecording): boolean {
  return sameDevice(a.deviceId, b.deviceId) && a.startMs <= b.endMs && b.startMs <= a.endMs;
}

/** For each session id of one kind, the ids of the other kind of the same run. */
export function pairProfilerSessions(
  react: ReadonlyMap<string, SessionRecording | null>,
  native: ReadonlyMap<string, SessionRecording | null>
): { reactToNative: Map<string, string[]>; nativeToReact: Map<string, string[]> } {
  const reactToNative = new Map<string, string[]>();
  const nativeToReact = new Map<string, string[]>();
  for (const [reactId, a] of react) {
    for (const [nativeId, b] of native) {
      if (!a || !b || !sameRun(a, b)) continue;
      reactToNative.set(reactId, [...(reactToNative.get(reactId) ?? []), nativeId]);
      nativeToReact.set(nativeId, [...(nativeToReact.get(nativeId) ?? []), reactId]);
    }
  }
  return { reactToNative, nativeToReact };
}

/** The sessions of one kind of the same run as a session of the other kind. */
export interface SameRun {
  /** Sorted, each with the device it recorded on. */
  partners: { id: string; deviceId: string }[];
  /** Whether the id also names a session of the asked kind, on another device. */
  ownElsewhere: boolean;
}

/**
 * The sessions of `kind` of the same run as the other kind's session
 * `sessionId`, for a load on `deviceId`. None when `sessionId` names a session
 * of `kind` on that device, or on a device its files do not name, or on another
 * device while no run of `deviceId` has this id; or when no session of `kind`
 * recorded on the other session's device at the same time. Of the other kind's
 * sessions with this id, the ones on `deviceId` count when there are any.
 * `trace` limits the native sessions to pair to the ones a load can read.
 */
export async function sameRunSessions(
  debugDir: string,
  kind: "react" | "native",
  sessionId: string,
  deviceId: string,
  trace?: NativeTrace
): Promise<SameRun> {
  const none: SameRun = { partners: [], ownElsewhere: false };
  const sessions = await scanProfilerSessions(debugDir);
  if (!sessions) return none;
  const [own, other] =
    kind === "react" ? [sessions.react, sessions.native] : [sessions.native, sessions.react];
  if (!other.has(sessionId)) return none;
  const recordings = async (
    k: "react" | "native",
    id: string,
    traces: NativeTrace[] = ["xctrace", "android"]
  ): Promise<SessionRecording[]> => {
    const found =
      k === "react"
        ? [await readReactRecording(debugDir, id)]
        : await Promise.all(traces.map((t) => nativeRecording(debugDir, id, t)));
    return found.filter((r): r is SessionRecording => r !== null);
  };
  let ownElsewhere = false;
  if (own.has(sessionId)) {
    const mine = await recordings(kind, sessionId);
    if (mine.length === 0 || mine.some((r) => sameDevice(r.deviceId, deviceId))) return none;
    ownElsewhere = true;
  }
  const given = await recordings(kind === "react" ? "native" : "react", sessionId);
  const onDevice = given.filter((r) => sameDevice(r.deviceId, deviceId));
  // The session with this id is another device's, and so is every run of the other kind.
  if (ownElsewhere && onDevice.length === 0) return none;
  const runs = onDevice.length > 0 ? onDevice : given;
  if (runs.length === 0) return none;
  const ids = [...own.keys()].sort();
  const candidates = await Promise.all(
    ids.map((id) => recordings(kind, id, trace ? [trace] : undefined))
  );
  const partners: SameRun["partners"] = [];
  ids.forEach((id, i) => {
    const match = candidates[i]!.find((c) => runs.some((r) => sameRun(r, c)));
    if (match) partners.push({ id, deviceId: match.deviceId });
  });
  return { partners, ownElsewhere };
}
