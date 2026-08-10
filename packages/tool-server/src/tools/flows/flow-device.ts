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

/**
 * Args keys holding a LIST of device ids. Same treatment as
 * {@link DEVICE_BIND_KEYS} — stripped at record time, re-injected at replay —
 * but rebound to `[deviceId]`, since the runner resolves exactly one device per
 * run and a flow that named several would be naming the recording host's.
 *
 * `stop-all-simulator-servers`' `devices` is the only such key. It is a scope
 * rather than a target, and that difference decides when it is rebound. A
 * recording of the UNSCOPED sweep always replays as a stop of the run device:
 * the replayed artifact must not tear down devices another agent is mid-session
 * on, which is the hazard the `devices` scope was added for, and binding can
 * only narrow there. A recorded scope, on the other hand, is the flow's own
 * statement of what to reap, and is overridden only by an explicit `device` —
 * see {@link bindDeviceArgs}, which is where the two cases part.
 */
const DEVICE_BIND_LIST_KEYS = ["devices"] as const;

/**
 * Keys that mean a tool needs a device to act on at all — the TARGET keys, and
 * deliberately not the scope keys in {@link DEVICE_BIND_LIST_KEYS}.
 *
 * `toolRequiresDevice` consults this, and `resolveRunDevice` skips resolving a
 * device for a flow no step here matches. The distinction is what a missing
 * device does to the step: a `screenshot` with no `udid` has nothing to point
 * at and cannot run, while `stop-all-simulator-servers` with no `devices` is
 * the machine-wide sweep — a complete, meaningful call, and the whole content
 * of a cleanup flow. Listing `devices` here made such a flow demand a device it
 * has no use for, so the two situations a cleanup flow actually runs in — none
 * booted, or several — failed it outright.
 *
 * A scope key is therefore bound OPPORTUNISTICALLY: {@link bindDeviceArgs}
 * injects it when the run resolved a device (so a replayed teardown cannot reap
 * devices another agent is mid-session on) and leaves it off when the run has
 * none, rather than binding the empty string — `{ devices: [""] }` would be a
 * teardown scoped to an id that owns nothing, reaping nothing while reporting
 * pass, which is the failure {@link DEVICE_BIND_LIST_KEYS} exists to prevent.
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
 * Strip the device-TARGET keys from a set of args (so a recorded flow stores no
 * device to point at). Scope keys are deliberately kept — see below.
 *
 * Schema-blind on purpose: `bindDeviceArgs` strips unconditionally and re-injects
 * only what the target tool declares, so a stale id is never forwarded to a tool
 * that does not want it.
 *
 * A SCOPE survives into the YAML because dropping it changes what the recorded
 * step MEANS. `stop-all-simulator-servers` with no `devices` is the machine-wide
 * sweep, so a correctly scoped teardown would record as a bare
 * `- tool: stop-all-simulator-servers` — and the YAML is the artifact that gets
 * committed, read, and (per the create-flow skill's manual-execution strategy)
 * hand-run a step at a time. Replay rebinds it either way, but hand-running that
 * bare step reaps every device on the machine, which is the cross-agent teardown
 * the scope exists to prevent. The contrast is the point: a recorded `screenshot`
 * loses its `udid` too, and hand-running it fails loudly because `udid` is
 * required. Losing `devices` fails OPEN. The recorded ids are host-specific, but
 * that costs only a no-op plus an `unmatched` report on another machine — the
 * safe direction, and a legible one.
 */
export function stripDeviceKeys(args: Record<string, unknown>): Record<string, unknown> {
  const out = { ...args };
  for (const k of DEVICE_BIND_KEYS) delete out[k];
  return out;
}

/**
 * Bind the resolved device id into a tool's args. The runner is **authoritative**
 * on the device to act ON: any device id stored in the step is dropped and
 * replaced with the resolved one — so a flow recorded on one device stays
 * portable to another and a stale baked-in udid can't override the run target.
 * The id is injected only for the device-id keys the tool's input schema
 * declares (so `.strict()` schemas stay valid), as a bare id or as a one-element
 * list depending on which set the key is in.
 *
 * It is NOT authoritative on a device SCOPE it did not resolve from the caller;
 * `deviceIsExplicit` is what tells the two apart. See the loop below.
 *
 * This covers a nested `tool: flow-execute` step too — its own `device` arg is
 * rebound, so a composed run inherits the run device rather than driving the one
 * it was recorded against, matching how `run:` composition already behaves.
 */
/**
 * Whether a step acts on a device.
 *
 * Answered per kind rather than by trying and failing, so a flow that touches no
 * device never has to have one. The default is that a step DOES need one: a kind
 * added later inherits today's behaviour instead of silently running against no
 * device, and the `never` binding makes leaving it unclassified a compile error.
 *
 * Three of the classifications are worth stating outright:
 *
 * - `when` needs a device whatever its body contains, because the guard itself
 *   reads one — the device's platform, or its view tree.
 * - `idle` needs one despite carrying no selector: it reads the device twice
 *   over, the UI tree and a screenshot of it.
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

/** Whether any step in a flow acts on a device. */
export function flowRequiresDevice(registry: Registry, steps: FlowStep[]): boolean {
  return steps.some((step) => stepRequiresDevice(registry, step));
}

/**
 * Whether any step would NARROW itself to the run device if one were resolved,
 * without needing one to run — a `devices` scope, and only that today.
 *
 * Asked of a flow that {@link flowRequiresDevice} said no to, so the run has a
 * choice: resolve a device opportunistically and scope the teardown to it
 * (keeping the cross-agent protection the scope exists for), or, where no
 * single device is resolvable, run the step's unscoped meaning rather than
 * failing a flow whose whole purpose is to clear the machine.
 */
export function flowScopesDevice(registry: Registry, steps: FlowStep[]): boolean {
  return steps.some(
    (step) => step.kind === "tool" && declaresAny(registry, step.name, DEVICE_BIND_LIST_KEYS)
  );
}

function toolRequiresDevice(registry: Registry, toolName: string): boolean {
  // An unknown tool is assumed to need a device: the step is going to fail
  // either way, and it fails more usefully with one resolved.
  if (!registry.getTool(toolName)) return true;
  return declaresAny(registry, toolName, DEVICE_ARG_KEYS);
}

function declaresAny(registry: Registry, toolName: string, keys: readonly string[]): boolean {
  const toolDef = registry.getTool(toolName);
  const props = (toolDef?.inputSchema as { properties?: Record<string, unknown> } | undefined)
    ?.properties;
  // A tool with no declared input takes no device.
  if (!props) return false;
  return keys.some((k) => k in props);
}

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
    // machine-wide sweep — so bind it whatever resolved it. Strictly the safe
    // direction, and the reason a device is resolved for a cleanup flow at all.
    if (out[k] === undefined) {
      out[k] = [deviceId];
      continue;
    }
    // With one recorded, OVERRIDING it is destructive rather than portable: a
    // flow that named device A would tear down whichever device happened to
    // resolve, which is precisely the cross-agent teardown the `devices` scope
    // was added to prevent. Only an explicit `device` overrides — there the
    // caller named the run target itself, so retargeting the teardown at it is
    // what they asked for. An auto-resolved device names nobody's intent, so
    // the recorded ids stand: on another host they reap nothing and come back
    // in `unmatched`, which is the safe direction and a legible one.
    if (deviceIsExplicit) out[k] = [deviceId];
  }
  if (props) for (const k of DEVICE_BIND_KEYS) if (k in props) out[k] = deviceId;
  return out;
}
