import {
  HARMONY_EMPTY_SENTINEL,
  emulatorFailure,
  resolveHarmonyEmulator,
  runHarmonyEmulator,
} from "./harmony-cli";
import { HDC_EMPTY_SENTINEL, hdcFailure, hdcProse, resolveHdc, runHdc } from "./harmony-hdc";

/**
 * Discovery for the HarmonyOS platform, from the two sources that know about a
 * HarmonyOS target:
 *
 * - DevEco Studio's `Emulator` manager knows about emulator *instances*,
 *   running or not. An instance is what `boot-device` starts.
 * - `hdc` knows about *connected* targets — a physical phone over USB, and a
 *   running emulator once it has registered. A connect key is what every
 *   interaction tool drives.
 *
 * This is the same split Android has between `avdmanager` and `adb devices`,
 * and it has the same consequence: a running emulator legitimately appears in
 * both, under an instance name in one and a connect key in the other.
 *
 * Readers here treat `[Empty]` as "none" and a recognised diagnostic as a
 * failure, because neither CLI's exit code says either (see `harmony-cli.ts`
 * and `harmony-hdc.ts`).
 */

/** A HarmonyOS emulator instance as reported by `Emulator -list -details`. */
interface HarmonyInstance {
  name: string;
  /** `Phone`, `Foldable`, `Tablet`, `TV`, … as configured at creation. */
  deviceType: string | null;
  /** e.g. `HarmonyOS 6.1.1(24)`. */
  osVersion: string | null;
  running: boolean;
  /**
   * The panel the instance is configured with, or null when its config does not
   * describe one in this shape — a multi-display profile keys its LCDs
   * differently, and nothing here should assume otherwise.
   *
   * Load-bearing beyond metadata: these are the same numbers the booted guest
   * then reports as its `render resolution` (measured 1320x2856 on a HarmonyOS
   * 6.1.1 phone image, matching `hw.lcd.single.width`/`height` exactly), which
   * is the only join there is between an instance and the `hdc` connect key it
   * registers under. `boot-device` uses it to tell its own instance from
   * another device that reconnected beside it.
   */
  display: { width: number; height: number } | null;
}

/**
 * One `Emulator -list -details` record. Every value is a string, including the
 * booleans and the numbers — `isRunning` is `"true"`/`"false"` and
 * `hw.lcd.single.width` is `"1320"`, never a JSON boolean or number, the same
 * quirk `-imageList` has with `downloaded`.
 */
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

/**
 * A positive pixel count from the manager's all-strings JSON, or null.
 *
 * Digits and nothing else: `parseInt` stops at the first character it cannot
 * read, so `"1,320"` and `"1e4"` would both come back as `1`. A wrong panel is
 * worse here than no panel, since `boot-device` reads one no guest can match as
 * proof the target is someone else's device.
 */
const px = (v: unknown): number | null => {
  if (typeof v !== "string" || !/^\d+$/.test(v)) return null;
  const n = Number.parseInt(v, 10);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};

/**
 * Instances from `Emulator -list -details`.
 *
 * `-details` rather than the bare `-list` (one name per line) because it is the
 * strict superset and costs the same — both were measured at ~30ms, since each
 * only reads `~/.Huawei/Emulator/deployed`. It is also the only form that
 * reports `isRunning`, without which every instance would have to be listed
 * with an unknown state.
 *
 * The name is taken from the config's `name` key, not the directory: the manager
 * itself keys off the config, so two directories carrying the same configured
 * name are reported as one instance.
 */
