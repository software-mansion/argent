import type { DeviceInfo, Registry, ToolContext } from "@argent/registry";
import { FAILURE_CODES, FailureError } from "@argent/registry";
import { resolveDevice } from "../../utils/device-info";
import { invokeSubTool } from "../../utils/sub-invoke";
import type { FlowStep, WhenPlatform } from "./flow-utils";

/**
 * Device resolution + binding for the flow runner. Flows store no device id
 * (they are portable); the runner resolves one from explicit input, a platform
 * hint, or the single booted device — mirroring the SDK's `device()` binding —
 * and injects it schema-aware into each step's tool args.
 */

// One platform set for the whole flows directory — see LAUNCH_PLATFORMS in
// flow-utils, which this aliases via WhenPlatform.
export type FlowPlatform = WhenPlatform;

const DEVICE_BIND_KEYS = ["udid", "device_id"] as const;

/**
 * Keys that mean a tool acts on a device. A superset of the keys the runner
 * injects: `device` names one without receiving the run's own (a nested flow
 * takes it that way), and a step that drives a device must count as needing one
 * even when the runner does not hand it over.
 */
const DEVICE_ARG_KEYS = [...DEVICE_BIND_KEYS, "device"] as const;

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

/** Strip the device-id keys from a set of args (so a flow stores none). */
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
 */
/**
 * Whether a step acts on a device.
 *
 * Answered per kind rather than by trying and failing, so a flow that touches no
 * device never has to have one. The default is that a step DOES need one: a kind
 * added later inherits today's behaviour instead of silently running against no
 * device, and the `never` binding makes leaving it unclassified a compile error.
 *
 * Two of the classifications are worth stating outright:
 *
 * - `when` needs a device whatever its body contains, because the guard itself
 *   reads one — the device's platform, or its view tree.
 * - `run` needs one without the fragment being read here. The flow it names is
 *   resolved at run time; resolving it a second time would duplicate that lookup
 *   and could disagree with it if the file changed in between. The cost is that
 *   composing a narration-only fragment still resolves a device.
 */
export function stepRequiresDevice(registry: Registry, step: FlowStep): boolean {
  switch (step.kind) {
    case "echo":
    case "wait":
      return false;
    case "tool":
      return toolRequiresDevice(registry, step.name);
    case "when":
    case "run":
    case "launch":
    case "tap":
    case "long-press":
    case "type":
    case "await":
    case "assert":
    case "scroll-to":
    case "pinch":
    case "rotate":
    case "snapshot":
      return true;
    default: {
      const unclassified: never = step;
      void unclassified;
      return true;
    }
  }
}

/** Whether any step in a flow acts on a device. */
export function flowRequiresDevice(registry: Registry, steps: FlowStep[]): boolean {
  return steps.some((step) => stepRequiresDevice(registry, step));
}

function toolRequiresDevice(registry: Registry, toolName: string): boolean {
  const toolDef = registry.getTool(toolName);
  // An unknown tool is assumed to need a device: the step is going to fail
  // either way, and it fails more usefully with one resolved.
  if (!toolDef) return true;
  const props = (toolDef.inputSchema as { properties?: Record<string, unknown> } | undefined)
    ?.properties;
  // A tool with no declared input takes no device.
  if (!props) return false;
  return DEVICE_ARG_KEYS.some((k) => k in props);
}

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
