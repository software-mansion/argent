import type { DeviceInfo, Registry, ToolContext } from "@argent/registry";
import { FAILURE_CODES, FailureError } from "@argent/registry";
import { resolveDevice } from "../../utils/device-info";
import { invokeSubTool } from "../../utils/sub-invoke";
import { blockSteps, type FlowStep, type WhenPlatform } from "./flow-utils";

// The flows directory's one platform set — LAUNCH_PLATFORMS in flow-utils,
// reached through WhenPlatform.
export type FlowPlatform = WhenPlatform;

/**
 * Arg names that mean "the device to act on". Stripped from every recorded step
 * and re-injected with the resolved run device, so a name here must mean a
 * device id on EVERY tool that declares one — the strip is schema-blind.
 * `device` is `flow-execute`'s own, so a nested flow inherits the run device
 * instead of pinning the one it was recorded on (#607).
 *
 * `platform` is deliberately absent: it is not device-specific on every tool
 * (`react-profiler-analyze` declares its own, which a blind strip would
 * retarget), and it is read only when no device was given, so binding it would
 * change nothing.
 */
const DEVICE_BIND_KEYS = ["udid", "device_id", "device"] as const;

/**
 * Args keys holding a LIST of device ids. Same treatment as
 * {@link DEVICE_BIND_KEYS}, but rebound to `[deviceId]`, since a run resolves
 * exactly one device and a flow that named several would be naming the
 * recording host's.
 *
 * `stop-all-simulator-servers`' `devices` is the only such key, and it is a
 * scope rather than a target: a recording of the UNSCOPED sweep rebinds to the
 * run device (binding can only narrow, and the replay must not reap devices
 * another agent is mid-session on), while a recorded scope is the flow's own
 * statement of what to reap and is overridden only by an explicit `device` —
 * see {@link bindDeviceArgs}, where the two cases part.
 */
const DEVICE_BIND_LIST_KEYS = ["devices"] as const;

/**
 * Keys that mean a tool needs a device to act on at all — the TARGET keys, and
 * deliberately not the scope keys in {@link DEVICE_BIND_LIST_KEYS}. What
 * separates them is what a missing device does to the step: a `screenshot` with
 * no `udid` cannot run, while `stop-all-simulator-servers` with no `devices` is
 * the machine-wide sweep — a complete call, and the whole content of a cleanup
 * flow. Listing `devices` here made such a flow demand a device it has no use
 * for, failing it in the two situations it actually runs in: none booted, or
 * several.
 *
 * A scope key is therefore bound OPPORTUNISTICALLY by {@link bindDeviceArgs} —
 * only when the run resolved a device, never as `{ devices: [""] }`, a teardown
 * scoped to an id that owns nothing and so reaps nothing while reporting pass.
 */
const DEVICE_ARG_KEYS = DEVICE_BIND_KEYS;

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
 * Strip the device-TARGET keys from a set of args, so a recorded flow stores no
 * device to point at. Schema-blind on purpose: {@link bindDeviceArgs} re-injects
 * only what the target tool declares, so a stale id is never forwarded to a tool
 * that does not want it.
 *
 * A SCOPE survives into the YAML because dropping it changes what the recorded
 * step MEANS: a correctly scoped teardown would record as a bare
 * `- tool: stop-all-simulator-servers`, and hand-running that reaps every device
 * on the machine. Losing `devices` fails OPEN, where a `screenshot` that lost its
 * required `udid` fails loudly. Replay rebinds it either way, and recorded ids
 * cost only a no-op plus an `unmatched` report on another host.
 */
export function stripDeviceKeys(args: Record<string, unknown>): Record<string, unknown> {
  const out = { ...args };
  for (const k of DEVICE_BIND_KEYS) delete out[k];
  return out;
}

/**
 * Whether a step acts on a device.
 *
 * Answered per kind rather than by trying and failing, so a flow that touches no
 * device never has to have one. Unclassified defaults to needing one, and the
 * `never` binding makes leaving a new kind unclassified a compile error.
 *
 * Three of the classifications are worth stating outright:
 *
 * - `when` needs a device whatever its body contains, because the guard itself
 *   reads one — the device's platform, or its view tree. That classifies the
 *   header alone; the body is left to {@link flowRequiresDevice}'s walk.
 * - `idle` needs one despite carrying no selector: it reads the device twice
 *   over, the UI tree and a screenshot of it.
 * - `run` needs one without the fragment being read here: it is resolved at run
 *   time, so composing a narration-only fragment still resolves a device.
 */
