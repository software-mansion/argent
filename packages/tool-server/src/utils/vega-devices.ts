import { getFailureSignal } from "@argent/registry";
import { runVega, runVegaDevice, resolveVegaBinary } from "./vega-cli";
import { listVvdImages } from "./vega-sdk";
import { listRunningVvdConsolePorts } from "./vega-process";

// `list-devices` is `alwaysLoad` and runs at session start, so its Vega probe
// must stay snappy even when a VVD is wedged. A healthy `vega device list` /
// `device info` returns in ~1s; cap them tightly here (the interactive Vega
// tools keep their own, longer timeouts). The values give a generous multiple of
// the healthy time so a cold-start `vega` launcher (its python/node worker tree
// has import cost on first use) on a loaded machine isn't spuriously timed out —
// which would mis-report a genuinely-running VVD as stopped.
//
// Crucially the two device timeouts no longer *stack* into a 40s block against a
// wedged agent: the `device info` recovery is skipped when `device list` *timed
// out* (see listVegaDevices), so an unresponsive device costs one short call (~6s),
// not two. A *non-timeout* list failure (or a clean-but-empty list) still runs the
// recovery, whose full cost is `device list` + two serial `ps` probes + `device
// info` ≈ 20s worst case; that stays under list-devices' BRANCH_DEADLINE_MS (25s)
// so even the slow recovery path finishes inside the fan-out's backstop rather than
// being truncated — which would drop a real VVD from the list. The full accounting
// (and the invariant test that guards it) lives in list-devices.ts; keep the sum
// under the deadline with margin if any of these timeouts change.
export const VEGA_DISCOVERY_LIST_TIMEOUT_MS = 6_000;
export const VEGA_DISCOVERY_INFO_TIMEOUT_MS = 4_000;

/**
 * A Vega (Fire TV) device as surfaced to `list-devices`. A VVD is listed whether
 * or not it is running (like a Shutdown iOS simulator): `state` is `"running"` or
 * `"stopped"` for a VVD, `"device"` for a physical Fire TV.
 *
 * `serial` is the runtime host id (`amazon-…`, from `vega device list` / `info`)
 * an agent passes as `udid` to drive a *running* device; it is `null` for a
 * stopped VVD (none is connected to query). `vvdImage` is the SDK image name to
 * pass to `boot-device {vvdImage}` to start it — set for VVDs, `null` for physical.
 */
export interface VegaDevice {
  platform: "vega";
  serial: string | null;
  vvdImage: string | null;
  kind: "vvd" | "device";
  state: string;
  product: string | null;
  profile: string | null;
  buildDescription: string | null;
  simulated: boolean;
}

interface VegaInfo {
  idme?: string;
  os?: string;
  hostname?: string;
  architecture?: string;
  profile?: string;
  product?: string;
  buildDescription?: string;
  simulated?: boolean;
  inDeveloperMode?: boolean;
}

/**
 * Parse `vega device list`. A device row is:
 *
 *   VirtualDevice : tv - aarch64 - OS - amazon-4a27df03c9777152
 *
 * `<DeviceType> : … - <serial>` — the leading token is an alphabetic device type
 * (VirtualDevice, FireTV, …) and the trailing ` - `-separated token is the
 * serial we drive via the `vega` CLI.
 *
 * NOTE: if something has run `adb connect` against the VVD's adb transport, the
 * CLI instead lists it in adb form (`emulator-5554 : <idme>` /
 * `127.0.0.1:5555 : <idme>`). Those rows are deliberately skipped — argent
 * always drives Vega through the device-type serial, and adb is only used
 * out-of-band for host-side screen capture. Requiring an alphabetic type both
 * rejects those rows and avoids splitting on the `:` inside `host:port`.
 */
export function parseVegaDeviceList(stdout: string): Array<{ serial: string; type: string }> {
  const devices: Array<{ serial: string; type: string }> = [];
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    const sep = line.indexOf(" : ");
    if (sep < 0) continue;
    const type = line.slice(0, sep).trim();
    // Accept only an alphabetic CamelCase device type; skips the "Found the
    // following device(s)" banner and adb-transport rows (emulator-NNNN,
    // host:port) that appear when adb is explicitly connected to the VVD.
    if (!/^[A-Za-z]+$/.test(type)) continue;
    const rhs = line.slice(sep + 3).trim();
    const parts = rhs.split(/\s+-\s+/);
    const serial = parts[parts.length - 1]?.trim();
    if (!serial) continue;
    devices.push({ serial, type });
  }
  return devices;
}

