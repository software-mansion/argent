import type { DeviceInfo, Registry, ToolContext } from "@argent/registry";
import { FAILURE_CODES, FailureError } from "@argent/registry";
import { resolveDevice } from "../../utils/device-info";
import { invokeSubTool } from "../../utils/sub-invoke";
import type { WhenPlatform } from "./flow-utils";

/**
 * Device resolution + binding for the flow runner. Flows store no device id
 * (they are portable); the runner resolves one from explicit input, a platform
 * hint, or the single booted device — mirroring the SDK's `device()` binding —
 * and injects it schema-aware into each step's tool args.
 */

// One platform set for the whole flows directory — see LAUNCH_PLATFORMS in
// flow-utils, which this aliases via WhenPlatform.
export type FlowPlatform = WhenPlatform;

/**
 * Arg names that mean "the device to act on".
 *
 * The runner strips these from every recorded step and re-injects the resolved
 * run device, so a name here must mean a device id on EVERY tool that declares
 * one — the strip is schema-blind. `udid` covers most tools, `device_id` the
 * debugger and profiler families, and `device` is `flow-execute`'s own, so a
 * nested flow inherits the run device instead of pinning the one it was
 * recorded on (#607).
 *
 * `platform` is deliberately absent, for two independent reasons. It is only
 * ever read when no device was given — `resolveFlowDevice` returns on
 * `opts.device` before touching it, and the chromium boot spec is gated on
 * `!params.device` — so once `device` is bound it is inert. And it is not
 * device-specific on every tool: `react-profiler-analyze` declares its own
 * `platform`, which a blind strip would silently retarget.
 */
const DEVICE_BIND_KEYS = ["udid", "device_id", "device"] as const;

interface RawDevice {
  platform: FlowPlatform;
  state?: string;
  udid?: string;
  serial?: string;
  id?: string;
}

function deviceEntryId(d: RawDevice): string | undefined {
  if (d.platform === "ios") return d.udid;
  if (d.platform === "chromium") return d.id;
  return d.serial; // android, vega
}

function isBooted(d: RawDevice): boolean {
  switch (d.platform) {
    case "ios":
      return d.state === "Booted";
    case "android":
      return d.state === "device";
    case "vega":
      return d.state === "running" || d.state === "device";
    case "chromium":
      return true; // a discovered chromium device is, by definition, reachable
    default:
      return false;
  }
}

function describeDevice(d: RawDevice): string {
  return `${deviceEntryId(d) ?? "?"} (${d.platform}${d.state ? `, ${d.state}` : ""})`;
}

function deviceResolutionError(message: string, all: RawDevice[]): FailureError {
  const list = all.length ? all.map(describeDevice).join(", ") : "none";
  return new FailureError(`${message} Available devices: ${list}.`, {
    error_code: FAILURE_CODES.FLOW_DEVICE_RESOLUTION,
    failure_stage: "flow_device_resolution",
    failure_area: "tool_server",
    error_kind: "validation",
  });
}

/**
 * Resolve the device a flow runs against. Order: explicit `device` id → the
 * single booted device of `platform` → the single booted device overall →
 * throw, enumerating what is available.
 */
export async function resolveFlowDevice(
  registry: Registry,
  ctx: ToolContext | undefined,
  opts: { device?: string; platform?: FlowPlatform }
): Promise<DeviceInfo> {
  if (opts.device) return resolveDevice(opts.device);

  const { devices } = (await invokeSubTool(registry, ctx, "list-devices", {})) as {
    devices: RawDevice[];
  };
  const booted = devices.filter(isBooted);
  const scoped = opts.platform ? booted.filter((d) => d.platform === opts.platform) : booted;

  if (scoped.length === 1) {
    const id = deviceEntryId(scoped[0]);
    if (id) return resolveDevice(id);
  }
  if (scoped.length === 0) {
    const what = opts.platform
      ? `No booted ${opts.platform} device found.`
      : "No booted device found.";
    throw deviceResolutionError(`${what} Pass a device id or platform explicitly.`, devices);
  }
  throw deviceResolutionError(
    `${scoped.length} booted devices matched — pass --device or --platform to disambiguate.`,
    scoped
  );
}

/**
 * Strip the device-id keys from a set of args (so a flow stores none).
 *
 * Schema-blind on purpose: `bindDeviceArgs` strips unconditionally and re-injects
 * only what the target tool declares, so a stale id is never forwarded to a tool
 * that does not want it.
 */
export function stripDeviceKeys(args: Record<string, unknown>): Record<string, unknown> {
  const out = { ...args };
  for (const k of DEVICE_BIND_KEYS) delete out[k];
  return out;
}

/**
 * Bind the resolved device id into a tool's args. The runner is **authoritative**
 * on device: any device id stored in the step is dropped and replaced with the
 * resolved one — so a flow recorded on one device stays portable to another and
 * a stale baked-in udid can't override the run target. The id is injected only
 * for the device-id keys the tool's input schema declares (so `.strict()`
 * schemas stay valid).
 *
 * This covers a nested `tool: flow-execute` step too — its own `device` arg is
 * rebound, so a composed run inherits the run device rather than driving the one
 * it was recorded against, matching how `run:` composition already behaves.
 */
export function bindDeviceArgs(
  registry: Registry,
  toolName: string,
  deviceId: string,
  args: Record<string, unknown>
): Record<string, unknown> {
  const toolDef = registry.getTool(toolName);
  const props = (toolDef?.inputSchema as { properties?: Record<string, unknown> } | undefined)
    ?.properties;
  const out = stripDeviceKeys(args);
  if (props) {
    for (const k of DEVICE_BIND_KEYS) if (k in props) out[k] = deviceId;
  }
  return out;
}