export function parseHarmonyInstances(stdout: string): HarmonyInstance[] {
  const text = stdout.trim();
  if (text.length === 0 || text.startsWith(HARMONY_EMPTY_SENTINEL)) return [];
  // A malformed instance directory makes the manager print `Config file not
  // found: …` *before* the JSON body, so parse from the body's own opening
  // bracket rather than the first byte. Anchored to the start of a line: that
  // prose quotes an instance directory path, so a bracket inside it would
  // otherwise start the slice mid-sentence, and the parse failure that follows
  // reads to `boot-device` as a host with no instances at all.
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

/**
 * Bound for the `-list` call, well under `list-devices`' BRANCH_DEADLINE_MS —
 * that backstop must stay above every branch's worst case, or it truncates a
 * branch that would have completed and drops a real device from the list.
 * `runHarmonyEmulator`'s 30s default is above the deadline, so this call must
 * pass its own. `-list -details` only reads `~/.Huawei/Emulator/deployed`
 * (measured at under 0.1s), making 6s pure headroom for a loaded machine.
 */
export const HARMONY_LIST_TIMEOUT_MS = 6_000;

/**
 * Emulator instances, or [] when DevEco Studio isn't installed.
 *
 * `timeoutMs` is for a caller polling this on a deadline of its own: the
 * default is a ceiling for one call, not a promise about when the call returns
 * to a caller that has less time than that left.
 */
export async function listHarmonyInstances(
  timeoutMs = HARMONY_LIST_TIMEOUT_MS
): Promise<HarmonyInstance[]> {
  if (!(await resolveHarmonyEmulator())) return [];
  const result = await runHarmonyEmulator(["-list", "-details"], timeoutMs);
  if (emulatorFailure(result)) return [];
  return parseHarmonyInstances(result.stdout);
}

/** A target `hdc` is connected to — a physical device, or a running emulator. */
interface HarmonyHdcTarget {
  /** The key every `hdc -t <key>` call takes. A hardware serial, or `ip:port`. */
  connectKey: string;
  /** `USB`, `TCP`, … as reported in column 2. */
  connection: string | null;
  /** `Connected`, `Offline`, … — only a Connected target can be driven. */
  state: string;
}

/**
 * Bound for `hdc list targets`, chosen on the same basis as the instance list
 * above: it must stay under `BRANCH_DEADLINE_MS`. Unlike `-list` this one does
 * talk to a daemon (and starts it if absent), so it gets more room than a
 * directory read while staying far below the deadline.
 */
export const HDC_LIST_TIMEOUT_MS = 8_000;

/**
 * Parse `hdc list targets -v`, whose rows are tab-separated:
 *
 *   025DEK236V035771\t\tUSB\tConnected\tlocalhost
 *
 * Note the empty second column. Splitting on runs of whitespace rather than on
 * single tabs keeps that hole from shifting `connection` and `state` one column
 * left — which would report every attached phone's state as `USB`, a string no
 * readiness check matches, hiding a perfectly healthy device.
 */
export function parseHdcTargets(stdout: string): HarmonyHdcTarget[] {
  const out: HarmonyHdcTarget[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith(HDC_EMPTY_SENTINEL)) continue;
    if (trimmed.startsWith("[")) continue;
    // Prose, not a row. `hdc` prints some diagnostics with no `[Fail]` prefix
    // and still exits 0 — `Connect server failed` is three words, i.e. the
    // shape of a `-v` row, and became a target named `Connect`. The tab is what
    // the two never share, and it is sufficient on its own because `listTargets`
    // is the only caller and always passes `-v`. Tolerating a tab-less line as
    // a bare connect key instead would readmit the same class through any
    // ONE-word diagnostic: a phantom target for the boot's arrival wait to
    // adopt, and — since a parsed row means "a listing was printed" — the
    // diagnostic swallowed rather than reported.
    if (!trimmed.includes("\t")) continue;
    const cols = trimmed.split(/\s+/);
    out.push({ connectKey: cols[0], connection: cols[1] ?? null, state: cols[2] ?? "Unknown" });
  }
  return out;
}

/**
 * HarmonyOS targets `hdc` lists, or [] when `hdc` isn't installed or could not
 * produce a listing.
 *
 * Callers that cannot read "no devices" and "no answer" as the same thing want
 * {@link listHarmonyHdcTargetsStrict}.
 */
export async function listHarmonyHdcTargets(
  timeoutMs = HDC_LIST_TIMEOUT_MS
): Promise<HarmonyHdcTarget[]> {
  return listTargets(false, timeoutMs);
}

/**
 * The same listing, refusing rather than answering `[]` when `hdc` could not
 * produce one.
 *
 * `hdc` exits 0 whatever happens, so what it printed is the only thing
 * separating "nothing is connected" from "the device table could not be read".
 * A caller polling for a change can treat those alike; one establishing a
 * BASELINE to compare against cannot, since an empty baseline quietly means
 * "everything that shows up next is new".
 */
export async function listHarmonyHdcTargetsStrict(
  timeoutMs = HDC_LIST_TIMEOUT_MS
): Promise<HarmonyHdcTarget[]> {
  return listTargets(true, timeoutMs);
}

async function listTargets(strict: boolean, timeoutMs: number): Promise<HarmonyHdcTarget[]> {
  if (!(await resolveHdc())) return [];
  // `-v` is what makes every row tab-separated, which is the delimiter
  // {@link parseHdcTargets} tells a row from a diagnostic by.
  const result = await runHdc(["list", "targets", "-v"], timeoutMs);
  // A parsed row means a listing really was printed, so nothing said beside it
  // voids it — `parseAdbDevices` holds the same line. Asked BEFORE either
  // classifier rather than only before `hdcProse`: `hdcFailure` has no such
  // guard of its own, so a `[Fail]` line arriving next to real rows would empty
  // the listing for a polling caller and refuse the boot for a strict one.
  const targets = parseHdcTargets(result.stdout);
  if (targets.length > 0) return targets;
  const failure = hdcFailure(result) ?? hdcProse(result);
  if (failure) {
    if (strict) throw new Error(failure);
  }
  return [];
}