export function stepRequiresDevice(registry: Registry, step: FlowStep): boolean {
  switch (step.kind) {
    case "echo":
    case "wait":
      return false;
    case "tool":
      return toolRequiresDevice(registry, step.name);
    // One answer per step kind: a block directive needs a device without
    // recursing into its body. `when` because its guard reads the tree, and
    // `repeat` by the same blanket answer — which costs a `times` block over
    // pure `wait:`/`echo:` steps a device it never acts on. Accepted knowingly
    // and pinned by a test.
    case "when":
    case "repeat":
    case "run":
    case "launch":
    case "tap":
    case "long-press":
    case "type":
    case "await":
    case "assert":
    case "idle":
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

/**
 * Whether any step in a flow acts on a device - each block header's own
 * classification OR, via {@link blockSteps}, the steps it actually CONTAINS.
 *
 * The child walk answers nothing today: every block kind classifies
 * device-requiring in {@link stepRequiresDevice}. It is what makes a future
 * block kind safe to classify `false` — a flow that is only such a block would
 * otherwise resolve device-free and hard-stop on the first device step in its
 * body.
 */
export function flowRequiresDevice(registry: Registry, steps: FlowStep[]): boolean {
  return steps.some(
    (step) =>
      stepRequiresDevice(registry, step) || flowRequiresDevice(registry, blockSteps(step) ?? [])
  );
}

/**
 * Whether any step would NARROW itself to the run device if one were resolved,
 * without needing one to run — a `devices` scope, and only that today.
 *
 * Asked of a flow that {@link flowRequiresDevice} said no to, so the run has a
 * choice: resolve a device opportunistically and scope the teardown to it, or,
 * where no single device is resolvable, run the step's unscoped meaning rather
 * than failing a flow whose whole purpose is to clear the machine.
 *
 * The walk into a block's body is dead today for the same reason as
 * {@link flowRequiresDevice}'s, and guards the same future block kind: a
 * `devices` scope inside one would be invisible here, so the run would resolve
 * no device and the teardown would sweep the machine.
 */
export function flowScopesDevice(registry: Registry, steps: FlowStep[]): boolean {
  return steps.some(
    (step) =>
      (step.kind === "tool" && declaresAny(registry, step.name, DEVICE_BIND_LIST_KEYS)) ||
      flowScopesDevice(registry, blockSteps(step) ?? [])
  );
}

function toolRequiresDevice(registry: Registry, toolName: string): boolean {
  // An unknown tool is assumed to need a device: the step fails either way, and
  // it fails more usefully with one resolved.
  if (!registry.getTool(toolName)) return true;
  return declaresAny(registry, toolName, DEVICE_ARG_KEYS);
}

function declaresAny(registry: Registry, toolName: string, keys: readonly string[]): boolean {
  const toolDef = registry.getTool(toolName);
  const props = (toolDef?.inputSchema as { properties?: Record<string, unknown> } | undefined)
    ?.properties;
  if (!props) return false;
  return keys.some((k) => k in props);
}

/**
 * Bind the resolved device id into a tool's args. The runner is authoritative on
 * the device to act ON: any device id stored in the step is dropped and replaced
 * with the resolved one, so a flow recorded on one device stays portable and a
 * stale baked-in udid cannot override the run target. The id is injected only
 * for the device-id keys the tool's input schema declares (so `.strict()`
 * schemas stay valid), bare or as a one-element list depending on which set the
 * key is in.
 *
 * It is NOT authoritative on a device SCOPE it did not resolve from the caller;
 * `deviceIsExplicit` is what tells the two apart.
 */
export function bindDeviceArgs(
  registry: Registry,
  toolName: string,
  deviceId: string,
  args: Record<string, unknown>,
  deviceIsExplicit = false
): Record<string, unknown> {
  const toolDef = registry.getTool(toolName);
  const props = (toolDef?.inputSchema as { properties?: Record<string, unknown> } | undefined)
    ?.properties;
  const out = stripDeviceKeys(args);
  for (const k of DEVICE_BIND_LIST_KEYS) {
    // Never forward a scope to a tool that does not declare it — a `.strict()`
    // schema would reject the whole call.
    if (!props || !(k in props)) {
      delete out[k];
      continue;
    }
    // `[""]` is never bound: an id that owns nothing reaps nothing and still
    // reports pass.
    if (!deviceId) continue;
    // With NO recorded scope the run device NARROWS what the step would
    // otherwise do — an unscoped `stop-all-simulator-servers` is the
    // machine-wide sweep — so bind it whatever resolved it.
    if (out[k] === undefined) {
      out[k] = [deviceId];
      continue;
    }
    // With one recorded, OVERRIDING it is destructive rather than portable: a
    // flow that named device A would tear down whichever device happened to
    // resolve, the cross-agent teardown the `devices` scope was added to
    // prevent. Only an explicit `device` overrides — there the caller named the
    // run target itself. An auto-resolved one names nobody's intent, so the
    // recorded ids stand and on another host come back in `unmatched`.
    if (deviceIsExplicit) out[k] = [deviceId];
  }
  if (props) for (const k of DEVICE_BIND_KEYS) if (k in props) out[k] = deviceId;
  return out;
}
