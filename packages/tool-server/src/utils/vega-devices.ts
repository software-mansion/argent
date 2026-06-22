import { runVega, runVegaDevice, resolveVegaBinary } from "./vega-cli";
import { listVvdImages } from "./vega-sdk";
import { listRunningVvdConsolePorts } from "./vega-process";

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
    const { stdout } = await runVegaDevice(["info"], { timeoutMs: 20_000 });
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
  let rows: Array<{ serial: string; type: string }>;
  try {
    const { stdout } = await runVega(["device", "list"], { timeoutMs: 20_000 });
    rows = parseVegaDeviceList(stdout);
  } catch {
    rows = []; // CLI listing failed; still surface installed images below
  }

  // `vega device list` drops its `VirtualDevice : …` row once a stray
  // `adb connect 127.0.0.1:<port+1>` adds a 2nd adb transport for the VVD (it falls
  // back to adb-form rows that `parseVegaDeviceList` skips). The process table is the
  // authoritative running-VVD signal, so when the parse is empty but a VVD is running,
  // recover its identity via `device info` (now pinned to the VVD by -d emulator-<port>)
  // — otherwise the running VVD is mis-reported as gone and re-listed as a phantom
  // stopped image, and its adb shadow rows surface as bare Android devices.
  let info: VegaInfo | null = null;
  if (rows.length === 0 && (await listRunningVvdConsolePorts()).size >= 1) {
    info = await readVegaInfo();
    if (info?.hostname) rows = [{ serial: info.hostname, type: "VirtualDevice" }];
  } else if (rows.length === 1) {
    info = await readVegaInfo();
  }

  // The stopped list is the installed SDK images; the running VVD is one of them
  // and must be excluded so it doesn't appear twice. The link is the image
  // *directory* name, but `info.profile` isn't guaranteed to equal it (and
  // `device info` may omit `profile` entirely). Resolve the running VVD's image
  // name against the installed set, falling back to the sole installed image
  // when there's exactly one — enough to dedup the common single-VVD case
  // instead of re-emitting the running device as a phantom `stopped` row.
  const installedImages = await listVvdImages();
  const installedNames = new Set(installedImages.map((i) => i.name));
  const resolveVvdImageName = (profile: string | null): string | null => {
    if (profile && installedNames.has(profile)) return profile;
    if (installedImages.length === 1) return installedImages[0]!.name;
    return profile;
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
 */
export async function resolveRunningVvdSerial(): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const vvd = (await listVegaDevices()).find(
      (d) => d.kind === "vvd" && d.state === "running" && d.serial
    );
    if (vvd?.serial) return vvd.serial;
    await new Promise((r) => setTimeout(r, 1_000));
  }
  throw new Error("Vega Virtual Device reported running but did not appear in `vega device list`.");
}
