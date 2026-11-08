/**
 * How `list-devices` reaches an agent. The tool-server result stays as it is:
 * the SDK, `argent run`, flows and the preview UI read that JSON, and most
 * `list-devices` calls come from them, not from an MCP client.
 *
 * The agent gets the same object with less text in it:
 * - one device per line, as compact JSON;
 * - no `isEmulator` (it repeats `kind`), no null fields, and no
 *   `runtimeKind: "mobile"` (only `"tv"` changes what the agent does);
 * - an iOS runtime as `iOS 27.0`, not `com.apple.CoreSimulator.SimRuntime.iOS-27-0`;
 * - iOS simulators that are shut down after the object, one short line each.
 *
 * Usually most entries are simulators that are shut down, and agents seldom use them, but they do
 * boot them, so each keeps its udid, name, runtime, state and tags.
 */

const RUNTIME_PREFIX = "com.apple.CoreSimulator.SimRuntime.";

export const STOPPED_SIMULATORS_HEADER =
  "iOS simulators that are shut down, one per line (platform, udid, name, runtime, state, tags); start one with boot-device:";

type Entry = Record<string, unknown>;

function isRecord(value: unknown): value is Entry {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** `com.apple.CoreSimulator.SimRuntime.iOS-27-0` → `iOS 27.0`; any other string unchanged. */
export function shortRuntime(runtime: string): string {
  if (!runtime.startsWith(RUNTIME_PREFIX)) return runtime;
  const rest = runtime.slice(RUNTIME_PREFIX.length);
  const match = /^([A-Za-z]+)-(\d+(?:-\d+)*)$/.exec(rest);
  return match ? `${match[1]} ${match[2]!.replace(/-/g, ".")}` : rest;
}

function cleanEntry(device: Entry): Entry {
  const out: Entry = {};
  for (const [key, value] of Object.entries(device)) {
    if (value === null || value === undefined) continue;
    if (key === "isEmulator") continue;
    if (key === "runtimeKind" && value === "mobile") continue;
    out[key] = key === "runtime" && typeof value === "string" ? shortRuntime(value) : value;
  }
  return out;
}

/**
 * A simulator the header tells the agent to start: a local or remote iOS
 * simulator that is shut down. One that is changing state (`Booting`,
 * `Shutting Down`, `Creating`) keeps its full entry, as do a physical iPhone
 * (`kind: "device"`) and a provider's device (`external`).
 */
function isStoppedSimulator(device: Entry): boolean {
  if (device.platform !== "ios" && device.platform !== "ios-remote") return false;
  if ("kind" in device || "external" in device) return false;
  return typeof device.udid === "string" && device.state === "Shutdown";
}

const ONE_LINE_FIELDS = new Set(["platform", "udid", "name", "runtime", "state"]);

function quoteIfNeeded(value: string): string {
  return value === "" || /[\s"\\]/.test(value) ? JSON.stringify(value) : value;
}

function stoppedSimulatorLine(device: Entry): string {
  const d = cleanEntry(device);
  const name = typeof d.name === "string" ? d.name : "";
  const parts = [String(d.platform), String(d.udid), JSON.stringify(name)];
  // `iOS 27.0` reads as one value without quotes; a name can hold anything, so it is quoted.
  if (typeof d.runtime === "string") parts.push(d.runtime);
  if (typeof d.state === "string") parts.push(quoteIfNeeded(d.state));
  for (const [key, value] of Object.entries(d)) {
    if (ONE_LINE_FIELDS.has(key)) continue;
    if (value === true) parts.push(key);
    else if (typeof value === "string" || typeof value === "number")
      parts.push(`${key}=${quoteIfNeeded(String(value))}`);
    else parts.push(`${key}=${JSON.stringify(value)}`);
  }
  return parts.join(" ");
}

/**
 * The agent's text for a `list-devices` result, or `undefined` for a shape this
 * does not know (an older or newer tool-server), which then goes out as JSON.
 */
export function listDevicesText(result: unknown): string | undefined {
  if (!isRecord(result) || !Array.isArray(result.devices)) return undefined;
  if (!result.devices.every(isRecord)) return undefined;
  const devices = result.devices as Entry[];

  const listed: string[] = [];
  const stopped: string[] = [];
  for (const device of devices) {
    if (isStoppedSimulator(device)) stopped.push(stoppedSimulatorLine(device));
    else listed.push(JSON.stringify(cleanEntry(device)));
  }

  const rest: string[] = [];
  for (const [key, value] of Object.entries(result)) {
    if (key === "devices") continue;
    rest.push(`${JSON.stringify(key)}:${JSON.stringify(value)}`);
  }
  const devicesPart = listed.length > 0 ? `[\n${listed.join(",\n")}\n]` : "[]";
  const object = `{"devices":${devicesPart}${rest.map((r) => `,\n${r}`).join("")}}`;
  if (stopped.length === 0) return object;
  return `${object}\n${STOPPED_SIMULATORS_HEADER}\n${stopped.join("\n")}`;
}
