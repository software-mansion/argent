import {
  HARMONY_EMPTY_SENTINEL,
  emulatorFailure,
  resolveHarmonyEmulator,
  runHarmonyEmulator,
} from "./harmony-cli";
import { HDC_EMPTY_SENTINEL, hdcFailure, hdcProse, resolveHdc, runHdc } from "./harmony-hdc";

/**
 * HarmonyOS discovery. DevEco's `Emulator` manager knows instances (what
 * `boot-device` starts); `hdc` knows connected targets (what every other tool
 * drives). A running emulator appears in both, as with `avdmanager` and `adb`.
 */

interface HarmonyInstance {
  name: string;
  deviceType: string | null;
  osVersion: string | null;
  running: boolean;
  /**
   * The configured panel, or null for a profile not keyed this way. The booted
   * guest reports the same size, the only join between an instance and its
   * `hdc` key.
   */
  display: { width: number; height: number } | null;
}

/** Every value is a string, booleans and numbers included. */
interface RawInstance {
  "name"?: unknown;
  "deviceName"?: unknown;
  "deviceType"?: unknown;
  "isRunning"?: unknown;
  "os.osVersion"?: unknown;
  "hw.lcd.single.width"?: unknown;
  "hw.lcd.single.height"?: unknown;
}

const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

/** Digits only: `parseInt` would read `"1,320"` as 1, and a wrong panel is worse than none. */
const px = (v: unknown): number | null => {
  if (typeof v !== "string" || !/^\d+$/.test(v)) return null;
  const n = Number.parseInt(v, 10);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};

/** Instances from `Emulator -list -details`, the only form reporting `isRunning`. */
export function parseHarmonyInstances(stdout: string): HarmonyInstance[] {
  const text = stdout.trim();
  if (text.length === 0 || text.startsWith(HARMONY_EMPTY_SENTINEL)) return [];
  // A malformed instance prints prose (quoting a path) before the JSON, so
  // start at a line-leading bracket.
  const start = text.search(/^\[/m);
  if (start === -1) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(start));
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const out: HarmonyInstance[] = [];
  for (const entry of raw as RawInstance[]) {
    const name = str(entry?.name) ?? str(entry?.deviceName);
    if (!name) continue;
    const width = px(entry?.["hw.lcd.single.width"]);
    const height = px(entry?.["hw.lcd.single.height"]);
    out.push({
      name,
      deviceType: str(entry?.deviceType),
      osVersion: str(entry?.["os.osVersion"]),
      running: entry?.isRunning === "true",
      display: width && height ? { width, height } : null,
    });
  }
  return out;
}

/** Under `list-devices`' BRANCH_DEADLINE_MS, which must exceed every branch. */
export const HARMONY_LIST_TIMEOUT_MS = 6_000;

/** Emulator instances, or [] when DevEco Studio isn't installed. */
export async function listHarmonyInstances(
  timeoutMs = HARMONY_LIST_TIMEOUT_MS
): Promise<HarmonyInstance[]> {
  if (!(await resolveHarmonyEmulator())) return [];
  const result = await runHarmonyEmulator(["-list", "-details"], timeoutMs);
  if (emulatorFailure(result)) return [];
  return parseHarmonyInstances(result.stdout);
}

interface HarmonyHdcTarget {
  /** A hardware serial or `ip:port`. */
  connectKey: string;
  connection: string | null;
  state: string;
}

/** Under BRANCH_DEADLINE_MS; more than `-list` since it talks to a daemon. */
export const HDC_LIST_TIMEOUT_MS = 8_000;

/**
 * `hdc list targets -v` rows are tab-separated with an empty second column:
 *
 *   025DEK236V035771\t\tUSB\tConnected\tlocalhost
 */
export function parseHdcTargets(stdout: string): HarmonyHdcTarget[] {
  const out: HarmonyHdcTarget[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith(HDC_EMPTY_SENTINEL)) continue;
    if (trimmed.startsWith("[")) continue;
    // Untabbed prose such as `Connect server failed` (exit 0) is not a row.
    if (!trimmed.includes("\t")) continue;
    const cols = trimmed.split(/\s+/);
    out.push({ connectKey: cols[0], connection: cols[1] ?? null, state: cols[2] ?? "Unknown" });
  }
  return out;
}

/** HarmonyOS targets `hdc` lists, or [] when it cannot list them. */
export async function listHarmonyHdcTargets(
  timeoutMs = HDC_LIST_TIMEOUT_MS
): Promise<HarmonyHdcTarget[]> {
  return listTargets(false, timeoutMs);
}

/** Throws instead of answering [] when the table could not be read. */
export async function listHarmonyHdcTargetsStrict(
  timeoutMs = HDC_LIST_TIMEOUT_MS
): Promise<HarmonyHdcTarget[]> {
  return listTargets(true, timeoutMs);
}

async function listTargets(strict: boolean, timeoutMs: number): Promise<HarmonyHdcTarget[]> {
  if (!(await resolveHdc())) return [];
  const result = await runHdc(["list", "targets", "-v"], timeoutMs);
  // Rows outrank any diagnostic printed beside them, as in `parseAdbDevices`.
  const targets = parseHdcTargets(result.stdout);
  if (targets.length > 0) return targets;
  const failure = hdcFailure(result) ?? hdcProse(result);
  if (failure) {
    if (strict) throw new Error(failure);
  }
  return [];
}