/**
 * A running VVD auto-registers on adb as an `emulator-XXXX` transport, so a
 * single VVD otherwise surfaces in `list-devices` twice — once as
 * `platform:"android"` and once as `platform:"vega"`. Drop the Android rows
 * whose adb serial was resolved to a VVD (`vvdAdbSerials`) so the VVD shows up
 * only under `platform:"vega"`. Genuine standalone Android emulators are not in
 * the set and pass through untouched.
 */
export function filterVvdShadowsFromAndroid<T extends { serial: string }>(
  androidDevices: readonly T[],
  vvdAdbSerials: ReadonlySet<string>
): T[] {
  return androidDevices.filter((d) => !vvdAdbSerials.has(d.serial));
}

async function readVegaInfo(): Promise<VegaInfo | null> {
  try {
    // `runVegaDevice` pins `-d emulator-<port>`; without it, `device info` returns an
    // empty `{idme:"", os:"unknown", …}` device when the VVD has a 2nd adb transport.
    const { stdout } = await runVegaDevice(["info"], { timeoutMs: VEGA_DISCOVERY_INFO_TIMEOUT_MS });
    return JSON.parse(stdout) as VegaInfo;
  } catch {
    return null;
  }
}

function classifyKind(type: string, info: VegaInfo | null): "vvd" | "device" {
  if (/virtual/i.test(type)) return "vvd";
  if (info?.simulated === true) return "vvd";
  if (info?.product && info.product.startsWith("vvrp")) return "vvd";
  return "device";
}

/**
 * Discover Vega devices for `list-devices`. Returns [] when the Vega SDK isn't on
 * PATH.
 */
export async function listVegaDevices(): Promise<VegaDevice[]> {
  if (!(await resolveVegaBinary())) return [];

  // Connected/running devices (these carry the `amazon-` runtime serial).
  let rows: Array<{ serial: string; type: string }> = [];
  let listTimedOut = false;
  try {
    const { stdout } = await runVega(["device", "list"], {
      timeoutMs: VEGA_DISCOVERY_LIST_TIMEOUT_MS,
    });
    rows = parseVegaDeviceList(stdout);
  } catch (err) {
    // CLI listing failed or timed out; still surface installed images below. Only a
    // *timeout* means the device agent is wedged — and a wedged agent makes the
    // `device info` recovery hang too, so the two stack into the ~40s `list-devices`
    // stall this fix targets. Suppress recovery in *that* case only. A fast,
    // non-timeout failure (a transient CLI error) does NOT imply an unresponsive
    // agent, so we still let recovery run below — otherwise a genuinely-running VVD
    // would be mis-reported as stopped. (runVega now reaps its whole process group on
    // timeout, so the suppressed second call would no longer *leak* either.)
    listTimedOut = getFailureSignal(err)?.error_kind === "timeout";
  }

  // `vega device list` drops its `VirtualDevice : …` row once a stray
  // `adb connect 127.0.0.1:<port+1>` adds a 2nd adb transport for the VVD (it falls
  // back to adb-form rows that `parseVegaDeviceList` skips). The process table is the
  // authoritative running-VVD signal, so when the parse is empty but a VVD is running,
  // recover its identity via `device info` (now pinned to the VVD by -d emulator-<port>)
  // — otherwise the running VVD is mis-reported as gone and re-listed as a phantom
  // stopped image, and its adb shadow rows surface as bare Android devices. Skip the
  // recovery only when `device list` *timed out* so a wedged agent doesn't pay for a
  // second hanging call (the `rows.length === 1` branch is unreachable on a timeout,
  // since rows stay empty, so it needs no guard).
  let info: VegaInfo | null = null;
  if (!listTimedOut && rows.length === 0 && (await listRunningVvdConsolePorts()).size >= 1) {
    info = await readVegaInfo();
    if (info?.hostname) rows = [{ serial: info.hostname, type: "VirtualDevice" }];
  } else if (rows.length === 1) {
    info = await readVegaInfo();
  }

  // The stopped list is the installed SDK images; the running VVD is one of them
  // and should be excluded so it doesn't appear twice. The link is the image
  // *directory* name, but `info.profile` isn't guaranteed to equal it (and
  // `device info` may omit `profile` entirely). Resolve the running VVD's image
  // name against the installed set, falling back to the sole installed image when
  // there's exactly one.
  //
  // When neither holds (an unrecognized profile with 2+ installed images, or 2+
  // running VVDs where `info` is null) the image genuinely can't be confirmed:
  // return `null` rather than a raw, non-installed profile, so the running row
  // never advertises a `vvdImage` that `boot-device` cannot start. We have no
  // reliable running-VVD→image identity in that case — the `ps` probe yields the
  // console port, not the image name — so the running image may still also appear
  // in the stopped list. That residual is no longer dangerous: a non-force
  // `boot-device` rejects unless it can positively confirm the running image.
  const installedImages = await listVvdImages();
  const installedNames = new Set(installedImages.map((i) => i.name));
  const resolveVvdImageName = (profile: string | null): string | null => {
    if (profile && installedNames.has(profile)) return profile;
    if (installedImages.length === 1) return installedImages[0]!.name;
    return null;
  };

  const connected: VegaDevice[] = rows.map((row): VegaDevice => {
    const kind = classifyKind(row.type, info);
    return {
      platform: "vega",
      serial: row.serial,
      vvdImage: kind === "vvd" ? resolveVvdImageName(info?.profile ?? null) : null,
      kind,
      state: kind === "vvd" ? "running" : "device",
      product: info?.product ?? null,
      profile: info?.profile ?? null,
      buildDescription: info?.buildDescription ?? null,
      simulated: info?.simulated ?? kind === "vvd",
    };
  });

  const connectedImages = new Set(
    connected.filter((d) => d.kind === "vvd" && d.vvdImage).map((d) => d.vvdImage)
  );
  const stopped: VegaDevice[] = installedImages
    .filter((img) => !connectedImages.has(img.name))
    .map(
      (img): VegaDevice => ({
        platform: "vega",
        serial: null,
        vvdImage: img.name,
        kind: "vvd",
        state: "stopped",
        product: null,
        profile: img.name,
        buildDescription: null,
        simulated: true,
      })
    );

  return [...connected, ...stopped];
}

