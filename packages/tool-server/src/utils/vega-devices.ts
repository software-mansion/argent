import { runVega, resolveVegaBinary } from "./vega-cli";
import { registerVegaDevices } from "./device-info";

/**
 * A Vega (Fire TV) device as surfaced to `list-devices`. The `serial` is the
 * stable host identifier reported by `vega device list` / `info.hostname`
 * (e.g. `amazon-4a27df03c9777152`) and is what an agent passes as `udid` to
 * Vega tools. `kind` is `"virtual"` for the QEMU Virtual Device (the iOS-
 * simulator / Android-emulator analogue) and `"device"` for physical Fire TV.
 */
export interface VegaDevice {
  platform: "vega";
  serial: string;
  kind: "virtual" | "device";
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
 * Parse `vega device list`. The listing prints a human banner then one line per
 * device of the shape:
 *
 *   VirtualDevice : tv - aarch64 - OS - amazon-4a27df03c9777152
 *
 * The trailing ` - `-separated token is the serial; the leading `<type> :` tells
 * virtual vs physical. We parse defensively (the banner wording is not API) and
 * keep only lines that actually carry a serial.
 */
export function parseVegaDeviceList(stdout: string): Array<{ serial: string; type: string }> {
  const devices: Array<{ serial: string; type: string }> = [];
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const type = line.slice(0, colon).trim();
    // A device row's left-of-colon is a CamelCase device type (VirtualDevice,
    // FireTV, …) with no spaces; banner lines ("Found the following device")
    // contain spaces and are skipped.
    if (!type || /\s/.test(type)) continue;
    const rhs = line.slice(colon + 1).trim();
    const parts = rhs.split(/\s+-\s+/);
    const serial = parts[parts.length - 1]?.trim();
    if (!serial) continue;
    devices.push({ serial, type });
  }
  return devices;
}

async function readVegaInfo(): Promise<VegaInfo | null> {
  try {
    const { stdout } = await runVega(["device", "info"], { timeoutMs: 20_000 });
    return JSON.parse(stdout) as VegaInfo;
  } catch {
    return null;
  }
}

async function isVirtualDeviceRunning(): Promise<boolean> {
  try {
    const { stdout } = await runVega(["virtual-device", "status"], { timeoutMs: 15_000 });
    const parsed = JSON.parse(stdout) as { running?: boolean };
    return parsed.running === true;
  } catch {
    return false;
  }
}

function classifyKind(type: string, info: VegaInfo | null): "virtual" | "device" {
  if (/virtual/i.test(type)) return "virtual";
  if (info?.simulated === true) return "virtual";
  if (info?.product && info.product.startsWith("vvrp")) return "virtual";
  return "device";
}

/**
 * Discover Vega devices via the `vega`/`kepler` CLI and register them in the
 * device-classification inventory so `resolveDevice` maps their serials to the
 * `vega` platform. Returns [] (and registers nothing) when the Vega SDK is not
 * installed, so callers can merge unconditionally.
 *
 * v1 enriches via `vega device info` (no `-d`), which targets the single
 * connected device — so enrichment is only attached when exactly one device is
 * present. Bare entries (serial only) are still returned and registered.
 */
export async function listVegaDevices(): Promise<VegaDevice[]> {
  if (!(await resolveVegaBinary())) return [];

  let listOut: string;
  try {
    ({ stdout: listOut } = await runVega(["device", "list"], { timeoutMs: 20_000 }));
  } catch {
    return [];
  }

  const rows = parseVegaDeviceList(listOut);
  if (rows.length === 0) {
    registerVegaDevices([]);
    return [];
  }

  const info = rows.length === 1 ? await readVegaInfo() : null;
  const virtualRunning = await isVirtualDeviceRunning();

  const devices: VegaDevice[] = rows.map((row) => {
    const kind = classifyKind(row.type, info);
    const state = kind === "virtual" ? (virtualRunning ? "running" : "stopped") : "device";
    return {
      platform: "vega",
      serial: row.serial,
      kind,
      state,
      product: info?.product ?? null,
      profile: info?.profile ?? null,
      buildDescription: info?.buildDescription ?? null,
      simulated: info?.simulated ?? kind === "virtual",
    };
  });

  registerVegaDevices(
    devices.map((d) => ({
      id: d.serial,
      kind: d.kind,
      name: d.product ?? undefined,
      state: d.state,
    }))
  );

  return devices;
}

const VEGA_POLL_INTERVAL_MS = 15_000;

/**
 * Keep the Vega device inventory warm so `resolveDevice` classifies Vega serials
 * correctly even when a tool is called before `list-devices`. Mirrors
 * `startSimulatorWatcher`: a periodic, best-effort poll. `listVegaDevices`
 * returns early (no shell-out) when the Vega SDK isn't installed, so this is
 * effectively free on non-Vega hosts. The first poll is fire-and-forget so
 * server startup never blocks on the Vega CLI.
 */
export function startVegaWatcher(): { stop: () => void } {
  void listVegaDevices().catch(() => {});
  const interval = setInterval(() => {
    void listVegaDevices().catch(() => {});
  }, VEGA_POLL_INTERVAL_MS);
  // Don't keep the event loop alive solely for this poll.
  interval.unref?.();
  return { stop: () => clearInterval(interval) };
}
