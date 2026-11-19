import type { UiOrientation } from "../tools/describe/contract";
import { isTvOsSimulator } from "./ios-devices";
import { resolveDevice } from "./device-info";
import type { PlatformImpl } from "./cross-platform-tool";

/**
 * The interface orientation of an iOS simulator's front app, for the tools
 * that turn the screen's portrait-native space into the upright one agents
 * work in.
 *
 * An iOS simulator captures, frames and takes touches in the screen's fixed
 * (portrait-native) space whatever the UI's orientation, so a landscape UI
 * lies sideways in it. Agents read screenshots and send taps in the UI's own
 * upright space instead (as on Android), and the tool-server turns between
 * the two at its edge: captures and frames on the way out, touches on the way
 * in. Every turn needs the orientation with its sense, which only the device
 * knows: the screen's aspect gives the axis, but landscapeLeft and
 * landscapeRight differ by a half turn.
 *
 * The ax-service answers it (`systemArbitratedInterfaceOrientationForDisplayID:`),
 * following the app rather than the device: a portrait-only app on a rotated
 * device stays `portrait`, and so needs no turn.
 */

/** What a read found: the orientation, or why there is none. */
export interface UiOrientationRead {
  orientation?: UiOrientation;
  /** The screen's size in points on its portrait-native axes, when the read reported it. */
  nativeScreen?: { width: number; height: number };
  /**
   * Set when a read failed: why. Undefined with no orientation means none was
   * asked for (no source is wired in, as in a unit test), which is not worth a note.
   */
  unknownReason?: string;
}

type OrientationSource = {
  orientation(): Promise<{
    interfaceOrientation?: UiOrientation;
    screenFrame?: { width: number; height: number };
  }>;
};

let sourceFor: ((udid: string) => Promise<OrientationSource>) | undefined;

/**
 * Wire the ax-service in, as `setLivePanelSourceProvider` does for a
 * foldable's panel: the daemon is a registry service and this module is not.
 * Unset (a unit test), every read answers no orientation, and no note.
 */
export function setUiOrientationSourceProvider(
  provider: ((udid: string) => Promise<OrientationSource>) | undefined
): void {
  sourceFor = provider;
}

/**
 * How long an answer is reused, a failed read's too. Long enough that the
 * touches of one gesture and the taps of a double-tap, which must land inside
 * the OS's double-tap window, share one read, and that a daemon which hangs
 * holds one touch rather than every one; short enough that a UI that turns on
 * its own (an app that locks landscape on launch) is seen by the next tool call.
 */
const MAX_AGE_MS = 1_000;

/** Bound on one read: a daemon that hangs must not hold a touch. */
const READ_TIMEOUT_MS = 2_500;

const cache = new Map<string, { read: UiOrientationRead; at: number }>();
const inFlight = new Map<string, { generation: number; read: Promise<UiOrientationRead> }>();
/** Bumped by every forget, so a read started before it is neither joined nor cached. */
const generations = new Map<string, number>();

/**
 * How long after a rotate or a fold no answer is reused: the UI takes a few
 * hundred milliseconds to turn, and a read taken mid-turn may still name the
 * old orientation, which a cache would then hand on to the next touches.
 */
const TURN_SETTLE_MS = 1_500;
const noReuseUntil = new Map<string, number>();

/** Record what a tree read reported, so the next touch need not ask again. */
export function noteUiOrientation(
  udid: string,
  orientation: UiOrientation | undefined,
  nativeScreen?: { width: number; height: number }
): void {
  if (orientation === undefined || turning(udid)) return;
  cache.set(udid, {
    read: { orientation, ...(nativeScreen ? { nativeScreen } : {}) },
    at: Date.now(),
  });
}

/** Drop what is known of a device's orientation: it was just rotated or folded. */
export function forgetUiOrientation(udid: string): void {
  cache.delete(udid);
  generations.set(udid, (generations.get(udid) ?? 0) + 1);
  noReuseUntil.set(udid, Date.now() + TURN_SETTLE_MS);
}

function turning(udid: string): boolean {
  const until = noReuseUntil.get(udid);
  if (until === undefined) return false;
  if (Date.now() < until) return true;
  noReuseUntil.delete(udid);
  return false;
}

/** Test-only. */
export function __resetUiOrientationForTests(): void {
  cache.clear();
  inFlight.clear();
  generations.clear();
  noReuseUntil.clear();
}

/**
 * The front app's interface orientation on an iOS simulator, read at most
 * {@link MAX_AGE_MS} ago. Never throws: a failed read is unknown, with why.
 */
export function readUiOrientation(udid: string): Promise<UiOrientationRead> {
  const hit = cache.get(udid);
  if (hit && Date.now() - hit.at <= MAX_AGE_MS && !turning(udid)) return Promise.resolve(hit.read);
  const generation = generations.get(udid) ?? 0;
  const pending = inFlight.get(udid);
  if (pending && pending.generation === generation) return pending.read;
  const read = readFresh(udid).then((result) => {
    // Kept only while nothing turned the UI since the read began.
    if ((generations.get(udid) ?? 0) === generation && !turning(udid)) {
      cache.set(udid, { read: result, at: Date.now() });
    }
    return result;
  });
  const entry = { generation, read };
  inFlight.set(udid, entry);
  void read.finally(() => {
    if (inFlight.get(udid) === entry) inFlight.delete(udid);
  });
  return read;
}

async function readFresh(udid: string): Promise<UiOrientationRead> {
  if (!sourceFor) return {};
  // An Apple TV has no interface orientation to turn by, and the iOS
  // accessibility service does not run on it.
  // Asked of a local simulator only: a remote one is not in the local listing,
  // which would then be read again on every touch.
  if (resolveDevice(udid).platform === "ios" && (await isTvOsSimulator(udid).catch(() => false))) {
    return {};
  }
  let timer: NodeJS.Timeout | undefined;
  try {
    const answer = await Promise.race([
      sourceFor(udid).then((source) => source.orientation()),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`no answer within ${READ_TIMEOUT_MS}ms`)),
          READ_TIMEOUT_MS
        );
        timer.unref?.();
      }),
    ]);
    const orientation = answer.interfaceOrientation;
    if (orientation === undefined) {
      return { unknownReason: "the accessibility service did not name it" };
    }
    return { orientation, ...(answer.screenFrame ? { nativeScreen: answer.screenFrame } : {}) };
  } catch (err) {
    return {
      unknownReason: `the accessibility service could not be asked (${err instanceof Error ? err.message : String(err)})`,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The note a tool carries when it could not read the orientation and so left
 * its coordinates in the screen's portrait-native space. Only a landscape or
 * upside-down UI is affected, which the caller cannot tell either.
 */
export function unknownOrientationNote(read: UiOrientationRead, what: string): string {
  return (
    `The interface orientation could not be read (${read.unknownReason ?? "unknown"}), so ${what} ` +
    `the screen's portrait-native space. If the UI is landscape or upside down, that is not ` +
    `the upright space screenshots and describe frames normally use.`
  );
}

/**
 * An iOS simulator branch of a tool that changes the front app (launch-app,
 * restart-app, open-url): the new app can lie another way, so what was read
 * of the last one's orientation is forgotten once it ran, as after a rotate.
 */
export function forgettingUiOrientation<S, P, O>(
  impl: PlatformImpl<S, P, O>
): PlatformImpl<S, P, O> {
  return {
    ...impl,
    handler: async (services, params, device, options) => {
      try {
        return await impl.handler(services, params, device, options);
      } finally {
        forgetUiOrientation(device.id);
      }
    },
  };
}