/**
 * Resolve the `amazon-` runtime serial of the currently-running VVD — e.g. right
 * after `boot-device` starts it. A freshly-started VVD can take a moment to
 * surface in `vega device list`, so retry a few times before giving up.
 *
 * Bounded by an overall wall-clock budget on top of the retry count. The budget
 * gates whether to START another attempt — it is checked *between* attempts, not
 * as cancellation, and `listVegaDevices()` is never interrupted mid-flight. So the
 * true upper bound is the budget plus one in-flight attempt's worst case: a single
 * `listVegaDevices()` can take up to ~20s against a non-timeout-failing-but-running
 * VVD (see its discovery-timeout accounting), so an attempt that starts just under
 * the deadline pushes total wall time to ~budget + 20s. That looser bound is fine
 * here: unlike `list-devices`, this runs post-`boot-device` (not on the alwaysLoad
 * hot path), and a healthy VVD surfaces in the first attempt or two (a fast list +
 * 1s backoff), so the budget only bites the unhappy path — it just caps the number
 * of *additional* attempts rather than acting as a precise wall-clock ceiling.
 */
const RESOLVE_VVD_SERIAL_BUDGET_MS = 15_000;

export async function resolveRunningVvdSerial(): Promise<string> {
  const deadline = Date.now() + RESOLVE_VVD_SERIAL_BUDGET_MS;
  // The budget is enforced at the one place it matters: after a miss, only sleep +
  // retry if there's still time left. The first attempt always runs (deadline is set
  // 15s out), and we never start an attempt past the deadline because we break here
  // first — so no separate deadline check is needed in the loop header.
  for (let attempt = 0; attempt < 5; attempt++) {
    const vvd = (await listVegaDevices()).find(
      (d) => d.kind === "vvd" && d.state === "running" && d.serial
    );
    if (vvd?.serial) return vvd.serial;
    if (Date.now() >= deadline) break;
    await new Promise((r) => setTimeout(r, 1_000));
  }
  throw new Error("Vega Virtual Device reported running but did not appear in `vega device list`.");
}
