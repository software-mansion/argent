import { getFailureSignal, FAILURE_CODES, FailureError } from "@argent/registry";
import { runVega, runVegaDevice, resolveVegaBinary } from "./vega-cli";
import { listVvdImages } from "./vega-sdk";
import { listRunningVvdConsolePorts } from "./vega-process";

// `list-devices` is `alwaysLoad`, so these probes must stay short even against a
// wedged VVD (the interactive Vega tools keep their own, longer timeouts). A healthy
// call returns in ~1s; the slack covers a cold-start `vega` launcher on a loaded
// machine, since timing that out mis-reports a running VVD as stopped.
//
// The two don't stack: listVegaDevices skips the `device info` recovery when
// `device list` *timed out*. The recovery path's total (list + two serial `ps`
// probes + info ≈ 20s) must stay under list-devices' BRANCH_DEADLINE_MS (25s) —
// the accounting and the test that guards it live in list-devices.ts.
export const VEGA_DISCOVERY_LIST_TIMEOUT_MS = 6_000;
export const VEGA_DISCOVERY_INFO_TIMEOUT_MS = 4_000;

/**
 * A Vega (Fire TV) device as surfaced to `list-devices`. A VVD is listed whether or
 * not it is running: `state` is `"running"`/`"stopped"` for a VVD, `"device"` for a
 * physical Fire TV.
 *
 * `serial` is the runtime host id (`amazon-…`) an agent passes as `udid` to drive a
 * *running* device; `null` for a stopped VVD. `vvdImage` is the SDK image name to
 * pass to `boot-device` — set for VVDs, `null` for physical.
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
 * `<DeviceType> : … - <serial>`, where the trailing token is the serial we drive
 * via the `vega` CLI.
 *
 * Once something has run `adb connect` against the VVD, the CLI instead lists it in
 * adb form (`emulator-5554 : <idme>` / `127.0.0.1:5555 : <idme>`); those rows are
 * skipped, since argent always drives Vega through the device-type serial.
 * Requiring an alphabetic type rejects them and avoids splitting on the `:` inside
 * `host:port`.
 */
export function parseVegaDeviceList(stdout: string): Array<{ serial: string; type: string }> {
  const devices: Array<{ serial: string; type: string }> = [];
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    const sep = line.indexOf(" : ");
    if (sep < 0) continue;
    const type = line.slice(0, sep).trim();
    // Skips the "Found the following device(s)" banner and the adb-transport rows.
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
 * A running VVD auto-registers on adb as an `emulator-XXXX` transport, so a single
 * VVD otherwise surfaces in `list-devices` twice — as `platform:"android"` and as
 * `platform:"vega"`. Dropping the Android rows whose serial resolved to a VVD leaves
 * it under `platform:"vega"` only; standalone emulators aren't in the set.
 */
export function filterVvdShadowsFromAndroid<T extends { serial: string }>(
  androidDevices: readonly T[],
  vvdAdbSerials: ReadonlySet<string>
): T[] {
  return androidDevices.filter((d) => !vvdAdbSerials.has(d.serial));
}

async function readVegaInfo(): Promise<VegaInfo | null> {
  try {
    // `runVegaDevice` pins `-d emulator-<port>`; without it `device info` returns an
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

/** Discover Vega devices for `list-devices`. Returns [] when the Vega CLI is absent. */
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
    // Listing failed; installed images are still surfaced below. Only a *timeout*
    // means the device agent is wedged, in which case the `device info` recovery would
    // hang too — suppress it in that case only. A transient non-timeout failure does
    // not imply a wedged agent, and skipping recovery there would mis-report a running
    // VVD as stopped.
    listTimedOut = getFailureSignal(err)?.error_kind === "timeout";
  }

  // `vega device list` drops its `VirtualDevice : …` row once a stray
  // `adb connect 127.0.0.1:<port+1>` adds a 2nd adb transport for the VVD (it falls
  // back to adb-form rows that `parseVegaDeviceList` skips). The process table is the
  // authoritative running-VVD signal, so recover the identity via `device info` —
  // otherwise the running VVD is mis-reported as gone, re-listed as a phantom stopped
  // image, and its adb shadow rows surface as bare Android devices. Skipped on a
  // `device list` timeout so a wedged agent doesn't pay for a second hanging call; the
  // `rows.length === 1` branch needs no such guard, as rows stay empty on a timeout.
  let info: VegaInfo | null = null;
  if (!listTimedOut && rows.length === 0 && (await listRunningVvdConsolePorts()).size >= 1) {
    info = await readVegaInfo();
    if (info?.hostname) rows = [{ serial: info.hostname, type: "VirtualDevice" }];
  } else if (rows.length === 1) {
    info = await readVegaInfo();
  }

  // The stopped list is the installed SDK images minus the running one. The link is
  // the image *directory* name, which `info.profile` isn't guaranteed to equal (and
  // `device info` may omit it), so resolve against the installed set and fall back to
  // the sole installed image when there is exactly one.
  //
  // When neither holds the image genuinely can't be confirmed: return `null` rather
  // than a raw, non-installed profile, so a row never advertises a `vvdImage` that
  // `boot-device` cannot start. The running image may then also appear in the stopped
  // list; that is safe because a non-force `boot-device` rejects unless it can
  // positively confirm the running image.
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
 * Budget for resolving the `amazon-` runtime serial of the running VVD — e.g. right
 * after `boot-device` starts it, when it can take a moment to surface in
 * `vega device list`.
 *
 * It gates whether to START another attempt and never cancels an in-flight
 * `listVegaDevices()`, which can itself take ~20s, so the true ceiling is the budget
 * plus one attempt. That is fine off the `list-devices` hot path: a healthy VVD is
 * found in the first attempt or two, so the budget only caps the unhappy path.
 */
const RESOLVE_VVD_SERIAL_BUDGET_MS = 15_000;

export async function resolveRunningVvdSerial(): Promise<string> {
  const deadline = Date.now() + RESOLVE_VVD_SERIAL_BUDGET_MS;
  // Enforced after a miss only: sleep + retry while time remains. The first attempt
  // always runs and none starts past the deadline, so the loop header needs no check.
  for (let attempt = 0; attempt < 5; attempt++) {
    const vvd = (await listVegaDevices()).find(
      (d) => d.kind === "vvd" && d.state === "running" && d.serial
    );
    if (vvd?.serial) return vvd.serial;
    if (Date.now() >= deadline) break;
    await new Promise((r) => setTimeout(r, 1_000));
  }
  throw new FailureError(
    "Vega Virtual Device reported running but did not appear in `vega device list`.",
    {
      error_code: FAILURE_CODES.VEGA_BOOT_TIMEOUT,
      failure_stage: "vega_resolve_running_serial",
      failure_area: "tool_server",
      error_kind: "timeout",
    }
  );
}
